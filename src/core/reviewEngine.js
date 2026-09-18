/**
 * src/core/reviewEngine.js
 *
 * Review Engine — orchestrates the complete AI PR Review pipeline.
 *
 * Responsibilities:
 *   - Accept input (diff text, file paths, or a ReviewContext).
 *   - Obtain Genesis repository context for the changed files.
 *   - Invoke the Security Agent with the source code + Genesis context.
 *   - Pass every AI finding through the deterministic Evidence Validator.
 *   - Return a structured ReviewResult.
 *
 * The Review Engine is independent of any trigger mechanism.
 * The same engine is called from:
 *   - The CLI  (src/cli/index.js)
 *   - The GitHub Actions reusable workflow  (via src/cli/index.js or directly)
 *
 * Pipeline:
 *   Input (diff | file paths | ReviewContext)
 *     ↓
 *   makeReviewContext()          — normalise inputs
 *     ↓
 *   genesisAdapter               — optional repository context
 *     ↓
 *   securityAgent                — LLM finds potential SQL Injection
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
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, relative, extname } from 'path';

import { makeReviewContext }                       from './reviewContext.js';
import { makeReviewResult, makeErrorResult }       from './reviewResult.js';
import { getContextForFiles, isGenesisAvailable }  from '../genesis/genesisAdapter.js';
import { analyseForSecurity }                      from '../agents/securityAgent.js';
import { validateFindings }                        from '../validation/evidenceValidator.js';

// Extensions the engine will review
const REVIEWABLE_EXTS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full review pipeline on a diff string or a single file path.
 *
 * @param {Object} options
 * @param {string}   [options.diff]      - Raw diff text or full file content
 * @param {string}   [options.filePath]  - Absolute or relative path to review
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
    diffText           = readFileSync(abs, 'utf8');
    const rel          = relative(effectiveRoot, abs).replace(/\\/g, '/');
    resolvedFilePaths  = [rel];
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
  let repoContext = '';

  if (genesisAvailable && resolvedFilePaths.length > 0) {
    try {
      const genesisCtx = await getContextForFiles(resolvedFilePaths, effectiveRoot);
      repoContext = genesisCtx.summary || '';
    } catch {
      // Genesis failure is non-fatal — continue without context
    }
  }

  // ── Step 2: Security Agent ────────────────────────────────────────────────
  const agentResult = await analyseForSecurity(diffText, repoContext);

  if (!agentResult.llmUsed) {
    return makeReviewResult({
      findings:         [],
      genesisAvailable,
      llmUsed:          false,
      error:            agentResult.error,
      durationMs:       Date.now() - start,
    });
  }

  // ── Step 3: Evidence Validator ────────────────────────────────────────────
  const validatedPairs = validateFindings(agentResult.findings, effectiveRoot);

  // ── Step 4: Merge findings with validation results ────────────────────────
  const findings = validatedPairs.map(({ finding, validation }) => ({
    ...finding,
    verification: validation,
  }));

  return makeReviewResult({
    findings,
    genesisAvailable,
    llmUsed:    true,
    error:      agentResult.error || null,
    durationMs: Date.now() - start,
  });
}

/**
 * Review a specific file.
 * Convenience wrapper around runReview.
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
 *
 * @param {string} diff
 * @param {string} [repoRoot]
 * @returns {Promise<Object>} ReviewResult
 */
export async function reviewDiff(diff, repoRoot) {
  return runReview({ diff, repoRoot });
}

/**
 * Review a batch of file paths — primary entry point for GitHub Actions.
 *
 * Files are reviewed sequentially to respect Groq rate limits.
 * A file that does not exist is skipped with an error result rather than
 * aborting the entire batch — one bad path must not block the rest.
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
