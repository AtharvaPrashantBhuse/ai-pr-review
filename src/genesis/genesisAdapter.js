/**
 * src/genesis/genesisAdapter.js
 *
 * Genesis repository intelligence adapter.
 *
 * Responsibility: provide structured repository context (symbols, imports,
 * dependencies, blast-radius) for files touched by a PR. This context is
 * passed to the Security Agent to enrich its LLM prompt.
 *
 * Genesis is NOT a vulnerability detector. It provides repository structure
 * and relationships. The Security Agent uses that context alongside the
 * changed source code to make better-informed security assessments.
 *
 * Architecture:
 *   Review Engine
 *        |  (list of changed files)
 *        v
 *   genesisAdapter.getContextForFiles()
 *        |
 *        v
 *   Genesis query.mjs  (loadGraph, defines, impact, callers, boundary)
 *        |
 *        v
 *   Context summary string  →  Security Agent prompt
 *
 * Key design change from the abcd-web-projecttracker MVP:
 *   The MVP hard-coded REPO_ROOT relative to __dirname (which worked
 *   because the review code lived inside the application repo).
 *   This central repository is separate — it does NOT contain the code
 *   being reviewed. The repository being reviewed is checked out by
 *   GitHub Actions into GITHUB_WORKSPACE (or a path you specify locally).
 *   REPO_ROOT is therefore resolved from:
 *     1. REVIEW_REPO_ROOT environment variable  (set by reusable workflow)
 *     2. process.cwd()                           (local CLI fallback)
 *
 * Genesis location:
 *   Genesis is a separate tool installed on the developer's machine or
 *   available as a sibling directory. This adapter uses the same discovery
 *   heuristic as the MVP:
 *     1. Read genesis.cmd / genesis shell wrapper to find the tools path.
 *     2. Fall back to $HOME/Documents/genesis-kit/tools.
 *   In CI (GitHub Actions) Genesis is optional — if the .genesis/index
 *   is not present in the checked-out repository, context is skipped
 *   gracefully and the Security Agent still runs on the raw diff.
 */

import { createRequire }            from 'module';
import { join, resolve, dirname }   from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath }            from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Resolve the root of the REPOSITORY BEING REVIEWED
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine the root of the repository currently under review.
 *
 * Priority order:
 *   1. REVIEW_REPO_ROOT env var  — set by the reusable GitHub Actions workflow
 *                                  to GITHUB_WORKSPACE (the caller's checkout)
 *   2. process.cwd()             — works for local CLI usage when the shell is
 *                                  cd'd into the repository to review
 */
function resolveRepoRoot() {
  return process.env.REVIEW_REPO_ROOT || process.cwd();
}

// ─────────────────────────────────────────────────────────────────────────────
// Locate the Genesis toolkit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Locate the genesis-kit tools directory by inspecting the genesis CLI wrapper.
 *
 * The genesis CLI is installed at one of:
 *   Windows: %USERPROFILE%\.local\bin\genesis.cmd
 *   Unix:    $HOME/.local/bin/genesis  (shell script)
 *
 * Both contain a line like:
 *   node "/path/to/genesis-kit/tools/genesis.mjs" %* / "$@"
 *
 * Parsing that line gives us the tools directory without hard-coding a path.
 * Falls back to the well-known sibling location used on the developer machine.
 */
function findGenesisKitDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '';

  // Try Windows genesis.cmd wrapper
  const cmdPath = join(home, '.local', 'bin', 'genesis.cmd');
  if (existsSync(cmdPath)) {
    const content = readFileSync(cmdPath, 'utf8');
    const match = content.match(/node\s+"([^"]+genesis\.mjs)"/i);
    if (match) return dirname(match[1]);
  }

  // Try Unix genesis shell wrapper
  const shPath = join(home, '.local', 'bin', 'genesis');
  if (existsSync(shPath)) {
    const content = readFileSync(shPath, 'utf8');
    const match = content.match(/node\s+"?([^"'\s]+genesis\.mjs)"?/i);
    if (match) return dirname(match[1]);
  }

  // Fall back to well-known development location
  return resolve(home, 'Documents', 'genesis-kit', 'tools');
}

const GENESIS_TOOLS_DIR  = findGenesisKitDir();
const GENESIS_QUERY_PATH = join(GENESIS_TOOLS_DIR, 'query.mjs');

// ─────────────────────────────────────────────────────────────────────────────
// Module-level cache  (reset between runs when repoRoot changes)
// ─────────────────────────────────────────────────────────────────────────────

let _queryModule   = null;
let _graph         = null;
let _cachedRepoRoot = null;

/** @returns {Promise<Object>} */
async function getQueryModule() {
  if (_queryModule) return _queryModule;
  if (!existsSync(GENESIS_QUERY_PATH)) {
    throw new Error(
      `Genesis query module not found at: ${GENESIS_QUERY_PATH}\n` +
      'Ensure genesis-kit is installed, or set GENESIS_TOOLS_DIR in your environment.\n' +
      'Genesis context will be skipped — the Security Agent will still run without it.'
    );
  }
  const url    = `file:///${GENESIS_QUERY_PATH.replace(/\\/g, '/')}`;
  _queryModule = await import(url);
  return _queryModule;
}

/** @returns {Promise<Object>} */
async function getGraph(repoRoot) {
  // Invalidate cache when the repo root changes (e.g. multiple reviews in one process)
  if (_graph && _cachedRepoRoot === repoRoot) return _graph;
  const q       = await getQueryModule();
  _graph        = q.loadGraph(repoRoot);
  _cachedRepoRoot = repoRoot;
  return _graph;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return all symbols defined in a file.
 *
 * @param {string} filePath  - Relative path from repo root, e.g. "src/users.js"
 * @param {string} [repoRoot]
 * @returns {Promise<Array>}
 */
export async function getSymbolsInFile(filePath, repoRoot = resolveRepoRoot()) {
  try {
    const [q, graph] = await Promise.all([getQueryModule(), getGraph(repoRoot)]);
    return q.defines(graph, filePath, { limit: 100 });
  } catch {
    return [];
  }
}

/**
 * Return the blast-radius of a file: all files that transitively import it.
 *
 * @param {string} filePath
 * @param {number} [hops=2]
 * @param {string} [repoRoot]
 * @returns {Promise<Array>}
 */
export async function getImpact(filePath, hops = 2, repoRoot = resolveRepoRoot()) {
  try {
    const [q, graph] = await Promise.all([getQueryModule(), getGraph(repoRoot)]);
    const fileId = `file:${filePath}`;
    const node   = graph.byId?.get(fileId);
    if (!node) return [];
    return q.impact(graph, node, { hops, limit: 50 });
  } catch {
    return [];
  }
}

/**
 * Return the import/export boundary of a file.
 *
 * @param {string} filePath
 * @param {string} [repoRoot]
 * @returns {Promise<Object>}
 */
export async function getBoundary(filePath, repoRoot = resolveRepoRoot()) {
  try {
    const [q, graph] = await Promise.all([getQueryModule(), getGraph(repoRoot)]);
    return q.boundary(graph, filePath, { limit: 20 });
  } catch {
    return { prefix: filePath, files: 0, symbolCount: 0, dependsOn: [], dependedOnBy: [] };
  }
}

/**
 * Primary entry point: gather all Genesis context relevant to a set of files.
 *
 * This is called by the Review Engine to enrich the Security Agent's prompt
 * with repository structure information. Genesis context is optional — if
 * the index is unavailable the returned summary is an empty string and the
 * Security Agent still runs on the raw diff alone.
 *
 * @param {string[]} filePaths  - Relative paths of changed files
 * @param {string}   [repoRoot]
 * @returns {Promise<{ files: Array, summary: string }>}
 */
export async function getContextForFiles(filePaths, repoRoot = resolveRepoRoot()) {
  const unique = [...new Set(filePaths)];

  const results = await Promise.all(
    unique.map(async (fp) => {
      const [symbols, impactList, boundary] = await Promise.all([
        getSymbolsInFile(fp, repoRoot),
        getImpact(fp, 2, repoRoot),
        getBoundary(fp, repoRoot),
      ]);
      return { file: fp, symbols, impact: impactList, boundary };
    })
  );

  return {
    files:   results,
    summary: buildContextSummary(results),
  };
}

/**
 * Check whether the Genesis index is present in the repository under review.
 * Called by the Review Engine to decide whether to attempt Genesis queries.
 *
 * @param {string} [repoRoot]
 * @returns {boolean}
 */
export function isGenesisAvailable(repoRoot = resolveRepoRoot()) {
  const graphPath = join(repoRoot, '.genesis', 'index', 'graph.json');
  return existsSync(graphPath) && existsSync(GENESIS_QUERY_PATH);
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a concise text summary of repository context for injection into the
 * Security Agent's LLM prompt. Structured plaintext rather than JSON so the
 * LLM does not have to parse it.
 *
 * @param {Array} fileContexts
 * @returns {string}
 */
function buildContextSummary(fileContexts) {
  const lines = [];

  for (const ctx of fileContexts) {
    lines.push(`## File: ${ctx.file}`);

    if (ctx.symbols?.length > 0) {
      const symNames = ctx.symbols
        .slice(0, 10)
        .map(s => `${s.kind} ${s.name} (line ${s.line})`);
      lines.push(`  Symbols defined: ${symNames.join(', ')}`);
    }

    if (ctx.boundary?.dependsOn?.length > 0) {
      const deps = ctx.boundary.dependsOn.slice(0, 5).map(d => d.target);
      lines.push(`  Depends on: ${deps.join(', ')}`);
    }

    if (ctx.impact?.length > 0) {
      const impacted = ctx.impact.slice(0, 5).map(i => i.path);
      lines.push(`  Imported by (blast radius): ${impacted.join(', ')}`);
    }
  }

  return lines.join('\n');
}
