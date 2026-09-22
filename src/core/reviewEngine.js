/**
 * src/core/reviewEngine.js
 *
 * Review Engine — orchestrates the complete AI PR Review pipeline.
 *
 * Responsibilities:
 *   - Accept input (diff text, file paths, or a ReviewContext).
 *   - Build a bounded LLM context via contextBuilder (PR diff + targeted
 *     source snippets + Genesis context) instead of sending entire files.
 *   - Invoke the Security Agent with the bounded context.
 *   - Pass every AI finding through the deterministic Evidence Validator.
 *   - Return a structured ReviewResult.
 *
 * The Review Engine is independent of any trigger mechanism.
 * The same engine is called from:
 *   - The CLI  (src/cli/index.js)
 *   - The GitHub Actions reusable workflow  (via src/cli/index.js)
 *
 * Pipeline:
 *   Input (diff | file paths | ReviewContext)
 *     ↓
 *   makeReviewContext()          — normalise inputs
 *     ↓
 *   contextBuilder               — bounded diff + source context + Genesis
 *     ↓
 *   securityAgent + qualityAgent — LLM finds security + code-quality issues
 *     ↓
 *   evidenceValidator            — deterministic source verification
 *     ↓
 *   ReviewResult                 — merged findings with VERIFIED / UNVERIFIED
 *
 * Error handling:
 *   - Genesis failure is non-fatal — the Security Agent still runs without context.
 *   - LLM failure returns an error ReviewResult with empty findings.
 *   - Individual file failures (missing file, deleted) are returned as error results
 *     per-file without aborting the rest of the batch.
 *
 * Context-size protection:
 *   Before every LLM call the engine logs:
 *     [AI-Review] Groq model: <model>
 *     [AI-Review] Diff chars: <n>
 *     [AI-Review] Source context chars: <n>
 *     [AI-Review] Genesis context chars: <n>
 *     [AI-Review] User prompt chars: <n>
 *   These diagnostics help diagnose 413/token-limit problems without
 *   echoing actual source code or secrets.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, relative, extname } from 'path';

import { makeReviewContext }                       from './reviewContext.js';
import { makeReviewResult, makeErrorResult }       from './reviewResult.js';
import { buildContext }                            from './contextBuilder.js';
import { getContextForFiles, isGenesisAvailable }  from '../genesis/genesisAdapter.js';
import { analyseForSecurity }                      from '../agents/securityAgent.js';
import { analyseForQuality }                        from '../agents/qualityAgent.js';
import { resolveQualityConfig }                     from '../agents/checkCatalog.js';
import { dedupeFindings }                           from './findingDedup.js';
import { validateFindings }                        from '../validation/evidenceValidator.js';
import { DEFAULT_MODEL }                           from '../integrations/groq.js';

// Extensions the engine will review
const REVIEWABLE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);



// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full review pipeline on a diff string or a single file path.
 *
 * When `filePath` is supplied the engine reads the file content and wraps it
 * in a minimal unified-diff envelope so the context builder can locate the
 * changed lines.  This preserves backward-compatibility for local/CLI use
 * while keeping a single code path through contextBuilder.
 *
 * When `diff` is supplied (the primary GitHub PR path) it is used directly.
 *
 * @param {Object} options
 * @param {string}   [options.diff]      - Unified diff text (preferred for PR review)
 * @param {string}   [options.filePath]  - Absolute or relative path to review (local use)
 * @param {string}   [options.repoRoot]  - Repository root (defaults to REVIEW_REPO_ROOT or cwd)
 * @returns {Promise<Object>} ReviewResult
 */
export async function runReview({ diff, filePath, repoRoot } = {}) {
  const start = Date.now();

  const ctx = makeReviewContext({ repoRoot });
  const effectiveRoot = repoRoot ? resolve(repoRoot) : ctx.repoRoot;

  // ── Resolve input ─────────────────────────────────────────────────────────
  let diffText          = diff || '';
  let resolvedFilePaths = [];

  if (filePath) {
    const abs = resolve(effectiveRoot, filePath);
    if (!existsSync(abs)) {
      return makeErrorResult(`File not found: ${filePath}`, start, isGenesisAvailable(effectiveRoot));
    }

    // Wrap the full file in a minimal unified-diff envelope.
    // This lets contextBuilder parse it to extract changed-line ranges,
    // and gives the LLM file + line context rather than a raw blob.
    // We mark every line as added (+) so the context builder treats the
    // whole file as "changed" — but the source-context extractor will
    // still only emit function-scoped snippets, not the whole file.
    const rel        = relative(effectiveRoot, abs).replace(/\\/g, '/');
    const content    = readFileSync(abs, 'utf8');
    diffText         = wrapFileAsDiff(rel, content);
    resolvedFilePaths = [rel];
  }

  if (!diffText.trim()) {
    return makeErrorResult(
      'No input provided — pass a diff string or a filePath.',
      start,
      isGenesisAvailable(effectiveRoot)
    );
  }

  // If file paths weren't derived from a filePath arg, extract them from the diff
  if (resolvedFilePaths.length === 0) {
    resolvedFilePaths = extractFilePaths(diffText, effectiveRoot);
  }

  // ── Step 1: Genesis context ───────────────────────────────────────────────
  const genesisAvailable = isGenesisAvailable(effectiveRoot);
  let genesisCtx = '';

  if (genesisAvailable && resolvedFilePaths.length > 0) {
    try {
      const genesisResult = await getContextForFiles(resolvedFilePaths, effectiveRoot);
      genesisCtx = genesisResult.summary || '';
    } catch {
      // Genesis failure is non-fatal — continue without context
    }
  }

  // ── Step 2: Build bounded context ────────────────────────────────────────
  const { combined, diagnostics } = buildContext(diffText, effectiveRoot, genesisCtx);

  // Log prompt-size diagnostics (no source code, no secrets)
  const model = process.env.GROQ_SECURITY_MODEL || DEFAULT_MODEL;
  console.log(`[AI-Review] Groq model:            ${model}`);
  console.log(`[AI-Review] Diff chars:            ${diagnostics.diffChars}`);
  console.log(`[AI-Review] Source context chars:  ${diagnostics.sourceChars}`);
  console.log(`[AI-Review] Genesis context chars: ${diagnostics.genesisChars}`);
  console.log(`[AI-Review] User prompt chars:     ${diagnostics.combinedChars}`);

  // ── Step 3: Analysis agents ───────────────────────────────────────────────
  // Both agents run over the SAME bounded context. Genesis context is already
  // embedded in `combined` by buildContext, so we pass an empty second arg to
  // each agent to avoid double-including it.
  //
  // The quality agent runs the enabled subset of the check catalog, controlled
  // by AI_REVIEW_ENABLE_QUALITY plus the per-category toggles. The two agent
  // calls are independent, so they run in parallel.
  const qualityConfig  = resolveQualityConfig();
  const qualityEnabled = qualityConfig.enabled && qualityConfig.enabledTypes.size > 0;

  if (qualityEnabled) {
    console.log(
      `[AI-Review] Quality categories:   ${[...qualityConfig.enabledCategories].join(', ')}`
    );
    console.log(`[AI-Review] Quality min severity: ${qualityConfig.minSeverity}`);
  } else {
    console.log('[AI-Review] Quality agent:        disabled');
  }

  const [securityResult, qualityResult] = await Promise.all([
    analyseForSecurity(combined, ''),
    qualityEnabled
      ? analyseForQuality(combined, '', { config: qualityConfig })
      : Promise.resolve(null),
  ]);

  // The review is considered to have used the LLM if either agent did.
  const llmUsed = securityResult.llmUsed || Boolean(qualityResult?.llmUsed);

  // If no agent produced a usable LLM result, surface the error and stop.
  if (!llmUsed) {
    const error = securityResult.error || qualityResult?.error || 'LLM analysis unavailable.';
    return makeReviewResult({
      findings:         [],
      genesisAvailable,
      llmUsed:          false,
      error,
      durationMs:       Date.now() - start,
    });
  }

  // Merge findings from every agent that ran successfully, then collapse
  // overlapping findings on the same location so reviewers do not see the same
  // line flagged several times (e.g. LOGIC_ERROR + MAGIC_NUMBER on one line).
  const rawFindings = dedupeFindings([
    ...securityResult.findings,
    ...(qualityResult?.findings || []),
  ]);

  // Combine agent errors (e.g. one agent hit a rate limit but the other worked)
  // into a single non-fatal note so the caller still gets partial results.
  const agentErrors = [securityResult.error, qualityResult?.error]
    .filter(Boolean);
  const combinedError = agentErrors.length > 0 ? agentErrors.join(' | ') : null;

  // ── Step 4: Evidence Validator ────────────────────────────────────────────
  // The validator reads the actual checked-out source on disk — it is
  // intentionally NOT limited to the context window sent to the LLM.
  // Every finding — security or quality — passes through the same
  // deterministic verification. LLM confidence alone is never sufficient.
  const validatedPairs = validateFindings(rawFindings, effectiveRoot);

  // ── Step 5: Merge findings with validation results ────────────────────────
  const findings = validatedPairs.map(({ finding, validation }) => ({
    ...finding,
    verification: validation,
  }));

  return makeReviewResult({
    findings,
    genesisAvailable,
    llmUsed:    true,
    error:      combinedError,
    durationMs: Date.now() - start,
  });
}

/**
 * Review a specific file.
 * Convenience wrapper around runReview — kept for backward-compatibility.
 *
 * @param {string} filePath
 * @param {string} [repoRoot]
 * @returns {Promise<Object>} ReviewResult
 */
export async function reviewFile(filePath, repoRoot) {
  return runReview({ filePath, repoRoot });
}

/**
 * Review raw diff/code text.
 * Primary path for GitHub PR review — the diff is passed directly.
 *
 * @param {string} diff
 * @param {string} [repoRoot]
 * @returns {Promise<Object>} ReviewResult
 */
export async function reviewDiff(diff, repoRoot) {
  return runReview({ diff, repoRoot });
}

/**
 * Review a batch of file paths — kept for backward-compatibility with the
 * existing --files-from CLI path.
 *
 * Files are reviewed sequentially to respect Groq rate limits.
 * A file that does not exist is skipped with an error result rather than
 * aborting the entire batch.
 *
 * @param {string[]} filePaths  - Relative or absolute paths
 * @param {string}   [repoRoot]
 * @returns {Promise<Array<{ filePath: string, result: Object }>>}
 */
export async function reviewFiles(filePaths, repoRoot) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) return [];

  const results = [];
  for (const fp of filePaths) {
    const result = await runReview({ filePath: fp, repoRoot });
    results.push({ filePath: fp, result });
  }
  return results;
}

/**
 * Classify a list of raw paths into reviewable vs skipped.
 *
 * - Filters to REVIEWABLE_EXTS only.
 * - Skips files that do not exist on disk (deleted files, etc.).
 *
 * @param {string[]} rawPaths
 * @param {string}   repoRoot
 * @returns {{ reviewable: string[], skipped: Array<{path, reason}> }}
 */
export function classifyFiles(rawPaths, repoRoot) {
  const effectiveRoot = repoRoot || process.env.REVIEW_REPO_ROOT || process.cwd();
  const reviewable    = [];
  const skipped       = [];

  for (const raw of rawPaths) {
    const p = (raw || '').trim();
    if (!p) continue;

    if (!REVIEWABLE_EXTS.has(extname(p).toLowerCase())) {
      skipped.push({ path: p, reason: 'not a reviewable source file (JS/TS only)' });
      continue;
    }

    const abs = resolve(effectiveRoot, p);
    if (!existsSync(abs)) {
      skipped.push({ path: p, reason: 'file not found on disk (deleted or renamed)' });
      continue;
    }

    reviewable.push(p);
  }

  return { reviewable, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap full file content in a minimal unified-diff envelope.
 *
 * This is used when reviewing a single file path (local/CLI mode) so that
 * contextBuilder can parse it the same way it parses a real PR diff.
 * Every line is marked as added (+) starting at line 1 so the source-context
 * extractor knows every line is "in scope", but will still function-scope
 * the output rather than re-emitting the whole file verbatim.
 *
 * @param {string}   relPath  - Relative file path (used in diff headers)
 * @param {string}   content  - Full file content
 * @returns {string}          - Minimal unified diff string
 */
function wrapFileAsDiff(relPath, content) {
  const lines  = content.split('\n');
  const header =
    `--- a/${relPath}\n` +
    `+++ b/${relPath}\n` +
    `@@ -0,0 +1,${lines.length} @@\n`;
  const body = lines.map(l => `+${l}`).join('\n');
  return header + body;
}

/**
 * Extract relative file paths from a unified diff header.
 * Falls back to scanning for JS/TS file references in the text.
 * Only returns paths that actually exist under repoRoot.
 */
function extractFilePaths(diffText, repoRoot) {
  const paths = new Set();

  // Standard unified diff headers: +++ b/path or --- a/path
  for (const match of diffText.matchAll(/^(?:\+\+\+|---)\s+(?:a\/|b\/)?(.+?)(?:\s|$)/gm)) {
    const p = match[1].trim();
    if (p !== '/dev/null' && !p.startsWith('..')) {
      paths.add(p.replace(/\\/g, '/'));
    }
  }

  // Fallback: look for JS/TS file references in the text
  if (paths.size === 0) {
    for (const match of diffText.matchAll(/\b([\w./-]+\.(?:m?[jt]sx?|cjs|mjs))\b/g)) {
      paths.add(match[1].replace(/\\/g, '/'));
    }
  }

  // Filter to paths that exist under the repo root
  return [...paths].filter(p => {
    try { return existsSync(resolve(repoRoot, p)); } catch { return false; }
  });
}
