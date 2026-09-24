/**
 * src/reporting/githubReporter.js
 *
 * GitHub Reporter — formats and posts AI review results as PR comments.
 *
 * Responsibility: consume a ReviewResult and post a formatted Markdown
 * comment onto the Pull Request in the CALLER repository. Nothing else.
 *
 * This module does NOT:
 *   - Approve, merge, block, or modify the Pull Request.
 *   - Make any security analysis decisions.
 *   - Read or write source files.
 *
 * Architecture:
 *   Review Engine
 *        ↓  ReviewResult
 *   githubReporter.reportToPR()
 *        ├─ buildCommentBody()       → postPRComment()       (body summary)
 *        └─ buildInlineComments()    → createPullRequestReview() (per-line)
 *        ↓
 *   GitHub API  →  PR comment + inline review comments on CALLER repository
 *
 * Permissions required on the CALLER repository's GITHUB_TOKEN:
 *   pull-requests: write
 *
 * Inline comment behaviour:
 *   - A GitHub PR review (COMMENT event — never APPROVE or REQUEST_CHANGES) is
 *     created with one inline comment per VERIFIED finding whose file:line falls
 *     inside the diff (changed or context lines).
 *   - Findings whose line is NOT in the diff (e.g. pre-existing lines outside
 *     all hunks) can't receive inline comments — GitHub returns 422 for those.
 *     They remain fully described in the body summary comment.
 *   - The body summary is always posted, even when every finding gets an
 *     inline comment, so reviewers have a single consolidated view.
 *   - If inline comment creation fails (network error, missing diff, etc.) the
 *     failure is logged and the body summary is still posted — it is non-fatal.
 *
 * Cross-repository note (important):
 *   When called from the reusable workflow, the owner/repo/prNumber are
 *   passed as workflow inputs from the CALLER repository's event context.
 *   This ensures the comment is posted on the CALLER's PR, not on this
 *   (ai-pr-review) repository.
 */

import {
  postPRComment,
  getPR,
  createPullRequestReview,
  listIssueComments,
  updateIssueComment,
  listReviewComments,
  deleteReviewComment,
  isGitHubAvailable,
} from '../integrations/github.js';
import { categoryMetaForType }              from '../agents/checkCatalog.js';
import {
  ALL_SECURITY_TYPES,
  securityCategoryMetaForType,
} from '../agents/securityCatalog.js';
import {
  ALL_TESTING_TYPES,
  testingCategoryMetaForType,
} from '../agents/testingCatalog.js';
import { buildInDiffLineMap }               from '../core/contextBuilder.js';

// ─────────────────────────────────────────────────────────────────────────────
// Severity icons — Unicode works in GitHub Markdown
// ─────────────────────────────────────────────────────────────────────────────

const SEV_ICON = {
  CRITICAL: '🔴',
  HIGH:     '🟠',
  MEDIUM:   '🟡',
  LOW:      '🔵',
};

// ─────────────────────────────────────────────────────────────────────────────
// Hidden markers — invisible in rendered Markdown, used for update-in-place.
// GitHub renders HTML comments as nothing, so these never appear to the reader
// but let the tool recognise its own prior comments on a re-run.
// ─────────────────────────────────────────────────────────────────────────────

export const SUMMARY_MARKER = '<!-- ai-pr-review:summary -->';
export const INLINE_MARKER  = '<!-- ai-pr-review:inline -->';

/**
 * Display category ("<icon> <label>") for a finding type.
 *
 * Security types resolve through the security catalog to their specific
 * category (Injection, Web, Crypto, …) and are prefixed with "Security:" so
 * they read as a security concern. Quality types resolve through the quality
 * catalog. Either way a new category shows up here automatically.
 *
 * @param {string} type
 * @returns {string}
 */
function categoryOf(type) {
  if (ALL_SECURITY_TYPES.has(type)) {
    const meta = securityCategoryMetaForType(type);
    return `${meta.icon} Security: ${meta.label}`;
  }
  if (ALL_TESTING_TYPES.has(type)) {
    const meta = testingCategoryMetaForType(type);
    return `${meta.icon} Testing: ${meta.label}`;
  }
  const meta = categoryMetaForType(type);
  return `${meta.icon} ${meta.label}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a ReviewResult (or array of per-file results) and post it on the
 * specified Pull Request in two complementary forms:
 *
 *   1. Inline review comments — one comment anchored to each finding's line
 *      in the diff. Only VERIFIED findings whose file:line are inside the diff
 *      receive an inline comment (GitHub rejects out-of-diff lines with 422).
 *      All inline comments are submitted in a single PR Review (COMMENT event).
 *
 *   2. Body summary comment — the existing full-detail summary that lists
 *      every finding regardless of in-diff status. Always posted.
 *
 * Update-in-place (no duplicate stacking on re-runs):
 *   - The summary comment carries a hidden marker; on a re-run the prior
 *     summary is found and UPDATED in place instead of posting a new one.
 *   - Inline comments also carry a hidden marker; the tool's prior inline
 *     comments are deleted before the fresh review is posted, so lines are not
 *     annotated multiple times across pushes.
 *
 * Inline comment creation is non-fatal: if it fails (e.g. no PR diff available,
 * GitHub API error, missing commit SHA) the failure is logged and the body
 * summary is still posted so the reviewer never loses findings.
 *
 * @param {Object} params
 * @param {string}         params.owner     - Repository owner (from CALLER event)
 * @param {string}         params.repo      - Repository name  (from CALLER event)
 * @param {number}         params.prNumber  - Pull Request number (from CALLER event)
 * @param {Object|Array}   params.results   - ReviewResult OR Array<{filePath, result}>
 * @param {string}         [params.diff]    - Raw PR diff text (pr-diff.txt content).
 *                                            When provided, VERIFIED findings whose
 *                                            line is in-diff also receive an inline
 *                                            review comment. When absent, only the
 *                                            body summary is posted.
 * @returns {Promise<{ summaryComment: Object|null, review: Object|null }>}
 */
export async function reportToPR({ owner, repo, prNumber, results, diff }) {
  if (!isGitHubAvailable()) {
    console.warn(
      '[GitHubReporter] GITHUB_TOKEN is not set — skipping PR comment.\n' +
      '                 In GitHub Actions this token is injected automatically.\n' +
      '                 For local testing, set GITHUB_TOKEN to a PAT with repo scope.'
    );
    return { summaryComment: null, review: null };
  }

  if (!owner || !repo || !prNumber) {
    throw new Error(
      'reportToPR requires owner, repo, and prNumber. ' +
      'These must come from the CALLER repository event context.'
    );
  }

  // ── 1. Body summary comment (update-in-place, always posted) ──────────────
  // Find a prior summary comment from this tool (by its hidden marker) and
  // edit it in place; otherwise post a fresh one. This keeps an active PR to a
  // single, always-current summary instead of one comment per push.
  const bodyText = buildCommentBody(results);
  let summaryComment = null;

  try {
    let priorId = null;
    try {
      const existing = await listIssueComments(owner, repo, prNumber);
      const mine = existing.find(c => typeof c.body === 'string' && c.body.includes(SUMMARY_MARKER));
      priorId = mine?.id ?? null;
    } catch (err) {
      // Listing failed — fall back to posting a new comment.
      console.warn(`[GitHubReporter] Could not list prior comments: ${err.message}`);
    }

    if (priorId) {
      summaryComment = await updateIssueComment(owner, repo, priorId, bodyText);
      console.log(`[GitHubReporter] Updated summary comment #${priorId} on ${owner}/${repo}#${prNumber}`);
    } else {
      summaryComment = await postPRComment(owner, repo, prNumber, bodyText);
      console.log(`[GitHubReporter] Posted summary comment on ${owner}/${repo}#${prNumber}`);
    }
  } catch (err) {
    console.error(`[GitHubReporter] Failed to post/update summary comment: ${err.message}`);
    throw err;   // summary is the primary output — propagate this failure
  }

  // ── 2. Inline review comments (best-effort, non-fatal) ───────────────────
  let review = null;

  if (!diff || !diff.trim()) {
    console.log('[GitHubReporter] No diff provided — skipping inline comments.');
    return { summaryComment, review };
  }

  try {
    // Build the in-diff line map so we know which finding lines GitHub accepts.
    const inDiffMap = buildInDiffLineMap(diff);

    // Collect all findings across the (possibly batched) results.
    const batch       = normaliseResults(results);
    const allFindings = batch.flatMap(({ result }) => result.findings || []);

    // Only VERIFIED findings whose line is in the diff get inline comments.
    // UNVERIFIED findings may have wrong file/line, so we never try to anchor them.
    const inlineable = allFindings.filter(f => {
      if (f.verification?.status !== 'VERIFIED') return false;
      const fileLines = inDiffMap.get(f.file);
      if (!fileLines) return false;
      // For range findings use the start line; if that's not in-diff, skip.
      return fileLines.has(f.line);
    });

    if (inlineable.length === 0) {
      console.log('[GitHubReporter] No in-diff VERIFIED findings — skipping inline comments.');
      return { summaryComment, review };
    }

    // Fetch the HEAD commit SHA — required by the reviews endpoint.
    const pr       = await getPR(owner, repo, prNumber);
    const commitId = pr?.head?.sha;

    if (!commitId) {
      console.warn('[GitHubReporter] Could not read PR commit SHA — skipping inline comments.');
      return { summaryComment, review };
    }

    // Remove this tool's inline comments from a prior run so a re-review does
    // not stack duplicate line comments. Comments are identified by the hidden
    // INLINE_MARKER. Deletion is best-effort — a failure to delete one comment
    // must not prevent posting the fresh review.
    try {
      const prior = await listReviewComments(owner, repo, prNumber);
      const mine  = prior.filter(c => typeof c.body === 'string' && c.body.includes(INLINE_MARKER));
      for (const c of mine) {
        try {
          await deleteReviewComment(owner, repo, c.id);
        } catch (delErr) {
          console.warn(`[GitHubReporter] Could not delete prior inline comment #${c.id}: ${delErr.message}`);
        }
      }
      if (mine.length > 0) {
        console.log(`[GitHubReporter] Removed ${mine.length} stale inline comment(s) before re-review.`);
      }
    } catch (listErr) {
      console.warn(`[GitHubReporter] Could not list prior inline comments: ${listErr.message}`);
    }

    // Build the inline comments array.
    const comments = inlineable.map((f) => ({
      path: f.file,
      line: f.line,
      side: 'RIGHT',
      body: buildInlineCommentBody(f, allFindings.indexOf(f) + 1),
    }));

    // Post one PR review containing all inline comments.
    // event='COMMENT' — informational only; never approves or blocks the PR.
    review = await createPullRequestReview(owner, repo, prNumber, {
      commitId,
      body:     '',    // top-level review body intentionally blank — summary comment covers it
      comments,
      event:    'COMMENT',
    });

    console.log(
      `[GitHubReporter] Posted ${comments.length} inline comment(s) on ` +
      `${owner}/${repo}#${prNumber}`
    );
  } catch (err) {
    // Inline failure is non-fatal — the body summary is already posted.
    console.error(`[GitHubReporter] Inline comments failed (non-fatal): ${err.message}`);
  }

  return { summaryComment, review };
}

/**
 * Build the formatted Markdown comment body from review results.
 *
 * Accepts either:
 *   - A single ReviewResult (from a diff review)
 *   - An array of { filePath, result } objects (from a batch file review)
 *
 * @param {Object|Array} results
 * @returns {string} Markdown body
 */
export function buildCommentBody(results) {
  // Normalise to array of { filePath, result }
  const batch = normaliseResults(results);

  const allFindings = batch.flatMap(({ filePath, result }) =>
    (result.findings || []).map(f => ({ ...f, _filePath: filePath }))
  );

  const totalVerified   = allFindings.filter(f => f.verification?.status === 'VERIFIED').length;
  const totalUnverified = allFindings.length - totalVerified;
  const hasErrors       = batch.some(({ result }) => result.error && !result.llmUsed);

  const lines = [];

  // ── Header ────────────────────────────────────────────────────────────────
  // Hidden marker (first line) lets a re-run find and update this exact comment
  // instead of posting a new one.
  lines.push(SUMMARY_MARKER);
  lines.push('## 🤖 AI Code Review');
  lines.push('');
  lines.push('> **Powered by:** Genesis · Security Agent · Quality Agent · Testing Agent · Groq/LLM · Evidence Validator');
  lines.push('');

  // ── Summary ───────────────────────────────────────────────────────────────
  if (allFindings.length === 0) {
    if (hasErrors) {
      lines.push('⚠️ **Review could not complete** — LLM analysis was unavailable.');
      lines.push('');
      lines.push('Check that `GROQ_API_KEY` is configured as a repository secret.');
    } else {
      lines.push('✅ **No security or code-quality findings detected** in the changed files.');
    }
    lines.push('');
    appendImpactSection(lines, batch);
    lines.push(buildFooter(batch));
    return lines.join('\n');
  }

  lines.push(
    `**Findings: ${allFindings.length}** ` +
    `(${totalVerified} verified ✅ · ${totalUnverified} unverified ❌)`
  );
  lines.push('');
  lines.push(buildCategoryBreakdown(allFindings));
  lines.push('');
  lines.push('---');
  lines.push('');

  // ── Per-finding detail ────────────────────────────────────────────────────
  allFindings.forEach((f, i) => {
    const sevIcon  = SEV_ICON[f.severity] || '⚪';
    const verIcon  = f.verification?.status === 'VERIFIED' ? '✅ VERIFIED' : '❌ UNVERIFIED';

    lines.push(`### Finding ${i + 1}: ${f.type}`);
    lines.push('');
    lines.push(`| Field          | Value |`);
    lines.push(`|----------------|-------|`);
    const lineLabel = f.endLine && f.endLine > f.line
      ? `${f.line}–${f.endLine}`
      : `${f.line}`;

    lines.push(`| **Category**   | ${categoryOf(f.type)} |`);
    // When reconciled (e.g. vulnerability in unreachable code) show the
    // downgraded severity together with the original for transparency.
    if (f.reconciled && f.originalSeverity) {
      const origIcon = SEV_ICON[f.originalSeverity] || '⚪';
      lines.push(
        `| **Severity**   | ${sevIcon} ${f.severity} ` +
        `<sub>(downgraded from ${origIcon} ${f.originalSeverity})</sub> |`
      );
    } else {
      lines.push(`| **Severity**   | ${sevIcon} ${f.severity} |`);
    }
    lines.push(`| **Confidence** | ${f.confidence} |`);
    lines.push(`| **File**       | \`${f.file}\` |`);
    lines.push(`| **Line${f.endLine && f.endLine > f.line ? 's' : ''}**       | ${lineLabel} |`);
    if (Array.isArray(f.alsoFlaggedAs) && f.alsoFlaggedAs.length > 0) {
      lines.push(`| **Also flagged as** | ${f.alsoFlaggedAs.join(', ')} |`);
    }
    lines.push(`| **Verification** | ${verIcon} |`);
    lines.push('');

    lines.push('**Evidence**');
    lines.push('');
    lines.push('```');
    lines.push(f.evidence || '(no evidence)');
    lines.push('```');
    lines.push('');

    lines.push('**Explanation**');
    lines.push('');
    lines.push(f.explanation || '(no explanation)');
    lines.push('');

    if (f.reconciled && f.reconciliationNote) {
      lines.push(`> ℹ️ **Reconciled:** ${f.reconciliationNote}`);
      lines.push('');
    }

    if (f.verification?.status === 'VERIFIED' && f.verification.sourceLine) {
      lines.push('<details><summary>Verified source line</summary>');
      lines.push('');
      lines.push('```');
      lines.push(f.verification.sourceLine);
      lines.push('```');
      lines.push('</details>');
      lines.push('');
    }

    if (f.verification?.status === 'UNVERIFIED') {
      lines.push(
        `> ⚠️ **Could not verify against source:** ${f.verification.reason || 'unknown reason'}`
      );
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  });

  // ── Errors ────────────────────────────────────────────────────────────────
  const errorEntries = batch.filter(({ result }) => result.error);
  if (errorEntries.length > 0) {
    lines.push('### ⚠️ Errors');
    lines.push('');
    errorEntries.forEach(({ filePath, result }) => {
      lines.push(`- \`${filePath || 'unknown'}\`: ${result.error}`);
    });
    lines.push('');
  }

  appendImpactSection(lines, batch);
  lines.push(buildFooter(batch));
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the Markdown body for a single inline PR review comment.
 *
 * Kept intentionally compact — the developer is already looking at the code
 * line; they do not need the full finding table repeated here. The comment
 * gives them the category, severity, a one-line evidence snippet, the
 * explanation, and the verification status so they know whether to act on it.
 * A cross-reference to the finding number in the summary helps them navigate
 * to the full detail if they want it.
 *
 * When a single-line finding carries a `suggestedFix`, a GitHub
 * ```suggestion``` block is included so the developer can apply the corrected
 * line with one click. Range findings never get a suggestion block (GitHub
 * suggestions map to exactly the commented line).
 *
 * @param {Object} finding   - Post-validation finding (has .verification etc.)
 * @param {number} findingNo - 1-based index in the full findings list (for cross-ref)
 * @returns {string} Markdown string suitable for a GitHub review comment body
 */
export function buildInlineCommentBody(finding, findingNo) {
  const sevIcon  = SEV_ICON[finding.severity] || '⚪';
  const verBadge = finding.verification?.status === 'VERIFIED' ? '✅ VERIFIED' : '❌ UNVERIFIED';
  const category = categoryOf(finding.type);
  const lineRef  = finding.endLine && finding.endLine > finding.line
    ? `lines ${finding.line}–${finding.endLine}`
    : `line ${finding.line}`;

  const lines = [];

  // Hidden marker lets a re-run identify and remove this tool's prior inline
  // comments before posting a fresh review (avoids stacking duplicates).
  lines.push(INLINE_MARKER);

  // Compact header — category + type + severity on one line
  lines.push(
    `**${category} · ${finding.type}** &nbsp; ${sevIcon} ${finding.severity} &nbsp; ${verBadge}`
  );
  lines.push('');

  // Evidence block
  lines.push('```');
  lines.push(finding.evidence || '(no evidence)');
  lines.push('```');
  lines.push('');

  // Explanation (the most important part for the developer)
  lines.push(finding.explanation || '(no explanation)');
  lines.push('');

  // Suggested fix — a GitHub ```suggestion``` block renders a one-click
  // "Commit suggestion" button. GitHub applies a suggestion to exactly the
  // commented line, so we only emit it for SINGLE-LINE findings that carry a
  // concrete suggestedFix. Range findings (endLine > line) can't map a one-line
  // suggestion to a multi-line span, so they never get a suggestion block.
  const isSingleLine = !(finding.endLine && finding.endLine > finding.line);
  if (isSingleLine && typeof finding.suggestedFix === 'string' && finding.suggestedFix.trim()) {
    lines.push('**Suggested fix**');
    lines.push('');
    lines.push('```suggestion');
    // The suggestion body replaces the flagged line verbatim. Emit it exactly
    // as provided (already trimmed of trailing whitespace by the parser).
    lines.push(finding.suggestedFix);
    lines.push('```');
    lines.push('');
  }

  // Additional merged types, if any
  if (Array.isArray(finding.alsoFlaggedAs) && finding.alsoFlaggedAs.length > 0) {
    lines.push(`_Also flagged as: ${finding.alsoFlaggedAs.join(', ')}_`);
    lines.push('');
  }

  // Cross-reference to the summary comment
  lines.push(
    `<sub>Finding #${findingNo} · ${lineRef} · ` +
    `See the summary comment for full details.</sub>`
  );

  return lines.join('\n');
}

/**
 * Build the "Security: n · Correctness: n · ..." breakdown line, listing only
 * the categories that actually have findings so the comment stays compact.
 *
 * @param {Array} allFindings
 * @returns {string}
 */
function buildCategoryBreakdown(allFindings) {
  const counts = new Map();   // display label → count

  for (const f of allFindings) {
    const label = categoryOf(f.type);
    counts.set(label, (counts.get(label) || 0) + 1);
  }

  if (counts.size === 0) return '';

  return [...counts.entries()]
    .map(([label, n]) => `${label}: ${n}`)
    .join(' · ');
}

/**
 * Normalise the results argument into a consistent
 * Array<{ filePath: string, result: ReviewResult }> shape.
 */
function normaliseResults(results) {
  if (Array.isArray(results)) {
    // Already a batch array
    return results.map(item => ({
      filePath: item.filePath || item.file || 'unknown',
      result:   item.result  || item,
    }));
  }

  // Single ReviewResult object
  return [{ filePath: 'review', result: results }];
}

/**
 * Append the deterministic Impact Analysis section (Genesis blast radius +
 * dependencies) to the comment, if — and only if — impact data is present.
 *
 * Impact data is optional: it exists only when Genesis was active for the run.
 * When absent, this appends nothing so the comment never shows an empty or
 * broken-looking "Impact: none" block.
 *
 * The impact summary lives on each ReviewResult (`result.impact`). In a batch
 * of per-file results, several entries may each carry their own impact summary;
 * we merge the per-file records across the batch, de-duplicating by file path.
 *
 * @param {string[]} lines  - The comment lines accumulator (mutated in place)
 * @param {Array}    batch  - Normalised Array<{ filePath, result }>
 */
function appendImpactSection(lines, batch) {
  // Collect every available per-file impact record across the batch.
  const byFile = new Map();   // file path → impact record
  for (const { result } of batch) {
    const impact = result?.impact;
    if (!impact?.available || !Array.isArray(impact.files)) continue;
    for (const rec of impact.files) {
      if (rec?.file && !byFile.has(rec.file)) byFile.set(rec.file, rec);
    }
  }

  if (byFile.size === 0) return;   // no impact data — omit the section entirely

  lines.push('### 📊 Impact Analysis');
  lines.push('');
  lines.push(
    `<sub>How many files import each changed file (blast radius), from the ` +
    `Genesis dependency graph — deterministic, no LLM.</sub>`
  );
  lines.push('');

  // Sort by blast radius (highest reach first) — the changes most likely to
  // affect the rest of the codebase surface at the top.
  const records = [...byFile.values()].sort((a, b) => (b.blastRadius || 0) - (a.blastRadius || 0));

  // Compact overview table: file → how many files it impacts / depends on.
  lines.push('| Changed file | Blast radius | Depends on |');
  lines.push('|---|---|---|');
  for (const rec of records) {
    lines.push(
      `| \`${rec.file}\` | ${rec.blastRadius} file(s) | ${rec.dependsOn.length} dep(s) |`
    );
  }
  lines.push('');
  lines.push(
    `<sub>**Blast radius** = files that import the changed file (what could ` +
    `break). **Depends on** = what the changed file imports.</sub>`
  );
  lines.push('');

  // Full, expandable detail per file — nothing hidden behind un-clickable text.
  for (const rec of records) {
    const hasImpacts = rec.impactedFiles?.length > 0;
    const hasDeps    = rec.dependsOn?.length > 0;
    if (!hasImpacts && !hasDeps) continue;

    lines.push(`<details><summary><code>${rec.file}</code> — details</summary>`);
    lines.push('');

    if (hasImpacts) {
      lines.push(`**Impacted by this change (${rec.impactedFiles.length}):**`);
      rec.impactedFiles.forEach(p => lines.push(`- \`${p}\``));
      lines.push('');
    }

    if (hasDeps) {
      lines.push(`**Depends on (${rec.dependsOn.length}):**`);
      rec.dependsOn.forEach(p => lines.push(`- \`${p}\``));
      lines.push('');
    }

    lines.push('</details>');
    lines.push('');
  }

  lines.push('---');
  lines.push('');
}

/**
 * Build the footer line for the comment.
 */
function buildFooter(batch) {
  const filesReviewed = batch.length;
  const genesis = batch.some(({ result }) => result.genesisAvailable);
  const llm     = batch.some(({ result }) => result.llmUsed);

  return (
    `<sub>` +
    `Files reviewed: ${filesReviewed} · ` +
    `Genesis: ${genesis ? '✓' : '✗'} · ` +
    `LLM: ${llm ? '✓' : '✗'} · ` +
    `This review is informational only — no automated action was taken.` +
    `</sub>`
  );
}
