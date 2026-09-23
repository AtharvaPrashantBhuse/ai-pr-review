/**
 * src/agents/testingCatalog.js
 *
 * The single source of truth for the TESTING check catalog.
 *
 * Mirrors src/agents/securityCatalog.js and src/agents/checkCatalog.js but for
 * the Testing Agent. It defines:
 *   - Every testing finding TYPE the Testing Agent may emit.
 *   - The CATEGORY each type belongs to (used for grouping + toggling).
 *   - Which types are RANGE-based (span multiple lines, need endLine).
 *   - The default enable/disable state per category.
 *   - The environment-driven configuration (toggles + severity floor).
 *
 * Scope: the Testing Agent reviews TEST code and the test-related aspects of a
 * change. Like the other agents it detects via the LLM, and every finding is
 * verified line-by-line against source by the deterministic Evidence Validator.
 *
 * Honest limitation: the engine does NOT run the test suite or read a coverage
 * report. "Missing test" findings are therefore an inference from the diff and
 * repository context, not a measured coverage delta. That is why the coverage
 * category leans on Genesis context when available and is best-effort.
 *
 * Design goals:
 *   - Adding a new check is a data change here, not a code change elsewhere.
 *   - Categories are individually toggleable so teams tune signal/noise.
 *   - Checks anchored to visible test code (assertions, flakiness, hygiene,
 *     mocking, async) are ON by default. Noisier / more subjective categories
 *     (isolation, smells) are OFF by default.
 *
 * Configuration (all optional):
 *   AI_REVIEW_ENABLE_TESTING         master switch (default on)
 *   AI_REVIEW_TESTING_CATEGORIES     comma allow-list — run ONLY these
 *   AI_REVIEW_DISABLE_TESTING_CATEGORIES  comma list — remove from defaults
 *   AI_REVIEW_TESTING_MIN_SEVERITY   drop findings below this severity
 *                                    (LOW|MEDIUM|HIGH|CRITICAL, default LOW)
 *
 * NOTE: this severity floor applies to TESTING findings only — separate from
 * the security and quality floors.
 *
 * Category keys are lowercase; finding types are SCREAMING_SNAKE_CASE.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Category definitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Each category has:
 *   key          canonical lowercase id used in env config
 *   label        human display label (used in PR comment grouping)
 *   icon         emoji for the PR comment
 *   types        the finding types that belong to this category
 *   rangeTypes   subset of types that are range-based (multi-line)
 *   defaultOn    whether the category runs when no explicit config is given
 */
export const TESTING_CATEGORIES = [
  {
    key:        'coverage',
    label:      'Test Coverage',
    icon:       '🧪',
    types:      ['MISSING_TEST', 'UNTESTED_EDGE_CASE', 'UNTESTED_ERROR_PATH'],
    rangeTypes: [],
    defaultOn:  true,
  },
  {
    key:        'assertions',
    label:      'Assertions',
    icon:       '🎯',
    types:      ['NO_ASSERTION', 'WEAK_ASSERTION', 'ASSERTION_ON_MOCK', 'SNAPSHOT_OVERUSE'],
    rangeTypes: ['NO_ASSERTION'],
    defaultOn:  true,
  },
  {
    key:        'flakiness',
    label:      'Flakiness',
    icon:       '🎲',
    types:      [
      'TIME_DEPENDENT_TEST', 'RANDOMNESS_IN_TEST', 'ORDER_DEPENDENT_TEST',
      'NETWORK_IN_UNIT_TEST', 'RACE_IN_TEST',
    ],
    rangeTypes: [],
    defaultOn:  true,
  },
  {
    key:        'hygiene',
    label:      'Test Hygiene',
    icon:       '🧼',
    types:      [
      'SKIPPED_TEST', 'EMPTY_TEST', 'COMMENTED_OUT_TEST', 'DUPLICATE_TEST',
      'POOR_TEST_NAME',
    ],
    rangeTypes: ['EMPTY_TEST', 'COMMENTED_OUT_TEST'],
    defaultOn:  true,
  },
  {
    key:        'mocking',
    label:      'Mocking',
    icon:       '🎭',
    types:      ['UNRESTORED_MOCK', 'OVER_MOCKING', 'MISSING_MOCK_CLEANUP'],
    rangeTypes: ['OVER_MOCKING'],
    defaultOn:  true,
  },
  {
    key:        'async',
    label:      'Async Correctness',
    icon:       '⏳',
    types:      ['MISSING_AWAIT_ASSERTION', 'PROMISE_NOT_RETURNED', 'MISSING_DONE_CALLBACK'],
    rangeTypes: [],
    defaultOn:  true,
  },
  {
    key:        'isolation',
    label:      'Test Data & Isolation',
    icon:       '🧱',
    types:      ['SHARED_MUTABLE_FIXTURE', 'HARDCODED_TEST_DATA', 'MISSING_CLEANUP'],
    rangeTypes: [],
    defaultOn:  false,   // noisier → opt-in
  },
  {
    key:        'smells',
    label:      'Test Smells',
    icon:       '👃',
    types:      ['TEST_LOGIC', 'MULTIPLE_CONCERNS', 'TESTING_IMPLEMENTATION', 'TRIVIAL_TEST'],
    rangeTypes: ['TEST_LOGIC', 'MULTIPLE_CONCERNS'],
    defaultOn:  false,   // subjective → opt-in
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Derived lookup tables
// ─────────────────────────────────────────────────────────────────────────────

/** All testing finding types across every category. */
export const ALL_TESTING_TYPES = new Set(
  TESTING_CATEGORIES.flatMap(c => c.types)
);

/** All range-based testing finding types. */
export const TESTING_RANGE_TYPES = new Set(
  TESTING_CATEGORIES.flatMap(c => c.rangeTypes)
);

/** type → category descriptor (label, icon, key) */
const TYPE_TO_CATEGORY_META = new Map();
for (const c of TESTING_CATEGORIES) {
  for (const t of c.types) {
    TYPE_TO_CATEGORY_META.set(t, { key: c.key, label: c.label, icon: c.icon });
  }
}

/**
 * Category descriptor for a testing finding type. Falls back to a generic
 * Testing bucket so an unexpected type is still displayed rather than dropped.
 *
 * @param {string} type
 * @returns {{ key: string, label: string, icon: string }}
 */
export function testingCategoryMetaForType(type) {
  return TYPE_TO_CATEGORY_META.get(type) || { key: 'testing', label: 'Testing', icon: '🧪' };
}

/** @param {string} type @returns {boolean} */
export function isTestingRangeType(type) {
  return TESTING_RANGE_TYPES.has(type);
}

// ─────────────────────────────────────────────────────────────────────────────
// Severity floor
// ─────────────────────────────────────────────────────────────────────────────

const SEVERITY_RANK = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

/**
 * @param {string} severity
 * @param {string} floor
 * @returns {boolean} true when severity >= floor
 */
export function meetsSeverityFloor(severity, floor) {
  const s = SEVERITY_RANK[String(severity || '').toUpperCase()] || 1;
  const f = SEVERITY_RANK[String(floor || 'LOW').toUpperCase()]  || 1;
  return s >= f;
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment-driven configuration
// ─────────────────────────────────────────────────────────────────────────────

function parseList(value) {
  return String(value || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function isFalsey(value) {
  const v = String(value ?? '').trim().toLowerCase();
  return ['false', '0', 'no', 'off'].includes(v);
}

/**
 * Log a warning for unrecognised category keys so a typo does not silently
 * disable everything.
 */
function warnUnknownCategories(keys, known, source) {
  const unknown = keys.filter(k => !known.has(k));
  if (unknown.length > 0) {
    console.warn(
      `[AI-Review] Ignoring unknown testing categor${unknown.length === 1 ? 'y' : 'ies'} ` +
      `in ${source}: ${unknown.join(', ')}. ` +
      `Valid categories: ${[...known].join(', ')}.`
    );
  }
}

/**
 * Resolve the effective testing configuration from the environment.
 *
 * @param {Object} [env=process.env]
 * @returns {{
 *   enabled: boolean,
 *   enabledCategories: Set<string>,
 *   enabledTypes: Set<string>,
 *   minSeverity: string
 * }}
 */
export function resolveTestingConfig(env = process.env) {
  const enabled = !isFalsey(env.AI_REVIEW_ENABLE_TESTING ?? 'true');

  const known = new Set(TESTING_CATEGORIES.map(c => c.key));
  let enabledCategories;

  const explicit = parseList(env.AI_REVIEW_TESTING_CATEGORIES);
  if (explicit.length > 0) {
    warnUnknownCategories(explicit, known, 'AI_REVIEW_TESTING_CATEGORIES');
    enabledCategories = new Set(explicit.filter(k => known.has(k)));
  } else {
    enabledCategories = new Set(
      TESTING_CATEGORIES.filter(c => c.defaultOn).map(c => c.key)
    );
  }

  const disabled = parseList(env.AI_REVIEW_DISABLE_TESTING_CATEGORIES);
  warnUnknownCategories(disabled, known, 'AI_REVIEW_DISABLE_TESTING_CATEGORIES');
  for (const key of disabled) enabledCategories.delete(key);

  const enabledTypes = new Set();
  for (const c of TESTING_CATEGORIES) {
    if (enabledCategories.has(c.key)) {
      for (const t of c.types) enabledTypes.add(t);
    }
  }

  const minSeverity = String(env.AI_REVIEW_TESTING_MIN_SEVERITY || 'LOW').toUpperCase();

  return {
    enabled,
    enabledCategories,
    enabledTypes,
    minSeverity: SEVERITY_RANK[minSeverity] ? minSeverity : 'LOW',
  };
}

/**
 * Filter parsed findings to the configured testing types + severity floor.
 * Only types owned by an enabled testing category are kept.
 *
 * @param {Array}  findings
 * @param {Object} config    result of resolveTestingConfig()
 * @returns {Array}
 */
export function filterTestingFindings(findings, config) {
  if (!Array.isArray(findings)) return [];
  return findings.filter(f =>
    config.enabledTypes.has(f.type) &&
    meetsSeverityFloor(f.severity, config.minSeverity)
  );
}
