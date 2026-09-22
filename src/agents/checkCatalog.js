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
 *                                   NOTE: this floor applies to QUALITY findings
 *                                   only. Security findings are on a separate
 *                                   path and are never suppressed by it.
 *
 * Unknown category keys in AI_REVIEW_QUALITY_CATEGORIES or
 * AI_REVIEW_DISABLE_CATEGORIES are ignored, and a warning is logged so a typo
 * (e.g. "corectness") does not silently disable everything.
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
 * Log a warning for any category keys that are not recognised. A typo in the
 * config (e.g. "corectness") would otherwise be dropped silently — and if it
 * was the only entry in the allow-list, the whole agent would quietly do
 * nothing. Warning makes the misconfiguration visible.
 *
 * @param {string[]} keys      keys supplied by the user
 * @param {Set<string>} known  the set of valid category keys
 * @param {string} source      the env var name, for the message
 */
function warnUnknownCategories(keys, known, source) {
  const unknown = keys.filter(k => !known.has(k));
  if (unknown.length > 0) {
    console.warn(
      `[AI-Review] Ignoring unknown categor${unknown.length === 1 ? 'y' : 'ies'} ` +
      `in ${source}: ${unknown.join(', ')}. ` +
      `Valid categories: ${[...known].join(', ')}.`
    );
  }
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

  const known = new Set(CATEGORIES.map(c => c.key));
  let enabledCategories;

  const explicit = parseList(env.AI_REVIEW_QUALITY_CATEGORIES);
  if (explicit.length > 0) {
    warnUnknownCategories(explicit, known, 'AI_REVIEW_QUALITY_CATEGORIES');
    // Explicit allow-list: ONLY these categories (that are known) run.
    enabledCategories = new Set(explicit.filter(k => known.has(k)));
  } else {
    // Start from the default-on set, then apply the disable list.
    enabledCategories = new Set(
      CATEGORIES.filter(c => c.defaultOn).map(c => c.key)
    );
  }

  const disabled = parseList(env.AI_REVIEW_DISABLE_CATEGORIES);
  warnUnknownCategories(disabled, known, 'AI_REVIEW_DISABLE_CATEGORIES');
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
 * severity floor.
 *
 * Only findings whose `type` belongs to an enabled quality category are kept;
 * any other type (including security types, or an unexpected type from the LLM)
 * is dropped here. The severity floor is applied on top. This is intentionally
 * quality-only: security findings are produced and filtered on a separate path
 * and are never subject to the quality severity floor.
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
