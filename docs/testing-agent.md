# Testing Agent

Grounded in `src/agents/testingAgent.js`, `src/agents/testingCatalog.js`,
`src/agents/findingParser.js`, and `src/validation/evidenceValidator.js`.

> See also: [security-agent.md](security-agent.md) and
> [quality-agent.md](quality-agent.md) (the parallel agents) and
> [checks.md](checks.md) (the complete per-type check reference).

---

## Overview

The Testing Agent reviews **test code and the test-related aspects of a change**
— the automated "are these tests any good?" pass that runs alongside the
Security and Quality agents. It:

1. Receives the bounded context (PR diff + targeted source context, plus Genesis
   context when available) from the Context Builder.
2. Builds a **category-scoped** prompt (only the enabled categories are
   described to the model) and submits it to the LLM via the Groq layer.
3. Parses and normalises the LLM's structured JSON findings.
4. Filters findings to the enabled categories and the configured severity floor.

It does **not** make HTTP calls directly (Groq layer), validate findings against
source (Evidence Validator), or report to GitHub (GitHub Reporter). It does not
look for security or general code-quality issues — those are the other agents.

The LLM temperature is kept low for deterministic output. If `GROQ_API_KEY` is
absent, the agent returns a graceful error result. If it is disabled (or all its
categories are), it returns `skipped: true` and makes no LLM call.

### Finding shape

```
{
  "type":        "<a testing finding type, e.g. NO_ASSERTION>",
  "severity":    "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "confidence":  "LOW" | "MEDIUM" | "HIGH",
  "file":        "relative/path.test.js",
  "line":        <1-based line number>,
  "endLine":     <optional 1-based end line for a multi-line/range finding>,
  "evidence":    "the exact offending line of test code",
  "explanation": "the test problem and its risk"
}
```

---

## Check catalog

`testingCatalog.js` is the single source of truth. Checks are grouped into
categories; each is individually toggleable. Full per-type reference:
[checks.md](checks.md).

| Category | Default | Finding types |
|---|---|---|
| **Test Coverage** | on | `MISSING_TEST`, `UNTESTED_EDGE_CASE`, `UNTESTED_ERROR_PATH` |
| **Assertions** | on | `NO_ASSERTION` *(range)*, `WEAK_ASSERTION`, `ASSERTION_ON_MOCK`, `SNAPSHOT_OVERUSE` |
| **Flakiness** | on | `TIME_DEPENDENT_TEST`, `RANDOMNESS_IN_TEST`, `ORDER_DEPENDENT_TEST`, `NETWORK_IN_UNIT_TEST`, `RACE_IN_TEST` |
| **Test Hygiene** | on | `SKIPPED_TEST`, `EMPTY_TEST` *(range)*, `COMMENTED_OUT_TEST` *(range)*, `DUPLICATE_TEST`, `POOR_TEST_NAME` |
| **Mocking** | on | `UNRESTORED_MOCK`, `OVER_MOCKING` *(range)*, `MISSING_MOCK_CLEANUP` |
| **Async Correctness** | on | `MISSING_AWAIT_ASSERTION`, `PROMISE_NOT_RETURNED`, `MISSING_DONE_CALLBACK` |
| **Test Data & Isolation** | **off** | `SHARED_MUTABLE_FIXTURE`, `HARDCODED_TEST_DATA`, `MISSING_CLEANUP` |
| **Test Smells** | **off** | `TEST_LOGIC` *(range)*, `MULTIPLE_CONCERNS` *(range)*, `TESTING_IMPLEMENTATION`, `TRIVIAL_TEST` |

**Why some categories are off by default.** `isolation` is noisier and `smells`
is subjective, so they are opt-in to keep the out-of-the-box signal high.

Fixture: `fixtures/testing-issues.js` contains a no-assertion test, a focused
`.only`, a weak assertion, a time-dependent test, an un-awaited async assertion,
and an unrestored mock. (It is named `.js` — not `.test.js` — so the project's
own Vitest run never executes it.)

---

## Configuration

All settings are environment variables, independent of the security and quality
settings.

| Variable | Default | Purpose |
|---|---|---|
| `AI_REVIEW_ENABLE_TESTING` | `true` | Master switch. `false`/`0`/`no`/`off` skips test analysis. |
| `AI_REVIEW_TESTING_CATEGORIES` | *(unset)* | Comma allow-list — run **only** these categories. |
| `AI_REVIEW_DISABLE_TESTING_CATEGORIES` | *(unset)* | Comma list — remove categories from the default set. |
| `AI_REVIEW_TESTING_MIN_SEVERITY` | `LOW` | Drop testing findings below this severity. |
| `GROQ_TESTING_MODEL` | *(falls back to `GROQ_SECURITY_MODEL`)* | Override the model used for testing analysis. |

Unknown category keys are ignored with a logged warning. Example:

```yaml
    - name: Run AI Security Review
      env:
        AI_REVIEW_TESTING_CATEGORIES: "assertions,flakiness,async"
        AI_REVIEW_TESTING_MIN_SEVERITY: "MEDIUM"
```

---

## How findings flow through the pipeline

Testing findings use the same shape as security and quality findings, so they
pass through the deterministic Evidence Validator (verified against the real
test source), the de-duplication step (a security finding always outranks an
overlapping testing finding), and the GitHub Reporter, which groups them under
their category (e.g. "Testing: Test Hygiene", "Testing: Async Correctness").

Verification proves the **location** of a finding, not the correctness of the
judgment — a VERIFIED testing finding can still be a false positive.

---

## Honest limitations

- **No test execution or coverage report.** The engine never runs the suite,
  so `MISSING_TEST` / `UNTESTED_*` are inferences from the diff and repository
  context — clear gaps, not a measured coverage delta. This overlaps with the
  Quality Agent's `TEST_COVERAGE` check; both are best-effort. If you want one
  owner for coverage, disable `test_coverage` in the quality catalog and let the
  Testing Agent's `coverage` category own it (or vice versa).
- **Whole-suite context is limited.** The agent sees the diff + function-scoped
  context, not the entire test suite, so cross-file "is there a test for X"
  reasoning is partial (Genesis exported-symbol data helps when present).
- **Detection quality depends on the LLM.** The test suite mocks the LLM and
  proves the pipeline; real-model precision is best checked with `npm run smoke`.
- `smells` and `isolation` are the most subjective categories and will vary most
  between runs — hence off by default.
