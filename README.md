# ai-pr-review

**Central AI Pull Request Security Review Engine**

Reusable, repository-independent engine for automated SQL Injection detection in Pull Requests. Powered by [Genesis](https://github.com/your-org/genesis-kit) for repository intelligence, [Groq](https://console.groq.com) for LLM inference, and a deterministic Evidence Validator that never trusts LLM output alone.

---

## Why two repositories?

| Repository | Role |
|---|---|
| **`ai-pr-review`** (this repo) | Central AI review engine — Security Agent, Genesis adapter, Groq integration, Evidence Validator, GitHub Reporter, reusable workflow |
| **`ai-pr-review-demo`** | Small demo/test application — calls this engine via GitHub Actions `workflow_call` |
| **`abcd-web-projecttracker`** | Existing application — can call this same engine via a one-line workflow addition |

The engine lives in exactly one place. Any repository that wants AI security review adds a small caller workflow — it does not copy the engine.

---

## Architecture

```
         ai-pr-review-demo  (or any other repository)
              |
           PR raised
              |
              v
       GitHub Actions
              |
              | workflow_call
              v
         ai-pr-review  ◄── THIS REPOSITORY
              |
    ┌─────────┼──────────┐
    v         v          v
 Genesis   Security    GitHub
 Adapter    Agent      Reporter
              |
              v
           Groq API
              |
              v
        Configured LLM
              |
              v
      Raw SQL Injection
         Findings
              |
              v
    Evidence Validator
     (deterministic,
      no LLM used)
              |
              v
      VERIFIED / UNVERIFIED
              |
              v
   ai-pr-review-demo PR comment
```

### Component responsibilities

| Component | Responsibility |
|---|---|
| **Genesis Adapter** | Repository intelligence — symbols, imports, dependencies, blast-radius. Provides context to the Security Agent. NOT a vulnerability detector. |
| **Security Agent** | Security analysis — sends changed code + Genesis context to the LLM, receives structured findings. |
| **Groq** | LLM inference/API infrastructure — the HTTP layer between the Security Agent and the configured language model. |
| **LLM** | Generates potential SQL Injection findings in structured JSON format. |
| **Evidence Validator** | Deterministic source verification — checks every finding against the actual checked-out source. Never uses an LLM. |
| **Review Engine** | Orchestrator — coordinates the full pipeline from changed files to verified findings. |
| **GitHub Reporter** | Posts the formatted review result as a comment on the CALLER repository's Pull Request. |
| **GitHub Actions** | Trigger and execution environment — the reusable workflow is called by other repositories. |

---

## Repository structure

```
ai-pr-review/
│
├── src/
│   ├── core/
│   │   ├── reviewEngine.js       # Orchestrates the full pipeline
│   │   ├── reviewContext.js      # Input normalisation
│   │   └── reviewResult.js       # Output shape + factory helpers
│   │
│   ├── genesis/
│   │   └── genesisAdapter.js     # Repository intelligence (optional)
│   │
│   ├── agents/
│   │   └── securityAgent.js      # SQL Injection detection via LLM
│   │
│   ├── validation/
│   │   └── evidenceValidator.js  # Deterministic source verification
│   │
│   ├── integrations/
│   │   ├── groq.js               # Groq API client (TLS-safe)
│   │   └── github.js             # GitHub REST API (postComment, getFiles)
│   │
│   ├── reporting/
│   │   └── githubReporter.js     # PR comment formatting + posting
│   │
│   └── cli/
│       └── index.js              # CLI + GitHub Actions entry point
│
├── fixtures/
│   ├── vulnerable.js             # SQL injection fixture (for tests + demo)
│   ├── safe.js                   # Safe parameterised queries (for tests)
│   └── fake-finding.js           # Innocent file (tests UNVERIFIED path)
│
├── tests/
│   └── review.test.js            # 13 test suites, fully mocked (no LLM)
│
├── .github/
│   └── workflows/
│       ├── ci.yml                # CI for this repository
│       └── reusable-review.yml   # Reusable workflow (called by others)
│
├── package.json
├── vitest.config.js
├── .env.example
└── README.md
```

---

## Reusable GitHub Actions workflow

`reusable-review.yml` uses `workflow_call` so any other repository can trigger a review without copying the engine.

### How the cross-repository flow works

1. A developer opens a PR in `ai-pr-review-demo`.
2. `ai-pr-review-demo`'s `ai-security-review.yml` fires.
3. It calls `YOUR_ORG/ai-pr-review/.github/workflows/reusable-review.yml@main`.
4. The reusable workflow **checks out `ai-pr-review-demo`** (the caller), not `ai-pr-review`.
5. Changed JS/TS files are identified via the GitHub API.
6. The review engine runs against those files.
7. The GitHub Reporter posts the result on **`ai-pr-review-demo`'s PR** — not on any `ai-pr-review` PR.

The key mechanism: when `workflow_call` fires, `github.repository` and `github.ref` already point to the **caller repository**. The default `actions/checkout` therefore checks out the caller's code. The engine code is checked out separately into `_ai_review_engine/` so it never overwrites the caller's workspace.

---

## Setup (caller repository)

### Step 1 — Add GROQ_API_KEY secret

In your repository: **Settings → Secrets and variables → Actions → New repository secret**

- Name: `GROQ_API_KEY`
- Value: your Groq API key (obtain free at https://console.groq.com)

### Step 2 — Add the caller workflow

Create `.github/workflows/ai-security-review.yml` in your repository:

```yaml
name: AI Security Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  ai-review:
    uses: YOUR_ORG/ai-pr-review/.github/workflows/reusable-review.yml@main
    secrets:
      GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
```

Replace `YOUR_ORG` with the GitHub organisation or user that owns the `ai-pr-review` repository.

That is the complete integration. No engine code lives in your repository.

---

## Local usage

```bash
# Install dependencies
npm install

# Review a specific file
npm run ai-review -- fixtures/vulnerable.js

# Review the vulnerable fixture (built-in shortcut)
npm run ai-review:test

# Run all tests (no GROQ_API_KEY required — tests are fully mocked)
npm test
```

### Environment variables

Copy `.env.example` to `.env.local` and fill in:

```
GROQ_API_KEY=your-key-here
```

For reviewing a repository other than the current directory:

```
REVIEW_REPO_ROOT=/path/to/the/repository/being/reviewed
```

For corporate proxy (e.g. Zscaler) — TLS verification stays enabled:

```
HTTPS_PROXY=http://proxy.example.com:8080
NODE_EXTRA_CA_CERTS=/path/to/corporate-ca.crt
```

---

## Security

- `GROQ_API_KEY` comes from environment only — never hardcoded, never logged.
- `GITHUB_TOKEN` is the caller repository's Actions token — never a PAT, no extra permissions.
- TLS certificate verification is always **enabled**. `rejectUnauthorized: false` is never set.
- Corporate proxy support via `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` without disabling TLS.
- The review engine never approves, merges, blocks, or modifies a Pull Request.
- The review engine never writes to source files.

---

## Evidence Validator

The Evidence Validator is deterministic and never uses an LLM.

For every AI finding it checks:

1. The referenced file exists on disk.
2. The referenced line number is within the file's line count.
3. The reported evidence appears in the source around the reported line.

A finding is only marked **VERIFIED** when all three checks pass.
LLM confidence alone is never sufficient — a finding the LLM is "certain" about
is still **UNVERIFIED** if the source does not confirm it.

---

## Reusability across many repositories

The same `ai-pr-review` repository can be consumed by any number of repositories:

```
GitHub Organisation
        |
 ┌──────┼──────┬──────┐
 │      │      │      │
Repo A  Repo B Repo C Repo D
 │      │      │      │
 └──────┴──────┴──────┘
              |
         workflow_call
              |
         ai-pr-review
              |
        Review Engine
```

Each consumer adds one small caller workflow. The engine is maintained in one place.

---

## Production direction (future)

For this MVP, the integration uses **GitHub Actions + reusable workflow**.

The long-term organisation-wide architecture could use a GitHub App:

```
GitHub Organisation
        |
 Repo A, Repo B, Repo C, Repo D
        |
   GitHub App  ←— receives PR webhook events for all repos
        |
   ai-pr-review
        |
   Review Engine
```

This is **not implemented in this MVP**. The reusable workflow approach is sufficient for demonstrating and validating the AI review engine before committing to a GitHub App.

---

## What is NOT implemented (by design)

- Quality Agent, Correctness Agent, Testing Agent
- Multiple-agent orchestration
- Autonomous code fixes or PR modifications
- Automatic approval, merge, or blocking
- Production dashboard or review database
- GitHub App
- Full 2×2 uncertainty matrix

The architecture is intentionally extensible for all of the above.
