# ai-pr-review

**Central AI Pull Request Review Engine**

A reusable, repository-independent engine that reviews the changed code in a
Pull Request and posts its findings back as a PR comment. It runs two analysis
agents over the diff and verifies every finding against the actual source before
reporting it:

- **Security Agent** — a full security catalog: injection (SQL, command, code, etc.), web (XSS, CSRF, CORS…), secrets, cryptography, files/resources (path traversal, SSRF, deserialization…), data exposure, and configuration. Auth and API checks are available but off by default. Category-toggleable.
- **Quality Agent** — code-quality checks (dead code, duplication, logic errors,
  bug risks, error handling, maintainability, performance, API/contract). The
  Quality Agent is enabled by default and can be disabled or tuned per category.
- **Testing Agent** — test-quality checks (coverage gaps, weak/missing
  assertions, flakiness, test hygiene like stray `.only`, mocking issues, and
  async-assertion correctness). Enabled by default; isolation and test-smell
  checks are available but off by default.

The engine uses [Groq](https://console.groq.com) for LLM inference and a
deterministic **Evidence Validator** that never trusts LLM output alone — a
finding is only reported as VERIFIED when it matches the checked-out source.

> **Genesis status:** Genesis repository intelligence is an *optional* input.
> It is only used when a `.genesis/index` is present in the repository under
> review. It is **not present in this repository**, so the engine currently
> runs without Genesis context. See [docs/architecture.md](docs/architecture.md).

---

## Project purpose

Automate the first pass of peer code review on every Pull Request:

- Detect real, exploitable **SQL Injection** and exposed **Hardcoded Secrets**.
- Surface common **code-quality** problems in the changed code.
- Keep the review **trustworthy** by verifying each finding against source, so
  a confident-but-wrong LLM claim is downgraded to UNVERIFIED rather than
  reported as fact.
- Live in **one** central repository that any number of other repositories can
  call, instead of copying review code into each project.

---

## Current MVP flow

```
Pull Request (caller repository)
      │
      ▼
GitHub Actions  →  reusable workflow (reusable-review.yml)
      │
      ├─ checkout caller repo + PR diff (pr-diff.txt)
      ▼
Review Engine (src/core/reviewEngine.js)
      │
      ▼
Context Builder      → bounded prompt (PR diff + targeted source context)
      │
      ▼
Security Agent + Quality Agent  → Groq / LLM  → structured findings
      │
      ▼
Evidence Validator   → VERIFIED / UNVERIFIED (deterministic, no LLM)
      │
      ▼
GitHub Reporter      → PR comment on the caller repository
```

The engine can also run locally against a file or a diff via the CLI (below).
Full component detail is in [docs/architecture.md](docs/architecture.md).

---

## How to run the project

Requires Node.js ≥ 20.

```bash
# Install dependencies
npm install

# Review a single file (local)
npm run ai-review -- fixtures/vulnerable.js

# Review the built-in vulnerable fixture (shortcut)
npm run ai-review:test

# Run the full test suite (fully mocked — no GROQ_API_KEY required)
npm test

# Live smoke test against fixtures (REAL Groq calls; needs GROQ_API_KEY).
# No-ops safely (exit 0) when the key is absent.
npm run smoke
```

CLI entry point: `src/cli/index.js`. Supported inputs:

| Flag | Description |
|---|---|
| `<file>` | Review one or more file paths directly. |
| `--diff-file <path>` | Review a unified diff (preferred for PR review). |
| `--files-from <path>` | Review a newline-separated list of file paths. |
| `--report-to-pr` | Post the result as a PR comment (requires PR env vars). |

Local usage does not modify source files and never approves, merges, or blocks
a Pull Request.

---

## Configuration / environment variables

Copy `.env.example` to `.env.local` for local development. Do **not** commit
`.env.local` or any real credentials.

| Variable | Required | Purpose |
|---|---|---|
| `GROQ_API_KEY` | Yes (for LLM analysis) | Groq API key. Read from the environment only — never hardcoded or logged. |
| `GROQ_SECURITY_MODEL` | No | Override the model for security analysis. Default: `openai/gpt-oss-20b`. |
| `GROQ_QUALITY_MODEL` | No | Override the model for quality analysis. Falls back to `GROQ_SECURITY_MODEL`. |
| `REVIEW_REPO_ROOT` | No | Root of the repository being reviewed. Set by the workflow to the checkout path; defaults to the current working directory locally. |
| `GITHUB_TOKEN` | Only for `--report-to-pr` | Token used to post the PR comment. Provided automatically by GitHub Actions. |
| `PR_NUMBER`, `PR_REPO_OWNER`, `PR_REPO_NAME` | Only for `--report-to-pr` | Identify which PR to comment on. |
| `AI_REVIEW_ENABLE_SECURITY` | No | Master switch for the Security Agent (default on). `false`/`0`/`no`/`off` runs quality only. |
| `AI_REVIEW_SECURITY_CATEGORIES` | No | Comma allow-list — run only these security categories. |
| `AI_REVIEW_DISABLE_SECURITY_CATEGORIES` | No | Comma list — remove security categories from the default set. |
| `AI_REVIEW_SECURITY_MIN_SEVERITY` | No | Drop security findings below this severity (`LOW`\|`MEDIUM`\|`HIGH`\|`CRITICAL`; default `LOW`). |
| `AI_REVIEW_ENABLE_QUALITY` | No | Master switch for the Quality Agent (default on). `false`/`0`/`no`/`off` disables it. |
| `AI_REVIEW_QUALITY_CATEGORIES` | No | Comma allow-list — run only these quality categories. |
| `AI_REVIEW_DISABLE_CATEGORIES` | No | Comma list — remove quality categories from the default set. |
| `AI_REVIEW_ENABLE_TESTING` | No | Master switch for the Testing Agent (default on). `false`/`0`/`no`/`off` disables it. |
| `AI_REVIEW_TESTING_CATEGORIES` | No | Comma allow-list — run only these testing categories. |
| `AI_REVIEW_DISABLE_TESTING_CATEGORIES` | No | Comma list — remove testing categories from the default set. |
| `AI_REVIEW_TESTING_MIN_SEVERITY` | No | Drop testing findings below this severity (`LOW`\|`MEDIUM`\|`HIGH`\|`CRITICAL`; default `LOW`). |
| `GROQ_TESTING_MODEL` | No | Override the model for testing analysis. Falls back to `GROQ_SECURITY_MODEL`. |
| `AI_REVIEW_QUALITY_MIN_SEVERITY` | No | Drop quality findings below this severity (`LOW`\|`MEDIUM`\|`HIGH`\|`CRITICAL`; default `LOW`). |
| `AI_REVIEW_MAX_DIFF_CHARS` | No | Diff section limit (default 8000). |
| `AI_REVIEW_MAX_SOURCE_CONTEXT_CHARS` | No | Source-context limit (default 12000). |
| `AI_REVIEW_MAX_GENESIS_CONTEXT_CHARS` | No | Genesis-context limit (default 4000). |
| `AI_REVIEW_MAX_PROMPT_CHARS` | No | Total combined prompt limit (default 24000). |
| `HTTPS_PROXY` / `HTTP_PROXY` | No | Corporate proxy support. TLS verification stays enabled. |
| `NODE_EXTRA_CA_CERTS` | No | Path to a corporate CA certificate (e.g. Zscaler). |

TLS certificate verification is always enabled. `rejectUnauthorized: false` is
never set.

---

## Current security checks

The Security Agent runs a catalog of checks grouped into toggleable categories
(single source of truth: `src/agents/securityCatalog.js`):

| Category | Default | Examples |
|---|---|---|
| Injection | on | SQL, NoSQL, command, code (`eval`), LDAP, XPath, template, header, log injection |
| Web / client-side | on | XSS, open redirect, CSRF, clickjacking, insecure CORS, postMessage misuse |
| Secrets & credentials | on | hardcoded secrets, secrets in logs/URLs, weak crypto keys |
| Cryptography | on | weak hash (MD5/SHA1), weak cipher, insecure random, disabled TLS validation |
| Files & resources | on | path traversal, SSRF, unrestricted upload, zip slip, XXE, insecure deserialization, ReDoS |
| Data exposure | on | sensitive data / verbose errors, mass assignment, PII logging |
| Configuration | on | insecure config, missing security headers, dangerous permissions, supply-chain risk |
| Auth / access control | **off** | missing auth, broken access control (IDOR), insecure JWT/session, weak password policy |
| API / GraphQL | **off** | missing rate limit, GraphQL introspection, excessive data exposure |

`auth` and `api` are off by default because they need whole-handler/endpoint
context and are more prone to false positives; enable them per repo when wanted.
Categories, an allow-list, a disable-list, and a severity floor are all
configurable via environment variables (see below).

**Dependency/CVE scanning is intentionally out of scope** for the LLM — use a
dedicated scanner (npm audit / OSV / Dependabot). Every finding is passed
through the Evidence Validator, which confirms the file exists, the line/range is
valid, and the reported evidence appears in the source. See
[docs/security-agent.md](docs/security-agent.md).

## Current testing checks

The Testing Agent reviews test quality (single source of truth:
`src/agents/testingCatalog.js`):

| Category | Default | Examples |
|---|---|---|
| Test coverage | on | untested new functions, untested edge/error paths |
| Assertions | on | tests with no assertion, weak assertions, assertion-on-mock, snapshot overuse |
| Flakiness | on | time/randomness/order dependence, real network in unit tests, races |
| Test hygiene | on | stray `.only`/`.skip`, empty/commented-out/duplicate tests, poor names |
| Mocking | on | unrestored mocks, over-mocking, missing mock cleanup |
| Async correctness | on | un-awaited async assertions, unreturned promises, missing `done()` |
| Test data & isolation | **off** | shared mutable fixtures, hardcoded data, missing cleanup |
| Test smells | **off** | logic in tests, multiple concerns, testing internals, trivial tests |

**Limitation:** the engine does not run the suite or read coverage — coverage
findings are inferences from the diff, not a measured delta. See
[docs/testing-agent.md](docs/testing-agent.md).

---

## Basic testing instructions

```bash
# Run all tests (offline, LLM fully mocked)
npm test
```

Latest measured result: **163 tests pass** (Vitest). The suite covers SQL
Injection detection, Hardcoded Secrets detection (positive and negative cases),
the Evidence Validator (VERIFIED / UNVERIFIED paths), the Context Builder
bounding, the Quality Agent catalog and configuration, and the GitHub Reporter
formatting. No `GROQ_API_KEY` is required — all LLM responses are mocked.

For details see [docs/testing.md](docs/testing.md).

---

## Documentation

- [docs/checks.md](docs/checks.md) — the complete list of security and quality checks, with defaults and config.
- [docs/architecture.md](docs/architecture.md) — MVP architecture, components, two-repo setup, current vs future.
- [docs/context-management.md](docs/context-management.md) — the whole-file problem, the request-size issue, and the bounded-context solution.
- [docs/security-agent.md](docs/security-agent.md) — Security Agent, the full check catalog, category config, false-positive handling, and the validator.
- [docs/quality-agent.md](docs/quality-agent.md) — Quality Agent, the code-quality catalog, category config, range findings, and the validator.
- [docs/testing-agent.md](docs/testing-agent.md) — Testing Agent, the test-quality catalog, category config, and limitations.
- [docs/testing.md](docs/testing.md) — test suite, cases, CI, and latest results.
- [CHANGELOG.md](CHANGELOG.md) — notable changes during MVP development.
- [integration.md](integration.md) — how a caller repository connects to the engine.

---

## Security notes

- Credentials are read from the environment only and are never logged.
- The engine never writes to source files and never approves, merges, blocks, or
  modifies a Pull Request. Its output is informational.
- Prompt-size diagnostics logged during a run contain character counts only —
  no source code and no secrets.
