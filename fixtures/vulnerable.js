/**
 * fixtures/vulnerable.js
 *
 * Deliberately vulnerable JavaScript — SQL Injection via string concatenation.
 *
 * Used by:
 *   Test 1 — Security Agent must identify the SQL injection.
 *   Evidence Validator must mark it VERIFIED against this source.
 *
 * This file is a FIXTURE only. It is NEVER executed in production.
 * It exists solely to give the LLM something real to detect.
 */

const { Pool } = require('pg');
const pool = new Pool();

// VULNERABLE: user-supplied input is directly concatenated into the SQL string.
// An attacker who controls `req.query.userId` can manipulate the query.
// e.g. userId = "1 OR 1=1 --" returns all rows.
async function getUserById(req, res) {
  const userId = req.query.userId;
  const sql = 'SELECT * FROM users WHERE id = ' + userId;  // SQL INJECTION
  const result = await pool.query(sql);
  res.json(result.rows);
}

// VULNERABLE: template literal embeds user input — also injectable.
// e.g. name = "' OR '1'='1" bypasses the WHERE clause.
async function getUserByName(req, res) {
  const name = req.body.name;
  const result = await pool.query(`SELECT * FROM users WHERE name = '${name}'`);  // SQL INJECTION
  res.json(result.rows);
}

module.exports = { getUserById, getUserByName };
