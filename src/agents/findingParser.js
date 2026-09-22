/**
 * src/agents/findingParser.js
 *
 * Shared LLM-response parser for all analysis agents (Security, Quality).
 *
 * Both agents ask the LLM for a JSON array of findings using the same schema.
 * This module owns the single, canonical routine that turns the raw LLM text
 * into a normalised findings array so the two agents cannot drift apart.
 *
 * Responsibilities:
 *   - Strip markdown code fences the LLM sometimes wraps around its JSON.
 *   - Parse the JSON, or extract an embedded array from surrounding prose.
 *   - Coerce every field to its expected type.
 *   - Replace invalid enum values (severity / confidence) with safe defaults
 *     so downstream code never sees an unexpected shape.
 *   - Carry an optional `endLine` for range (multi-line) findings such as
 *     duplicated blocks or over-long functions. `endLine` is null for
 *     single-line findings and is never less than `line`.
 *
 * This module is deliberately type-agnostic: it does not decide WHICH finding
 * types are valid. Each agent filters the parsed findings down to the types it
 * owns (e.g. SQL_INJECTION for the Security Agent, DEAD_CODE for the Quality
 * Agent). Keeping the parser type-agnostic means a new agent can reuse it
 * without editing this file.
 */

const VALID_SEVERITY   = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const VALID_CONFIDENCE = new Set(['LOW', 'MEDIUM', 'HIGH']);

/**
 * Parse and normalise the raw LLM response into a validated findings array.
 *
 * @param {string} raw - Raw text response from the LLM
 * @returns {Array}    - Normalised findings array (may be empty)
 */
export function parseFindings(raw) {
  let text = (raw || '').trim();

  // Strip markdown code fences  (```json ... ``` or ``` ... ```)
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Try to extract a JSON array embedded in surrounding prose
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { return []; }
    } else {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter(f => f && typeof f === 'object')
    .map(f => {
      const line    = parseInt(f.line, 10) || 0;
      // endLine is optional. When present and valid it describes a multi-line
      // (range) finding such as a duplicated block or an over-long function.
      // It never drops below `line`; an out-of-order or absent endLine is
      // normalised to null so single-line validation stays the default.
      let endLine = parseInt(f.endLine, 10);
      endLine = Number.isFinite(endLine) && endLine >= line ? endLine : null;

      return {
        type:        String(f.type        || 'UNKNOWN').toUpperCase(),
        severity:    VALID_SEVERITY.has(String(f.severity   || '').toUpperCase())
                       ? String(f.severity).toUpperCase()    : 'LOW',
        confidence:  VALID_CONFIDENCE.has(String(f.confidence || '').toUpperCase())
                       ? String(f.confidence).toUpperCase()  : 'LOW',
        file:        String(f.file        || 'unknown'),
        line,
        endLine,
        evidence:    String(f.evidence    || ''),
        explanation: String(f.explanation || ''),
      };
    })
    .filter(f => f.type && f.file);
}
