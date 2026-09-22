# Security Agent

Grounded in `src/agents/securityAgent.js`, `src/agents/findingParser.js`, and
`src/validation/evidenceValidator.js`.

---

## Overview

The Security Agent performs security-focused analysis of the changed code. It:

1. Receives the bounded context (PR diff + targeted source context, plus Genesis
   context when available) from the Context Builder.
2. Builds a security-focused prompt and submits it to the LLM via the Groq
   integration layer.
3. Parses and normalises the LLM's structured JSON findings.

It does **not** make HTTP calls directly (that is the Groq layer), validate
findings against source (that is the Evidence Validator), or report to GitHub
(that is the GitHub Reporter). It detects two vulnerability classes today.

The LLM temperature is kept low for deterministic, factual output. If
`GROQ_API_KEY` is absent, the agent returns a graceful error result rather than
crashing, and no analysis is performed.

### Finding shape

```
{
  "type":        "SQL_INJECTION" | "HARDCODED_SECRET",
  "severity":    "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "confidence":  "LOW" | "MEDIUM" | "HIGH",
  "file":        "relative/path.js",
  "line":        <1-based line number>,
  "evidence":    "the exact offending line of code",
  "explanation": "why it is a vulnerability and the risk"
}
```

The shared finding parser strips markdown code fences, extracts an embedded JSON
array if the model wraps it in prose, coerces field types, and replaces invalid
`severity`/`confidence` values with safe defaults.

---

## SQL Injection check (`SQL_INJECTION`)

**Flagged:** user-controlled input concatenated or interpolated directly into a
SQL string without parameterisation — for example values from
`req.query` / `req.body` / `req.params` or function arguments joined into SQL via
string concatenation or a template literal.

**Not flagged (treated as safe):**

- Parameterised queries (`$1`, `$2`, `?`, or named parameters).
- Prepared statements.
- Static SQL with no user-controlled input.
- Purely theoretical or speculative issues — only clear, exploitable injection.

Fixtures: `fixtures/vulnerable.js` (concatenation and template-literal injection)
and `fixtures/safe.js` (parameterised and static queries).

---

## Hardcoded Secrets check (`HARDCODED_SECRET`)

**Flagged:** a real credential written as a literal in source — API keys and
tokens, access/bearer tokens and OAuth secrets, passwords, JWT signing secrets,
cloud credential strings, personal access tokens, PEM private keys, and
connection strings containing passwords.

A value is flagged only when it is a non-trivial literal **and** the surrounding
context suggests it is a real credential.

**Not flagged (treated as safe):**

- Environment-variable reads (`process.env.SECRET`, `os.environ[...]`, etc.).
- Obvious placeholders (`YOUR_API_KEY`, `<API_KEY>`, `replace-me`, `changeme`,
  `test`, `dummy`, and similar).
- Short generic config strings/identifiers.
- Clearly non-production test-fixture values.

Suggested severity guidance in the prompt: CRITICAL for private keys / broad
root credentials, HIGH for a real production API key/token/password, MEDIUM for
lower-confidence credential-like values.

Fixture: `fixtures/hardcoded-secrets.js` contains positive cases (a fake API
key, password, and access token) and negative cases (env-var reads, a
placeholder, and a short config string).

> Note: the fixture credential-like strings are **fake** values used only for
> testing. No real secrets appear in the repository.

---

## Expected findings and false-positive handling

False positives are controlled at two layers:

1. **Prompt-level guidance.** The system prompt explicitly lists safe patterns
   (parameterised queries, `process.env` reads, placeholders) and instructs the
   model to report only clear, exploitable issues.
2. **Deterministic verification.** Even a confident finding is only surfaced as
   VERIFIED if it matches the real source. This is the primary guard against
   fabricated or misattributed findings.

Findings are informational. The engine never approves, merges, blocks, or edits
the Pull Request based on them.

---

## How the Evidence Validator fits in

After the agent returns findings, each one passes through the Evidence Validator
(`src/validation/evidenceValidator.js`), which is **deterministic and never uses
an LLM**. A finding is marked **VERIFIED** only when:

1. The referenced file exists on disk in the checked-out repository.
2. The reported line number is within the file's line count.
3. The reported evidence appears in the source around the reported line.

Evidence matching is flexible (exact normalised match, substring containment, or
a significant-token overlap threshold) to tolerate minor paraphrasing while
still rejecting unrelated text. Multi-line (range) findings — used more by the
Quality Agent — verify the evidence within the claimed span.

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
