#!/usr/bin/env node
/**
 * scripts/smoke-test.js
 *
 * MANUAL live smoke test for the AI PR Review engine.
 *
 * Unlike the unit suite (which mocks the LLM), this script makes REAL Groq
 * calls so you can sanity-check the actual model output — prompt quality,
 * finding precision, and the VERIFIED/UNVERIFIED split — against the built-in
 * fixtures. It is intentionally NOT part of `npm test` and never runs in CI.
 *
 * Requirements:
 *   GROQ_API_KEY must be set (in .env.local or the environment). Without it the
 *   script prints a notice and exits 0 so it is safe to invoke unconditionally.
 *
 * Usage:
 *   npm run smoke                      # runs the default fixture set
 *   node scripts/smoke-test.js         # same
 *   node scripts/smoke-test.js fixtures/vulnerable.js fixtures/quality-issues.js
 *
 * What it does:
 *   For each fixture, runs the full pipeline (both agents → validator) via
 *   reviewFile(), then prints a compact per-finding summary grouped by
 *   verification status. Exit code is 0 unless the engine could not run at all
 *   (e.g. every LLM call failed), which returns 1 so the failure is visible.
 */

import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Load .env.local for local convenience (same behaviour as the CLI).
try {
  const { config } = await import('dotenv');
  const envLocal = resolve(REPO_ROOT, '.env.local');
  if (existsSync(envLocal)) config({ path: envLocal });
  else config();
} catch { /* dotenv optional */ }

// Point the engine + validator at this repo so fixtures resolve.
process.env.REVIEW_REPO_ROOT = process.env.REVIEW_REPO_ROOT || REPO_ROOT;

const { reviewFile } = await import('../src/core/reviewEngine.js');

const DEFAULT_FIXTURES = [
  'fixtures/vulnerable.js',
  'fixtures/hardcoded-secrets.js',
  'fixtures/quality-issues.js',
  'fixtures/safe.js',
];

const SEV_ICON = { CRITICAL: '🔴', HIGH: '🟠', MEDIUM: '🟡', LOW: '🔵' };

function line(char = '─') { return char.repeat(64); }

async function main() {
  if (!process.env.GROQ_API_KEY) {
    console.log('ℹ  GROQ_API_KEY is not set — skipping live smoke test.');
    console.log('   Set it in .env.local to exercise the real Groq/LLM path.');
    process.exit(0);
  }

  const argv = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const fixtures = argv.length > 0 ? argv : DEFAULT_FIXTURES;

  console.log(line('═'));
  console.log(' AI PR REVIEW — LIVE SMOKE TEST (real Groq calls)');
  console.log(line('═'));
  console.log(` Repo root : ${REPO_ROOT}`);
  console.log(` Fixtures  : ${fixtures.length}`);
  console.log('');

  let totalFindings = 0;
  let totalVerified = 0;
  let anyLlmUsed = false;
  const perFixture = [];

  for (const fixture of fixtures) {
    const abs = resolve(REPO_ROOT, fixture);
    if (!existsSync(abs)) {
      console.log(`⚠  Skipping missing fixture: ${fixture}`);
      continue;
    }

    process.stdout.write(`Reviewing ${fixture} ... `);
    const result = await reviewFile(fixture, REPO_ROOT);
    anyLlmUsed = anyLlmUsed || result.llmUsed;

    const verified = result.findings.filter(f => f.verification?.status === 'VERIFIED').length;
    totalFindings += result.findings.length;
    totalVerified += verified;
    perFixture.push({ fixture, result, verified });

    console.log(`${result.findings.length} finding(s), ${verified} verified` +
      (result.error ? `  [error: ${result.error}]` : ''));
  }

  console.log('');
  for (const { fixture, result } of perFixture) {
    if (result.findings.length === 0) continue;
    console.log(line());
    console.log(`FILE: ${fixture}`);
    result.findings.forEach((f, i) => {
      const icon   = SEV_ICON[f.severity] || '⚪';
      const verify = f.verification?.status === 'VERIFIED' ? '✅ VERIFIED' : '❌ UNVERIFIED';
      const span   = f.endLine && f.endLine > f.line ? `${f.line}-${f.endLine}` : `${f.line}`;
      console.log(`  #${i + 1} ${icon} ${f.severity}  ${f.type}  (${verify})`);
      console.log(`     ${fixture}:${span}`);
      console.log(`     evidence: ${String(f.evidence).slice(0, 100)}`);
      if (f.verification?.status === 'UNVERIFIED') {
        console.log(`     reason:   ${f.verification.reason}`);
      }
    });
    console.log('');
  }

  console.log(line('═'));
  console.log(` SUMMARY: ${totalFindings} findings, ${totalVerified} verified, ` +
    `${totalFindings - totalVerified} unverified across ${perFixture.length} file(s)`);
  console.log(line('═'));

  // Fail only if the engine never managed to use the LLM at all.
  process.exit(anyLlmUsed ? 0 : 1);
}

main().catch(err => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
