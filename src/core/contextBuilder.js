/**
 * src/core/contextBuilder.js
 *
 * Context Builder — assembles a bounded LLM prompt from:
 *   1. The actual PR diff (what changed)
 *   2. Targeted source context around the changed lines (not the whole file)
 *   3. Genesis repository context (symbols, dependencies, relationships)
 *
 * Motivation:
 *   Sending entire source files to the LLM causes 413 / token-limit errors
 *   on large files.  This module replaces that pattern with a context window
 *   that is proportional to what actually changed, not to the file size.
 *
 * Size limits (all configurable via environment variables):
 *   AI_REVIEW_MAX_DIFF_CHARS           default  8 000
 *   AI_REVIEW_MAX_SOURCE_CONTEXT_CHARS default 12 000
 *   AI_REVIEW_MAX_GENESIS_CONTEXT_CHARS default  4 000
 *   AI_REVIEW_MAX_PROMPT_CHARS         default 24 000
 *
 * Public API:
 *   buildContext(diff, repoRoot, genesisContext)
 *     → { diffSection, sourceSection, genesisSection, combined, diagnostics }
 *
 *   extractSourceContext(diff, repoRoot, maxChars)
 *     → string  (targeted source snippets, bounded to maxChars)
 *
 *   parseChangedHunks(diff)
 *     → Array<{ file, addedLines: [{ lineNo, text }], contextLines: [{ lineNo, text }] }>
 *
 *   buildInDiffLineMap(diff)
 *     → Map<string, Set<number>>
 *       Keys are relative file paths; values are sets of 1-based line numbers
 *       that appear in the diff (both changed and context lines).
 *       Used to validate whether a finding's line can receive an inline
 *       GitHub comment (GitHub only accepts comments on in-diff lines).
 */

import { existsSync, readFileSync } from 'fs';
import { resolve }                  from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Configurable limits
// ─────────────────────────────────────────────────────────────────────────────

function limit(envVar, defaultValue) {
  const v = parseInt(process.env[envVar], 10);
  return Number.isFinite(v) && v > 0 ? v : defaultValue;
}

function getLimits() {
  return {
    maxDiffChars:    limit('AI_REVIEW_MAX_DIFF_CHARS',            8_000),
    maxSourceChars:  limit('AI_REVIEW_MAX_SOURCE_CONTEXT_CHARS', 12_000),
    maxGenesisChars: limit('AI_REVIEW_MAX_GENESIS_CONTEXT_CHARS', 4_000),
    maxPromptChars:  limit('AI_REVIEW_MAX_PROMPT_CHARS',         24_000),
  };
}

// Lines of source to include above/below each changed hunk
const SOURCE_PAD_LINES = 8;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a bounded, structured LLM prompt context from its three inputs.
 *
 * @param {string} diff           - Unified diff text from the PR
 * @param {string} repoRoot       - Absolute path to the checked-out repository
 * @param {string} [genesisCtx]   - Repository context summary from genesisAdapter
 * @returns {{
 *   diffSection:    string,
 *   sourceSection:  string,
 *   genesisSection: string,
 *   combined:       string,
 *   diagnostics:    Object
 * }}
 */
export function buildContext(diff, repoRoot, genesisCtx = '') {
  const limits = getLimits();

  // ── 1. Diff section ───────────────────────────────────────────────────────
  const diffTrimmed   = (diff || '').trim();
  const diffSection   = truncate(diffTrimmed, limits.maxDiffChars, 'PR diff');

  // ── 2. Source context section ─────────────────────────────────────────────
  const sourceRaw     = extractSourceContext(diffTrimmed, repoRoot, limits.maxSourceChars);
  const sourceSection = truncate(sourceRaw, limits.maxSourceChars, 'source context');

  // ── 3. Genesis section ────────────────────────────────────────────────────
  const genesisTrimmed  = (genesisCtx || '').trim();
  const genesisSection  = truncate(genesisTrimmed, limits.maxGenesisChars, 'Genesis context');

  // ── 4. Combine and enforce total prompt limit ─────────────────────────────
  let combined = '';
  if (diffSection) {
    combined += '=== PR DIFF ===\n' + diffSection + '\n\n';
  }
  if (sourceSection) {
    combined += '=== RELEVANT SOURCE CONTEXT ===\n' + sourceSection + '\n\n';
  }
  if (genesisSection) {
    combined += '=== REPOSITORY CONTEXT (Genesis) ===\n' + genesisSection + '\n\n';
  }

  // Hard cap on total combined context
  const remainingBudget = limits.maxPromptChars - combined.length;
  if (remainingBudget < 0) {
    combined = combined.slice(0, limits.maxPromptChars);
  }

  const diagnostics = {
    diffChars:    diffSection.length,
    sourceChars:  sourceSection.length,
    genesisChars: genesisSection.length,
    combinedChars: combined.length,
    limits,
  };

  return { diffSection, sourceSection, genesisSection, combined, diagnostics };
}

/**
 * Extract targeted source context around the lines changed in the diff.
 *
 * Strategy per changed file:
 *   1. Parse the diff to find which line numbers were added/modified.
 *   2. Read the checked-out source file.
 *   3. For each changed line range, expand to include the containing
 *      function/block (by walking up to a `function`/`class`/`=>` header)
 *      plus SOURCE_PAD_LINES of padding.
 *   4. Include import/require lines only when the file is small enough that
 *      they fit in the remaining budget.
 *   5. Annotate each snippet with its filename and line numbers.
 *
 * Files that do not exist in the checkout (e.g. deleted) are silently skipped.
 *
 * @param {string} diff      - Unified diff text
 * @param {string} repoRoot  - Absolute path to repo root
 * @param {number} [maxChars] - Character limit for the entire return value
 * @returns {string}
 */
export function extractSourceContext(diff, repoRoot, maxChars) {
  const limits = getLimits();
  const budget = maxChars ?? limits.maxSourceChars;

  const hunks   = parseChangedHunks(diff);
  if (hunks.length === 0) return '';

  const sections = [];

  for (const { file, ranges } of hunks) {
    const abs = resolve(repoRoot, file);
    if (!existsSync(abs)) continue;

    let source;
    try {
      source = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    const lines = source.split('\n');
    const snippet = buildFileSnippet(file, lines, ranges);
    if (snippet) sections.push(snippet);
  }

  if (sections.length === 0) return '';

  // Join sections and hard-cap to budget
  const joined = sections.join('\n\n');
  return joined.length <= budget ? joined : joined.slice(0, budget) + '\n[... source context truncated ...]';
}

/**
 * Parse a unified diff into per-file changed line ranges.
 *
 * @param {string} diff
 * @returns {Array<{ file: string, ranges: Array<[number, number]> }>}
 *   ranges is an array of [startLine, endLine] pairs (1-based, inclusive)
 */
export function parseChangedHunks(diff) {
  if (!diff || !diff.trim()) return [];

  const fileMap = new Map();   // file → Set of changed line numbers
  let currentFile = null;
  let currentNewLine = 0;

  for (const raw of diff.split('\n')) {
    // New file header: +++ b/path/to/file.js
    const headerMatch = raw.match(/^\+\+\+\s+(?:b\/)?(.+?)(?:\s|$)/);
    if (headerMatch) {
      const p = headerMatch[1].trim();
      if (p !== '/dev/null') {
        currentFile = p.replace(/\\/g, '/');
        if (!fileMap.has(currentFile)) fileMap.set(currentFile, new Set());
      } else {
        currentFile = null;
      }
      continue;
    }

    // Hunk header: @@ -a,b +c,d @@
    const hunkMatch = raw.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch) {
      currentNewLine = parseInt(hunkMatch[1], 10);
      continue;
    }

    if (!currentFile) continue;

    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      // Added/modified line
      fileMap.get(currentFile).add(currentNewLine);
      currentNewLine++;
    } else if (raw.startsWith('-') && !raw.startsWith('---')) {
      // Removed line — does not advance new-file line counter
    } else if (!raw.startsWith('\\')) {
      // Context line
      currentNewLine++;
    }
  }

  // Convert per-file line sets to merged ranges
  const result = [];
  for (const [file, lineSet] of fileMap) {
    if (lineSet.size === 0) continue;
    const ranges = mergeLineRanges([...lineSet].sort((a, b) => a - b));
    result.push({ file, ranges });
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an annotated source snippet for one file, expanding each changed
 * line range to include the containing function/block.
 */
function buildFileSnippet(file, lines, ranges) {
  // Merge expanded ranges so overlapping expansions collapse
  const expandedRanges = ranges.map(([s, e]) => expandToFunction(lines, s, e));
  const merged         = mergeLineRanges(
    expandedRanges.flatMap(([s, e]) => {
      const arr = [];
      for (let i = s; i <= e; i++) arr.push(i);
      return arr;
    }).sort((a, b) => a - b)
  );

  let snippet = `--- ${file} (relevant context) ---\n`;
  let lastEnd = -1;

  for (const [s, e] of merged) {
    if (lastEnd >= 0 && s > lastEnd + 1) {
      snippet += '  ...\n';
    }
    for (let ln = s; ln <= e; ln++) {
      const idx = ln - 1;
      if (idx < 0 || idx >= lines.length) continue;
      snippet += `${String(ln).padStart(4, ' ')} | ${lines[idx]}\n`;
    }
    lastEnd = e;
  }

  return snippet.trim();
}

/**
 * Expand a [start, end] line range (1-based) outward to include the
 * enclosing function/class/method declaration, plus SOURCE_PAD_LINES padding.
 *
 * @param {string[]} lines  - All lines of the source file (0-indexed)
 * @param {number}   start  - First changed line (1-based)
 * @param {number}   end    - Last changed line (1-based)
 * @returns {[number, number]}
 */
function expandToFunction(lines, start, end) {
  const total = lines.length;

  // Walk upward from start-1 (0-based) looking for a function/class header
  let top = Math.max(0, start - 1 - SOURCE_PAD_LINES);   // default: pad only
  for (let i = start - 1; i >= 0; i--) {
    const line = lines[i];
    if (isFunctionHeader(line)) {
      top = i;
      break;
    }
    // Stop expanding if we've gone too far back
    if (start - 1 - i > 60) break;
  }

  // Pad downward
  const bottom = Math.min(total - 1, end - 1 + SOURCE_PAD_LINES);

  return [top + 1, bottom + 1];  // back to 1-based
}

/**
 * Heuristic: is this line the start of a function/class/method declaration?
 */
function isFunctionHeader(line) {
  const t = line.trimStart();
  return (
    /^(?:export\s+)?(?:async\s+)?function\s/.test(t) ||
    /^(?:export\s+)?(?:default\s+)?class\s/.test(t)  ||
    /^(?:(?:export|static|async|public|private|protected)\s+)*\w+\s*\(/.test(t) ||
    /(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?\(/.test(t) ||
    /(?:const|let|var)\s+\w+\s*=\s*(?:async\s+)?function/.test(t) ||
    /^\s*(?:async\s+)?\w+\s*\([^)]*\)\s*\{/.test(t)
  );
}

/**
 * Merge a sorted array of line numbers into [start, end] ranges.
 * Adjacent or overlapping line numbers are merged.
 *
 * @param {number[]} sorted - Sorted ascending line numbers
 * @returns {Array<[number, number]>}
 */
function mergeLineRanges(sorted) {
  if (sorted.length === 0) return [];
  const ranges = [];
  let s = sorted[0];
  let e = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] <= e + 1) {
      e = sorted[i];
    } else {
      ranges.push([s, e]);
      s = sorted[i];
      e = sorted[i];
    }
  }
  ranges.push([s, e]);
  return ranges;
}

/**
 * Truncate a string to maxChars, appending a note when cut.
 */
function truncate(str, maxChars, label = 'content') {
  if (!str) return '';
  if (str.length <= maxChars) return str;
  return str.slice(0, maxChars) + `\n[... ${label} truncated at ${maxChars} chars ...]`;
}

/**
 * Build a map of every line number that appears inside any diff hunk for each
 * file, including both changed lines (+/-) AND the surrounding context lines.
 *
 * GitHub's pull-request review API only accepts inline comments on lines that
 * appear somewhere in the diff (either as a changed line or as the context
 * lines the API echoes around each hunk). Attempting to comment on a line
 * outside the diff yields a 422 Unprocessable Entity error.
 *
 * This function walks the diff with the same state-machine logic as
 * parseChangedHunks but tracks EVERY new-file line number (changed + context),
 * not just the added lines. Removed lines (-) have no new-file number, so they
 * are correctly omitted.
 *
 * The result is used by githubReporter.js to decide whether a finding should
 * receive an inline comment or be kept only in the body summary.
 *
 * @param {string} diff  - Unified diff text (the full pr-diff.txt content)
 * @returns {Map<string, Set<number>>}
 *   Keys: relative file paths (e.g. "src/api/users.js")
 *   Values: Set of 1-based new-file line numbers that are in the diff
 */
export function buildInDiffLineMap(diff) {
  if (!diff || !diff.trim()) return new Map();

  /** @type {Map<string, Set<number>>} */
  const lineMap = new Map();
  let currentFile   = null;
  let currentNewLine = 0;
  let inHunk = false;

  for (const raw of diff.split('\n')) {
    // ── File header: +++ b/path/to/file.js ───────────────────────────────
    const headerMatch = raw.match(/^\+\+\+\s+(?:b\/)?(.+?)(?:\s|$)/);
    if (headerMatch) {
      const p = headerMatch[1].trim();
      currentFile   = p !== '/dev/null' ? p.replace(/\\/g, '/') : null;
      inHunk        = false;
      currentNewLine = 0;
      if (currentFile && !lineMap.has(currentFile)) {
        lineMap.set(currentFile, new Set());
      }
      continue;
    }

    // ── Old-file header: --- a/path — resets hunk state ─────────────────
    if (raw.startsWith('--- ')) {
      inHunk = false;
      continue;
    }

    // ── Hunk header: @@ -a,b +c,d @@ ────────────────────────────────────
    const hunkMatch = raw.match(/^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunkMatch) {
      currentNewLine = parseInt(hunkMatch[1], 10);
      inHunk         = true;
      continue;
    }

    if (!currentFile || !inHunk) continue;

    if (raw.startsWith('-') && !raw.startsWith('---')) {
      // Removed line — no new-file line number, do not advance counter.
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" — skip, do not advance.
    } else {
      // Added (+) or context line — both have a new-file line number.
      lineMap.get(currentFile).add(currentNewLine);
      currentNewLine++;
    }
  }

  return lineMap;
}
