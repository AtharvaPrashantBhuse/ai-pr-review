/**
 * src/validation/evidenceValidator.js
 *
 * Deterministic Evidence Validator.
 *
 * Responsibility: deterministically verify every AI finding against the
 * actual source code on disk. This module NEVER uses an LLM.
 *
 * A finding is only VERIFIED when all four checks pass:
 *   1. The referenced file exists on disk.
 *   2. The referenced line number is within the file's line count.
 *   3. The reported evidence string is present in the source around that line.
 *   4. (Implicit from 3) The evidence corresponds to the reported location.
 *
 * A finding that passes LLM confidence checks but fails source verification
 * is marked UNVERIFIED — LLM confidence alone is never sufficient.
 *
 * Result shapes:
 *   VERIFIED:   { status: "VERIFIED",   file, line, sourceLine, [endLine] }
 *   UNVERIFIED: { status: "UNVERIFIED", file, line, reason,     [endLine] }
 *
 * Range (multi-line) findings:
 *   A finding may include an `endLine`. When it does, the validator treats the
 *   finding as spanning line..endLine and searches that whole span (plus the
 *   context window) for the evidence. This lets duplication blocks, over-long
 *   functions, and other multi-line constructs be VERIFIED instead of being
 *   forced UNVERIFIED by a single-line check. Single-line findings (no endLine)
 *   behave exactly as before.
 *
 * Evidence matching strategy (three levels, any one is sufficient):
 *   1. Exact normalised match (whitespace-collapsed, lowercased).
 *   2. Substring containment (evidence ⊆ source line or source line ⊆ evidence).
 *   3. Significant-token overlap — ≥60% of meaningful tokens from the evidence
 *      appear in the source line. Handles LLM paraphrasing of the vulnerable
 *      construct without accepting completely unrelated strings.
 *
 * The repository root is resolved from REVIEW_REPO_ROOT (set by the reusable
 * workflow) or process.cwd() as a local fallback. Tests may pass an explicit
 * repoRoot to point validation at the fixtures directory.
 */

import { existsSync, readFileSync } from 'fs';
import { resolve }                  from 'path';

// Lines either side of the claimed line to search for evidence
const CONTEXT_WINDOW = 3;

// ─────────────────────────────────────────────────────────────────────────────
// Repo root resolution  (mirrors genesisAdapter strategy)
// ─────────────────────────────────────────────────────────────────────────────

function resolveDefaultRepoRoot() {
  return process.env.REVIEW_REPO_ROOT || process.cwd();
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate a single AI finding against the checked-out source.
 *
 * @param {Object} finding    - A finding produced by securityAgent.analyseForSecurity()
 * @param {string} [repoRoot] - Root of the repository being reviewed.
 *                              Defaults to REVIEW_REPO_ROOT or process.cwd().
 * @returns {{ status: string, file: string, line: number, sourceLine?: string, reason?: string }}
 */
export function validateFinding(finding, repoRoot = resolveDefaultRepoRoot()) {
  const { file, line, evidence } = finding;

  // endLine marks a range (multi-line) finding — e.g. a duplicated block or an
  // over-long function. When present and valid, verification searches the whole
  // claimed span (plus the context window) for the evidence rather than a single
  // line. When absent, behaviour is identical to the original single-line check.
  const endLineRaw = parseInt(finding.endLine, 10);
  const hasRange   = Number.isFinite(endLineRaw) && endLineRaw > (parseInt(line, 10) || 0);

  // ── Check 1: file field present ──────────────────────────────────────────
  if (!file || typeof file !== 'string') {
    return unverified(file, line, 'Finding has no file field.');
  }

  const absolutePath = resolve(repoRoot, file);

  // ── Check 2: file exists on disk ─────────────────────────────────────────
  if (!existsSync(absolutePath)) {
    return unverified(file, line, `File does not exist: ${file}`);
  }

  // ── Check 3: read source; verify line range ───────────────────────────────
  let sourceLines;
  try {
    sourceLines = readFileSync(absolutePath, 'utf8').split('\n');
  } catch (err) {
    return unverified(file, line, `Could not read file: ${err.message}`);
  }

  const totalLines  = sourceLines.length;
  const claimedLine = parseInt(line, 10);

  if (!claimedLine || claimedLine < 1) {
    return unverified(file, line, `Invalid line number: ${line}`);
  }

  if (claimedLine > totalLines) {
    return unverified(
      file,
      line,
      `Line ${claimedLine} does not exist — file only has ${totalLines} lines.`
    );
  }

  // ── Check 4: evidence exists in source around the claimed line/range ──────
  if (!evidence || !evidence.trim()) {
    return unverified(file, line, 'Finding has no evidence to verify against source.');
  }

  const evidenceNorm    = normalise(evidence);
  const exactSourceLine = sourceLines[claimedLine - 1];   // 1-based → 0-based

  if (hasRange) {
    // Range finding: clamp endLine to the file, then search the whole span
    // (with padding) for the evidence. The end line must be within the file —
    // a claimed span that runs past EOF is a fabrication signal.
    const claimedEnd = endLineRaw;
    if (claimedEnd > totalLines) {
      return unverified(
        file,
        line,
        `Range end line ${claimedEnd} does not exist — file only has ${totalLines} lines.`,
        claimedEnd
      );
    }

    const windowStart = Math.max(0, claimedLine - 1 - CONTEXT_WINDOW);
    const windowEnd   = Math.min(totalLines - 1, claimedEnd - 1 + CONTEXT_WINDOW);
    const windowLines = sourceLines.slice(windowStart, windowEnd + 1);

    const matched = windowLines.some(srcLine => evidenceMatches(evidenceNorm, normalise(srcLine)));

    if (!matched) {
      return unverified(
        file,
        line,
        `Evidence not found within claimed range ${claimedLine}-${claimedEnd}. ` +
        `Claimed: "${evidence.substring(0, 120)}".`,
        claimedEnd
      );
    }

    return {
      status:     'VERIFIED',
      file,
      line:       claimedLine,
      endLine:    claimedEnd,
      sourceLine: exactSourceLine.trim(),
    };
  }

  // Single-line finding (default path — unchanged behaviour).
  const windowStart = Math.max(0, claimedLine - 1 - CONTEXT_WINDOW);
  const windowEnd   = Math.min(totalLines - 1, claimedLine - 1 + CONTEXT_WINDOW);
  const windowLines = sourceLines.slice(windowStart, windowEnd + 1);

  const matched = windowLines.some(srcLine => evidenceMatches(evidenceNorm, normalise(srcLine)));

  if (!matched) {
    return unverified(
      file,
      line,
      `Evidence not found in source around line ${claimedLine}. ` +
      `Claimed: "${evidence.substring(0, 120)}". ` +
      `Actual line ${claimedLine}: "${exactSourceLine ? exactSourceLine.trim() : '(empty)'}"`
    );
  }

  return {
    status:     'VERIFIED',
    file,
    line:       claimedLine,
    sourceLine: exactSourceLine.trim(),
  };
}

/**
 * Validate all findings in a batch.
 *
 * Each entry in the returned array corresponds to one input finding:
 *   { finding: <original finding>, validation: <result> }
 *
 * @param {Object[]} findings  - Array of findings from securityAgent
 * @param {string}   [repoRoot]
 * @returns {Array<{ finding: Object, validation: Object }>}
 */
export function validateFindings(findings, repoRoot = resolveDefaultRepoRoot()) {
  if (!Array.isArray(findings)) return [];
  return findings.map(f => ({
    finding:    f,
    validation: validateFinding(f, repoRoot),
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function unverified(file, line, reason, endLine = null) {
  const result = { status: 'UNVERIFIED', file, line, reason };
  if (endLine != null) result.endLine = endLine;
  return result;
}

/**
 * Normalise a string for comparison:
 *   - lowercase
 *   - collapse all whitespace to a single space
 *   - strip surrounding whitespace
 *   - strip surrounding quotes (LLM often quotes the evidence string)
 */
function normalise(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^['"`]|['"`]$/g, '');
}

/**
 * Three-level flexible evidence matching:
 *
 *   Level 1 — Exact normalised match.
 *   Level 2 — Substring containment (either direction).
 *   Level 3 — Significant-token overlap (≥60% of evidence tokens found in source).
 *             Only tokens of length ≥3 that are not pure punctuation are counted
 *             as "significant" so short common tokens don't inflate the ratio.
 *
 * The three-level approach is intentional: the LLM may quote a slightly
 * condensed version of the vulnerable construct, but if none of the levels
 * match there is no meaningful overlap with the source and the finding is
 * correctly rejected as UNVERIFIED.
 */
function evidenceMatches(evidenceNorm, sourceNorm) {
  if (!evidenceNorm || !sourceNorm) return false;

  // Level 1: exact
  if (evidenceNorm === sourceNorm) return true;

  // Level 2: substring (either direction)
  if (sourceNorm.includes(evidenceNorm)) return true;
  if (evidenceNorm.includes(sourceNorm)) return true;

  // Level 3: significant-token overlap
  const evidenceTokens = tokenise(evidenceNorm);
  const sourceTokenSet = new Set(tokenise(sourceNorm));

  if (evidenceTokens.length === 0) return false;

  const sigEvidence = evidenceTokens.filter(
    t => t.length >= 3 && !/^[(){};,=><+\-*/|&^%!~]+$/.test(t)
  );
  if (sigEvidence.length === 0) return false;

  const matchCount = sigEvidence.filter(t => sourceTokenSet.has(t)).length;
  return (matchCount / sigEvidence.length) >= 0.60;
}

function tokenise(str) {
  return str.split(/[\s\W]+/).filter(Boolean);
}
