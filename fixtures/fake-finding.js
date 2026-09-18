/**
 * fixtures/fake-finding.js
 *
 * Intentionally innocent file — contains NO vulnerabilities.
 *
 * Used by:
 *   Test 3 — Evidence Validator must return UNVERIFIED for any fabricated finding
 *             that points to a non-existent line or mismatched evidence in this file.
 *
 * The file is deliberately short (< 25 lines total including this header).
 * Any finding that claims:
 *   - A line number > 25
 *   - Evidence that does not appear in this file
 * is demonstrably fabricated and must be rejected as UNVERIFIED.
 *
 * This file is a FIXTURE only. It is NEVER executed in production.
 */

function greet(name) {
  return `Hello, ${name}!`;
}

module.exports = { greet };
