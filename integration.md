# Integration Guide — AI PR Security Review

How to connect any GitHub repository to the `ai-pr-review` engine for automated SQL Injection detection on every Pull Request.

---

## How it works

`ai-pr-review` is a **central engine repository**. Your repository never contains engine code — it just adds a small caller workflow that fires `workflow_call` into this engine.

```
Your repository
      |
   PR opened / updated
      |
      v  .github/workflows/ai-security-review.yml  (in YOUR repo)
         uses: AtharvaPrashantBhuse/ai-pr-review/.github/workflows/reusable-review.yml@main
      |
      v  reusable-review.yml  (runs inside ai-pr-review)
         1. Checkout your repository at the PR branch
         2. Fetch the PR diff from the GitHub API
         3. Build bounded LLM context  ←  context-size fix
         4. Security Agent → Groq/LLM → SQL Injection findings
         5. Evidence Validator → VERIFIED / UNVERIFIED
         6. GitHub Reporter → PR comment on YOUR repository
```

The engine checks out your code and posts the comment back to your PR. Nothing else in your repository changes.

---

## Prerequisites

| Requirement | Detail |
|---|---|
| Groq API key | Free at [console.groq.com](https://console.groq.com) |
| Public repository (or PAT) | `ai-pr-review` must be publicly accessible, or you must supply a `GITHUB_PAT` with `repo` scope |
| Node.js ≥ 20 | Provided automatically by the workflow runner |

---

## Step 1 — Add the GROQ_API_KEY secret

In **your** repository, go to:

**Settings → Secrets and variables → Actions → New repository secret**

| Field | Value |
|---|---|
| Name | `GROQ_API_KEY` |
| Value | Your Groq API key |

---

## Step 2 — Add the caller workflow

Create this file in **your** repository:

```
.github/workflows/ai-security-review.yml
```

```yaml
name: AI Security Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents:      read
  pull-requests: write

jobs:
  ai-review:
    uses: AtharvaPrashantBhuse/ai-pr-review/.github/workflows/reusable-review.yml@main
    secrets:
      GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
```

That is the complete integration. Commit this file, open a PR, and the review runs automatically.

---

## What the reusable workflow does (step by step)

### Step 1 — Checkout your repository

The workflow checks out your repository at the PR branch ref. `GITHUB_WORKSPACE` is set to your code root throughout the run.

### Step 2 — Checkout the review engine

The engine is checked out into `$GITHUB_WORKSPACE/_ai_review_engine` — a subdirectory that never overwrites your code.

### Step 3 — Install engine dependencies

```bash
npm ci --prefer-offline
```

Runs inside `_ai_review_engine`. Your `package.json` is untouched.

### Step 4 — Get changed files and build the PR diff

Calls `github.rest.pulls.listFiles()` to retrieve every changed file in the PR. For each added/modified JS or TS file, the GitHub API `patch` field (the actual unified diff) is written to `pr-diff.txt`.

Two files are written:

| File | Purpose |
|---|---|
| `pr-diff.txt` | Actual PR patches — used by the review engine (preferred path) |
| `changed-files.txt` | Newline-separated file paths — kept for backward-compatibility |

Deleted files and non-JS/TS files are excluded. Binary files or files too large for a patch are skipped with a warning.

### Step 5 — Run the security review

```bash
node _ai_review_engine/src/cli/index.js \
  --diff-file pr-diff.txt \
  --report-to-pr
```

The engine receives the PR diff, not entire source files. The context builder extracts only the function-scoped source around changed lines, keeping the LLM prompt well within token limits regardless of file size.

### Step 6 — Post the PR comment

If findings are detected, a formatted comment is posted on your PR. If no issues are found, a clean "No SQL Injection findings detected" comment is posted.

---

## Context size protection

This is the main architectural improvement over the previous version, which sent entire source files to the LLM and caused `413 Request Entity Too Large` errors on large files.

The engine now builds a bounded prompt from three sources:

```
PR diff (what actually changed)
+
Relevant source context (function-scoped snippets around changed lines only)
+
Genesis repository context (symbols, dependencies — if .genesis/index exists)
─────────────────────────────────────────────────────────────────────────────
Bounded Context Builder  →  Security Agent  →  Evidence Validator
```

Default limits (all configurable via environment variables):

| Env var | Default | Controls |
|---|---|---|
| `AI_REVIEW_MAX_DIFF_CHARS` | 8 000 | PR diff section |
| `AI_REVIEW_MAX_SOURCE_CONTEXT_CHARS` | 12 000 | Source snippet section |
| `AI_REVIEW_MAX_GENESIS_CONTEXT_CHARS` | 4 000 | Genesis context section |
| `AI_REVIEW_MAX_PROMPT_CHARS` | 24 000 | Total combined prompt |

To override a limit, set the environment variable in the `Run AI Security Review` step of your caller workflow:

```yaml
    - name: Run AI Security Review
      env:
        AI_REVIEW_MAX_DIFF_CHARS: "12000"
        AI_REVIEW_MAX_PROMPT_CHARS: "32000"
```

---

## Diagnostic output

Before every LLM call, the engine logs prompt-size diagnostics to the Actions log. No source code or secrets are included.

```
[AI-Review] Groq model:            openai/gpt-oss-20b
[AI-Review] Diff chars:            1842
[AI-Review] Source context chars:  3104
[AI-Review] Genesis context chars: 0
[AI-Review] User prompt chars:     5124
```

Use these lines to diagnose any remaining size issues without having to inspect raw code.

---

## Environment variables (reference)

These are set automatically by the reusable workflow. You do not need to set them manually in the caller workflow unless you are running the engine locally.

| Variable | Set by | Purpose |
|---|---|---|
| `GROQ_API_KEY` | Caller secret | LLM inference — required |
| `GROQ_SECURITY_MODEL` | Optional override | Override the default Groq model |
| `REVIEW_REPO_ROOT` | Reusable workflow | Absolute path to the checked-out caller repository |
| `GITHUB_TOKEN` | Reusable workflow | Posts the PR comment on the caller repository |
| `PR_NUMBER` | Reusable workflow | Identifies which PR to comment on |
| `PR_REPO_OWNER` | Reusable workflow | Repository owner for the PR comment |
| `PR_REPO_NAME` | Reusable workflow | Repository name for the PR comment |
| `HTTPS_PROXY` / `HTTP_PROXY` | Optional | Corporate proxy (TLS verification stays enabled) |
| `NODE_EXTRA_CA_CERTS` | Optional | Path to corporate CA certificate (e.g. Zscaler) |

---

## Connecting multiple repositories

Every repository that wants AI security review adds the same two-line caller workflow. The engine is maintained in one place.

```yaml
jobs:
  ai-review:
    uses: AtharvaPrashantBhuse/ai-pr-review/.github/workflows/reusable-review.yml@main
    secrets:
      GROQ_API_KEY: ${{ secrets.GROQ_API_KEY }}
```

Each repository needs only its own `GROQ_API_KEY` secret (or they can share a single org-level secret).

---

## Files reviewed

The engine reviews files with these extensions:

```
.js  .jsx  .ts  .tsx  .mjs  .cjs
```

Files that are deleted in the PR, binary, or have no patch available are skipped automatically. All skipped files are listed in the Actions log.

---

## Local usage

Run the engine locally for development or testing:

```bash
# Clone the engine
git clone https://github.com/AtharvaPrashantBhuse/ai-pr-review.git
cd ai-pr-review
npm install

# Copy env template and add your Groq key
cp .env.example .env.local
# edit .env.local — set GROQ_API_KEY

# Review a single file
npm run ai-review -- path/to/file.js

# Review via a PR diff file
node src/cli/index.js --diff-file pr-diff.txt

# Review via a file list
node src/cli/index.js --files-from changed-files.txt

# Review the built-in vulnerable fixture
npm run ai-review:test

# Run the full test suite (no GROQ_API_KEY required — fully mocked)
npm test
```

To review a specific repository checkout, set `REVIEW_REPO_ROOT`:

```bash
REVIEW_REPO_ROOT=/path/to/your/repo node src/cli/index.js --diff-file pr-diff.txt
```

---

## CLI flags

| Flag | Description |
|---|---|
| `--diff-file <path>` | Read a unified diff from a file. Preferred for GitHub PR review. Calls `reviewDiff()`. |
| `--files-from <path>` | Read a newline-separated list of file paths. Legacy/local mode. Calls `reviewFiles()`. |
| `--files <f1> <f2> …` | Pass file paths directly. |
| `--report-to-pr` | Post results as a PR comment. Requires `PR_NUMBER`, `PR_REPO_OWNER`, `PR_REPO_NAME` env vars. |

---

## Evidence Validator

The Evidence Validator is deterministic — it never calls an LLM.

For every finding returned by the Security Agent it checks:

1. The referenced file exists on disk in the checked-out repository.
2. The line number is within the file's actual line count.
3. The reported evidence string appears in the source code around the reported line.

A finding is only marked **VERIFIED** when all three checks pass. LLM confidence is never sufficient on its own.

This means the LLM can now work from a bounded context window (the PR diff + targeted snippets) while the validator still checks findings against the complete source on disk.

---

## Genesis integration (optional)

If the caller repository has a `.genesis/index` directory committed, the engine will use it to provide additional repository context (symbols, import relationships, blast radius) to the Security Agent.

Genesis context is bounded to `AI_REVIEW_MAX_GENESIS_CONTEXT_CHARS` (default 4 000 chars) before being included in the prompt. If Genesis is not present, the engine runs without it — it is not required.

---

## PR comment format

Example comment when a vulnerability is found:

```
## 🔐 AI Security Review

| | |
|---|---|
| **Findings** | 1 (1 verified) |
| **Model** | openai/gpt-oss-20b |
| **Genesis** | ✗ not available |

---

### 🔴 Finding #1 — SQL_INJECTION (HIGH)

| Field | Value |
|---|---|
| **File** | src/api/users.js |
| **Line** | 42 |
| **Confidence** | HIGH |
| **Verification** | ✅ VERIFIED |

**Evidence**
\`\`\`
const sql = 'SELECT * FROM users WHERE id = ' + userId;
\`\`\`

**Explanation**  
User input from `req.query.userId` is concatenated directly into the SQL string without parameterisation. An attacker can inject arbitrary SQL.
```

When no findings are detected:

```
## 🔐 AI Security Review

✅ No SQL Injection findings detected in this PR.
```

---

## Permissions required

The caller workflow must declare these permissions:

```yaml
permissions:
  contents:      read   # checkout + source file reading
  pull-requests: write  # post the review comment
```

These are scoped to the caller repository's `GITHUB_TOKEN`. No PAT or elevated permissions are required for the review workflow itself.

---

## Troubleshooting

**No PR comment appears**

- Confirm `permissions: pull-requests: write` is set in the caller workflow.
- Confirm `GROQ_API_KEY` is set as a repository secret (not an environment variable in the workflow file).
- Check the Actions log for `[AI-Review] User prompt chars` — if this is 0, the diff file was empty.

**`413 Request Entity Too Large` from Groq**

This should no longer occur with the context-size fix. If it does:
- Check `[AI-Review] User prompt chars` in the Actions log.
- Lower `AI_REVIEW_MAX_PROMPT_CHARS` via an env var in your caller workflow.
- The default limit is 24 000 characters, which is well within Groq's token limits for the default model.

**`GROQ_API_KEY is not set`**

The secret name in GitHub must be exactly `GROQ_API_KEY`. Confirm it is set under **Settings → Secrets and variables → Actions** in the caller repository, not in `ai-pr-review`.

**All findings are UNVERIFIED**

The Evidence Validator checks findings against the checked-out source. If file paths in the findings do not match the actual paths on disk, or if line numbers shifted between the diff and the checkout, findings will be unverified. Check the `Reason` field in the Actions log output.

**Engine not found / checkout fails**

`ai-pr-review` must be a public repository, or you must add a `token` to the engine checkout step pointing to a PAT with `repo` scope.
