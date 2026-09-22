/**
 * src/agents/checkCatalog.js
 *
 * The single source of truth for the code-quality check catalog.
 *
 * This module defines:
 *   - Every code-quality finding TYPE the Quality Agent may emit.
 *   - The CATEGORY each type belongs to (used for grouping + toggling).
 *   - Which categories are RANGE-based (span multiple lines) vs line-anchored.
 *   - The default enable/disable state per category (high-signal defaults).
 *   - The environment-driven configuration that turns categories on/off and
 *     applies a global minimum severity floor.
 *
 * Design goals:
 *   - Adding a new check is a data change here, not a code change elsewhere.
 *   - Categories are individually toggleable so teams can tune signal/noise.
 *   - Subjective / high-noise categories (STYLE, TEST_COVERAGE) are OFF by
 *     default so the tool is useful out of the box for peer-review automation.
 *
 * Configuration (all optional):
 *   AI_REVIEW_ENABLE_QUALITY        master switch (default on)
 *   AI_REVIEW_QUALITY_CATEGORIES    comma list to force-enable an explicit set
 *                                   e.g. "correctness,error_handling,performance"
 *                                   When set, ONLY those categories run.
 *   AI_REVIEW_DISABLE_CATEGORIES    comma list to disable specific categories
 *                                   e.g. "style,maintainability"
 *   AI_REVIEW_QUALITY_MIN_SEVERITY  drop findings below this severity
 *                                   one of LOW|MEDIUM|HIGH|CRITICAL (default LOW)
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
 *   rangeTypes   subset of types that are range-based (multi-line, need endLine)
 *   defaultOn    whether the category runs when no explicit config is given
 */
export const CATEGORIES = [
  {
    key:        'correctness',
    label:      'Correctness',
    icon:       '🐞',
    types:      ['LOGIC_ERROR', 'BUG_RISK'],
    rangeTypes: [],
    defaultOn:  true,
  },
  {
    key:        'dead_code',
    label:      'Dead Code',
    icon:       '🧹',
    types:      ['DEAD_CODE'],
    rangeTypes: [],
    defaultOn:  true,
  },
  {
    key:        'duplication',
    label:      'Duplication',
    icon:       '📋',
    types:      ['DUPLICATE_CODE'],
    rangeTypes: ['DUPLICATE_CODE'],
    defaultOn:  true,
  },
  {
    key:        'error_handling',
    label:      'Error Handling',
    icon:       '🛟',
    types:      ['ERROR_HANDLING'],
    rangeTypes: ['ERROR_HANDLING'],
    defaultOn:  true,
  },
  {
    key:        'maintainability',
    label:      'Maintainability',
    icon:       '🔧',
    types:      ['MAINTAINABILITY', 'COMPLEXITY', 'NAMING', 'MAGIC_NUMBER', 'DOCUMENTATION'],
    rangeTypes: ['COMPLEXITY', 'MAINTAINABILITY'],
    defaultOn:  true,
  },
  {
    key:        'performance',
    label:      'Performance',
    icon:       '⚡',
    types:      ['PERFORMANCE'],
    rangeTypes: ['PERFORMANCE'],
    defaultOn:  true,
  },
  {
    key:        'api_contract',
    label:      'API / Contract',
    icon:       '🔌',
    types:      ['API_CONTRACT'],
    rangeTypes: [],
    defaultOn:  true,
  },
  {
    key:        'style',
    label:      'Style',
    icon:       '🎨',
    types:      ['STYLE'],
    rangeTypes: [],
    defaultOn:  false,   // subjective — off by default to keep signal high
  },
  {
    key:        'test_coverage',
    label:      'Test Coverage',
    icon:       '🧪',
    types:      ['TEST_COVERAGE'],
    rangeTypes: [],
    defaultOn:  false,   // needs whole-PR context; off by default in v1
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Derived lookup tables
// ─────────────────────────────────────────────────────────────────────────────

/** All quality finding types across every category. */
export const ALL_QUALITY_TYPES = new Set(
  CATEGORIES.flatMap(c => c.types)
);

/** All range-based finding types (need an endLine to validate a span). */
export const RANGE_TYPES = new Set(
  CATEGORIES.flatMap(c => c.rangeTypes)
);

/** type → category key */
const TYPE_TO_CATEGORY = new Map();
for (const c of CATEGORIES) {
  for (const t of c.types) TYPE_TO_CATEGORY.set(t, c.key);
}

/** type → category descriptor (label, icon, key) */
const TYPE_TO_CATEGORY_META = new Map();
for (const c of CATEGORIES) {
  for (const t of c.types) {
    TYPE_TO_CATEGORY_META.set(t, { key: c.key, label: c.label, icon: c.icon });
  }
}

/**
 * Category descriptor for a finding type. Falls back to an "Other" bucket so
 * an unexpected type from the LLM is still displayed rather than dropped.
 *
 * @param {string} type
 * @returns {{ key: string, label: string, icon: string }}
 */
export function categoryMetaForType(type) {
  return TYPE_TO_CATEGORY_META.get(type) || { key: 'other', label: 'Other', icon: 'ℹ️' };
}

/** @param {string} type @returns {boolean} */
export function isRangeType(type) {
  return RANGE_TYPES.has(type);
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
 * Resolve the effective quality configuration from the environment.
 *
 * @param {Object} [env=process.env]
 * @returns {{
 *   enabled: boolean,
 *   enabledCategories: Set<string>,
 *   enabledTypes: Set<string>,
 *   minSeverity: string
 * }}
 */
export function resolveQualityConfig(env = process.env) {
  // Master switch
  const enabled = !isFalsey(env.AI_REVIEW_ENABLE_QUALITY ?? 'true');

  const allKeys = CATEGORIES.map(c => c.key);
  let enabledCategories;

  const explicit = parseList(env.AI_REVIEW_QUALITY_CATEGORIES);
  if (explicit.length > 0) {
    // Explicit allow-list: ONLY these categories (that are known) run.
    const known = new Set(allKeys);
    enabledCategories = new Set(explicit.filter(k => known.has(k)));
  } else {
    // Start from the default-on set, then apply the disable list.
    enabledCategories = new Set(
      CATEGORIES.filter(c => c.defaultOn).map(c => c.key)
    );
  }

  const disabled = parseList(env.AI_REVIEW_DISABLE_CATEGORIES);
  for (const key of disabled) enabledCategories.delete(key);

  // Expand enabled categories into their finding types.
  const enabledTypes = new Set();
  for (const c of CATEGORIES) {
    if (enabledCategories.has(c.key)) {
      for (const t of c.types) enabledTypes.add(t);
    }
  }

  const minSeverity = String(env.AI_REVIEW_QUALITY_MIN_SEVERITY || 'LOW').toUpperCase();

  return {
    enabled,
    enabledCategories,
    enabledTypes,
    minSeverity: SEVERITY_RANK[minSeverity] ? minSeverity : 'LOW',
  };
}

/**
 * Filter a list of parsed findings down to the configured quality types and
 * severity floor. Types not owned by any quality category are left untouched
 * ONLY if `keepUnknown` is true (the security path passes its own findings
 * through a different filter, so this is quality-only by default).
 *
 * @param {Array}  findings
 * @param {Object} config      result of resolveQualityConfig()
 * @returns {Array}
 */
export function filterQualityFindings(findings, config) {
  if (!Array.isArray(findings)) return [];
  return findings.filter(f =>
    config.enabledTypes.has(f.type) &&
    meetsSeverityFloor(f.severity, config.minSeverity)
  );
}
