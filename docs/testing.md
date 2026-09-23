# Testing

Grounded in `tests/review.test.js`, `vitest.config.js`, and the workflows under
`.github/workflows/`.

---

## Test suite overview

- **Runner:** Vitest (`vitest run` via `npm test`).
- **Location:** `tests/review.test.js`.
- **Offline & deterministic:** every test that would call the LLM injects mock
  findings through the same parse → validate → report path used in production.
  **No real Groq calls are made and `GROQ_API_KEY` is not required.**
- **Structure:** 69 `describe` groups (labelled Test 1–69) covering the Security
  Agent (SQL injection, hardcoded secrets, and the full security catalog), the
  Evidence Validator, the Context Builder, the Quality Agent catalog/config, the
  Testing Agent catalog/config, finding de-duplication, and the GitHub Reporter.

Run it:

```bash
npm test
```

### Latest results

```
Test Files  1 passed (1)
Tests       212 passed (212)
```

(212 assertions passing, measured with Vitest. Duration is a few seconds on a
typical machine.)

---

## SQL Injection testing

- **Positive (Test 1, 4, 25):** a mock SQL-injection finding against
  `fixtures/vulnerable.js` is normalised correctly and marked **VERIFIED** by the
  Evidence Validator on the real source line. Severity is asserted HIGH/CRITICAL
  and evidence/explanation are non-empty.
- **Negative (Test 2):** for `fixtures/safe.js` (parameterised / static queries)
  the LLM returns an empty array and the pipeline produces no findings.
- **Multiple findings (Test 8):** two injection points in one response are each
  validated independently.

## Hardcoded Secrets testing

- **Positive (Tests 19–21):** mock findings for a hardcoded API key, password,
  and access token in `fixtures/hardcoded-secrets.js` are each **VERIFIED**
  against the real source lines.
- **Negative (Tests 22–23):** environment-variable reads and placeholder values
  produce no findings; a fabricated finding pointing at an env-var/placeholder
  line with unrelated evidence is **UNVERIFIED**.
- **Normalisation (Test 24):** the `HARDCODED_SECRET` type is uppercased,
  invalid severity is coerced to `LOW`, and `CRITICAL` is accepted.
- **Regression + mixed (Tests 25–26):** SQL Injection still works after adding
  secrets, and a single response containing both types is handled and rendered
  together.

> The credential-like strings in the fixture are **fake**, used only for tests.

## Positive and negative test cases (validator)

The Evidence Validator is exercised across both outcomes:

- **VERIFIED:** exact evidence on a known line, and flexible token-overlap
  matches (Tests 1, 4, 38–41, 45).
- **UNVERIFIED:** line beyond end of file, line ≤ 0, missing file, empty file
  field, evidence not present around the claimed line, empty evidence, and a
  range whose end runs past end of file (Tests 3, 5, 6, 7, 31, 38).

This is the core anti-hallucination guarantee: a finding is reported as VERIFIED
only when it matches the checked-out source.

## Context Builder and Quality Agent tests

- **Context Builder (Tests 14–18):** diff parsing into per-file line ranges,
  bounded snippet extraction from a large file, combined-output section
  assembly, missing-file handling, and empty-diff handling. See
  [context-management.md](context-management.md) for the measurements.
- **Quality Agent / catalog (Tests 27–49):** each quality finding type verifies
  and reports; fabricated findings are UNVERIFIED; category configuration
  (defaults, allow-list, disable-list, severity floor) resolves correctly; range
  (multi-line) findings validate against their span; and the reporter groups
  findings by category.
- **Finding de-duplication (Tests 50–55):** overlapping same-location findings
  merge into one primary (security always wins) with the others recorded as
  `alsoFlaggedAs`; findings on different lines or in different files stay
  separate; unknown category keys warn; the master switch is honoured; deduped
  findings still validate correctly.
- **Security catalog (Tests 56–62):** default/allow-list/disable-list config and
  severity floor resolve correctly; unknown keys warn; category metadata and
  range types are correct; representative findings across categories (command
  injection, code injection, XSS, path traversal, weak hash, insecure random,
  disabled cert validation) VERIFY against `fixtures/security-issues.js`, a
  fabricated one is UNVERIFIED; security findings stay primary over overlapping
  quality findings; the reporter groups security findings by their category.
- **Testing catalog (Tests 63–69):** default/allow-list/disable-list config and
  severity floor resolve correctly; unknown keys warn; category metadata and
  range types are correct; representative findings (skipped `.only`, weak
  assertion, time-dependent test, un-awaited async assertion, unrestored mock,
  and a no-assertion range) VERIFY against `fixtures/testing-issues.js`, a
  fabricated one is UNVERIFIED; security stays primary over an overlapping
  testing finding; the reporter groups testing findings by their category.

---

## GitHub Actions end-to-end testing

Two workflows exist under `.github/workflows/`:

- **`ci.yml`** — runs on push and pull_request to this repository. It installs
  dependencies and runs `npm test`. Because the suite is fully mocked, CI does
  **not** require `GROQ_API_KEY`.
- **`reusable-review.yml`** — the `workflow_call` entry point used by caller
  repositories. On a caller PR it checks out the caller repo, builds the PR diff,
  runs the engine (`node .../src/cli/index.js --diff-file pr-diff.txt
  --report-to-pr`), and posts the comment on the caller's PR. Exercising this
  path is a real end-to-end review and requires a `GROQ_API_KEY` secret in the
  caller repository. See [../integration.md](../integration.md).

### Manual live smoke test

For a real (non-mocked) check against the fixtures:

```bash
npm run smoke
```

`scripts/smoke-test.js` makes real Groq calls and prints each finding with its
type, severity, line/range, and VERIFIED/UNVERIFIED status. It is guarded by
`GROQ_API_KEY` and exits 0 (a no-op) when the key is absent, so it never runs in
CI. There are no committed live-run result logs in the repository.
