/**
 * src/users.VULNERABLE.js
 *
 * ⚠️  THIS IS THE VULNERABLE VERSION FOR THE DEMO BRANCH  ⚠️
 *
 * On the `vuln/sql-injection` branch, the content of `src/users.js`
 * is REPLACED with this vulnerable implementation.
 *
 * This file is provided as a reference so you can copy-paste the
 * content into src/users.js when creating the demo PR.
 *
 * DO NOT commit this file as users.js on the main branch.
 * DO NOT use this code in production — it is deliberately insecure.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DEMO STEPS:
 *   1. Create branch: git checkout -b vuln/sql-injection
 *   2. Copy content of this file into src/users.js  (overwrite the safe version)
 *   3. git add src/users.js
 *   4. git commit -m "demo: introduce SQL injection vulnerability"
 *   5. git push origin vuln/sql-injection
 *   6. Open a Pull Request from vuln/sql-injection → main
 *   7. GitHub Actions runs the AI security review automatically
 *   8. The reviewer detects and VERIFIES the injection
 *   9. A comment appears on this PR showing the findings
 * ─────────────────────────────────────────────────────────────────────────────
 */

const { Pool } = require('pg');
const pool = new Pool();

/**
 * Get a user by their ID.
 * VULNERABLE: user input from req.query.userId is concatenated into SQL.
 * Attack: userId = "1 OR 1=1 --"  returns all rows.
 */
async function getUserById(req, res) {
  const userId = req.query.userId;
  const sql = 'SELECT * FROM users WHERE id = ' + userId;  // SQL INJECTION
  const result = await pool.query(sql);
  res.json(result.rows);
}

/**
 * Get a user by name.
 * VULNERABLE: template literal embeds user input directly into SQL.
 * Attack: name = "' OR '1'='1"  bypasses the WHERE clause.
 */
// Testing AI PR Security Review


async function getUserByName(req, res) {
  const name = req.body.name;
  const result = await pool.query(`SELECT * FROM users WHERE name = '${name}'`);  // SQL INJECTION
  res.json(result.rows);
}

/**
 * Get all active users.
 * SAFE: no user input — the AI reviewer should NOT flag this.
 */
async function getActiveUsers(_req, res) {
  const result = await pool.query(
    'SELECT id, name FROM users WHERE is_active = true ORDER BY name'
  );
  res.json(result.rows);
}

module.exports = { getUserById, getUserByName, getActiveUsers };
