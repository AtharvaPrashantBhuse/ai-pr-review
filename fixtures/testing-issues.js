/**
 * fixtures/testing-issues.js
 *
 * Deliberately poor test code covering several Testing Agent categories.
 *
 * Used by the Testing Agent / Evidence Validator tests to confirm that testing
 * findings verify against real source lines. This file is NAMED like a source
 * file (not *.test.js) on purpose so the project's own Vitest run does not try
 * to execute it — it is a FIXTURE only and is NEVER executed.
 *
 * The `it`, `expect`, `vi` references below are illustrative, not real calls.
 */

/* eslint-disable */

// ── NO_ASSERTION — a test that runs code but asserts nothing (range 17-19) ────
it('creates a user', () => {
  createUser({ name: 'Ada' });                   // line 18  NO_ASSERTION (no expect)
});

// ── SKIPPED_TEST — focused .only silently drops other tests ───────────────────
it.only('computes total', () => {                // line 22  SKIPPED_TEST (.only)
  expect(total([1, 2])).toBe(3);
});

// ── WEAK_ASSERTION — only truthiness where a value is checkable ───────────────
it('returns a user object', () => {
  const u = getUser(1);
  expect(u).toBeTruthy();                        // line 29  WEAK_ASSERTION
});

// ── TIME_DEPENDENT_TEST — relies on real Date.now without faking ──────────────
it('token expires in a day', () => {
  const exp = makeToken().expiresAt;
  expect(exp).toBe(Date.now() + 86400000);       // line 36  TIME_DEPENDENT_TEST
});

// ── MISSING_AWAIT_ASSERTION — async assertion not awaited ─────────────────────
it('rejects invalid input', () => {
  expect(loadConfig('bad')).rejects.toThrow();   // line 42  MISSING_AWAIT_ASSERTION (no await)
});

// ── UNRESTORED_MOCK — spy created but never restored ──────────────────────────
it('calls the logger', () => {
  const spy = vi.spyOn(console, 'log');          // line 48  UNRESTORED_MOCK (no restore)
  doWork();
  expect(spy).toHaveBeenCalled();
});
