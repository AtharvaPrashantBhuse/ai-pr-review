/**
 * src/core/findingDedup.js
 *
 * De-duplication and merging of overlapping findings.
 *
 * Both analysis agents can independently flag the SAME location. For example a
 * single line `if (age = 18)` legitimately triggers LOGIC_ERROR and MAGIC_NUMBER,
 * and a copy-pasted function is reported as both DEAD_CODE and DUPLICATE_CODE.
 * Posting all of those as separate findings is noise that erodes reviewer trust.
 *
 * This module collapses findings that refer to the same location into a single
 * primary finding, recording the other overlapping types as `alsoFlaggedAs` so
 * no information is lost. It is deterministic and does not use an LLM.
 *
 * Two findings are considered "the same location" when they are in the same
 * file and their line spans overlap. `line`..`endLine` defines a span
 * (`endLine` defaults to `line` for single-line findings).
 *
 * Merge rules within an overlapping group:
 *   - The PRIMARY finding is the one with the highest severity; ties are broken
 *     by highest confidence, then by the widest span, then by original order.
 *   - Security findings (any type in the security catalog) are NEVER dropped or
 *     merged away: a security finding is always kept as its own primary. Quality
 *     findings may merge into a security primary as `alsoFlaggedAs`, but a
 *     security finding is never demoted.
 *   - The primary keeps its own type/severity/evidence/etc. The distinct types
 *     of the merged findings are recorded on `primary.alsoFlaggedAs`.
 *
 * Reconciliation of contradictory findings:
 *   A group can contain findings that contradict each other — most importantly,
 *   a vulnerability (e.g. XSS) on a line that another finding marks as DEAD_CODE
 *   / unreachable. A critical vulnerability in code that can never execute is
 *   not exploitable as written, and reporting it as CRITICAL misleads reviewers.
 *
 *   When the primary sits in a group that also flags the span as DEAD_CODE (and
 *   the primary itself is not the DEAD_CODE finding), the primary is reconciled:
 *     - its displayed `severity` is downgraded to LOW,
 *     - the original severity is preserved on `originalSeverity`,
 *     - `reconciled: true` and a human-readable `reconciliationNote` are added.
 *   No finding is dropped and no evidence is lost — only the displayed severity
 *   and an explanatory note change.
 *
 * The function is order-stable: output order follows the primary findings'
 * first appearance in the input.
 */

import { ALL_SECURITY_TYPES } from '../agents/securityCatalog.js';

const SEVERITY_RANK   = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };
const CONFIDENCE_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3 };

// Finding type that signals a span is unreachable / has no effect.
const UNREACHABLE_TYPE = 'DEAD_CODE';

function sevRank(f)  { return SEVERITY_RANK[String(f.severity   || '').toUpperCase()] || 0; }
function confRank(f) { return CONFIDENCE_RANK[String(f.confidence || '').toUpperCase()] || 0; }
function spanStart(f) { return parseInt(f.line, 10) || 0; }
function spanEnd(f)   { const e = parseInt(f.endLine, 10); const s = spanStart(f); return Number.isFinite(e) && e >= s ? e : s; }
function isSecurity(f) { return ALL_SECURITY_TYPES.has(f.type); }

/**
 * Do two findings overlap? Same file and intersecting line spans.
 */
function overlaps(a, b) {
  if (!a.file || !b.file || a.file !== b.file) return false;
  return spanStart(a) <= spanEnd(b) && spanStart(b) <= spanEnd(a);
}

/**
 * Choose which of two findings should be the primary.
 * Security always wins over quality. Otherwise: severity, then confidence,
 * then wider span, then keep the existing one (stable).
 */
function preferred(current, candidate) {
  if (isSecurity(current) !== isSecurity(candidate)) {
    return isSecurity(current) ? current : candidate;
  }
  if (sevRank(candidate) !== sevRank(current)) {
    return sevRank(candidate) > sevRank(current) ? candidate : current;
  }
  if (confRank(candidate) !== confRank(current)) {
    return confRank(candidate) > confRank(current) ? candidate : current;
  }
  const curSpan = spanEnd(current) - spanStart(current);
  const canSpan = spanEnd(candidate) - spanStart(candidate);
  if (canSpan !== curSpan) return canSpan > curSpan ? candidate : current;
  return current;
}

/**
 * Merge overlapping findings.
 *
 * @param {Array} findings  - raw findings (pre-validation) from the agents
 * @returns {Array}         - de-duplicated findings; merged entries carry an
 *                            `alsoFlaggedAs` array of the other overlapping types
 */
export function dedupeFindings(findings) {
  if (!Array.isArray(findings) || findings.length <= 1) {
    return Array.isArray(findings) ? findings.slice() : [];
  }

  // Each group: { members: Finding[] }. We keep insertion order of groups.
  const groups = [];

  for (const finding of findings) {
    // Find an existing group this finding overlaps with.
    const group = groups.find(g => g.members.some(m => overlaps(m, finding)));
    if (group) group.members.push(finding);
    else groups.push({ members: [finding] });
  }

  return groups.map(({ members }) => {
    if (members.length === 1) return members[0];

    // Pick the primary.
    let primary = members[0];
    for (let i = 1; i < members.length; i++) primary = preferred(primary, members[i]);

    // Collect the distinct OTHER types (excluding the primary's own type).
    const alsoFlaggedAs = [
      ...new Set(
        members
          .filter(m => m !== primary)
          .map(m => m.type)
          .filter(t => t && t !== primary.type)
      ),
    ];

    let result = alsoFlaggedAs.length > 0 ? { ...primary, alsoFlaggedAs } : { ...primary };

    // Reconcile: if the span is flagged unreachable by a DIFFERENT finding and
    // the primary itself is not the dead-code finding, downgrade the primary's
    // displayed severity — a vulnerability in unreachable code is not
    // exploitable as written.
    const flaggedUnreachable = members.some(
      m => m !== primary && m.type === UNREACHABLE_TYPE
    );
    if (flaggedUnreachable && primary.type !== UNREACHABLE_TYPE) {
      result = reconcileUnreachable(result);
    }

    return result;
  });
}

/**
 * Downgrade a finding that sits in code flagged as unreachable / dead.
 * Preserves the original severity and records why the change was made.
 *
 * @param {Object} finding
 * @returns {Object} a new finding object with reconciliation metadata
 */
function reconcileUnreachable(finding) {
  // Already LOW — nothing to downgrade, but still annotate so the reader knows.
  const originalSeverity = String(finding.severity || '').toUpperCase();

  return {
    ...finding,
    severity:           'LOW',
    originalSeverity,
    reconciled:         true,
    reconciliationNote:
      `Located in code flagged as ${UNREACHABLE_TYPE} (unreachable). ` +
      `Not exploitable as written — resolve the unreachable-code issue first. ` +
      `Original severity: ${originalSeverity}.`,
  };
}
