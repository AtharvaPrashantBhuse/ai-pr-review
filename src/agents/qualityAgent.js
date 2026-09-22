/**
 * src/agents/qualityAgent.js
 *
 * Quality Agent — production-grade automated code review across the full
 * code-quality check catalog. Runs alongside the Security Agent to automate
 * the peer-review pass on a Pull Request.
 *
 * Categories and finding types (see checkCatalog.js for the authoritative list):
 *   Correctness      → LOGIC_ERROR, BUG_RISK
 *   Dead Code        → DEAD_CODE
 *   Duplication      → DUPLICATE_CODE            (range)
 *   Error Handling   → ERROR_HANDLING            (range)
 *   Maintainability  → MAINTAINABILITY (range), COMPLEXITY (range), NAMING,
 *                      MAGIC_NUMBER, DOCUMENTATION
 *   Performance      → PERFORMANCE               (range)
 *   API / Contract   → API_CONTRACT
 *   Style            → STYLE                     (off by default)
 *   Test Coverage    → TEST_COVERAGE             (off by default)
 *
 * Responsibility: code-quality analysis only. This agent:
 *   1. Receives changed source code and optional repository context (Genesis).
 *   2. Builds a category-aware, quality-focused prompt scoped to the enabled
 *      categories so the LLM does not spend effort on disabled checks.
 *   3. Submits the prompt to the LLM via the Groq integration layer.
 *   4. Parses/normalises the structured JSON findings (shared findingParser).
 *   5. Filters findings to the enabled categories + severity floor.
 *
 * It produces the SAME finding shape as the Security Agent (plus an optional
 * `endLine` for range findings), so every finding flows unchanged through the
 * deterministic Evidence Validator, the ReviewResult contract, the CLI, and the
 * GitHub Reporter.
 *
 * Security:
 *   - GROQ_API_KEY read from environment only — never hardcoded or logged.
 *   - TLS verification always enabled (see groq.js).
 *   - LLM temperature kept low for deterministic, factual output.
 */

import { getClient, isGroqAvailable, DEFAULT_MODEL } from '../integrations/groq.js';
import { parseFindings }                             from './findingParser.js';
import {
  CATEGORIES,
  ALL_QUALITY_TYPES,
  resolveQualityConfig,
  filterQualityFindings,
} from './checkCatalog.js';

// Backwards-compatible export: the full set of quality finding types.
export const QUALITY_TYPES = ALL_QUALITY_TYPES;

// ─────────────────────────────────────────────────────────────────────────────
// Prompt building
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-category instruction blocks. Only the enabled categories are included in
 * the system prompt, which keeps the model focused and the prompt compact.
 */
const CATEGORY_INSTRUCTIONS = {
  correctness: `CORRECTNESS  (types: "LOGIC_ERROR", "BUG_RISK")
Flag code whose behaviour clearly does not match its evident intent, or that is
likely to fault at runtime.
  LOGIC_ERROR:
    - Assignment (=) used where comparison (=== / ==) was intended in a condition.
    - Inverted or off-by-one conditions (<= vs <, wrong boundary).
    - == where === is required and coercion changes behaviour.
    - Always-true / always-false conditions from operator misuse (|| vs &&).
    - Returning the wrong variable; shadowing that changes the intended target.
    - Missing await on a promise whose value is then used synchronously.
  BUG_RISK:
    - Possible null / undefined dereference (property access on a maybe-null value).
    - Array access / destructuring that may be out of bounds or undefined.
    - Using a variable before it is defined in the relevant scope.
    - Off-by-one in loop bounds that reads past the end.
  Do NOT flag correctly-guarded cases or purely stylistic preferences.`,

  dead_code: `DEAD CODE  (type: "DEAD_CODE")
Flag code that can never execute or has no effect:
  - Statements after an unconditional return / throw / break / continue.
  - Unreachable branches (if (false), conditions that are always true/false).
  - Variables, parameters, imports, or local functions declared but never used.
  - Assignments whose result is never read before being overwritten.
  Do NOT flag exported symbols (public API) or code behind a legitimate flag.`,

  duplication: `DUPLICATION  (type: "DUPLICATE_CODE")   [RANGE]
Flag clear copy-paste duplication that should be factored out:
  - Two or more blocks with near-identical logic (same structure, renamed vars).
  - Repeated literal blocks that differ only by a constant and should be a helper/loop.
  Report ONE representative block and set "line"/"endLine" to that block's span.
  Name the duplicate location in the explanation.
  Do NOT flag short idiomatic patterns (simple getters/guards) that naturally repeat.`,

  error_handling: `ERROR HANDLING  (type: "ERROR_HANDLING")   [RANGE]
Flag unsafe or missing error handling:
  - Empty catch blocks or catch blocks that swallow the error silently.
  - Over-broad catches that hide real failures.
  - Operations that can throw/reject with no handling on a realistic failure path.
  - Resources (files, connections, streams, locks) not released on an error path.
  For a block-level issue set "line"/"endLine" to the try/catch or block span.
  Do NOT flag already-correct handling.`,

  maintainability: `MAINTAINABILITY  (types: "MAINTAINABILITY", "COMPLEXITY", "NAMING", "MAGIC_NUMBER", "DOCUMENTATION")
  COMPLEXITY [RANGE]:
    - Functions that are too long, deeply nested, or have too many branches/params
      (high cyclomatic complexity) and should be decomposed.
      Set "line"/"endLine" to the function span.
  MAINTAINABILITY [RANGE]:
    - Structural smells that hurt future changes (e.g. large switch that should be
      a lookup, tangled responsibilities). Use a range when it spans lines.
  NAMING:
    - Misleading or non-descriptive identifiers that obscure intent.
  MAGIC_NUMBER:
    - Unexplained literal constants that should be named. Report the exact line.
  DOCUMENTATION:
    - Missing or incorrect doc on a NON-trivial exported/public function.
  Prefer precision; do not nitpick trivially small helpers.`,

  performance: `PERFORMANCE  (type: "PERFORMANCE")   [RANGE]
Flag constructs likely to cause a real performance problem:
  - Database/network/IO calls inside a loop that should be batched (N+1).
  - Repeated recomputation of a value that could be hoisted out of a loop.
  - Blocking synchronous calls on a hot/async path.
  - Building unbounded data structures from unbounded input.
  Set "line"/"endLine" to the offending loop/block span where relevant.
  Do NOT flag micro-optimisations with no measurable impact.`,

  api_contract: `API / CONTRACT  (type: "API_CONTRACT")
Flag changes that break or weaken a public/consumer-facing contract:
  - Changed exported function signature (removed/renamed/reordered params).
  - Changed return type/shape that existing callers rely on.
  - Inconsistent error contract (throwing where callers expect a returned error, etc.).
  Only flag when the symbol is exported or otherwise part of a public surface.
  USE THE REPOSITORY CONTEXT: the "Symbols defined" and "Imported by (blast radius)"
  lines tell you whether a changed symbol is exported and which files depend on it.
  Prefer HIGH severity when the blast radius lists dependents that would break.
  If the repository context shows no dependents, keep severity at most MEDIUM.`,

  style: `STYLE  (type: "STYLE")
Flag readability/consistency issues that deviate from the surrounding code:
  - Inconsistent conventions vs the rest of the file/module.
  - Formatting or idiom choices that clearly reduce readability.
  Keep severity LOW unless it genuinely impairs understanding.`,

  test_coverage: `TEST COVERAGE  (type: "TEST_COVERAGE")
Flag new non-trivial logic or branches added without corresponding tests, when
the change itself makes this evident. Report the line of the untested logic.
  USE THE REPOSITORY CONTEXT: the "Symbols defined" lines list the functions in
  the changed file. If a newly added or substantially changed exported function
  appears there and the repository context / diff shows no matching test file
  (e.g. *.test.js, *.spec.js) covering it, flag the function's line.
  Only flag genuinely non-trivial logic (branches, computation) — not thin
  wrappers, getters, or config.`,
};

/**
 * Build the system prompt for the currently enabled categories.
 *
 * @param {Object} config  result of resolveQualityConfig()
 * @returns {string}
 */
function buildSystemPrompt(config) {
  const enabledBlocks = CATEGORIES
    .filter(c => config.enabledCategories.has(c.key))
    .map(c => CATEGORY_INSTRUCTIONS[c.key])
    .filter(Boolean);

  const enabledTypeList = [...config.enabledTypes].join(' | ') || '(none)';

  return `You are a meticulous senior software engineer performing an automated peer code review.
You are NOT looking for security vulnerabilities — a separate reviewer handles those.
Analyse the supplied source code and repository context for the categories below.

Review ONLY these finding types: ${enabledTypeList}
Do not emit any other type.

─────────────────────────────────────────────────────────────────
CHECK CATALOG (enabled categories only)
─────────────────────────────────────────────────────────────────
${enabledBlocks.join('\n\n─────────────────────────────────────────────────────────────────\n')}

─────────────────────────────────────────────────────────────────
SEVERITY GUIDANCE
─────────────────────────────────────────────────────────────────
- CRITICAL: will almost certainly cause incorrect results or a crash on a common path.
- HIGH:     a clear defect on a realistic path, or a serious maintainability/perf problem.
- MEDIUM:   a probable issue, or moderate dead/duplicate code / complexity.
- LOW:      minor or low-confidence observation.

─────────────────────────────────────────────────────────────────
OUTPUT FORMAT
─────────────────────────────────────────────────────────────────
Return ONLY a valid JSON array. No markdown, no commentary, no text outside the JSON.
If no issues are found return an empty array: []

Each finding must follow this exact schema:
{
  "type":        "<one of the enabled types above>",
  "severity":    "<LOW|MEDIUM|HIGH|CRITICAL>",
  "confidence":  "<LOW|MEDIUM|HIGH>",
  "file":        "<relative file path exactly as shown in the code, or 'unknown'>",
  "line":        <integer — 1-based start line in the file after the change>,
  "endLine":     <integer — OPTIONAL; 1-based end line for a multi-line/range finding; omit for single-line>,
  "evidence":    "<the exact offending line of code (for a range, a representative line within it)>",
  "explanation": "<concise explanation of the issue and the concrete risk or cost>"
}

Rules:
- "line" (and "endLine" when present) must be actual line numbers in the file, not diff offsets.
- For RANGE finding types (duplication, error-handling blocks, complexity, performance,
  structural maintainability) include "endLine" describing the full span.
- "evidence" must be a verbatim or near-verbatim copy of a real line in the reported range.
- Do NOT fabricate evidence — only report what is explicitly present in the supplied code.
- Only report issues you are reasonably confident about; prefer precision over recall.
- Do not report the same issue more than once.`;
}

/**
 * Build the user-facing prompt: Genesis context (if any) + the code to review.
 *
 * @param {string} diff
 * @param {string} repoContext
 * @returns {string}
 */
function buildUserPrompt(diff, repoContext) {
  let prompt = '';
  if (repoContext && repoContext.trim()) {
    prompt += '=== REPOSITORY CONTEXT (from Genesis index) ===\n';
    prompt += repoContext.trim();
    prompt += '\n\n';
  }
  prompt += '=== SOURCE CODE TO REVIEW ===\n';
  prompt += diff.trim();
  prompt += '\n\nReview the above per the enabled check catalog. Return only a JSON array of findings.';
  return prompt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyse a code diff or file content for code-quality issues.
 *
 * @param {string} diff            - The changed source code or unified diff text
 * @param {string} [repoContext]   - Repository context summary from genesisAdapter
 * @param {Object} [options]
 * @param {string} [options.model] - Override the Groq model (default: DEFAULT_MODEL)
 * @param {Object} [options.config] - Pre-resolved quality config (defaults to env)
 * @returns {Promise<{ findings: Array, error: string|null, llmUsed: boolean, skipped?: boolean }>}
 */
export async function analyseForQuality(diff, repoContext = '', options = {}) {
  const config = options.config || resolveQualityConfig();

  // If every category is disabled there is nothing to ask the model.
  if (config.enabledTypes.size === 0) {
    return { findings: [], error: null, llmUsed: false, skipped: true };
  }

  if (!isGroqAvailable()) {
    return {
      findings: [],
      error:
        'GROQ_API_KEY is not set — LLM quality analysis unavailable. ' +
        'Set GROQ_API_KEY in .env.local or as a GitHub repository secret.',
      llmUsed: false,
    };
  }

  const client = await getClient();
  if (!client) {
    return {
      findings: [],
      error:    'Failed to initialise Groq client — check GROQ_API_KEY and network connectivity.',
      llmUsed:  false,
    };
  }

  const model = options.model
    || process.env.GROQ_QUALITY_MODEL
    || process.env.GROQ_SECURITY_MODEL
    || DEFAULT_MODEL;

  const systemPrompt = buildSystemPrompt(config);
  const userPrompt   = buildUserPrompt(diff, repoContext);

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      max_tokens:  4096,
      temperature: 0.1,
    });

    const raw = response.choices?.[0]?.message?.content || '';
    // Parse, then keep only enabled types that meet the severity floor.
    const findings = filterQualityFindings(parseFindings(raw), config);

    return { findings, error: null, llmUsed: true };

  } catch (err) {
    if (err.status === 429) {
      return {
        findings: [],
        error:    'Groq rate limit reached. Retry after a short wait.',
        llmUsed:  false,
      };
    }
    return {
      findings: [],
      error:    `LLM call failed: ${err.message}`,
      llmUsed:  false,
    };
  }
}

/**
 * Check whether the Quality Agent can operate (Groq API key configured).
 * Does not make a network request.
 *
 * @returns {boolean}
 */
export function isAgentAvailable() {
  return isGroqAvailable();
}
