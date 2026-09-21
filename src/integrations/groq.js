/**
 * src/integrations/groq.js
 *
 * Groq API infrastructure layer.
 *
 * Responsibility: construct and return a configured OpenAI-SDK client
 * pointed at the Groq API endpoint. Nothing more.
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
export const DEFAULT_MODEL    = 'groq/compound-mini';

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
