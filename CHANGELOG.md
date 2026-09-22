# Changelog

Notable changes during MVP development. This project has not yet published
versioned releases; entries below describe the state reflected in the current
codebase and are grouped under an `Unreleased` heading.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/).

---

## [Unreleased]

### Context-size fix (bounded prompts)

- Replaced sending whole source files to the LLM with a **bounded Context
  Builder** (`src/core/contextBuilder.js`).
- The prompt is now assembled from the **PR diff** plus **targeted,
  function-scoped source snippets** around the changed lines, plus **Genesis
  context when available**.
- Added configurable character limits with defaults: diff 8,000; source context
  12,000; Genesis 4,000; total prompt 24,000
  (`AI_REVIEW_MAX_*` environment variables).
- Added prompt-size diagnostics (character counts only — no source, no secrets).
- Resolves the earlier HTTP 413 (request-too-large) failures on large files.
- Verified by Context Builder tests using `fixtures/large-file.js`
  (~10,978 bytes / 396 lines): the extracted snippet is asserted to be under 40%
  of the full file while still containing the changed function and its evidence.

### Security Agent improvements

- Security Agent (`src/agents/securityAgent.js`) analyses the bounded context
  and returns structured, normalised findings.
- Robust LLM-response parsing (shared `src/agents/findingParser.js`): strips
  markdown code fences, extracts embedded JSON arrays from prose, coerces field
  types, and defaults invalid `severity`/`confidence` values.
- Graceful degradation when `GROQ_API_KEY` is absent (no crash; clear error
  result).
- Low temperature for deterministic, factual output.
- Every finding is passed through the deterministic **Evidence Validator**, which
  never uses an LLM; findings are marked VERIFIED only when they match the
  checked-out source, otherwise UNVERIFIED with a reason.

### Hardcoded Secrets detection

- Added the **Hardcoded Secrets** check (`HARDCODED_SECRET`) alongside SQL
  Injection.
- Flags real credential literals (API keys, tokens, passwords, private keys,
  connection strings); does **not** flag environment-variable reads or obvious
  placeholders.
- Added `fixtures/hardcoded-secrets.js` with positive and negative cases (fake,
  test-only values).

### Code-quality review (Quality Agent)

- Added the **Quality Agent** (`src/agents/qualityAgent.js`) and a check catalog
  (`src/agents/checkCatalog.js`) covering correctness, dead code, duplication,
  error handling, maintainability, performance, and API/contract; style and
  test-coverage checks exist but are off by default.
- Per-category configuration via `AI_REVIEW_ENABLE_QUALITY`,
  `AI_REVIEW_QUALITY_CATEGORIES`, `AI_REVIEW_DISABLE_CATEGORIES`, and
  `AI_REVIEW_QUALITY_MIN_SEVERITY`.
- Extended the Evidence Validator to verify **range (multi-line)** findings via
  an optional `endLine`, keeping single-line behaviour unchanged.
- GitHub Reporter groups findings by category; CLI shows line ranges.
- Added `scripts/smoke-test.js` (`npm run smoke`) for a manual, `GROQ_API_KEY`-
  guarded live check against fixtures.

### Security Agent — full check catalog

- Expanded the Security Agent from two checks (SQL injection, hardcoded secrets)
  into a full, toggleable catalog (`src/agents/securityCatalog.js`) covering:
  injection (SQL/NoSQL/command/code/LDAP/XPath/template/header/log), web (XSS,
  open redirect, CSRF, clickjacking, insecure CORS, postMessage misuse), secrets
  (hardcoded, in logs/URLs, weak keys), cryptography (weak hash/cipher, insecure
  random, disabled cert validation, missing TLS, hardcoded IV/salt), files &
  resources (path traversal, SSRF, unrestricted upload, zip slip, XXE, insecure
  deserialization, ReDoS), data exposure (sensitive data, verbose errors, mass
  assignment, PII logging), and configuration (insecure config, missing security
  headers, dangerous permissions, supply-chain risk).
- `auth` (missing auth, broken access control/IDOR, insecure JWT/session, weak
  password policy, privilege escalation) and `api` (rate limit, GraphQL
  introspection, excessive data exposure) categories are available but **off by
  default** — they are context-heavy and more false-positive prone.
- Per-category configuration: `AI_REVIEW_ENABLE_SECURITY`,
  `AI_REVIEW_SECURITY_CATEGORIES` (allow-list), `AI_REVIEW_DISABLE_SECURITY_CATEGORIES`,
  `AI_REVIEW_SECURITY_MIN_SEVERITY`. Unknown category keys warn instead of
  silently disabling everything; the master switch is honoured defensively.
- The agent now uses a category-scoped prompt (only enabled categories are
  described to the model), filters results to enabled types + severity floor,
  and supports range (`endLine`) findings for block-level issues.
- Reporter now groups security findings by their specific category
  (e.g. "Security: Injection", "Security: Cryptography"); dedup treats every
  catalog type as security (security always wins over an overlapping quality
  finding).
- Deliberate scope: known-CVE / vulnerable-dependency scanning is **not** done
  by the LLM — use a dedicated scanner (npm audit / OSV / Dependabot).
- Added `fixtures/security-issues.js` (command injection, code injection, XSS,
  path traversal, weak hash, insecure random, disabled cert validation) with
  fake, test-only payloads.

### Genesis activation in CI

- The reusable workflow now checks out the Genesis toolkit and runs
  `genesis index` on the caller checkout before the review, so Genesis is
  **active in CI** with a fresh index matching the exact PR code
  (`genesisAvailable: ✓`). The step is best-effort — indexing failure falls
  back to a review without Genesis context.

### Finding de-duplication and review-quality fixes

- Added `src/core/findingDedup.js`: overlapping findings on the same file and
  line span are merged into a single primary (highest severity; security
  findings always win), with the other types recorded as `alsoFlaggedAs`.
  Wired into the Review Engine before validation; surfaced in the reporter and
  CLI. Reduces reviewer noise (e.g. one line no longer appears as separate
  LOGIC_ERROR and MAGIC_NUMBER findings).
- Quality-agent robustness fixes: warn on unknown category keys in
  `AI_REVIEW_QUALITY_CATEGORIES` / `AI_REVIEW_DISABLE_CATEGORIES` (instead of
  silently disabling everything on a typo); the Quality Agent honours the
  `AI_REVIEW_ENABLE_QUALITY` master switch defensively; the prompt builder warns
  if an enabled category has no instruction block; removed dead code and
  corrected a misleading doc comment.

### Testing milestones

- Fully mocked, offline test suite (`tests/review.test.js`, Vitest) — no
  `GROQ_API_KEY` required.
- Coverage for SQL Injection (positive/negative/multiple), Hardcoded Secrets
  (positive/negative/normalisation/regression/mixed), the Evidence Validator
  (VERIFIED and UNVERIFIED paths), the Context Builder bounding, the Quality
  Agent catalog/config and range validation, the Security Agent catalog/config,
  finding de-duplication, and the GitHub Reporter.
- Latest measured result: **188 tests passing**.
- CI (`.github/workflows/ci.yml`) runs the suite on push and pull_request.

### Documentation

- Added `docs/architecture.md`, `docs/context-management.md`,
  `docs/security-agent.md`, `docs/testing.md`, and this changelog; refreshed
  `README.md`.

### Notes

- **Genesis** repository intelligence is optional. It is **active in the
  reusable CI workflow** (a fresh index is built per PR) and inactive locally
  unless a `.genesis/index` is generated in the repository under review. This
  engine repository does not commit its own index (generated artifact).
- Future/proposed items (GitHub App, autonomous fixes, auto-merge/approve,
  dashboard) are **not implemented** — see `docs/architecture.md`.
