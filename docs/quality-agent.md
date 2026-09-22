# Quality Agent

Grounded in `src/agents/qualityAgent.js`, `src/agents/checkCatalog.js`,
`src/agents/findingParser.js`, and `src/validation/evidenceValidator.js`.

> See also: [security-agent.md](security-agent.md) (the parallel security agent)
> and [checks.md](checks.md) (the complete per-type check reference).

---

## Overview

The Quality Agent performs code-quality analysis of the changed code — the
automated peer-review pass that runs alongside the Security Agent. It:

1. Receives the bounded context (PR diff + targeted source context, plus Genesis
   context when available) from the Context Builder.
2. Builds a **category-scoped** quality prompt (only the enabled categories are
   described to the model) and submits it to the LLM via the Groq layer.
3. Parses and normalises the LLM's structured JSON findings.
4. Filters findings to the enabled categories and the configured severity floor.

It does **not** make HTTP calls directly (Groq layer), validate findings against
source (Evidence Validator), or report to GitHub (GitHub Reporter). It does not
look for security vulnerabilities — that is the Security Agent's job.

The LLM temperature is kept low for deterministic, factual output. If
`GROQ_API_KEY` is absent, the agent returns a graceful error result rather than
crashing. If the quality agent is disabled (or all its categories are), it
returns `skipped: true` and makes no LLM call.

### Finding shape

```
{
  "type":        "<a quality finding type, e.g. LOGIC_ERROR>",
  "severity":    "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "confidence":  "LOW" | "MEDIUM" | "HIGH",
  "file":        "relative/path.js",
  "line":        <1-based line number>,
  "endLine":     <optional 1-based end line for a multi-line/range finding>,
  "evidence":    "the exact offending line of code",
  "explanation": "the issue and the concrete risk or cost"
}
```

The shared finding parser strips markdown code fences, extracts an embedded JSON
array if the model wraps it in prose, coerces field types, replaces invalid
`severity`/`confidence` values with safe defaults, and carries an optional
`endLine` for range findings.

---

## Check catalog

`checkCatalog.js` is the single source of truth. Checks are grouped into
categories; each category is individually toggleable. The full per-type
reference lives in [checks.md](checks.md).

| Category | Default | Finding types |
|---|---|---|
| **Correctness** | on | `LOGIC_ERROR`, `BUG_RISK` |
| **Dead Code** | on | `DEAD_CODE` |
| **Duplication** | on | `DUPLICATE_CODE` *(range)* |
| **Error Handling** | on | `ERROR_HANDLING` *(range)* |
| **Maintainability** | on | `MAINTAINABILITY` *(range)*, `COMPLEXITY` *(range)*, `NAMING`, `MAGIC_NUMBER`, `DOCUMENTATION` |
| **Performance** | on | `PERFORMANCE` *(range)* |
| **API / Contract** | on | `API_CONTRACT` |
| **Style** | **off** | `STYLE` |
| **Test Coverage** | **off** | `TEST_COVERAGE` |

**Why some categories are off by default.** `style` is subjective and noisy, and
`test_coverage` needs whole-PR context that a bounded diff often lacks. Both are
opt-in via `AI_REVIEW_QUALITY_CATEGORIES` so the out-of-the-box signal stays
high.

### What each check flags (summary)

- `LOGIC_ERROR` — `=` vs `===`, off-by-one/inverted conditions, always-true/false,
  wrong return variable, missing `await` on a value used synchronously.
- `BUG_RISK` — possible null/undefined dereference, out-of-bounds/undefined
  destructuring, use-before-define, off-by-one loop bounds.
- `DEAD_CODE` — statements after an unconditional return/throw/break; unreachable
  branches; unused vars/params/imports/local functions; assignments never read.
- `DUPLICATE_CODE` — copy-paste blocks that should be factored into a helper.
- `ERROR_HANDLING` — empty/over-broad catches, swallowed errors, operations that
  can throw with no handling, resources not released on an error path.
- `COMPLEXITY` — over-long/deeply-nested functions, too many branches/params.
- `MAINTAINABILITY` — structural smells (e.g. a large switch that should be a
  lookup, tangled responsibilities).
- `NAMING` — misleading or non-descriptive identifiers.
- `MAGIC_NUMBER` — unexplained literal constants that should be named.
- `DOCUMENTATION` — missing/incorrect docs on a non-trivial public function.
- `PERFORMANCE` — N+1 queries, work that should be hoisted out of a loop,
  blocking sync calls on a hot path, unbounded growth.
- `API_CONTRACT` — breaking public signature/return-shape changes, inconsistent
  error contract. Uses Genesis blast-radius (when available) to judge whether
  dependents would break.

Fixture: `fixtures/quality-issues.js` contains a dead-code path, an
assignment-in-condition logic error, a null dereference, duplicate blocks, an
empty catch, a magic number, an N+1 loop, and a deeply-nested function.

---

## Configuration

All settings are environment variables and are independent of the security-agent
settings.

| Variable | Default | Purpose |
|---|---|---|
| `AI_REVIEW_ENABLE_QUALITY` | `true` | Master switch. `false`/`0`/`no`/`off` runs security only. |
| `AI_REVIEW_QUALITY_CATEGORIES` | *(unset)* | Comma allow-list — run **only** these categories. |
| `AI_REVIEW_DISABLE_CATEGORIES` | *(unset)* | Comma list — remove categories from the default set. |
| `AI_REVIEW_QUALITY_MIN_SEVERITY` | `LOW` | Drop quality findings below this severity. |
| `GROQ_QUALITY_MODEL` | *(falls back to `GROQ_SECURITY_MODEL`)* | Override the model used for quality analysis. |

Unknown category keys are ignored with a logged warning (so a typo does not
silently disable everything). Example:

```yaml
    - name: Run AI Security Review
      env:
        AI_REVIEW_QUALITY_CATEGORIES: "correctness,error_handling,performance"
        AI_REVIEW_QUALITY_MIN_SEVERITY: "MEDIUM"
```

---

## Range (multi-line) findings

Some checks describe a span, not a single line — a duplicated block, an
over-long function, an N+1 loop. These findings carry an `endLine`, and the
Evidence Validator verifies the evidence appears **within the claimed span** (a
span that runs past end-of-file is rejected as UNVERIFIED). This is what lets
duplication and complexity findings be VERIFIED rather than silently dropped.

---

## Expected findings and false-positive handling

False positives are controlled at three layers:

1. **Prompt-level guidance.** Each category block lists what to flag and what to
   leave alone (e.g. do not flag exported symbols as dead code, do not nitpick
   trivial helpers), and instructs the model to prefer precision over recall.
2. **Type + severity filtering.** Findings outside the enabled categories, or
   below the severity floor, are dropped before reporting.
3. **Deterministic verification.** Even a confident finding is only surfaced as
   VERIFIED if it matches the real source.

Overlapping findings on the same location are de-duplicated
(`src/core/findingDedup.js`) into one primary with the others recorded as
`alsoFlaggedAs`; a security finding always outranks an overlapping quality one.

Findings are informational. The engine never approves, merges, blocks, or edits
the Pull Request based on them.

---

## How the Evidence Validator fits in

After the agent returns findings, each passes through the Evidence Validator
(`src/validation/evidenceValidator.js`), which is **deterministic and never uses
an LLM**. A finding is marked **VERIFIED** only when:

1. The referenced file exists on disk in the checked-out repository.
2. The reported line (or range) is within the file's line count.
3. The reported evidence appears in the source around the reported line/range.

If any check fails, the finding is marked **UNVERIFIED** with a reason.
**LLM confidence alone is never sufficient**: a finding the model is "certain"
about is still UNVERIFIED if the source does not confirm it.

Result shapes:

```
VERIFIED:   { status: "VERIFIED",   file, line, sourceLine, [endLine] }
UNVERIFIED: { status: "UNVERIFIED", file, line, reason,     [endLine] }
```

The validator reads the complete source on disk, independent of the bounded
prompt window, so verification is not limited by context size.

---

## Honest limitations

- Verification proves the **location** (the evidence line exists), not the
  **correctness** of the judgment. A finding can be VERIFIED yet still be a
  false positive. The category filters and prompt guidance reduce this, but do
  not eliminate it.
- `API_CONTRACT` and `TEST_COVERAGE` are the most cross-file checks. They are
  best-effort without Genesis; with a Genesis index they use exported-symbol and
  blast-radius data. `TEST_COVERAGE` is off by default for this reason.
- Detection quality depends on the LLM. The test suite exercises the pipeline
  with mocked findings; real-model precision on live PRs is best checked with
  `npm run smoke`.
- `style`, `naming`, and `maintainability` are the most subjective checks and
  will vary most between runs.
