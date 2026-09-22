/**
 * src/agents/securityCatalog.js
 *
 * The single source of truth for the SECURITY check catalog.
 *
 * Mirrors src/agents/checkCatalog.js (the quality catalog) but for the
 * Security Agent. It defines:
 *   - Every security finding TYPE the Security Agent may emit.
 *   - The CATEGORY each type belongs to (used for grouping + toggling).
 *   - Which types are RANGE-based (span multiple lines, need endLine).
 *   - The default enable/disable state per category.
 *   - The environment-driven configuration (toggles + severity floor).
 *
 * Design goals:
 *   - Adding a new security check is a data change here, not a code change.
 *   - Categories are individually toggleable so teams tune signal/noise.
 *   - "Tier 1" categories that fit LLM-on-a-diff detection well are ON by
 *     default. Noisier / context-heavy categories (auth, data exposure, API)
 *     are OFF by default to keep the out-of-the-box signal high.
 *   - Dependency/CVE scanning is deliberately NOT here — that belongs to a
 *     real scanner (npm audit / OSV), not an LLM.
 *
 * Configuration (all optional):
 *   AI_REVIEW_ENABLE_SECURITY        master switch (default on)
 *   AI_REVIEW_SECURITY_CATEGORIES    comma allow-list — run ONLY these
 *   AI_REVIEW_DISABLE_SECURITY_CATEGORIES  comma list — remove from defaults
 *   AI_REVIEW_SECURITY_MIN_SEVERITY  drop findings below this severity
 *                                    (LOW|MEDIUM|HIGH|CRITICAL, default LOW)
 *
 * NOTE: The severity floor here applies to SECURITY findings only. It is a
 * separate control from the quality floor. By default it is LOW (i.e. surface
 * everything) because suppressing security findings is a deliberate choice.
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
export const SECURITY_CATEGORIES = [
  {
    key:        'injection',
    label:      'Injection',
    icon:       '💉',
    types:      [
      'SQL_INJECTION', 'NOSQL_INJECTION', 'COMMAND_INJECTION', 'CODE_INJECTION',
      'LDAP_INJECTION', 'XPATH_INJECTION', 'TEMPLATE_INJECTION', 'HEADER_INJECTION',
      'LOG_INJECTION',
    ],
    rangeTypes: [],
    defaultOn:  true,
  },
  {
    key:        'web',
    label:      'Web / Client-side',
    icon:       '🌐',
    types:      [
      'XSS', 'OPEN_REDIRECT', 'CSRF', 'CLICKJACKING', 'INSECURE_CORS',
      'POSTMESSAGE_MISUSE',
    ],
    rangeTypes: [],
    defaultOn:  true,
  },
  {
    key:        'secrets',
    label:      'Secrets & Credentials',
    icon:       '🔑',
    types:      ['HARDCODED_SECRET', 'WEAK_CRYPTO_KEY', 'SECRET_IN_LOG', 'SECRET_IN_URL'],
    rangeTypes: [],
    defaultOn:  true,
  },
  {
    key:        'crypto',
    label:      'Cryptography',
    icon:       '🔐',
    types:      [
      'WEAK_HASH', 'WEAK_CIPHER', 'INSECURE_RANDOM', 'DISABLED_CERT_VALIDATION',
      'MISSING_TLS', 'HARDCODED_IV_SALT',
    ],
    rangeTypes: [],
    defaultOn:  true,
  },
  {
    key:        'files',
    label:      'Files & Resources',
    icon:       '📁',
    types:      [
      'PATH_TRAVERSAL', 'SSRF', 'UNRESTRICTED_FILE_UPLOAD', 'ZIP_SLIP', 'XXE',
      'INSECURE_DESERIALIZATION', 'REDOS',
    ],
    rangeTypes: ['INSECURE_DESERIALIZATION'],
    defaultOn:  true,
  },
  {
    key:        'data_exposure',
    label:      'Data Exposure',
    icon:       '📤',
    types:      [
      'SENSITIVE_DATA_EXPOSURE', 'VERBOSE_ERROR', 'MASS_ASSIGNMENT', 'PII_LOGGING',
    ],
    rangeTypes: [],
    defaultOn:  true,
  },
  {
    key:        'config',
    label:      'Configuration',
    icon:       '⚙️',
    types:      [
      'INSECURE_CONFIG', 'MISSING_SECURITY_HEADERS', 'DANGEROUS_PERMISSIONS',
      'SUPPLY_CHAIN_RISK',
    ],
    rangeTypes: [],
    defaultOn:  true,
  },
  {
    key:        'auth',
    label:      'Auth / Access Control',
    icon:       '🛂',
    types:      [
      'MISSING_AUTH_CHECK', 'BROKEN_ACCESS_CONTROL', 'WEAK_PASSWORD_POLICY',
      'INSECURE_JWT', 'INSECURE_SESSION', 'PRIVILEGE_ESCALATION',
    ],
    rangeTypes: ['MISSING_AUTH_CHECK', 'BROKEN_ACCESS_CONTROL'],
    defaultOn:  false,   // context-heavy → higher false-positive risk; opt-in
  },
  {
    key:        'api',
    label:      'API / GraphQL',
    icon:       '🔌',
    types:      ['MISSING_RATE_LIMIT', 'GRAPHQL_INTROSPECTION', 'EXCESSIVE_DATA_EXPOSURE'],
    rangeTypes: [],
    defaultOn:  false,   // needs whole-endpoint context; opt-in
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Derived lookup tables
// ─────────────────────────────────────────────────────────────────────────────

/** All security finding types across every category. */
export const ALL_SECURITY_TYPES = new Set(
  SECURITY_CATEGORIES.flatMap(c => c.types)
);

/** All range-based security finding types. */
export const SECURITY_RANGE_TYPES = new Set(
  SECURITY_CATEGORIES.flatMap(c => c.rangeTypes)
);

/** type → category descriptor (label, icon, key) */
const TYPE_TO_CATEGORY_META = new Map();
for (const c of SECURITY_CATEGORIES) {
  for (const t of c.types) {
    TYPE_TO_CATEGORY_META.set(t, { key: c.key, label: c.label, icon: c.icon });
  }
}

/**
 * Category descriptor for a security finding type. Falls back to a generic
 * Security bucket so an unexpected type is still displayed rather than dropped.
 *
 * @param {string} type
 * @returns {{ key: string, label: string, icon: string }}
 */
export function securityCategoryMetaForType(type) {
  return TYPE_TO_CATEGORY_META.get(type) || { key: 'security', label: 'Security', icon: '🔐' };
}

/** @param {string} type @returns {boolean} */
export function isSecurityRangeType(type) {
  return SECURITY_RANGE_TYPES.has(type);
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
      `[AI-Review] Ignoring unknown security categor${unknown.length === 1 ? 'y' : 'ies'} ` +
      `in ${source}: ${unknown.join(', ')}. ` +
      `Valid categories: ${[...known].join(', ')}.`
    );
  }
}

/**
 * Resolve the effective security configuration from the environment.
 *
 * @param {Object} [env=process.env]
 * @returns {{
 *   enabled: boolean,
 *   enabledCategories: Set<string>,
 *   enabledTypes: Set<string>,
 *   minSeverity: string
 * }}
 */
export function resolveSecurityConfig(env = process.env) {
  const enabled = !isFalsey(env.AI_REVIEW_ENABLE_SECURITY ?? 'true');

  const known = new Set(SECURITY_CATEGORIES.map(c => c.key));
  let enabledCategories;

  const explicit = parseList(env.AI_REVIEW_SECURITY_CATEGORIES);
  if (explicit.length > 0) {
    warnUnknownCategories(explicit, known, 'AI_REVIEW_SECURITY_CATEGORIES');
    enabledCategories = new Set(explicit.filter(k => known.has(k)));
  } else {
    enabledCategories = new Set(
      SECURITY_CATEGORIES.filter(c => c.defaultOn).map(c => c.key)
    );
  }

  const disabled = parseList(env.AI_REVIEW_DISABLE_SECURITY_CATEGORIES);
  warnUnknownCategories(disabled, known, 'AI_REVIEW_DISABLE_SECURITY_CATEGORIES');
  for (const key of disabled) enabledCategories.delete(key);

  const enabledTypes = new Set();
  for (const c of SECURITY_CATEGORIES) {
    if (enabledCategories.has(c.key)) {
      for (const t of c.types) enabledTypes.add(t);
    }
  }

  const minSeverity = String(env.AI_REVIEW_SECURITY_MIN_SEVERITY || 'LOW').toUpperCase();

  return {
    enabled,
    enabledCategories,
    enabledTypes,
    minSeverity: SEVERITY_RANK[minSeverity] ? minSeverity : 'LOW',
  };
}

/**
 * Filter parsed findings to the configured security types + severity floor.
 * Only types owned by an enabled security category are kept.
 *
 * @param {Array}  findings
 * @param {Object} config    result of resolveSecurityConfig()
 * @returns {Array}
 */
export function filterSecurityFindings(findings, config) {
  if (!Array.isArray(findings)) return [];
  return findings.filter(f =>
    config.enabledTypes.has(f.type) &&
    meetsSeverityFloor(f.severity, config.minSeverity)
  );
}
