/**
 * fixtures/large-file.js
 *
 * A deliberately large source file used by the context-builder tests.
 *
 * The file is ~400 lines of realistic-looking but inert helper code.
 * A single SQL injection vulnerability is placed near line 200.
 *
 * Test goal: when the PR diff touches only the two lines around the
 * injection, extractSourceContext() must return a snippet that is much
 * smaller than the full file — proving the context builder does NOT
 * forward the entire file to the LLM.
 *
 * This file is a FIXTURE only. It is NEVER executed in production.
 */

'use strict';

const { Pool } = require('pg');
const pool = new Pool();

// ─── Section 1: String utilities (lines 20–80) ───────────────────────────────

function padLeft(str, width, char = ' ') {
  const s = String(str);
  return s.length >= width ? s : char.repeat(width - s.length) + s;
}

function padRight(str, width, char = ' ') {
  const s = String(str);
  return s.length >= width ? s : s + char.repeat(width - s.length);
}

function truncate(str, max, suffix = '…') {
  if (str.length <= max) return str;
  return str.slice(0, max - suffix.length) + suffix;
}

function camelToSnake(str) {
  return str.replace(/[A-Z]/g, c => '_' + c.toLowerCase()).replace(/^_/, '');
}

function snakeToCamel(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function capitalise(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-');
}

function countWords(str) {
  return str.trim().split(/\s+/).filter(Boolean).length;
}

function reverseWords(str) {
  return str.split(/\s+/).reverse().join(' ');
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, '');
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Section 2: Number utilities (lines 82–140) ──────────────────────────────

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0);
}

function average(arr) {
  if (!arr.length) return 0;
  return sum(arr) / arr.length;
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function range(start, end, step = 1) {
  const result = [];
  for (let i = start; i < end; i += step) result.push(i);
  return result;
}

function factorial(n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}

function isPrime(n) {
  if (n < 2) return false;
  for (let i = 2; i <= Math.sqrt(n); i++) {
    if (n % i === 0) return false;
  }
  return true;
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function lcm(a, b) {
  return (a * b) / gcd(a, b);
}

// ─── Section 3: Array utilities (lines 142–200) ──────────────────────────────

function flatten(arr, depth = 1) {
  return depth > 0
    ? arr.reduce((acc, val) =>
        acc.concat(Array.isArray(val) ? flatten(val, depth - 1) : val), [])
    : arr.slice();
}

function unique(arr) {
  return [...new Set(arr)];
}

function groupBy(arr, key) {
  return arr.reduce((acc, item) => {
    const k = typeof key === 'function' ? key(item) : item[key];
    (acc[k] = acc[k] || []).push(item);
    return acc;
  }, {});
}

function chunk(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

function zip(...arrays) {
  const length = Math.min(...arrays.map(a => a.length));
  return Array.from({ length }, (_, i) => arrays.map(a => a[i]));
}

function difference(a, b) {
  const setB = new Set(b);
  return a.filter(x => !setB.has(x));
}

function intersection(a, b) {
  const setB = new Set(b);
  return a.filter(x => setB.has(x));
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Section 4: Database helpers (lines 202–240) ─────────────────────────────
// VULNERABLE FUNCTION — SQL injection via string concatenation.
// The PR diff touches only the getUserReport function below.

async function getUserReport(req, res) {
  const reportId = req.query.reportId;
  // VULNERABLE: reportId is user-controlled and concatenated directly into SQL.
  const sql = 'SELECT * FROM reports WHERE id = ' + reportId;  // SQL INJECTION
  const result = await pool.query(sql);
  res.json(result.rows);
}

async function createReport(req, res) {
  const { title, body, userId } = req.body;
  // SAFE: parameterised query
  const result = await pool.query(
    'INSERT INTO reports (title, body, user_id) VALUES ($1, $2, $3) RETURNING *',
    [title, body, userId]
  );
  res.json(result.rows[0]);
}

async function deleteReport(req, res) {
  const { id } = req.params;
  // SAFE: parameterised query
  await pool.query('DELETE FROM reports WHERE id = $1', [id]);
  res.sendStatus(204);
}

async function listReports(req, res) {
  // SAFE: no user input in query
  const result = await pool.query('SELECT id, title, created_at FROM reports ORDER BY created_at DESC');
  res.json(result.rows);
}

// ─── Section 5: Date utilities (lines 242–300) ───────────────────────────────

function formatDate(date, sep = '-') {
  const d = new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${sep}${m}${sep}${day}`;
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function diffDays(a, b) {
  const msPerDay = 1000 * 60 * 60 * 24;
  return Math.round((new Date(b) - new Date(a)) / msPerDay);
}

function startOfWeek(date) {
  const d = new Date(date);
  const day = d.getDay();
  d.setDate(d.getDate() - day);
  return d;
}

function endOfWeek(date) {
  return addDays(startOfWeek(date), 6);
}

function isWeekend(date) {
  const day = new Date(date).getDay();
  return day === 0 || day === 6;
}

function toUnix(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

function fromUnix(ts) {
  return new Date(ts * 1000);
}

function isoWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  return 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
}

// ─── Section 6: Object utilities (lines 302–360) ─────────────────────────────

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function deepMerge(target, source) {
  const out = Object.assign({}, target);
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      out[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      out[key] = source[key];
    }
  }
  return out;
}

function pick(obj, keys) {
  return keys.reduce((acc, k) => { if (k in obj) acc[k] = obj[k]; return acc; }, {});
}

function omit(obj, keys) {
  const set = new Set(keys);
  return Object.fromEntries(Object.entries(obj).filter(([k]) => !set.has(k)));
}

function invert(obj) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [v, k]));
}

function flattenObj(obj, prefix = '', sep = '.') {
  return Object.entries(obj).reduce((acc, [key, val]) => {
    const newKey = prefix ? `${prefix}${sep}${key}` : key;
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(acc, flattenObj(val, newKey, sep));
    } else {
      acc[newKey] = val;
    }
    return acc;
  }, {});
}

function isEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ─── Section 7: Async utilities (lines 362–400) ──────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retry(fn, times = 3, delayMs = 500) {
  let lastErr;
  for (let i = 0; i < times; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < times - 1) await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

async function mapAsync(arr, fn, concurrency = 4) {
  const results = [];
  for (let i = 0; i < arr.length; i += concurrency) {
    const batch = arr.slice(i, i + concurrency).map(fn);
    results.push(...await Promise.all(batch));
  }
  return results;
}

async function filterAsync(arr, fn) {
  const flags = await Promise.all(arr.map(fn));
  return arr.filter((_, i) => flags[i]);
}

function promisify(fn) {
  return (...args) => new Promise((resolve, reject) => {
    fn(...args, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function timeout(promise, ms) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
  );
  return Promise.race([promise, timer]);
}

module.exports = {
  // string
  padLeft, padRight, truncate, camelToSnake, snakeToCamel,
  capitalise, slugify, countWords, reverseWords, stripHtml, escapeHtml,
  // number
  clamp, lerp, roundTo, sum, average, median, range,
  factorial, isPrime, gcd, lcm,
  // array
  flatten, unique, groupBy, chunk, zip, difference, intersection, shuffle,
  // database
  getUserReport, createReport, deleteReport, listReports,
  // date
  formatDate, addDays, diffDays, startOfWeek, endOfWeek,
  isWeekend, toUnix, fromUnix, isoWeek,
  // object
  deepClone, deepMerge, pick, omit, invert, flattenObj, isEqual,
  // async
  sleep, retry, mapAsync, filterAsync, promisify, timeout,
};
