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
 *        ↓
 *   github.js (postPRComment)
 *        ↓
 *   GitHub API  →  PR comment on CALLER repository
 *
 * Permissions required on the CALLER repository's GITHUB_TOKEN:
 *   pull-requests: write
 *
 * Cross-repository note (important):
 *   When called from the reusable workflow, the owner/repo/prNumber are
 *   passed as workflow inputs from the CALLER repository's event context.
 *   This ensures the comment is posted on the CALLER's PR, not on this
 *   (ai-pr-review) repository.
 */

import { postPRComment, isGitHubAvailable } from '../integrations/github.js';
import { categoryMetaForType }              from '../agents/checkCatalog.js';
import {
  ALL_SECURITY_TYPES,
  securityCategoryMetaForType,
} from '../agents/securityCatalog.js';

// ─────────────────────────────────────────────────────────────────────────────
// Severity icons — Unicode works in GitHub Markdown
// ─────────────────────────────────────────────────────────────────────────────

const SEV_ICON = {
  CRITICAL: '🔴',
  HIGH:     '🟠',
  MEDIUM:   '🟡',
  LOW:      '🔵',
};

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
  const meta = categoryMetaForType(type);
  return `${meta.icon} ${meta.label}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format a ReviewResult (or array of per-file results) into a Markdown comment
 * and post it on the specified Pull Request.
 *
 * @param {Object} params
 * @param {string}         params.owner     - Repository owner (from CALLER event)
 * @param {string}         params.repo      - Repository name  (from CALLER event)
 * @param {number}         params.prNumber  - Pull Request number (from CALLER event)
 * @param {Object|Array}   params.results   - ReviewResult OR Array<{filePath, result}>
 * @returns {Promise<Object|null>} The created GitHub comment object, or null on failure
 */
export async function reportToPR({ owner, repo, prNumber, results }) {
  if (!isGitHubAvailable()) {
    console.warn(
      '[GitHubReporter] GITHUB_TOKEN is not set — skipping PR comment.\n' +
      '                 In GitHub Actions this token is injected automatically.\n' +
      '                 For local testing, set GITHUB_TOKEN to a PAT with repo scope.'
    );
    return null;
  }

  if (!owner || !repo || !prNumber) {
    throw new Error(
      'reportToPR requires owner, repo, and prNumber. ' +
      'These must come from the CALLER repository event context.'
    );
  }

  const body = buildCommentBody(results);

  try {
    const comment = await postPRComment(owner, repo, prNumber, body);
    console.log(`[GitHubReporter] Posted review comment on ${owner}/${repo}#${prNumber}`);
    return comment;
  } catch (err) {
    console.error(`[GitHubReporter] Failed to post PR comment: ${err.message}`);
    throw err;
  }
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
  lines.push('## 🤖 AI Code Review');
  lines.push('');
  lines.push('> **Powered by:** Genesis · Security Agent · Quality Agent · Groq/LLM · Evidence Validator');
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
    lines.push(`| **Severity**   | ${sevIcon} ${f.severity} |`);
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

  lines.push(buildFooter(batch));
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

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
