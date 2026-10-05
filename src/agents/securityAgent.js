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

import { getClient, createChatCompletion, isGroqAvailable, DEFAULT_MODEL } from '../integrations/groq.js';
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
Flag when untrusted input (request parameters, function args, external data)
reaches a sensitive sink without proper sanitisation/parameterisation.
Apply to ALL languages — JavaScript/TypeScript, Java, Kotlin, Swift, Groovy, etc.
  SQL_INJECTION:     input concatenated/interpolated into a SQL string.
                     JS: string template/+ in a query. Java: Statement.execute(str),
                     JDBC string concat. Kotlin: same JDBC patterns.
                     Parameterised queries ($1, ?, named params), PreparedStatement,
                     Room @Query with bind args, and ORMs using parameter binding are SAFE.
  NOSQL_INJECTION:   input placed into a Mongo/NoSQL query object or $where clause;
                     Firestore queries built from unvalidated input.
  COMMAND_INJECTION: input in shell execution sinks — JS: exec/execSync/spawn/child_process;
                     Java/Kotlin: Runtime.exec(), ProcessBuilder with user-controlled args;
                     Swift: Process()/NSTask with unsanitised arguments.
  CODE_INJECTION:    JS: eval, new Function(), dynamic require/import from input;
                     Java/Kotlin: ScriptEngine.eval() with user content;
                     Android: loadUrl("javascript:"+input), addJavascriptInterface misuse.
  LDAP_INJECTION:    input concatenated into an LDAP filter string.
  XPATH_INJECTION:   input concatenated into an XPath expression.
  TEMPLATE_INJECTION:user input compiled/rendered as a server-side template (SSTI) —
                     Spring/Thymeleaf/FreeMarker with unsanitised model attributes.
  HEADER_INJECTION:  input with CR/LF placed into an HTTP header/response.
  LOG_INJECTION:     unsanitised newline-bearing input written to logs (log forging) —
                     applies equally to Log4j/SLF4J/Logback, os_log, NSLog, console.log.
  Do NOT flag parameterised/escaped/validated paths, or static values.`,

  web: `WEB / CLIENT-SIDE
  Applies to web backends (Spring MVC/Boot, Node/Express, etc.) and mobile WebViews.
  XSS:            unescaped user input rendered to HTML — JS: innerHTML/document.write/
                  dangerouslySetInnerHTML; server-side: Thymeleaf th:utext, unescaped
                  template vars; Android: WebView.loadDataWithBaseURL with raw HTML.
  OPEN_REDIRECT:  redirect/location target taken from user input without allow-listing —
                  Spring: HttpServletResponse.sendRedirect(param); JS: res.redirect(param).
  CSRF:           state-changing route/endpoint with no CSRF token or SameSite protection.
  CLICKJACKING:   HTTP responses without X-Frame-Options / frame-ancestors on sensitive pages.
  INSECURE_CORS:  Access-Control-Allow-Origin '*' combined with credentials, or an
                  origin reflected from the request without validation.
  POSTMESSAGE_MISUSE: window.postMessage or a message listener without an origin check;
                  Android: WebView addJavascriptInterface exposed to untrusted content.
  Do NOT flag correctly escaped output or properly validated redirects.`,

  secrets: `SECRETS & CREDENTIALS
  Applies to ALL languages and file types (Java, Kotlin, Swift, XML, Gradle, .properties).
  HARDCODED_SECRET: a real credential literal in source — API keys/tokens, passwords,
                    OAuth secrets, JWT signing secrets, cloud keys (AKIA…, AIza…, gsk_…),
                    GitHub tokens (ghp_…), PEM private keys, connection strings with password.
                    Android: hardcoded keys in strings.xml, BuildConfig fields, Gradle files.
                    iOS/Swift: hardcoded keys in Info.plist references, Swift string literals.
                    Spring Boot: plain-text passwords in application.properties/yml.
                    Flag only a non-trivial literal that looks like a real credential.
  WEAK_CRYPTO_KEY:  short/predictable/hardcoded key material used for crypto.
  SECRET_IN_LOG:    a credential/token written to logs — Log4j/SLF4J/Logback, os_log,
                    NSLog, Android Log.d/e/i, console.log.
  SECRET_IN_URL:    a token/key passed as a URL query parameter.
  Do NOT flag env var reads, config lookups via @Value/@ConfigurationProperties,
  Keychain/Keystore reads, or obvious placeholders ("YOUR_API_KEY", "changeme",
  "test", "dummy"), or clearly non-production test values.`,

  crypto: `CRYPTOGRAPHY
  Applies to ALL languages and their standard crypto libraries.
  WEAK_HASH:               MD5/SHA1 used for passwords or integrity — JS: crypto.createHash;
                           Java: MessageDigest.getInstance("MD5"/"SHA-1");
                           Swift: CC_MD5/CC_SHA1 (CommonCrypto).
  WEAK_CIPHER:             DES/3DES/RC4, ECB mode, or too-small key sizes —
                           Java: Cipher.getInstance("AES/ECB/...") or "DES/...";
                           Swift/iOS: kCCAlgorithmDES or kCCModeCBC without IV.
  INSECURE_RANDOM:         non-CSPRNG for tokens/keys/IDs/salts — JS: Math.random();
                           Java: java.util.Random (use SecureRandom instead);
                           Swift: arc4random() in a cryptographic context (use
                           SecRandomCopyBytes instead).
  DISABLED_CERT_VALIDATION: trust-all TLS — JS: rejectUnauthorized:false;
                           Java/Android: TrustManager that accepts all certs, HostnameVerifier
                           returning true unconditionally, okhttp with no cert pinning config;
                           Swift: URLSession with willSendRequestFor/didReceiveChallenge
                           always calling completionHandler(.useCredential, ...).
  MISSING_TLS:             sending credentials/sensitive data over plain http:// —
                           Android manifest cleartextTrafficPermitted="true" without a
                           network-security-config exemption; Spring: non-TLS endpoint
                           for auth routes.
  HARDCODED_IV_SALT:       static/hardcoded initialisation vectors or salts.
  Do NOT flag strong algorithms (bcrypt/scrypt/argon2, AES-GCM, SecureRandom) used correctly.`,

  files: `FILES & RESOURCES
  Applies to ALL languages.
  PATH_TRAVERSAL:           user input used to build a filesystem path (../) without
                            canonicalisation — Java: new File(base, userInput) without
                            getCanonicalPath() check; Swift: URL(fileURLWithPath:) with input.
  SSRF:                     server makes an HTTP/network request to a URL derived from
                            user input — Java: HttpURLConnection/OkHttp/RestTemplate with
                            user-supplied URL; Spring: RestTemplate.getForObject(param, ...).
  UNRESTRICTED_FILE_UPLOAD: upload handler with no type/extension/size validation —
                            Spring MultipartFile with no content-type or size check.
  ZIP_SLIP:                 archive extraction that writes outside the target directory —
                            Java: ZipEntry.getName() used to construct output path without
                            canonicalisation; Android: ZipInputStream extraction loops.
  XXE:                      XML parsing with external entity resolution enabled —
                            Java: DocumentBuilder/SAXParser/XMLInputFactory without
                            setFeature(disallow-doctype-decl, true); Android: XmlPullParser
                            is generally safe, but DOM/SAX parsers are not by default.
  INSECURE_DESERIALIZATION: untrusted data into deserialisation sinks —
                            Java: ObjectInputStream.readObject() with untrusted bytes;
                            Swift: NSKeyedUnarchiver.unarchiveObject(withData:) with
                            network data; JS: JSON reviver with side effects.
                            [RANGE — set line/endLine to the deserialisation block]
  REDOS:                    user input matched against a catastrophic-backtracking regex —
                            applies equally to java.util.regex.Pattern, Swift NSRegularExpression,
                            and JS RegExp.
  Do NOT flag validated paths, allow-listed URLs, or safe parsers.`,

  data_exposure: `DATA EXPOSURE
  SENSITIVE_DATA_EXPOSURE: secrets/PII returned in API responses, serialized to the client,
                           or written to Android SharedPreferences/iOS NSUserDefaults unencrypted.
  VERBOSE_ERROR:           stack traces / internal details returned to the client —
                           Spring Boot default error responses in prod; exception messages
                           surfaced to Android UI or iOS error alerts.
  MASS_ASSIGNMENT:         binding a whole request body straight into a model/entity without
                           an allow-list — Spring: @ModelAttribute/@RequestBody to an entity
                           class with no @JsonIgnoreProperties; JPA entity exposed directly.
  PII_LOGGING:             logging emails, card numbers, SSNs, tokens, or other PII —
                           Log4j/SLF4J/Logback, Android Log.*, os_log/NSLog, console.log.
  Do NOT flag redacted logs or explicitly whitelisted response fields.`,

  config: `CONFIGURATION
  Applies to code, XML, Gradle, .properties, YAML, and AndroidManifest.xml.
  INSECURE_CONFIG:         debug mode enabled in production (android:debuggable="true" in
                           release manifest; Spring Boot management endpoints exposed;
                           DEBUG=true in prod config); permissive defaults; default/blank
                           credentials; dangerous framework settings.
  MISSING_SECURITY_HEADERS: absent CSP / HSTS / X-Content-Type-Options on HTTP responses
                           where expected (Spring Security config).
  DANGEROUS_PERMISSIONS:   world-writable files/dirs (chmod 0777); over-broad IAM/OAuth scopes;
                           Android manifest: exported=true on sensitive Activity/Service/
                           Provider with no permission check; over-broad uses-permission
                           (READ_CONTACTS, ACCESS_FINE_LOCATION) without justification in diff.
  SUPPLY_CHAIN_RISK:       Gradle/Maven dependency with an unusual group/artifact that looks
                           like a typosquat; install/postinstall scripts (package.json) running
                           network/shell commands; dynamic dependency versions ('+' or 'latest')
                           in build.gradle that prevent reproducible builds.
  Do NOT report known-CVE dependency versions — that is a scanner's job, not yours.`,

  auth: `AUTH / ACCESS CONTROL
  Applies to all backend frameworks (Spring, Express, etc.) and mobile apps.
  MISSING_AUTH_CHECK:      a sensitive route/handler/endpoint with no authentication guard —
                           Spring: @RequestMapping method with no @PreAuthorize / Spring
                           Security filter; Android: exported Activity/ContentProvider with
                           no permission check or intent validation.
                           [RANGE — set line/endLine to the handler]
  BROKEN_ACCESS_CONTROL:   resource accessed by user-supplied id without an ownership/role
                           check (IDOR) — Spring: repository.findById(param) without verifying
                           the caller owns the record.
                           [RANGE — set line/endLine to the handler]
  WEAK_PASSWORD_POLICY:    passwords stored without hashing, or with weak hashing —
                           Java: storing plain text or MD5 password; Spring: no PasswordEncoder.
  INSECURE_JWT:            alg 'none', unverified signature, secret misuse, or no expiry check.
  INSECURE_SESSION:        non-rotating session IDs, or cookies missing HttpOnly/Secure/SameSite.
  PRIVILEGE_ESCALATION:    role/permission assigned from user-controlled input.
  Only flag when you can see the missing control in the supplied code; do not
  assume a check is absent merely because it is not in the diff window.`,

  api: `API / GRAPHQL / REST
  MISSING_RATE_LIMIT:      auth or expensive endpoints with no throttling/rate limit —
                           Spring Boot endpoint with no rate-limit filter or annotation;
                           Android API client retrying without backoff on 429.
  GRAPHQL_INTROSPECTION:   introspection enabled in prod, or no query depth/complexity limit.
  EXCESSIVE_DATA_EXPOSURE: an endpoint returning far more fields than the client needs —
                           Spring: returning a full JPA entity instead of a DTO.
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

The code may be written in any language: JavaScript, TypeScript, Java, Kotlin,
Swift, Groovy, XML, Gradle, YAML, .properties, or others. Apply the security
catalog to whatever language is present — the finding types and concepts are
language-agnostic even when the examples mention a specific language.

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
  "explanation": "<concise explanation of the vulnerability and the concrete risk>",
  "suggestedFix": "<OPTIONAL — the corrected version of the SINGLE flagged line, ready to replace it verbatim; omit for multi-line/range findings or when no safe one-line fix exists>"
}

Rules:
- Use HIGH/CRITICAL only when there is a clear, direct exploitation or exposure path.
- "line" (and "endLine" when present) must be actual line numbers, not diff offsets.
- For RANGE types (insecure deserialization block, missing-auth handler, broken access
  control handler) include "endLine" describing the span.
- "evidence" must be a verbatim or near-verbatim copy of a real line in the reported range.
- Do NOT fabricate evidence — only report what is explicitly present in the supplied code.
- "suggestedFix", when provided, must be a drop-in replacement for the single flagged
  line (same indentation), be genuinely safer, and preserve intent. Omit it entirely
  for range findings or when you are not confident a correct one-line fix exists —
  never guess a fix.
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
    // Rate-limit-aware: retries 429 / transient 5xx with backoff so a brief
    // Groq rate limit does not drop this agent's findings.
    const response = await createChatCompletion({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      max_tokens:  4096,
      temperature: 0.1,  // low temperature for deterministic, factual security output
    }, { client });

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
