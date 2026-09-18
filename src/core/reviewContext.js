/**
 * src/core/reviewContext.js
 *
 * ReviewContext — collects and normalises all inputs needed for one review run.
 *
 * The Review Engine creates a ReviewContext from the available inputs
 * (diff string, file paths, PR metadata) and passes it through the pipeline.
 * Keeping context in a structured object makes each pipeline stage testable
 * in isolation and makes it easy to add new context fields later.
 *
 * ReviewContext shape:
 * {
 *   // Input
 *   diff:          string|null    — raw diff or full file content
 *   filePaths:     string[]       — relative paths of changed files
 *   repoRoot:      string         — absolute path of the repository being reviewed
 *
 *   // PR metadata (present when called from GitHub Actions)
 *   prNumber:      number|null
 *   owner:         string|null    — repository owner (org or user)
 *   repo:          string|null    — repository name
 *
 *   // Populated during pipeline execution
 *   genesisContext: string        — summary text from Genesis adapter
 * }
 */

import { resolve } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// Default repo root  (same priority chain as evidenceValidator + genesisAdapter)
// ─────────────────────────────────────────────────────────────────────────────

function resolveDefaultRepoRoot() {
  return process.env.REVIEW_REPO_ROOT || process.cwd();
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a ReviewContext from raw inputs.
 *
 * @param {Object} params
 * @param {string}   [params.diff]       - Raw diff text or full file content
 * @param {string[]} [params.filePaths]  - Relative paths of changed files
 * @param {string}   [params.repoRoot]   - Override repository root
 * @param {number}   [params.prNumber]   - Pull Request number
 * @param {string}   [params.owner]      - Repository owner
 * @param {string}   [params.repo]       - Repository name
 * @returns {Object} ReviewContext
 */
export function makeReviewContext({
  diff       = null,
  filePaths  = [],
  repoRoot   = null,
  prNumber   = null,
  owner      = null,
  repo       = null,
} = {}) {
  return {
    diff:           diff       || null,
    filePaths:      Array.isArray(filePaths) ? filePaths : [],
    repoRoot:       repoRoot   ? resolve(repoRoot) : resolveDefaultRepoRoot(),
    prNumber:       prNumber   ? Number(prNumber)   : null,
    owner:          owner      || null,
    repo:           repo       || null,
    genesisContext: '',   // populated by Review Engine after Genesis query
  };
}
