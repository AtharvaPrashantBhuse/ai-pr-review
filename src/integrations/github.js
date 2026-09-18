/**
 * src/integrations/github.js
 *
 * GitHub REST API integration layer.
 *
 * Responsibility: low-level HTTP calls to GitHub API only.
 * Business logic (what to post, how to format it) lives in githubReporter.js.
 *
 * Operations exposed:
 *   - postPRComment(owner, repo, prNumber, body) — create a PR comment
 *   - getPRFiles(owner, repo, prNumber)           — list files changed in a PR
 *
 * Authentication:
 *   GITHUB_TOKEN environment variable — typically the Actions-provided token
 *   (${{ secrets.GITHUB_TOKEN }}) in the CALLER repository's workflow.
 *   A Personal Access Token works too but is not required for this MVP.
 *
 * Security:
 *   - Token read from environment only — never hardcoded or logged.
 *   - TLS verification always enabled.
 *   - Proxy supported via HTTPS_PROXY / HTTP_PROXY without disabling TLS.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const GITHUB_API_BASE = 'https://api.github.com';

// ─────────────────────────────────────────────────────────────────────────────
// HTTP helper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Make an authenticated request to the GitHub REST API.
 *
 * @param {string} path     - API path, e.g. "/repos/owner/repo/issues/1/comments"
 * @param {Object} [opts]   - fetch options (method, body, etc.)
 * @returns {Promise<Object>} Parsed JSON response
 */
async function githubFetch(path, opts = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN is not set. ' +
      'The token is injected automatically by GitHub Actions. ' +
      'For local use, set GITHUB_TOKEN to a Personal Access Token with repo scope.'
    );
  }

  const url = `${GITHUB_API_BASE}${path}`;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept':        'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type':  'application/json',
    'User-Agent':    'ai-pr-review/1.0',
    ...(opts.headers || {}),
  };

  // Corporate proxy support — TLS verification stays enabled
  let fetchFn = globalThis.fetch;
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY  ||
    process.env.http_proxy  ||
    null;

  if (proxyUrl) {
    try {
      const { ProxyAgent, fetch: undiciFetch } = await import('undici');
      const dispatcher = new ProxyAgent({ uri: proxyUrl });
      fetchFn = (u, i) => undiciFetch(u, { ...i, dispatcher });
    } catch {
      // undici unavailable — fall through to global fetch
    }
  }

  const response = await fetchFn(url, {
    ...opts,
    headers,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `GitHub API error ${response.status} ${response.statusText} — ${path}\n${text}`
    );
  }

  // Some endpoints return 204 No Content
  if (response.status === 204) return null;

  return response.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Post a comment on a Pull Request.
 *
 * Uses the Issues comments endpoint (PRs are Issues in GitHub's API).
 * The comment appears in the PR conversation timeline.
 *
 * @param {string} owner    - Repository owner (org or user)
 * @param {string} repo     - Repository name
 * @param {number} prNumber - Pull Request number
 * @param {string} body     - Comment body (Markdown supported)
 * @returns {Promise<Object>} Created comment object
 */
export async function postPRComment(owner, repo, prNumber, body) {
  return githubFetch(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
    method: 'POST',
    body:   JSON.stringify({ body }),
  });
}

/**
 * List files changed in a Pull Request.
 *
 * Paginates automatically up to 300 files (3 pages × 100).
 * Sufficient for all practical PRs — very large PRs are rare.
 *
 * @param {string} owner    - Repository owner
 * @param {string} repo     - Repository name
 * @param {number} prNumber - Pull Request number
 * @returns {Promise<Array>} Array of file objects from GitHub API
 *   Each file has: { filename, status, additions, deletions, changes, ... }
 */
export async function getPRFiles(owner, repo, prNumber) {
  const allFiles = [];

  for (let page = 1; page <= 3; page++) {
    const files = await githubFetch(
      `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`
    );

    if (!Array.isArray(files) || files.length === 0) break;
    allFiles.push(...files);
    if (files.length < 100) break; // last page
  }

  return allFiles;
}

/**
 * Check whether GitHub integration is available (token present).
 * Does not make a network request.
 *
 * @returns {boolean}
 */
export function isGitHubAvailable() {
  return !!process.env.GITHUB_TOKEN;
}
