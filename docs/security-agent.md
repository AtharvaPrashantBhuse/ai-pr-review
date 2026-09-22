# Security Agent

Grounded in `src/agents/securityAgent.js`, `src/agents/securityCatalog.js`,
`src/agents/findingParser.js`, and `src/validation/evidenceValidator.js`.

> See also: [quality-agent.md](quality-agent.md) (the parallel code-quality
> agent) and [checks.md](checks.md) (the complete per-type check reference).

---

## Overview

The Security Agent performs security-focused analysis of the changed code. It:

1. Receives the bounded context (PR diff + targeted source context, plus Genesis
   context when available) from the Context Builder.
2. Builds a **category-scoped** security prompt (only the enabled categories are
   described to the model) and submits it to the LLM via the Groq layer.
3. Parses and normalises the LLM's structured JSON findings.
4. Filters findings to the enabled categories and the configured severity floor.

It does **not** make HTTP calls directly (Groq layer), validate findings against
source (Evidence Validator), or report to GitHub (GitHub Reporter).

The LLM temperature is kept low for deterministic, factual output. If
`GROQ_API_KEY` is absent, the agent returns a graceful error result rather than
crashing. If the security agent is disabled (or all its categories are), it
returns `skipped: true` and makes no LLM call.

### Finding shape

```
{
  "type":        "<a security finding type, e.g. SQL_INJECTION>",
  "severity":    "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
  "confidence":  "LOW" | "MEDIUM" | "HIGH",
  "file":        "relative/path.js",
  "line":        <1-based line number>,
  "endLine":     <optional 1-based end line for a multi-line/range finding>,
  "evidence":    "the exact offending line of code",
  "explanation": "why it is a vulnerability and the risk"
}
```

The shared finding parser strips markdown code fences, extracts an embedded JSON
array if the model wraps it in prose, coerces field types, replaces invalid
`severity`/`confidence` values with safe defaults, and carries an optional
`endLine` for range findings.

---

## Check catalog

`securityCatalog.js` is the single source of truth. Checks are grouped into
categories; each category is individually toggleable.

| Category | Default | Finding types |
|---|---|---|
| **Injection** | on | `SQL_INJECTION`, `NOSQL_INJECTION`, `COMMAND_INJECTION`, `CODE_INJECTION`, `LDAP_INJECTION`, `XPATH_INJECTION`, `TEMPLATE_INJECTION`, `HEADER_INJECTION`, `LOG_INJECTION` |
| **Web / Client-side** | on | `XSS`, `OPEN_REDIRECT`, `CSRF`, `CLICKJACKING`, `INSECURE_CORS`, `POSTMESSAGE_MISUSE` |
| **Secrets & Credentials** | on | `HARDCODED_SECRET`, `WEAK_CRYPTO_KEY`, `SECRET_IN_LOG`, `SECRET_IN_URL` |
| **Cryptography** | on | `WEAK_HASH`, `WEAK_CIPHER`, `INSECURE_RANDOM`, `DISABLED_CERT_VALIDATION`, `MISSING_TLS`, `HARDCODED_IV_SALT` |
| **Files & Resources** | on | `PATH_TRAVERSAL`, `SSRF`, `UNRESTRICTED_FILE_UPLOAD`, `ZIP_SLIP`, `XXE`, `INSECURE_DESERIALIZATION` *(range)*, `REDOS` |
| **Data Exposure** | on | `SENSITIVE_DATA_EXPOSURE`, `VERBOSE_ERROR`, `MASS_ASSIGNMENT`, `PII_LOGGING` |
| **Configuration** | on | `INSECURE_CONFIG`, `MISSING_SECURITY_HEADERS`, `DANGEROUS_PERMISSIONS`, `SUPPLY_CHAIN_RISK` |
| **Auth / Access Control** | **off** | `MISSING_AUTH_CHECK` *(range)*, `BROKEN_ACCESS_CONTROL` *(range)*, `WEAK_PASSWORD_POLICY`, `INSECURE_JWT`, `INSECURE_SESSION`, `PRIVILEGE_ESCALATION` |
| **API / GraphQL** | **off** | `MISSING_RATE_LIMIT`, `GRAPHQL_INTROSPECTION`, `EXCESSIVE_DATA_EXPOSURE` |

**Why some categories are off by default.** `auth` and `api` require reasoning
about a whole handler or endpoint, and often about code outside the diff window.
An LLM working on a bounded diff can only approximate that, so these are opt-in
to keep the out-of-the-box signal high. Turn them on when you want them.

**Deliberately not included.** Known-CVE / vulnerable-dependency detection is
**not** performed by the LLM — an LLM cannot reliably know CVE data. Use a
dedicated scanner (npm audit, OSV, Dependabot, Snyk) for that. The catalog only
contains checks detectable from the changed code itself.

### Representative examples

- `COMMAND_INJECTION` — user input in `exec`/`spawn`/shell strings.
- `CODE_INJECTION` — `eval`, `new Function()`, dynamic `require` on user input.
- `XSS` — unescaped user input into HTML (`innerHTML`, `dangerouslySetInnerHTML`).
- `PATH_TRAVERSAL` — user input into a filesystem path.
- `WEAK_HASH` — MD5/SHA1 for passwords; `WEAK_CIPHER` — DES/RC4/ECB.
- `INSECURE_RANDOM` — `Math.random()` for tokens/keys.
- `DISABLED_CERT_VALIDATION` — `rejectUnauthorized: false` and equivalents.
- `SQL_INJECTION` / `HARDCODED_SECRET` — the original two checks, unchanged.

Fixtures: `fixtures/vulnerable.js` (SQL injection), `fixtures/safe.js` (safe
queries), `fixtures/hardcoded-secrets.js` (secret positives/negatives), and
`fixtures/security-issues.js` (command injection, code injection, XSS, path
traversal, weak hash, insecure random, disabled cert validation). All
credential-like strings in fixtures are **fake**, for tests only.

---

## Configuration

All settings are environment variables and are independent of the quality-agent
settings.

| Variable | Default | Purpose |
|---|---|---|
| `AI_REVIEW_ENABLE_SECURITY` | `true` | Master switch. `false`/`0`/`no`/`off` runs quality only. |
| `AI_REVIEW_SECURITY_CATEGORIES` | *(unset)* | Comma allow-list — run **only** these categories. |
| `AI_REVIEW_DISABLE_SECURITY_CATEGORIES` | *(unset)* | Comma list — remove categories from the default set. |
| `AI_REVIEW_SECURITY_MIN_SEVERITY` | `LOW` | Drop security findings below this severity. |
| `GROQ_SECURITY_MODEL` | *(default model)* | Override the model used for security analysis. |

Unknown category keys are ignored with a logged warning (so a typo does not
silently disable everything). Example:

```yaml
    - name: Run AI Security Review
      env:
        AI_REVIEW_SECURITY_CATEGORIES: "injection,crypto,secrets"
        AI_REVIEW_SECURITY_MIN_SEVERITY: "MEDIUM"
        # opt into the context-heavy checks:
        # AI_REVIEW_SECURITY_CATEGORIES: "injection,web,secrets,crypto,files,data_exposure,config,auth,api"
```

---

## Expected findings and false-positive handling

False positives are controlled at three layers:

1. **Prompt-level guidance.** Each category block lists safe patterns
   (parameterised queries, `process.env` reads, placeholders, strong crypto,
   validated paths) and instructs the model to report only clear issues.
2. **Type + severity filtering.** Findings outside the enabled categories, or
   below the severity floor, are dropped before reporting.
3. **Deterministic verification.** Even a confident finding is only surfaced as
   VERIFIED if it matches the real source (see below).

Overlapping findings on the same location are also de-duplicated
(`src/core/findingDedup.js`); a security finding always remains the primary over
an overlapping quality finding.

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

Evidence matching is flexible (exact normalised match, substring containment, or
a significant-token overlap threshold) to tolerate minor paraphrasing while
rejecting unrelated text. Range (multi-line) findings verify the evidence within
the claimed span.

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
  **correctness** of the security judgment. A finding can be VERIFIED yet still
  be a false positive if the flagged line is not actually exploitable. The
  category filters and prompt guidance reduce this, but do not eliminate it.
- Detection quality depends on the LLM. The test suite exercises the full
  pipeline with mocked findings; real-model precision on live PRs is best
  checked with `npm run smoke`.
- Dataflow-heavy issues (true taint tracking for SSRF, second-order injection)
  and dependency CVEs are outside what an LLM-on-a-diff can do reliably — pair
  this agent with dedicated SAST/scanners for defence in depth.
