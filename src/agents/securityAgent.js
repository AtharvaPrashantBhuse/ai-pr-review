/**
 * src/agents/securityAgent.js
 *
 * Security Agent — production-grade security review across the full security
 * check catalog. Runs alongside the Quality Agent on a Pull Request.
 *
 * Categories and finding types (see securityCatalog.js for the authoritative list):
 *   Injection      → SQL/NOSQL/COMMAND/CODE/LDAP/XPATH/TEMPLATE/HEADER/LOG injection
 *   Web            → XSS, OPEN_REDIRECT, CSRF, CLICKJACKING, INSECURE_CORS, POSTMESSAGE_MISUSE
 *   Secrets        → HARDCODED_SECRET, WEAK_CRYPTO_KEY, SECRET_IN_LOG, SECRET_IN_URL
 *   Crypto         → WEAK_HASH, WEAK_CIPHER, INSECURE_RANDOM, DISABLED_CERT_VALIDATION,
 *                    MISSING_TLS, HARDCODED_IV_SALT
 *   Files/Resources→ PATH_TRAVERSAL, SSRF, UNRESTRICTED_FILE_UPLOAD, ZIP_SLIP, XXE,
 *                    INSECURE_DESERIALIZATION (range), REDOS
 *   Data Exposure  → SENSITIVE_DATA_EXPOSURE, VERBOSE_ERROR, MASS_ASSIGNMENT, PII_LOGGING
 *   Config         → INSECURE_CONFIG, MISSING_SECURITY_HEADERS, DANGEROUS_PERMISSIONS,
 *                    SUPPLY_CHAIN_RISK
 *   Auth           → MISSING_AUTH_CHECK (range), BROKEN_ACCESS_CONTROL (range),
 *                    WEAK_PASSWORD_POLICY, INSECURE_JWT, INSECURE_SESSION, PRIVILEGE_ESCALATION
 *                    (off by default)
 *   API            → MISSING_RATE_LIMIT, GRAPHQL_INTROSPECTION, EXCESSIVE_DATA_EXPOSURE
 *                    (off by default)
 *
 * Responsibility: security analysis only. This agent:
 *   1. Receives changed source code and optional repository context (Genesis).
 *   2. Builds a category-scoped, security-focused prompt limited to enabled
 *      categories so the LLM does not spend effort on disabled checks.
 *   3. Submits the prompt to the LLM via the Groq integration layer.
 *   4. Parses/normalises the structured JSON findings (shared findingParser).
 *   5. Filters findings to the enabled categories + severity floor.
 *
 * It produces the SAME finding shape as the Quality Agent (plus an optional
 * `endLine` for range findings), so findings flow unchanged through the
 * deterministic Evidence Validator, the ReviewResult contract, the CLI, and the
 * GitHub Reporter.
 *
 * It does NOT: make HTTP calls directly (groq.js), validate findings against
 * source (evidenceValidator.js), or report to GitHub (githubReporter.js).
 *
 * Deliberate scope note: dependency/CVE scanning (known-vulnerable package
 * versions) is intentionally NOT done here — that belongs to a real scanner
 * (npm audit / OSV), not an LLM. The catalog reflects checks that an LLM can
 * detect from the changed code with reasonable precision.
 *
 * Security:
 *   - GROQ_API_KEY read from environment only — never hardcoded or logged.
 *   - TLS verification always enabled (see groq.js).
 *   - LLM temperature kept low for deterministic, factual output.
 */

import { getClient, isGroqAvailable, DEFAULT_MODEL } from '../integrations/groq.js';
import { parseFindings }                             from './findingParser.js';
import {
  SECURITY_CATEGORIES,
  ALL_SECURITY_TYPES,
  resolveSecurityConfig,
  filterSecurityFindings,
} from './securityCatalog.js';

// Re-export the shared parser so existing importers of
// `securityAgent.parseFindings` keep working unchanged.
export { parseFindings };

// The full set of security finding types this agent may emit.
// (Kept as an export for the reporter / dedup category mapping.)
export const SECURITY_TYPES = ALL_SECURITY_TYPES;

// ─────────────────────────────────────────────────────────────────────────────
// Per-category prompt instruction blocks
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_INSTRUCTIONS = {
  injection: `INJECTION
Flag when untrusted input (req.query/body/params, function args, external data)
reaches a sensitive sink without proper sanitisation/parameterisation.
  SQL_INJECTION:     input concatenated/interpolated into a SQL string. Parameterised
                     queries ($1, ?, named params) and prepared statements are SAFE.
  NOSQL_INJECTION:   input placed into a Mongo/NoSQL query object or $where clause.
  COMMAND_INJECTION: input in exec/execSync/spawn/child_process/system shell strings.
  CODE_INJECTION:    eval, new Function(), setTimeout/setInterval with a string,
                     dynamic require/import driven by user input.
  LDAP_INJECTION:    input concatenated into an LDAP filter.
  XPATH_INJECTION:   input concatenated into an XPath expression.
  TEMPLATE_INJECTION:user input compiled/rendered as a server-side template (SSTI).
  HEADER_INJECTION:  input with CR/LF placed into an HTTP header/response.
  LOG_INJECTION:     unsanitised newline-bearing input written to logs (log forging).
  Do NOT flag parameterised/escaped/validated paths, or static values.`,

  web: `WEB / CLIENT-SIDE
  XSS:            unescaped user input rendered to HTML (innerHTML, document.write,
                  React dangerouslySetInnerHTML, template output without escaping).
  OPEN_REDIRECT:  redirect/location target taken from user input without allow-listing.
  CSRF:           state-changing route with no CSRF token / SameSite protection.
  CLICKJACKING:   responses without X-Frame-Options / frame-ancestors on sensitive pages.
  INSECURE_CORS:  Access-Control-Allow-Origin '*' combined with credentials, or an
                  origin reflected from the request without validation.
  POSTMESSAGE_MISUSE: window.postMessage or a message listener without an origin check.
  Do NOT flag correctly escaped output or properly validated redirects.`,

  secrets: `SECRETS & CREDENTIALS
  HARDCODED_SECRET: a real credential literal in source — API keys/tokens, passwords,
                    OAuth secrets, JWT signing secrets, cloud keys (AKIA…, AIza…, gsk_…),
                    GitHub tokens (ghp_…), PEM private keys, connection strings with a password.
                    Flag only a non-trivial literal that looks like a real credential.
  WEAK_CRYPTO_KEY:  short/predictable/hardcoded key material used for crypto.
  SECRET_IN_LOG:    a credential/token written to logs or an error message.
  SECRET_IN_URL:    a token/key passed as a URL query parameter.
  Do NOT flag process.env reads, config lookups, or obvious placeholders
  ("YOUR_API_KEY", "changeme", "test", "dummy"), or clearly non-production test values.`,

  crypto: `CRYPTOGRAPHY
  WEAK_HASH:               MD5 / SHA1 used for passwords or integrity.
  WEAK_CIPHER:             DES / 3DES / RC4, ECB mode, or too-small key sizes.
  INSECURE_RANDOM:         Math.random() (or similar non-CSPRNG) for tokens/keys/IDs/salts.
  DISABLED_CERT_VALIDATION: rejectUnauthorized:false, verify=False, NODE_TLS_REJECT_UNAUTHORIZED=0,
                           or trust-all TLS.
  MISSING_TLS:             sending credentials/sensitive data over plain http://.
  HARDCODED_IV_SALT:       static/hardcoded initialisation vectors or salts.
  Do NOT flag strong algorithms (bcrypt/scrypt/argon2, AES-GCM) used correctly.`,

  files: `FILES & RESOURCES
  PATH_TRAVERSAL:           user input used to build a filesystem path (../), unsanitised fs ops.
  SSRF:                     server makes a request to a URL derived from user input.
  UNRESTRICTED_FILE_UPLOAD: upload handler with no type/extension/size validation.
  ZIP_SLIP:                 archive extraction that writes outside the target directory.
  XXE:                      XML parsing with external entity resolution enabled.
  INSECURE_DESERIALIZATION: untrusted data into pickle/yaml.load/Java deserialization/
                            JSON reviver with side effects. [RANGE — set line/endLine to the block]
  REDOS:                    user input matched against a catastrophic-backtracking regex.
  Do NOT flag validated paths, allow-listed URLs, or safe parsers.`,

  data_exposure: `DATA EXPOSURE
  SENSITIVE_DATA_EXPOSURE: secrets/PII returned in responses, or serialized to the client.
  VERBOSE_ERROR:           stack traces / internal details returned to the client.
  MASS_ASSIGNMENT:         binding a whole request body straight into a model/entity
                           (over-posting) without an allow-list of fields.
  PII_LOGGING:             logging emails, card numbers, SSNs, tokens, or other PII.
  Do NOT flag redacted logs or explicitly whitelisted response fields.`,

  config: `CONFIGURATION
  INSECURE_CONFIG:         debug mode enabled in production, permissive defaults,
                           default/blank credentials, dangerous framework settings.
  MISSING_SECURITY_HEADERS: absent CSP / HSTS / X-Content-Type-Options where expected.
  DANGEROUS_PERMISSIONS:   world-writable files/dirs (chmod 0777), over-broad IAM/OAuth scopes.
  SUPPLY_CHAIN_RISK:       install/postinstall scripts running network/shell commands, or a
                           dependency name that looks like a typosquat of a popular package.
  Do NOT report known-CVE dependency versions — that is a scanner's job, not yours.`,

  auth: `AUTH / ACCESS CONTROL
  MISSING_AUTH_CHECK:      a sensitive route/handler with no authentication guard.
                           [RANGE — set line/endLine to the handler]
  BROKEN_ACCESS_CONTROL:   object accessed by user-supplied id without an ownership/role
                           check (IDOR). [RANGE — set line/endLine to the handler]
  WEAK_PASSWORD_POLICY:    passwords stored without hashing, or with weak hashing.
  INSECURE_JWT:            alg 'none', unverified signature, secret misuse, or no expiry check.
  INSECURE_SESSION:        non-rotating session IDs, or cookies missing HttpOnly/Secure/SameSite.
  PRIVILEGE_ESCALATION:    role/permission assigned from user-controlled input.
  Only flag when you can see the missing control in the supplied code; do not
  assume a check is absent merely because it is not in the diff window.`,

  api: `API / GRAPHQL
  MISSING_RATE_LIMIT:      auth or expensive endpoints with no throttling/rate limit.
  GRAPHQL_INTROSPECTION:   introspection enabled, or no query depth/complexity limit, in prod.
  EXCESSIVE_DATA_EXPOSURE: an endpoint returning far more fields than the client needs.
  Only flag when the concern is evident from the supplied code.`,
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompt building
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the system prompt for the currently enabled security categories.
 *
 * @param {Object} config  result of resolveSecurityConfig()
 * @returns {string}
 */
function buildSystemPrompt(config) {
  const enabledCats = SECURITY_CATEGORIES.filter(c => config.enabledCategories.has(c.key));

  // Guard: an enabled category with no instruction block would be silently
  // omitted from the prompt, leaving its types "enabled" but unguided.
  const missing = enabledCats.filter(c => !CATEGORY_INSTRUCTIONS[c.key]);
  if (missing.length > 0) {
    console.warn(
      `[AI-Review] No prompt instructions for enabled security categor` +
      `${missing.length === 1 ? 'y' : 'ies'}: ${missing.map(c => c.key).join(', ')}.`
    );
  }

  const enabledBlocks = enabledCats
    .map(c => CATEGORY_INSTRUCTIONS[c.key])
    .filter(Boolean);

  const enabledTypeList = [...config.enabledTypes].join(' | ') || '(none)';

  return `You are a meticulous senior application-security engineer performing an
automated security review of a Pull Request. Analyse the supplied source code and
repository context for the categories below.

Review ONLY these finding types: ${enabledTypeList}
Do not emit any other type.

─────────────────────────────────────────────────────────────────
SECURITY CHECK CATALOG (enabled categories only)
─────────────────────────────────────────────────────────────────
${enabledBlocks.join('\n\n─────────────────────────────────────────────────────────────────\n')}

─────────────────────────────────────────────────────────────────
SEVERITY GUIDANCE
─────────────────────────────────────────────────────────────────
- CRITICAL: a directly exploitable vulnerability with severe impact (RCE, auth bypass,
            secret/private-key exposure, injection with a clear path to data/exec).
- HIGH:     a clear, realistic exploitation path or sensitive exposure.
- MEDIUM:   a probable issue, or one whose exploitability depends on context.
- LOW:      a minor or low-confidence observation / hardening gap.

─────────────────────────────────────────────────────────────────
OUTPUT FORMAT
─────────────────────────────────────────────────────────────────
Return ONLY a valid JSON array. No markdown, no commentary, no text outside the JSON.
If no vulnerabilities are found return an empty array: []

Each finding must follow this exact schema:
{
  "type":        "<one of the enabled types above>",
  "severity":    "<LOW|MEDIUM|HIGH|CRITICAL>",
  "confidence":  "<LOW|MEDIUM|HIGH>",
  "file":        "<relative file path exactly as shown in the code, or 'unknown'>",
  "line":        <integer — 1-based start line in the file after the change>,
  "endLine":     <integer — OPTIONAL; end line for a multi-line/range finding; omit for single-line>,
  "evidence":    "<the exact vulnerable line of code (for a range, a representative line within it)>",
  "explanation": "<concise explanation of the vulnerability and the concrete risk>"
}

Rules:
- Use HIGH/CRITICAL only when there is a clear, direct exploitation or exposure path.
- "line" (and "endLine" when present) must be actual line numbers, not diff offsets.
- For RANGE types (insecure deserialization block, missing-auth handler, broken access
  control handler) include "endLine" describing the span.
- "evidence" must be a verbatim or near-verbatim copy of a real line in the reported range.
- Do NOT fabricate evidence — only report what is explicitly present in the supplied code.
- Prefer precision over recall: only report issues you are reasonably confident about.
- Do not report the same issue more than once.`;
}

/**
 * Build the user-facing prompt: Genesis context (if any) + the code to review.
 *
 * @param {string} diff
 * @param {string} repoContext
 * @returns {string}
 */
function buildUserPrompt(diff, repoContext) {
  let prompt = '';
  if (repoContext && repoContext.trim()) {
    prompt += '=== REPOSITORY CONTEXT (from Genesis index) ===\n';
    prompt += repoContext.trim();
    prompt += '\n\n';
  }
  prompt += '=== SOURCE CODE TO REVIEW ===\n';
  prompt += diff.trim();
  prompt += '\n\nAnalyse the above per the enabled security catalog. Return only a JSON array of findings.';
  return prompt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyse a code diff or file content for security vulnerabilities.
 *
 * @param {string} diff            - The changed source code or unified diff text
 * @param {string} [repoContext]   - Repository context summary from genesisAdapter
 * @param {Object} [options]
 * @param {string} [options.model]  - Override the Groq model (default: DEFAULT_MODEL)
 * @param {Object} [options.config] - Pre-resolved security config (defaults to env)
 * @returns {Promise<{ findings: Array, error: string|null, llmUsed: boolean, skipped?: boolean }>}
 */
export async function analyseForSecurity(diff, repoContext = '', options = {}) {
  const config = options.config || resolveSecurityConfig();

  // Respect the master switch defensively (the engine also gates on it).
  if (!config.enabled) {
    return { findings: [], error: null, llmUsed: false, skipped: true };
  }

  // If every category is disabled there is nothing to ask the model.
  if (config.enabledTypes.size === 0) {
    return { findings: [], error: null, llmUsed: false, skipped: true };
  }

  // Check the key at call time (not just at client-build time) so that tests
  // which delete the env var after the singleton is built get the right answer.
  if (!isGroqAvailable()) {
    return {
      findings: [],
      error:
        'GROQ_API_KEY is not set — LLM security analysis unavailable. ' +
        'Set GROQ_API_KEY in .env.local or as a GitHub repository secret.',
      llmUsed: false,
    };
  }

  const client = await getClient();
  if (!client) {
    return {
      findings: [],
      error:    'Failed to initialise Groq client — check GROQ_API_KEY and network connectivity.',
      llmUsed:  false,
    };
  }

  const model        = options.model || process.env.GROQ_SECURITY_MODEL || DEFAULT_MODEL;
  const systemPrompt = buildSystemPrompt(config);
  const userPrompt   = buildUserPrompt(diff, repoContext);

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      max_tokens:  4096,
      temperature: 0.1,  // low temperature for deterministic, factual security output
    });

    const raw = response.choices?.[0]?.message?.content || '';
    // Parse, then keep only enabled types that meet the severity floor.
    const findings = filterSecurityFindings(parseFindings(raw), config);

    return { findings, error: null, llmUsed: true };

  } catch (err) {
    if (err.status === 429) {
      return {
        findings: [],
        error:    'Groq rate limit reached. Retry after a short wait.',
        llmUsed:  false,
      };
    }
    return {
      findings: [],
      error:    `LLM call failed: ${err.message}`,
      llmUsed:  false,
    };
  }
}

/**
 * Check whether the Security Agent can operate (Groq API key configured).
 * Does not make a network request.
 *
 * @returns {boolean}
 */
export function isAgentAvailable() {
  return isGroqAvailable();
}
