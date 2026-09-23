/**
 * src/core/reviewResult.js
 *
 * ReviewResult — the canonical shape of every review result.
 *
 * This module owns the data contract between the Review Engine and all
 * consumers (CLI, GitHub Reporter, tests). Nothing in here is business logic.
 *
 * ReviewResult shape:
 * {
 *   findings:         Array<Finding>   — merged findings with validation status
 *   genesisAvailable: boolean          — whether Genesis index was present
 *   llmUsed:          boolean          — whether a Groq/LLM call was made
 *   error:            string|null      — top-level error (e.g. missing API key)
 *   durationMs:       number           — wall-clock duration of the review
 *   impact:           Object|null      — optional Genesis impact summary
 *                                        (blast radius / dependencies); null when
 *                                        Genesis is unavailable
 * }
 *
 * Finding shape (post-validation):
 * {
 *   type:         string   — "SQL_INJECTION"
 *   severity:     string   — "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"
 *   confidence:   string   — "LOW" | "MEDIUM" | "HIGH"
 *   file:         string   — relative file path
 *   line:         number   — 1-based line number
 *   evidence:     string   — the specific vulnerable construct
 *   explanation:  string   — why it is a vulnerability
 *   verification: {
 *     status:     string   — "VERIFIED" | "UNVERIFIED"
 *     file:       string
 *     line:       number
 *     sourceLine: string   (VERIFIED only)
 *     reason:     string   (UNVERIFIED only)
 *   }
 * }
 */

// ─────────────────────────────────────────────────────────────────────────────
// Factory helpers — construct well-shaped result objects
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a successful ReviewResult (pipeline ran to completion).
 *
 * @param {Object} params
 * @param {Array}   params.findings
 * @param {boolean} params.genesisAvailable
 * @param {boolean} params.llmUsed
 * @param {string|null} params.error
 * @param {number}  params.durationMs
 * @returns {Object}
 */
export function makeReviewResult({ findings, genesisAvailable, llmUsed, error, durationMs, impact }) {
  return {
    findings:         Array.isArray(findings) ? findings : [],
    genesisAvailable: Boolean(genesisAvailable),
    llmUsed:          Boolean(llmUsed),
    error:            error || null,
    durationMs:       typeof durationMs === 'number' ? durationMs : 0,
    // Optional deterministic impact summary (blast radius / dependencies) from
    // Genesis. Absent (null) when Genesis is unavailable — consumers must guard.
    impact:           impact || null,
  };
}

/**
 * Build a ReviewResult representing a fatal pipeline error
 * (e.g. input file not found, all LLM calls failed).
 *
 * @param {string} message  - Human-readable error description
 * @param {number} startMs  - process.hrtime() start timestamp for duration calc
 * @param {boolean} genesisAvailable
 * @returns {Object}
 */
export function makeErrorResult(message, startMs = Date.now(), genesisAvailable = false) {
  return makeReviewResult({
    findings:         [],
    genesisAvailable,
    llmUsed:          false,
    error:            message,
    durationMs:       Date.now() - startMs,
  });
}

/**
 * Convenience: count verified / unverified findings in a result.
 *
 * @param {Object} result - ReviewResult
 * @returns {{ verified: number, unverified: number, total: number }}
 */
export function countFindings(result) {
  const total      = result.findings.length;
  const verified   = result.findings.filter(f => f.verification?.status === 'VERIFIED').length;
  const unverified = total - verified;
  return { total, verified, unverified };
}
