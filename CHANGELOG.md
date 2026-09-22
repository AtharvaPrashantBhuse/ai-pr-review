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

### Testing milestones

- Fully mocked, offline test suite (`tests/review.test.js`, Vitest) — no
  `GROQ_API_KEY` required.
- Coverage for SQL Injection (positive/negative/multiple), Hardcoded Secrets
  (positive/negative/normalisation/regression/mixed), the Evidence Validator
  (VERIFIED and UNVERIFIED paths), the Context Builder bounding, the Quality
  Agent catalog/config and range validation, and the GitHub Reporter.
- Latest measured result: **150 tests passing**.
- CI (`.github/workflows/ci.yml`) runs the suite on push and pull_request.

### Documentation

- Added `docs/architecture.md`, `docs/context-management.md`,
  `docs/security-agent.md`, `docs/testing.md`, and this changelog; refreshed
  `README.md`.

### Notes

- **Genesis** repository intelligence is integrated as an optional input but is
  **inactive** in this repository (no `.genesis/index` present); reviews run
  without Genesis context.
- Future/proposed items (GitHub App, autonomous fixes, auto-merge/approve,
  dashboard) are **not implemented** — see `docs/architecture.md`.
