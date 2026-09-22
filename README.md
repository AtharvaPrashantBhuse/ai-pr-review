# ai-pr-review

**Central AI Pull Request Review Engine**

A reusable, repository-independent engine that reviews the changed code in a
Pull Request and posts its findings back as a PR comment. It runs two analysis
agents over the diff and verifies every finding against the actual source before
reporting it:

- **Security Agent** — SQL Injection and Hardcoded Secrets.
- **Quality Agent** — code-quality checks (dead code, duplication, logic errors,
  bug risks, error handling, maintainability, performance, API/contract). The
  Quality Agent is enabled by default and can be disabled or tuned per category.

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
| `AI_REVIEW_ENABLE_QUALITY` | No | Master switch for the Quality Agent (default on). `false`/`0`/`no`/`off` runs security only. |
| `AI_REVIEW_QUALITY_CATEGORIES` | No | Comma allow-list — run only these quality categories. |
| `AI_REVIEW_DISABLE_CATEGORIES` | No | Comma list — remove categories from the default set. |
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

The Security Agent detects two vulnerability classes today:

- **SQL Injection (`SQL_INJECTION`)** — user-controlled input concatenated or
  interpolated directly into a SQL string without parameterisation. Parameterised
  queries, prepared statements, and static SQL are treated as safe.
- **Hardcoded Secrets (`HARDCODED_SECRET`)** — real credential literals in source
  (API keys, tokens, passwords, private keys, connection strings). Environment
  reads (`process.env.*`) and obvious placeholders (`YOUR_API_KEY`, etc.) are not
  flagged.

Every finding is passed through the Evidence Validator, which confirms the file
exists, the line is within range, and the reported evidence appears in the
source. See [docs/security-agent.md](docs/security-agent.md).

---

## Basic testing instructions

```bash
# Run all tests (offline, LLM fully mocked)
npm test
```

Latest measured result: **150 tests pass** (Vitest). The suite covers SQL
Injection detection, Hardcoded Secrets detection (positive and negative cases),
the Evidence Validator (VERIFIED / UNVERIFIED paths), the Context Builder
bounding, the Quality Agent catalog and configuration, and the GitHub Reporter
formatting. No `GROQ_API_KEY` is required — all LLM responses are mocked.

For details see [docs/testing.md](docs/testing.md).

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — MVP architecture, components, two-repo setup, current vs future.
- [docs/context-management.md](docs/context-management.md) — the whole-file problem, the request-size issue, and the bounded-context solution.
- [docs/security-agent.md](docs/security-agent.md) — Security Agent, the two checks, false-positive handling, and the validator.
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
