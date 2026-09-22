#!/usr/bin/env node
/**
 * src/cli/index.js
 *
 * CLI entry point for local development and GitHub Actions.
 *
 * Usage (local — file-based):
 *   npm run ai-review -- fixtures/vulnerable.js
 *   npm run ai-review -- fixtures/safe.js
 *   npm run ai-review:test                          # reviews fixtures/vulnerable.js
 *
 * Usage (GitHub Actions — PR diff, preferred):
 *   node src/cli/index.js --diff-file pr-diff.txt --report-to-pr
 *
 * Usage (GitHub Actions — file list, legacy):
 *   node src/cli/index.js --files-from changed-files.txt --report-to-pr
 *   node src/cli/index.js --files src/users.js src/api.js
 *
 * --diff-file <path>
 *   Read a unified diff from a file and pass it to reviewDiff().
 *   This is the preferred path for GitHub PR review because the LLM receives
 *   only what actually changed, not entire source files.
 *
 * --files-from <path>
 *   Read a newline-separated list of file paths and pass them to reviewFiles().
 *   Kept for backward-compatibility with local or file-based review.
 *
 * Environment variables:
 *   GROQ_API_KEY        — required for LLM analysis
 *   REVIEW_REPO_ROOT    — root of the repository being reviewed
 *                         (set automatically by the reusable workflow to GITHUB_WORKSPACE)
 *   GITHUB_TOKEN        — required only when --report-to-pr is used
 *   PR_NUMBER           — required when --report-to-pr is used
 *   PR_REPO_OWNER       — required when --report-to-pr is used
 *   PR_REPO_NAME        — required when --report-to-pr is used
 *
 * Exit codes:
 *   0  — review completed (findings may be present — they are informational)
 *   1  — fatal error (no input, all LLM calls failed, missing required args)
 */

import { readFileSync, existsSync } from 'fs';
import { resolve }                  from 'path';

const SEV_ICON = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🔵' };

// Load .env.local for local development convenience
try {
  const { config } = await import('dotenv');
  const envLocal   = resolve(process.cwd(), '.env.local');
  if (existsSync(envLocal)) config({ path: envLocal });
  else config();
} catch { /* dotenv is optional */ }

import { reviewFiles, reviewDiff, classifyFiles } from '../core/reviewEngine.js';
import { reportToPR }                              from '../reporting/githubReporter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Parse CLI arguments
// ─────────────────────────────────────────────────────────────────────────────

const args         = process.argv.slice(2);
const filePaths    = [];
let filesFrom      = null;
let diffFile       = null;
let reportToPRFlag = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--files-from' && args[i + 1]) {
    filesFrom = args[++i];
  } else if (args[i] === '--diff-file' && args[i + 1]) {
    diffFile = args[++i];
  } else if (args[i] === '--files') {
    filePaths.push(...args.slice(i + 1).filter(a => !a.startsWith('--')));
    break;
  } else if (args[i] === '--report-to-pr') {
    reportToPRFlag = true;
  } else if (!args[i].startsWith('--')) {
    filePaths.push(args[i]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers (defined before use — hoisting does not apply to const/let)
// ─────────────────────────────────────────────────────────────────────────────

function printBanner() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║              AI PR CODE REVIEW                      ║');
  console.log('║  Genesis · Security · Quality · Groq/LLM · Validator ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
}

function printFileResult(label, result) {
  const { findings, llmUsed, genesisAvailable, error, durationMs } = result;
  const verified   = findings.filter(f => f.verification?.status === 'VERIFIED').length;
  const unverified = findings.length - verified;

  console.log(`${'─'.repeat(62)}`);
  console.log(`FILE: ${label}`);
  console.log(`  Genesis available : ${genesisAvailable ? '✓' : '✗'}`);
  console.log(`  LLM used          : ${llmUsed   ? '✓ yes' : '✗ no'}`);
  console.log(`  Duration          : ${durationMs}ms`);
  console.log(`  Findings          : ${findings.length} (${verified} verified, ${unverified} unverified)`);

  if (error) console.log(`  ⚠  Error          : ${error}`);

  if (findings.length === 0) {
    console.log('  ✅ No findings.');
    return;
  }

  console.log('');

  findings.forEach((f, i) => {
    const icon   = SEV_ICON[f.severity] || '⚪';
    const verify = f.verification?.status === 'VERIFIED' ? '✅ VERIFIED' : '❌ UNVERIFIED';

    console.log(`  Finding #${i + 1}`);
    console.log(`    Type         : ${f.type}`);
    console.log(`    Severity     : ${icon} ${f.severity}`);
    console.log(`    Confidence   : ${f.confidence}`);
    console.log(`    File         : ${f.file}`);
    console.log(`    Line         : ${f.endLine && f.endLine > f.line ? `${f.line}-${f.endLine}` : f.line}`);
    console.log(`    Evidence     : ${f.evidence}`);
    if (Array.isArray(f.alsoFlaggedAs) && f.alsoFlaggedAs.length > 0) {
      console.log(`    Also flagged : ${f.alsoFlaggedAs.join(', ')}`);
    }
    console.log(`    Explanation  : ${f.explanation}`);
    console.log(`    Verification : ${verify}`);
    if (f.verification?.status === 'UNVERIFIED') {
      console.log(`    Reason       : ${f.verification.reason}`);
    }
    if (f.verification?.status === 'VERIFIED' && f.verification.sourceLine) {
      console.log(`    Source line  : ${f.verification.sourceLine}`);
    }
    console.log('');
  });
}

function printSummary(allResults, skipped) {
  const totalFindings = allResults.reduce((s, r) => s + r.result.findings.length, 0);
  const totalVerified = allResults.reduce(
    (s, r) => s + r.result.findings.filter(f => f.verification?.status === 'VERIFIED').length, 0
  );
  const totalCritical = allResults.reduce(
    (s, r) => s + r.result.findings.filter(f => f.severity === 'CRITICAL').length, 0
  );
  const totalHigh     = allResults.reduce(
    (s, r) => s + r.result.findings.filter(f => f.severity === 'HIGH').length, 0
  );
  const errors        = allResults.filter(r => r.result.error).length;

  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║                    REVIEW SUMMARY                   ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log(`  Files reviewed  : ${allResults.length}`);
  console.log(`  Files skipped   : ${skipped.length}`);
  console.log(`  Total findings  : ${totalFindings}`);
  console.log(`  Verified        : ${totalVerified}`);
  console.log(`  Unverified      : ${totalFindings - totalVerified}`);
  console.log(`  Critical        : ${totalCritical}`);
  console.log(`  High            : ${totalHigh}`);
  if (errors > 0) console.log(`  Errors          : ${errors} file(s) had LLM/API errors`);
  if (skipped.length > 0) printSkipped(skipped);
  console.log('');
}

function printSkipped(skipped) {
  if (skipped.length === 0) return;
  console.log('');
  console.log('  Skipped files:');
  skipped.forEach(s => console.log(`    • ${s.path}  (${s.reason})`));
}

/**
 * Post results to a GitHub PR comment when --report-to-pr is set.
 * Requires PR_NUMBER, PR_REPO_OWNER, and PR_REPO_NAME env vars.
 * Non-fatal — logs a warning and continues if vars are missing.
 *
 * @param {Array<{ filePath: string, result: Object }>} allResults
 */
async function maybeReportToPR(allResults) {
  const prNumber = parseInt(process.env.PR_NUMBER,  10) || null;
  const owner    = process.env.PR_REPO_OWNER         || null;
  const repo     = process.env.PR_REPO_NAME          || null;

  if (!prNumber || !owner || !repo) {
    console.warn(
      '⚠  --report-to-pr requires PR_NUMBER, PR_REPO_OWNER, and PR_REPO_NAME env vars.\n' +
      '   Skipping GitHub PR comment.'
    );
    return;
  }

  try {
    await reportToPR({ owner, repo, prNumber, results: allResults });
  } catch (err) {
    console.error(`Error posting PR comment: ${err.message}`);
    // Non-fatal — the review output is already in the log
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

const repoRoot = process.env.REVIEW_REPO_ROOT || process.cwd();

printBanner();

if (!process.env.GROQ_API_KEY) {
  console.warn('⚠  GROQ_API_KEY is not set — LLM analysis will be skipped.');
  console.warn('   Set it in .env.local or as an environment variable.\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch A: --diff-file  (GitHub PR review — preferred)
//
// Reads a unified diff and passes it directly to reviewDiff().
// The context builder extracts targeted function-scoped snippets from the
// checked-out source; the LLM never receives entire unrelated files.
// ─────────────────────────────────────────────────────────────────────────────

if (diffFile) {
  const diffAbs = resolve(process.cwd(), diffFile);
  if (!existsSync(diffAbs)) {
    console.error(`Error: --diff-file not found: ${diffFile}`);
    process.exit(1);
  }

  const diffText = readFileSync(diffAbs, 'utf8').trim();
  if (!diffText) {
    console.log('ℹ  Diff file is empty — nothing to review.');
    process.exit(0);
  }

  console.log(`Reviewing PR diff from: ${diffFile}  (${diffText.length} chars)\n`);

  const result = await reviewDiff(diffText, repoRoot);

  // Wrap in the same shape used by the file-based path so reporting helpers
  // are shared without duplication.
  const allResults = [{ filePath: diffFile, result }];

  printFileResult(diffFile, result);
  printSummary(allResults, []);

  if (reportToPRFlag) {
    await maybeReportToPR(allResults);
  }

  // Exit 1 only when the LLM call itself failed entirely (no analysis performed)
  const failed = result.error && !result.llmUsed;
  process.exit(failed ? 1 : 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch B: --files-from / --files / positional args  (file-based, legacy)
// ─────────────────────────────────────────────────────────────────────────────

let rawPaths = [];

if (filesFrom) {
  const abs = resolve(process.cwd(), filesFrom);
  if (!existsSync(abs)) {
    console.error(`Error: --files-from file not found: ${filesFrom}`);
    process.exit(1);
  }
  rawPaths = readFileSync(abs, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('#'));
} else if (filePaths.length > 0) {
  rawPaths = filePaths;
} else {
  console.error('Error: no input specified.');
  console.error('  Usage: node src/cli/index.js <file>');
  console.error('         node src/cli/index.js --diff-file pr-diff.txt');
  console.error('         node src/cli/index.js --files-from changed-files.txt');
  console.error('         node src/cli/index.js --files src/api.js src/users.js');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Classify files (Branch B only)
// ─────────────────────────────────────────────────────────────────────────────

const { reviewable, skipped } = classifyFiles(rawPaths, repoRoot);

if (rawPaths.length === 0 || reviewable.length === 0) {
  console.log('ℹ  No reviewable JS/TS files found.');
  printSkipped(skipped);
  process.exit(0);
}

console.log(`Reviewing ${reviewable.length} file(s) from: ${repoRoot}\n`);

// ─────────────────────────────────────────────────────────────────────────────
// Run review (Branch B)
// ─────────────────────────────────────────────────────────────────────────────

const allResults = await reviewFiles(reviewable, repoRoot);

// ─────────────────────────────────────────────────────────────────────────────
// Print results to console
// ─────────────────────────────────────────────────────────────────────────────

for (const { filePath, result } of allResults) {
  printFileResult(filePath, result);
}

printSummary(allResults, skipped);

// ─────────────────────────────────────────────────────────────────────────────
// GitHub PR reporting
// ─────────────────────────────────────────────────────────────────────────────

if (reportToPRFlag) {
  await maybeReportToPR(allResults);
}

// ─────────────────────────────────────────────────────────────────────────────
// Exit code
// ─────────────────────────────────────────────────────────────────────────────

// Exit 1 only when every reviewed file had a fatal LLM error.
// Findings themselves are informational — we never exit non-zero for findings.
const allFailed =
  allResults.length > 0 &&
  allResults.every(r => r.result.error && !r.result.llmUsed);

if (allFailed) process.exit(1);
