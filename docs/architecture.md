# Architecture

This document describes the **current MVP architecture** of the `ai-pr-review`
engine and clearly separates it from **proposed future work**.

---

## Current MVP architecture

```
Pull Request (caller repository, e.g. ai-pr-review-demo)
      │  opened / synchronized / reopened
      ▼
GitHub Actions
      │  workflow_call
      ▼
reusable-review.yml  (runs inside ai-pr-review)
      │  1. checkout caller repo at the PR ref
      │  2. list changed files + build pr-diff.txt from the PR patches
      ▼
Review Engine  (src/core/reviewEngine.js)
      │
      ▼
Context Builder  (src/core/contextBuilder.js)
      │  PR diff + targeted source context (+ Genesis context if present)
      ▼
Security Agent + Quality Agent  (src/agents/*)
      │  bounded prompt → Groq → LLM → structured JSON findings
      ▼
Evidence Validator  (src/validation/evidenceValidator.js)
      │  deterministic verification against checked-out source (no LLM)
      ▼
GitHub Reporter  (src/reporting/githubReporter.js)
      │
      ▼
PR comment on the caller repository
```

### Component purposes

| Component | File | Purpose |
|---|---|---|
| **Review Engine** | `src/core/reviewEngine.js` | Orchestrates the pipeline. Normalises input (diff, file path, or file list), coordinates context building, both agents, validation, and result assembly. Independent of any trigger. |
| **Review Context** | `src/core/reviewContext.js` | Normalises run inputs (diff, file paths, repo root, optional PR metadata) into a single structured object. |
| **Context Builder** | `src/core/contextBuilder.js` | Assembles a **bounded** LLM prompt from the PR diff, targeted source snippets around the changed lines, and Genesis context (when available). Enforces character limits. See [context-management.md](context-management.md). |
| **Security Agent** | `src/agents/securityAgent.js` | Detects SQL Injection and Hardcoded Secrets. Builds the security prompt, calls Groq, parses/normalises findings. See [security-agent.md](security-agent.md). |
| **Quality Agent** | `src/agents/qualityAgent.js` | Runs the code-quality catalog over the same context. Prompt is scoped to the enabled categories. |
| **Check Catalog** | `src/agents/checkCatalog.js` | Single source of truth for quality categories/types and their environment-driven configuration (toggles, severity floor). |
| **Finding Parser** | `src/agents/findingParser.js` | Shared, type-agnostic parser that turns raw LLM text into normalised findings (strips code fences, coerces fields, carries an optional multi-line `endLine`). |
| **Groq integration** | `src/integrations/groq.js` | Builds the OpenAI-SDK client pointed at the Groq endpoint. Reads `GROQ_API_KEY` from the environment; keeps TLS verification enabled; supports a corporate proxy. |
| **Evidence Validator** | `src/validation/evidenceValidator.js` | Deterministically verifies each finding against the checked-out source. Never uses an LLM. Marks findings VERIFIED or UNVERIFIED. |
| **GitHub integration** | `src/integrations/github.js` | Low-level GitHub REST calls (post PR comment, list PR files). |
| **GitHub Reporter** | `src/reporting/githubReporter.js` | Formats a ReviewResult into a Markdown comment and posts it to the caller's PR. Never approves, merges, blocks, or edits the PR. |
| **Genesis Adapter** | `src/genesis/genesisAdapter.js` | *Optional.* Provides repository intelligence (symbols, imports, blast radius) when a `.genesis/index` and the Genesis query tool are present. Not a vulnerability detector. |
| **CLI** | `src/cli/index.js` | Entry point for local runs and for the GitHub Actions step. |

### Genesis status (current)

Genesis context is **optional** and is used only when
`isGenesisAvailable()` finds both a `.genesis/index/graph.json` in the repository
under review **and** the Genesis query module on the machine. Neither is present
in this repository, so:

- The engine currently runs **without** Genesis context.
- Reviews report `genesisAvailable: false`.
- The Context Builder emits no Genesis section by default (verified by the test
  suite).

The pipeline is designed so that Genesis is a pure enrichment: when it is
absent, the agents run on the PR diff and targeted source context alone.

---

## Two-repository setup

| Repository | Role |
|---|---|
| **`ai-pr-review`** (this repo) | The central review **engine**: agents, context builder, validator, reporter, and the reusable workflow. Maintained in one place. |
| **`ai-pr-review-demo`** | A small demo/caller application that triggers the engine on its own Pull Requests via GitHub Actions `workflow_call`. |

How the cross-repository flow works:

1. A PR is opened in the caller repository (e.g. `ai-pr-review-demo`).
2. The caller's small workflow calls `ai-pr-review`'s `reusable-review.yml`.
3. The reusable workflow **checks out the caller repository** at the PR ref and
   builds the PR diff from the GitHub API.
4. The engine is checked out separately into a subdirectory so it never
   overwrites the caller's code.
5. The engine reviews the diff and the **GitHub Reporter posts the comment on
   the caller's PR** — not on `ai-pr-review`.

The engine lives in exactly one place; any repository that wants review adds a
small caller workflow rather than copying the engine. See
[../integration.md](../integration.md) for the caller setup.

---

## Current MVP vs. future architecture

### Current MVP (implemented)

- Trigger via **GitHub Actions + reusable workflow** (`workflow_call`).
- **Security Agent** (SQL Injection, Hardcoded Secrets) and **Quality Agent**
  (code-quality catalog).
- **Bounded context** builder to keep prompts within model limits.
- **Deterministic Evidence Validator**.
- **GitHub Reporter** posts an informational PR comment.
- Genesis integration present in code but **inactive** without a `.genesis/index`.

### Future / proposed (NOT implemented)

These are intentionally out of scope for the MVP and should be treated as
future work:

- **GitHub App** delivering PR webhooks for a whole organisation, replacing the
  per-repository caller workflow.
- Additional agents (e.g. correctness/testing agents beyond the current catalog)
  and multi-agent orchestration.
- Autonomous code fixes or PR modifications.
- Automatic approval, merge, or blocking of PRs.
- A production dashboard or a persistent review database.
- Active Genesis-backed cross-file analysis in CI (requires committing a
  `.genesis/index` and provisioning the Genesis tool in the runner).

The current design is deliberately extensible toward the above without changing
the core pipeline contract.
