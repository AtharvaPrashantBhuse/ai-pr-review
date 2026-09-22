/**
 * fixtures/security-issues.js
 *
 * Deliberately insecure JavaScript covering several security categories.
 *
 * Used by the Security Agent / Evidence Validator tests to confirm that
 * security findings across categories verify against real source lines.
 *
 * This file is a FIXTURE only. It is NEVER executed in production.
 * All "credentials" and payloads here are fake, for test coverage only.
 */

/* eslint-disable */

const { exec } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');

// ── COMMAND_INJECTION — user input into a shell command ───────────────────────
function runPing(req, res) {
  const host = req.query.host;
  exec('ping -c 1 ' + host, (e, out) => res.send(out));   // line 22  COMMAND_INJECTION
}

// ── CODE_INJECTION — eval on user input ───────────────────────────────────────
function compute(req, res) {
  const expr = req.body.expr;
  const result = eval(expr);                              // line 29  CODE_INJECTION
  res.json({ result });
}

// ── XSS — unescaped user input into HTML ──────────────────────────────────────
function renderName(req, res) {
  const name = req.query.name;
  res.send('<div>' + name + '</div>');                    // line 36  XSS
}

// ── PATH_TRAVERSAL — user input into a filesystem path ────────────────────────
function readDoc(req, res) {
  const file = req.query.file;
  const data = fs.readFileSync('/var/docs/' + file);      // line 43  PATH_TRAVERSAL
  res.send(data);
}

// ── WEAK_HASH — MD5 used for a password ───────────────────────────────────────
function hashPassword(pw) {
  return crypto.createHash('md5').update(pw).digest('hex'); // line 49  WEAK_HASH
}

// ── INSECURE_RANDOM — Math.random for a token ─────────────────────────────────
function makeToken() {
  return Math.random().toString(36).slice(2);             // line 54  INSECURE_RANDOM
}

// ── DISABLED_CERT_VALIDATION — TLS verification turned off ────────────────────
function fetchInsecure(url, cb) {
  const agent = new https.Agent({ rejectUnauthorized: false }); // line 59  DISABLED_CERT_VALIDATION
  https.get(url, { agent }, cb);
}

module.exports = {
  runPing, compute, renderName, readDoc, hashPassword, makeToken, fetchInsecure,
};
