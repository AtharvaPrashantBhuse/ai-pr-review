/**
 * src/core/impactAnalysis.js
 *
 * Impact Analysis — shapes the repository intelligence that Genesis already
 * computes (blast radius + dependency boundary) into a compact, deterministic
 * summary that the GitHub Reporter can render alongside findings.
 *
 * This module NEVER calls an LLM. It is pure data reshaping over the output of
 * genesisAdapter.getContextForFiles(), which returns one entry per changed file:
 *
 *   {
 *     file:     "src/auth/token.js",
 *     symbols:  [ { kind, name, line }, ... ],
 *     impact:   [ { path }, ... ],          // files that (transitively) import this one
 *     boundary: { dependsOn: [ { target } ], dependedOnBy, files, symbolCount, ... }
 *   }
 *
 * Responsibility:
 *   - Turn that raw structure into a bounded per-file impact record.
 *   - Compute a blast-radius count and a truncated list of impacted files.
 *   - Provide a per-file lookup so individual findings can be annotated with
 *     "this file is imported by N others".
 *
 * Everything here degrades gracefully: given empty or missing Genesis data it
 * returns an empty impact set, and the reporter simply omits the section.
 *
 * Configurable limits (environment variables):
 *   AI_REVIEW_IMPACT_MAX_FILES         default 25  — max files to summarise
 *   AI_REVIEW_IMPACT_MAX_LISTED        default 8   — max impacted paths listed per file
 *   AI_REVIEW_IMPACT_MAX_DEPENDS       default 8   — max dependency paths listed per file
 */

// ─────────────────────────────────────────────────────────────────────────────
// Configurable limits
// ─────────────────────────────────────────────────────────────────────────────

function limit(envVar, defaultValue) {
  const v = parseInt(process.env[envVar], 10);
  return Number.isFinite(v) && v > 0 ? v : defaultValue;
}

function getLimits() {
  return {
    maxFiles:   limit('AI_REVIEW_IMPACT_MAX_FILES',   25),
    maxListed:  limit('AI_REVIEW_IMPACT_MAX_LISTED',   8),
    maxDepends: limit('AI_REVIEW_IMPACT_MAX_DEPENDS',  8),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a bounded impact summary from Genesis per-file context.
 *
 * @param {Array<Object>} genesisFiles - The `files` array from getContextForFiles()
 * @returns {{
 *   available: boolean,
 *   files: Array<{
 *     file: string,
 *     blastRadius: number,        // total count of impacted files (pre-truncation)
 *     impactedFiles: string[],    // truncated list of impacted file paths
 *     impactedTruncated: number,  // how many were omitted from impactedFiles
 *     dependsOn: string[],        // truncated list of dependency paths
 *     dependsOnTruncated: number, // how many dependencies were omitted
 *   }>,
 *   byFile: Object,               // map: file path → the per-file record above
 *   totalBlastRadius: number,     // sum of blast radii across all changed files
 * }}
 */
export function buildImpactSummary(genesisFiles) {
  const limits = getLimits();

  if (!Array.isArray(genesisFiles) || genesisFiles.length === 0) {
    return emptyImpact();
  }

  const files  = [];
  const byFile  = {};

  for (const entry of genesisFiles.slice(0, limits.maxFiles)) {
    if (!entry || !entry.file) continue;

    const impactPaths  = normalisePaths(entry.impact,  p => p?.path ?? p?.target ?? p);
    const dependsPaths = normalisePaths(entry.boundary?.dependsOn, d => d?.target ?? d?.path ?? d);

    // Only record files that actually have some relationship data — a file with
    // no impact and no dependencies contributes nothing to the reader.
    if (impactPaths.length === 0 && dependsPaths.length === 0) continue;

    const record = {
      file:               entry.file,
      blastRadius:        impactPaths.length,
      // Full lists — the reporter renders these inside an expandable <details>
      // block, so nothing is hidden behind un-clickable "+N more" text.
      impactedFiles:      impactPaths,
      dependsOn:          dependsPaths,
      // Short previews kept for any non-Markdown consumer (CLI/log) that wants
      // a compact view without expanding the full list.
      impactedPreview:    impactPaths.slice(0, limits.maxListed),
      impactedTruncated:  Math.max(0, impactPaths.length - limits.maxListed),
      dependsPreview:     dependsPaths.slice(0, limits.maxDepends),
      dependsTruncated:   Math.max(0, dependsPaths.length - limits.maxDepends),
    };

    files.push(record);
    byFile[entry.file] = record;
  }

  if (files.length === 0) return emptyImpact();

  const totalBlastRadius = files.reduce((sum, f) => sum + f.blastRadius, 0);

  return { available: true, files, byFile, totalBlastRadius };
}

/**
 * Look up the blast-radius count for a single file from an impact summary.
 * Returns 0 when the file is unknown or impact data is unavailable.
 *
 * Used to annotate individual findings with the reach of the file they touch.
 *
 * @param {Object} impact - result of buildImpactSummary()
 * @param {string} file   - relative file path
 * @returns {number}
 */
export function blastRadiusForFile(impact, file) {
  if (!impact?.available || !file) return 0;
  return impact.byFile[file]?.blastRadius ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function emptyImpact() {
  return { available: false, files: [], byFile: {}, totalBlastRadius: 0 };
}

/**
 * Normalise a raw Genesis relationship array into a de-duplicated list of
 * string paths. Accepts entries that are plain strings or objects with a
 * `path`/`target` field, via the supplied accessor.
 */
function normalisePaths(rawList, accessor) {
  if (!Array.isArray(rawList)) return [];
  const seen = new Set();
  const out  = [];
  for (const raw of rawList) {
    const value = accessor(raw);
    if (typeof value !== 'string' || !value.trim()) continue;
    const p = value.trim().replace(/\\/g, '/');
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}
