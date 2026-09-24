/**
 * src/integrations/groq.js
 *
 * Groq API infrastructure layer.
 *
 * Responsibility: construct a configured OpenAI-SDK client pointed at the Groq
 * API endpoint, and expose a rate-limit-aware `createChatCompletion()` wrapper
 * that retries HTTP 429 / transient 5xx with exponential backoff. Agents call
 * that wrapper so a brief rate limit does not silently drop their findings.
 *
 * This module is deliberately separate from the Security Agent so that:
 *   - The Security Agent focuses on security logic, not HTTP infrastructure.
 *   - A different LLM provider can be swapped in later by changing only
 *     this file without touching any agent code.
 *
 * Architecture:
 *   Security Agent
 *        |
 *        v
 *   groq.js  ←— this file (API infrastructure)
 *        |
 *        v
 *   Groq API endpoint (https://api.groq.com/openai/v1)
 *        |
 *        v
 *   Configured LLM model
 *
 * Security requirements honoured here:
 *   - API key is read from GROQ_API_KEY environment variable only.
 *   - The key is never logged or included in error messages.
 *   - TLS certificate verification is always ENABLED (rejectUnauthorized: true).
 *   - Corporate proxy support: HTTPS_PROXY / HTTP_PROXY are honoured via
 *     undici ProxyAgent without disabling TLS verification.
 *   - For corporate CAs not trusted by Node.js (e.g. Zscaler), add the
 *     corporate root certificate via NODE_EXTRA_CA_CERTS — do NOT set
 *     rejectUnauthorized: false.
 */

import OpenAI from 'openai';

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const GROQ_BASE_URL    = 'https://api.groq.com/openai/v1';
export const DEFAULT_MODEL    = 'openai/gpt-oss-20b';

// ─────────────────────────────────────────────────────────────────────────────
// Singleton client — lazy initialisation
// ─────────────────────────────────────────────────────────────────────────────

let _client = null;

/**
 * Build and return a new OpenAI-SDK client pointed at Groq.
 *
 * Returns null when GROQ_API_KEY is absent — callers must handle this
 * gracefully rather than crashing.
 *
 * Corporate proxy support:
 *   If HTTPS_PROXY or HTTP_PROXY is set, an undici ProxyAgent is used.
 *   TLS verification is left at its default (enabled).
 *   If your corporate CA is not trusted by Node.js, configure it via:
 *     NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.crt
 *
 * @returns {Promise<OpenAI|null>}
 */
async function buildClient() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  const options = {
    apiKey,
    baseURL: GROQ_BASE_URL,
  };

  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY  ||
    process.env.http_proxy  ||
    null;

  if (proxyUrl) {
    try {
      const { ProxyAgent, fetch: undiciFetch } = await import('undici');
      // Use undici ProxyAgent with TLS verification ENABLED (default).
      // If the corporate CA is not trusted, set NODE_EXTRA_CA_CERTS instead
      // of disabling certificate verification.
      const dispatcher = new ProxyAgent({ uri: proxyUrl });
      options.fetch = (url, init) => undiciFetch(url, { ...init, dispatcher });
    } catch {
      // undici unavailable — fall through to default fetch.
      // The request may still succeed if the proxy is transparent.
    }
  }

  return new OpenAI(options);
}

/**
 * Return the cached Groq client, building it on first call.
 *
 * NOTE: The singleton is cached per-process. In tests that manipulate
 * GROQ_API_KEY mid-run, call resetClient() to force a rebuild.
 *
 * @returns {Promise<OpenAI|null>}
 */
export async function getClient() {
  if (_client) return _client;
  _client = await buildClient();
  return _client;
}

/**
 * Reset the cached client.
 * Useful in tests that alter GROQ_API_KEY between test cases.
 */
export function resetClient() {
  _client = null;
}

/**
 * Check whether the Groq client can be initialised (API key present).
 * Does not make a network request.
 *
 * @returns {boolean}
 */
export function isGroqAvailable() {
  return !!process.env.GROQ_API_KEY;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate-limit-aware chat completion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retry configuration (env-overridable):
 *   AI_REVIEW_GROQ_MAX_RETRIES     extra attempts after the first (default 3)
 *   AI_REVIEW_GROQ_RETRY_BASE_MS   base backoff in ms (default 1000)
 *   AI_REVIEW_GROQ_RETRY_CAP_MS    max single backoff in ms (default 15000)
 *
 * The engine runs three agents against Groq per review; on a free tier those
 * concurrent calls can trip the per-minute rate limit (HTTP 429). Without a
 * retry each 429 makes that agent return zero findings, so a whole class of
 * issues silently vanishes from the review. This wrapper retries 429 (and
 * transient 5xx) with exponential backoff, honouring the server's Retry-After
 * header when present, so a brief rate limit no longer drops findings.
 */
function retryConfig(env = process.env) {
  const intOr = (name, dflt) => {
    const v = parseInt(env[name], 10);
    return Number.isFinite(v) && v >= 0 ? v : dflt;
  };
  return {
    maxRetries: intOr('AI_REVIEW_GROQ_MAX_RETRIES',   3),
    baseMs:     intOr('AI_REVIEW_GROQ_RETRY_BASE_MS', 1000),
    capMs:      intOr('AI_REVIEW_GROQ_RETRY_CAP_MS',  15000),
  };
}

/** True for errors worth retrying: 429 (rate limit) and transient 5xx. */
function isRetryable(err) {
  const status = err?.status;
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

/**
 * Compute the delay before the next attempt.
 * Prefers the server's Retry-After header (seconds); otherwise exponential
 * backoff (base * 2^attempt) with a small jitter, capped at capMs.
 *
 * @param {Object} err       - the thrown error (may carry headers)
 * @param {number} attempt   - 0-based attempt index that just failed
 * @param {Object} cfg       - retryConfig()
 * @returns {number} delay in milliseconds
 */
function backoffDelayMs(err, attempt, cfg) {
  // Retry-After may live on err.headers (OpenAI SDK) as seconds.
  const retryAfterRaw =
    err?.headers?.['retry-after'] ??
    err?.headers?.get?.('retry-after') ??
    null;
  const retryAfterSec = parseInt(retryAfterRaw, 10);
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000, cfg.capMs);
  }
  const exp = cfg.baseMs * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * cfg.baseMs);
  return Math.min(exp + jitter, cfg.capMs);
}

function sleep(ms) {
  return new Promise(res => setTimeout(res, ms));
}

/**
 * Create a chat completion with automatic retry on rate-limit / transient
 * errors. All analysis agents call this instead of hitting the client
 * directly, so retry behaviour lives in exactly one place.
 *
 * On the final exhausted attempt the original error is re-thrown unchanged, so
 * each agent's existing catch block still surfaces the correct message (e.g.
 * "Groq rate limit reached").
 *
 * @param {Object} params  - OpenAI chat.completions.create params (model, messages, …)
 * @param {Object} [opts]
 * @param {Object} [opts.client]  - injectable client (tests); defaults to getClient()
 * @param {Object} [opts.config]  - injectable retry config (tests); defaults to env
 * @param {Function} [opts.onRetry] - optional callback(attempt, delayMs, err) for logging/tests
 * @returns {Promise<Object>} the completion response
 */
export async function createChatCompletion(params, opts = {}) {
  const cfg    = opts.config || retryConfig();
  const client = opts.client || await getClient();
  if (!client) {
    const err = new Error('Groq client unavailable (GROQ_API_KEY missing).');
    err.status = 401;
    throw err;
  }

  let lastErr;
  for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
    try {
      return await client.chat.completions.create(params);
    } catch (err) {
      lastErr = err;
      // Non-retryable, or out of attempts → propagate unchanged.
      if (!isRetryable(err) || attempt === cfg.maxRetries) throw err;

      const delay = backoffDelayMs(err, attempt, cfg);
      const reason = err?.status === 429 ? 'rate limit (429)' : `transient ${err?.status}`;
      console.warn(
        `[AI-Review] Groq ${reason} — retrying in ${delay}ms ` +
        `(attempt ${attempt + 1}/${cfg.maxRetries}).`
      );
      if (typeof opts.onRetry === 'function') opts.onRetry(attempt, delay, err);
      await sleep(delay);
    }
  }
  // Unreachable (loop either returns or throws), but keeps the analyser happy.
  throw lastErr;
}
