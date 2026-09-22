# Check Reference

The complete list of checks performed by the two agents. This is generated from
the catalogs, which are the single source of truth:

- Security: `src/agents/securityCatalog.js`
- Quality:  `src/agents/checkCatalog.js`

Legend: **Default** = whether the category runs out of the box. *(range)* marks
finding types that can span multiple lines (they carry an `endLine` and are
verified against the whole span).

---

## Security Agent — 49 checks across 9 categories

| Category | Default | Type | What it flags |
|---|---|---|---|
| **Injection** | on | `SQL_INJECTION` | User input concatenated/interpolated into a SQL string (non-parameterised). |
| | | `NOSQL_INJECTION` | User input into a Mongo/NoSQL query object or `$where`. |
| | | `COMMAND_INJECTION` | User input into `exec`/`spawn`/shell command strings. |
| | | `CODE_INJECTION` | `eval`, `new Function()`, dynamic `require`/`import` on user input. |
| | | `LDAP_INJECTION` | User input concatenated into an LDAP filter. |
| | | `XPATH_INJECTION` | User input concatenated into an XPath expression. |
| | | `TEMPLATE_INJECTION` | User input compiled/rendered as a server-side template (SSTI). |
| | | `HEADER_INJECTION` | CR/LF-bearing input placed into an HTTP header/response. |
| | | `LOG_INJECTION` | Unsanitised newline-bearing input written to logs (log forging). |
| **Web / Client-side** | on | `XSS` | Unescaped user input rendered to HTML. |
| | | `OPEN_REDIRECT` | Redirect target taken from user input without allow-listing. |
| | | `CSRF` | State-changing route with no CSRF/SameSite protection. |
| | | `CLICKJACKING` | Missing `X-Frame-Options` / frame-ancestors on sensitive pages. |
| | | `INSECURE_CORS` | `Access-Control-Allow-Origin: *` with credentials, or reflected origin. |
| | | `POSTMESSAGE_MISUSE` | `postMessage`/listener without an origin check. |
| **Secrets & Credentials** | on | `HARDCODED_SECRET` | Real credential literal in source (keys, tokens, passwords, PEM keys). |
| | | `WEAK_CRYPTO_KEY` | Short/predictable/hardcoded key material. |
| | | `SECRET_IN_LOG` | Credential/token written to logs or error messages. |
| | | `SECRET_IN_URL` | Token/key passed as a URL query parameter. |
| **Cryptography** | on | `WEAK_HASH` | MD5/SHA1 for passwords or integrity. |
| | | `WEAK_CIPHER` | DES/3DES/RC4, ECB mode, or too-small key sizes. |
| | | `INSECURE_RANDOM` | `Math.random()` (non-CSPRNG) for tokens/keys/IDs. |
| | | `DISABLED_CERT_VALIDATION` | `rejectUnauthorized:false`, `verify=False`, trust-all TLS. |
| | | `MISSING_TLS` | Sensitive data / credentials sent over plain `http://`. |
| | | `HARDCODED_IV_SALT` | Static/hardcoded initialisation vectors or salts. |
| **Files & Resources** | on | `PATH_TRAVERSAL` | User input used to build a filesystem path (`../`). |
| | | `SSRF` | Server request to a URL derived from user input. |
| | | `UNRESTRICTED_FILE_UPLOAD` | Upload handler with no type/extension/size validation. |
| | | `ZIP_SLIP` | Archive extraction writing outside the target directory. |
| | | `XXE` | XML parsing with external entity resolution enabled. |
| | | `INSECURE_DESERIALIZATION` *(range)* | Untrusted data into pickle/`yaml.load`/Java deserialization. |
| | | `REDOS` | User input matched against a catastrophic-backtracking regex. |
| **Data Exposure** | on | `SENSITIVE_DATA_EXPOSURE` | Secrets/PII returned in responses or serialized to the client. |
| | | `VERBOSE_ERROR` | Stack traces / internal details returned to the client. |
| | | `MASS_ASSIGNMENT` | Binding a whole request body into a model (over-posting). |
| | | `PII_LOGGING` | Logging emails, card numbers, SSNs, tokens, etc. |
| **Configuration** | on | `INSECURE_CONFIG` | Debug mode in prod, permissive defaults, default credentials. |
| | | `MISSING_SECURITY_HEADERS` | Absent CSP / HSTS / X-Content-Type-Options where expected. |
| | | `DANGEROUS_PERMISSIONS` | World-writable files, over-broad IAM/OAuth scopes. |
| | | `SUPPLY_CHAIN_RISK` | Install scripts running network/shell commands, typosquat-looking deps. |
| **Auth / Access Control** | **off** | `MISSING_AUTH_CHECK` *(range)* | Sensitive route/handler with no authentication guard. |
| | | `BROKEN_ACCESS_CONTROL` *(range)* | Object accessed by user id without ownership/role check (IDOR). |
| | | `WEAK_PASSWORD_POLICY` | Passwords stored without hashing, or weak hashing. |
| | | `INSECURE_JWT` | `alg: none`, unverified signature, secret misuse, no expiry. |
| | | `INSECURE_SESSION` | Non-rotating session IDs; cookies missing HttpOnly/Secure/SameSite. |
| | | `PRIVILEGE_ESCALATION` | Role/permission assigned from user-controlled input. |
| **API / GraphQL** | **off** | `MISSING_RATE_LIMIT` | Auth/expensive endpoints without throttling. |
| | | `GRAPHQL_INTROSPECTION` | Introspection or unbounded query depth enabled in prod. |
| | | `EXCESSIVE_DATA_EXPOSURE` | Endpoint returning far more fields than needed. |

**Off-by-default rationale:** `auth` and `api` need whole-handler/endpoint
context (often beyond the diff window) and are more false-positive prone, so
they are opt-in. Enable them via `AI_REVIEW_SECURITY_CATEGORIES`.

**Deliberately not included:** known-CVE / vulnerable-dependency detection — an
LLM cannot reliably know CVE data. Use a dedicated scanner (npm audit / OSV /
Dependabot / Snyk) for that.

---

## Quality Agent — 14 checks across 9 categories

| Category | Default | Type | What it flags |
|---|---|---|---|
| **Correctness** | on | `LOGIC_ERROR` | `=` vs `===`, off-by-one, always-true/false, wrong return, missing `await`. |
| | | `BUG_RISK` | Null/undefined deref, out-of-bounds access, use-before-def. |
| **Dead Code** | on | `DEAD_CODE` | Unreachable statements; unused vars/params/imports; assignments never read. |
| **Duplication** | on | `DUPLICATE_CODE` *(range)* | Copy-paste blocks that should be factored into a helper. |
| **Error Handling** | on | `ERROR_HANDLING` *(range)* | Empty/over-broad catches, swallowed errors, resources not released on error. |
| **Maintainability** | on | `MAINTAINABILITY` *(range)* | Structural smells that hurt future changes. |
| | | `COMPLEXITY` *(range)* | Over-long/deeply-nested functions; too many branches/params. |
| | | `NAMING` | Misleading or non-descriptive identifiers. |
| | | `MAGIC_NUMBER` | Unexplained literal constants that should be named. |
| | | `DOCUMENTATION` | Missing/incorrect docs on a non-trivial public function. |
| **Performance** | on | `PERFORMANCE` *(range)* | N+1 queries, work that should be hoisted, blocking sync on hot paths. |
| **API / Contract** | on | `API_CONTRACT` | Breaking public signature/return-shape changes; inconsistent error contract. |
| **Style** | **off** | `STYLE` | Readability/consistency deviations. Subjective. |
| **Test Coverage** | **off** | `TEST_COVERAGE` | New non-trivial logic added without corresponding tests. |

**Off-by-default rationale:** `style` is subjective and `test_coverage` needs
whole-PR context; both are opt-in via `AI_REVIEW_QUALITY_CATEGORIES`.

---

## Configuration summary

| Concern | Security env var | Quality env var |
|---|---|---|
| Master switch | `AI_REVIEW_ENABLE_SECURITY` | `AI_REVIEW_ENABLE_QUALITY` |
| Allow-list (only these) | `AI_REVIEW_SECURITY_CATEGORIES` | `AI_REVIEW_QUALITY_CATEGORIES` |
| Disable specific | `AI_REVIEW_DISABLE_SECURITY_CATEGORIES` | `AI_REVIEW_DISABLE_CATEGORIES` |
| Severity floor | `AI_REVIEW_SECURITY_MIN_SEVERITY` | `AI_REVIEW_QUALITY_MIN_SEVERITY` |
| Model override | `GROQ_SECURITY_MODEL` | `GROQ_QUALITY_MODEL` |

All category values are lowercase (e.g. `injection`, `correctness`). Unknown
keys are ignored with a logged warning. Severity is one of
`LOW | MEDIUM | HIGH | CRITICAL` (default `LOW`).

---

## Important caveats

- Every finding is verified against source by the deterministic Evidence
  Validator, but verification proves the **location**, not the **correctness**
  of the judgment — a VERIFIED finding can still be a false positive.
- Detection quality depends on the LLM. The test suite mocks the LLM and proves
  the pipeline; real-model precision is checked with `npm run smoke`.
- These are the checks the agents are prompted and configured to find. Coverage
  and accuracy vary by language and by how much context the diff provides.
