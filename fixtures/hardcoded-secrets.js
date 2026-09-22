/**
 * fixtures/hardcoded-secrets.js
 *
 * Deliberately vulnerable JavaScript — hardcoded credentials.
 *
 * Used by the Evidence Validator tests to confirm that HARDCODED_SECRET
 * findings can be verified against real source lines on disk.
 *
 * This file is a FIXTURE only. It is NEVER executed in production.
 * The "credentials" here are fake values used solely for test coverage.
 */

const { Pool } = require('pg');

// ── Positive cases — real-looking hardcoded credentials ───────────────────────

// HARDCODED API KEY: non-trivial string literal assigned to a credential variable.
const API_KEY = "gsk_example_long_credential_value_abc123xyz";           // line 17

// HARDCODED PASSWORD: plaintext password literal in source code.
const dbPassword = "ProductionPassword123!";                              // line 20

// HARDCODED ACCESS TOKEN: looks like a real bearer token.
const accessToken = "long-example-access-token-value-abcdef1234567890";  // line 23

// ── Negative cases — these must NOT be flagged ────────────────────────────────

// SAFE: value comes from environment variable — not hardcoded.
const API_KEY_FROM_ENV = process.env.API_KEY;                             // line 27

// SAFE: placeholder value — clearly not a real credential.
const PLACEHOLDER_KEY = "YOUR_API_KEY";                                   // line 30

// SAFE: short generic config string — not a credential.
const ENV_NAME = "production";                                            // line 33

// ── Database pool — SAFE: credentials come from env vars ─────────────────────

const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  database: process.env.DB_NAME,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,    // SAFE: from env
});

module.exports = { API_KEY, dbPassword, accessToken, pool };
