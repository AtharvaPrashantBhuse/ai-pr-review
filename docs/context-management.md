# Context Management

How the engine keeps the LLM prompt bounded, and why. Grounded in
`src/core/contextBuilder.js` and the Context Builder tests.

---

## The original problem: sending the entire file

An earlier approach sent the **entire source file** of every changed file to the
LLM for analysis. This does not scale:

- Prompt size grows with **file size**, not with the size of the change. A
  one-line fix in a large file still sent the whole file.
- Large files pushed the prompt past the model's token/size limits.
- Most of the file was irrelevant to the change under review, so the extra
  tokens added cost and latency without improving the review.

## The request-size / 413 issue

When the combined prompt exceeded the provider's accepted request size, the LLM
call failed with an HTTP **413 (Request Entity Too Large)** style error. The
review would fail outright on exactly the large files where review matters most.

## The current solution: bounded, targeted context

The Context Builder assembles a prompt whose size is proportional to **what
changed**, not to the file size. It combines up to three sources:

```
PR diff (what actually changed)
        +
Relevant source context (function-scoped snippets around the changed lines only)
        +
Genesis repository context (symbols, dependencies — only if .genesis/index exists)
        =
Bounded combined prompt  →  Security Agent + Quality Agent
```

Key behaviours (from `contextBuilder.js`):

- **PR diff** is used directly and truncated to its limit.
- **Source context** is extracted only around the changed line ranges. Each
  changed range is expanded to include its enclosing function/block plus a small
  padding, then bounded. Unrelated functions elsewhere in the file are excluded.
- **Genesis context** is included only when available; otherwise the section is
  omitted entirely.
- The combined prompt is hard-capped to a total limit.

The Evidence Validator still reads the **complete** source on disk when
verifying findings — it is intentionally *not* limited to the prompt window — so
bounding the prompt does not weaken verification.

---

## Context / token limits

All limits are character-based and configurable via environment variables
(defaults from `contextBuilder.js`):

| Environment variable | Default | Controls |
|---|---|---|
| `AI_REVIEW_MAX_DIFF_CHARS` | 8,000 | PR diff section |
| `AI_REVIEW_MAX_SOURCE_CONTEXT_CHARS` | 12,000 | Source-snippet section |
| `AI_REVIEW_MAX_GENESIS_CONTEXT_CHARS` | 4,000 | Genesis context section |
| `AI_REVIEW_MAX_PROMPT_CHARS` | 24,000 | Total combined prompt |

Each section is truncated to its own limit; the combined prompt is then capped
to the total limit. When a section is cut, a short truncation marker is appended.

### Diagnostics

Before the LLM call, the engine logs character counts only (no source, no
secrets), for example:

```
[AI-Review] Groq model:            openai/gpt-oss-20b
[AI-Review] Diff chars:            <n>
[AI-Review] Source context chars:  <n>
[AI-Review] Genesis context chars: <n>
[AI-Review] User prompt chars:     <n>
```

These make it possible to diagnose size issues without inspecting the code.

---

## Test measurements

The bounding is verified by the Context Builder test suite
(`tests/review.test.js`, Tests 14–18) using the `fixtures/large-file.js`
fixture.

- `fixtures/large-file.js` size: **~10,978 bytes across 396 lines** (measured).
- For a diff touching only the lines around the injection point, the extracted
  source snippet is asserted to be:
  - **strictly smaller** than the full file, and
  - **less than 40%** of the full file's size.
- The snippet is asserted to **contain** the changed function
  (`getUserReport`) and its evidence, and to **exclude** unrelated helpers
  (`isoWeek`, `promisify`, `slugify`).
- A tight `maxChars` budget (e.g. 300) is respected: the output length stays
  within the budget plus the truncation marker.
- With an empty Genesis input, `buildContext` produces **no** Genesis section
  (Test 16), consistent with Genesis being unavailable in this repository.

These are the latest measurements available in the code and tests; there are no
production-run size logs committed to the repository.
