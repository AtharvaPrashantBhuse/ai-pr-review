/**
 * fixtures/safe.js
 *
 * Safe parameterised SQL queries — NO injection vulnerabilities.
 *
 * Used by:
 *   Test 2 — Security Agent must NOT flag SQL injection here.
 *
 * This file is a FIXTURE only. It is NEVER executed in production.
 */

const { Pool } = require('pg');
const pool = new Pool();

// SAFE: parameterised query — $1 is bound by the pg driver, not concatenated.
// User input never enters the SQL string itself.
async function getUserById(req, res) {
  const userId = req.query.userId;
  const result = await pool.query('SELECT * FROM users WHERE id = $1', [userId]);
  res.json(result.rows);
}

// SAFE: named parameters with a prepared statement wrapper.
async function getUserByName(req, res) {
  const name = req.body.name;
  const result = await pool.query(
    'SELECT id, name, email FROM users WHERE name = $1 AND is_active = true',
    [name]
  );
  res.json(result.rows);
}

// SAFE: no user input involved — fully static query.
async function getActiveUsers(_req, res) {
  const result = await pool.query(
    'SELECT id, name FROM users WHERE is_active = true ORDER BY name'
  );
  res.json(result.rows);
}

module.exports = { getUserById, getUserByName, getActiveUsers };
