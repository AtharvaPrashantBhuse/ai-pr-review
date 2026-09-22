/**
 * fixtures/quality-issues.js
 *
 * Deliberately low-quality JavaScript — dead code, duplicate code,
 * logic errors, and bug risks.
 *
 * Used by the Quality Agent / Evidence Validator tests to confirm that
 * code-quality findings can be verified against real source lines on disk.
 *
 * This file is a FIXTURE only. It is NEVER executed in production.
 * The line numbers referenced by the tests are annotated in comments.
 */

/* eslint-disable */

// ── DEAD CODE — statement after an unconditional return ───────────────────────
function computeTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item.price;
  }
  return total;
  total = total * 2;                               // line 23  DEAD_CODE (unreachable)
}

// ── LOGIC ERROR — assignment used where comparison intended ───────────────────
function isAdmin(user) {
  if (user.role = 'admin') {                       // line 28  LOGIC_ERROR (= not ===)
    return true;
  }
  return false;
}

// ── BUG RISK — possible null dereference, no guard ────────────────────────────
function getCity(user) {
  return user.address.city;                        // line 36  BUG_RISK (address may be null)
}

// ── DUPLICATE CODE — two near-identical blocks ────────────────────────────────
function formatUsd(amount) {
  const rounded = Math.round(amount * 100) / 100;  // line 41  DUPLICATE_CODE
  return '$' + rounded.toFixed(2);
}

function formatEur(amount) {
  const rounded = Math.round(amount * 100) / 100;  // line 46  DUPLICATE_CODE (dup of formatUsd)
  return '€' + rounded.toFixed(2);
}

module.exports = { computeTotal, isAdmin, getCity, formatUsd, formatEur };

// ── ERROR_HANDLING — empty catch swallows the error (range 53-57) ─────────────
function loadConfig(path) {
  try {
    return JSON.parse(readFileSync(path));       // line 54
  } catch (e) {                                  // line 55
    // swallowed — caller cannot tell it failed  line 56
  }                                              // line 57
}

// ── MAGIC_NUMBER — unexplained literal constant ───────────────────────────────
function isExpired(createdAt) {
  return Date.now() - createdAt > 86400000;      // line 62  MAGIC_NUMBER (ms in a day)
}

// ── PERFORMANCE — N+1 query inside a loop (range 66-71) ───────────────────────
async function loadUsers(ids, db) {
  const users = [];                              // line 67
  for (const id of ids) {                        // line 68
    users.push(await db.query('SELECT * FROM users WHERE id = $1', [id]));  // line 69
  }                                              // line 70
  return users;                                  // line 71
}

// ── COMPLEXITY — long, deeply nested function (range 75-90) ───────────────────
function classify(n) {                           // line 75
  if (n > 0) {
    if (n > 10) {
      if (n > 100) {
        if (n > 1000) {
          return 'huge';
        }
        return 'big';
      }
      return 'medium';
    }
    return 'small';
  }
  return 'nonpositive';
}                                                // line 90
