#!/usr/bin/env node
/**
 * src/cli/index.js
 *
 * CLI entry point for local development and GitHub Actions.
 *
 * Usage (local):
 *   npm run ai-review -- fixtures/vulnerable.js
 *   npm run ai-review -- fixtures/safe.js
 *   npm run ai-review:test                          # reviews fixtures/vulnerable.js
 *
 * Usage (GitHub Actions — called by the reusable workflow):
 *   node src/cli/index.js --files-from changed-files.txt
 *   node src/cli/index.js --files src/users.js src/api.js
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

// Load .env.local for local development convenience
try {
  const { config } = await import('dotenv');
  const envLocal   = resolve(process.cwd(), '.env.local');
  if (existsSync(envLocal)) config({ path: envLocal });
  else config();
} catch { /* dotenv is optional */ }

import { reviewFiles, classifyFiles } from '../core/reviewEngine.js';
import { reportToPR }                  from '../reporting/githubReporter.js';

// ─────────────────────────────────────────────────────────────────────────────
// Parse CLI arguments
// ─────────────────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const filePaths  = [];
let filesFrom    = null;
let reportToPRFlag = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--files-from' && args[i + 1]) {
    filesFrom = args[++i];
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
// Resolve file list
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
  console.error('Error: no input files specified.');
  console.error('  Usage: node src/cli/index.js <file>');
  console.error('         node src/cli/index.js --files-from changed-files.txt');
  console.error('         node src/cli/index.js --files src/api.js src/users.js');
  process.exit(1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Classify files
// ─────────────────────────────────────────────────────────────────────────────

const repoRoot               = process.env.REVIEW_REPO_ROOT || process.cwd();
const { reviewable, skipped } = classifyFiles(rawPaths, repoRoot);

printBanner();

if (!process.env.GROQ_API_KEY) {
  console.warn('⚠  GROQ_API_KEY is not set — LLM analysis will be skipped.');
  console.warn('   Set it in .env.local or as an environment variable.\n');
}

if (rawPaths.length === 0 || reviewable.length === 0) {
  console.log('ℹ  No reviewable JS/TS files found.');
  printSkipped(skipped);
  process.exit(0);
}

console.log(`Reviewing ${reviewable.length} file(s) from: ${repoRoot}\n`);

// ─────────────────────────────────────────────────────────────────────────────
// Run review
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
// GitHub PR reporting (when called from GitHub Actions with --report-to-pr)
// ─────────────────────────────────────────────────────────────────────────────

if (reportToPRFlag) {
  const prNumber = parseInt(process.env.PR_NUMBER,     10) || null;
  const owner    = process.env.PR_REPO_OWNER            || null;
  const repo     = process.env.PR_REPO_NAME             || null;

  if (!prNumber || !owner || !repo) {
    console.warn(
      '⚠  --report-to-pr requires PR_NUMBER, PR_REPO_OWNER, and PR_REPO_NAME env vars.\n' +
      '   Skipping GitHub PR comment.'
    );
  } else {
    try {
      await reportToPR({ owner, repo, prNumber, results: allResults });
    } catch (err) {
      console.error(`Error posting PR comment: ${err.message}`);
      // Non-fatal — the review output is already in the log
    }
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────────────────

const SEV_ICON = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🔵' };

function printBanner() {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║           AI PR SECURITY REVIEW                     ║');
  console.log('║   Genesis · Security Agent · Groq/LLM · Validator   ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
}

function printFileResult(filePath, result) {
  const { findings, llmUsed, genesisAvailable, error, durationMs } = result;
  const verified   = findings.filter(f => f.verification?.status === 'VERIFIED').length;
  const unverified = findings.length - verified;

  console.log(`${'─'.repeat(62)}`);
  console.log(`FILE: ${filePath}`);
  console.log(`  Genesis available : ${genesisAvailable ? '✓' : '✗'}`);
  console.log(`  LLM used          : ${llmUsed   ? '✓ yes' : '✗ no'}`);
  console.log(`  Duration          : ${durationMs}ms`);
  console.log(`  Findings          : ${findings.length} (${verified} verified, ${unverified} unverified)`);

  if (error) console.log(`  ⚠  Error          : ${error}`);

  if (findings.length === 0) {
    console.log('  ✅ No security findings.');
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
    console.log(`    Line         : ${f.line}`);
    console.log(`    Evidence     : ${f.evidence}`);
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
