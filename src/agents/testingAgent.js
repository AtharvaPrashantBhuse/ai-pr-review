/**
 * src/agents/testingAgent.js
 *
 * Testing Agent — reviews test code and the test-related aspects of a change.
 * Runs alongside the Security and Quality agents on a Pull Request.
 *
 * Categories and finding types (see testingCatalog.js for the authoritative list):
 *   Coverage      → MISSING_TEST, UNTESTED_EDGE_CASE, UNTESTED_ERROR_PATH
 *   Assertions    → NO_ASSERTION (range), WEAK_ASSERTION, ASSERTION_ON_MOCK, SNAPSHOT_OVERUSE
 *   Flakiness     → TIME_DEPENDENT_TEST, RANDOMNESS_IN_TEST, ORDER_DEPENDENT_TEST,
 *                   NETWORK_IN_UNIT_TEST, RACE_IN_TEST
 *   Hygiene       → SKIPPED_TEST, EMPTY_TEST (range), COMMENTED_OUT_TEST (range),
 *                   DUPLICATE_TEST, POOR_TEST_NAME
 *   Mocking       → UNRESTORED_MOCK, OVER_MOCKING (range), MISSING_MOCK_CLEANUP
 *   Async         → MISSING_AWAIT_ASSERTION, PROMISE_NOT_RETURNED, MISSING_DONE_CALLBACK
 *   Isolation     → SHARED_MUTABLE_FIXTURE, HARDCODED_TEST_DATA, MISSING_CLEANUP (off by default)
 *   Smells        → TEST_LOGIC (range), MULTIPLE_CONCERNS (range), TESTING_IMPLEMENTATION,
 *                   TRIVIAL_TEST (off by default)
 *
 * Responsibility: test-quality analysis only. This agent:
 *   1. Receives changed source code and optional repository context (Genesis).
 *   2. Builds a category-scoped prompt limited to enabled categories.
 *   3. Submits the prompt to the LLM via the Groq integration layer.
 *   4. Parses/normalises the structured JSON findings (shared findingParser).
 *   5. Filters findings to the enabled categories + severity floor.
 *
 * It produces the SAME finding shape as the other agents (plus an optional
 * `endLine` for range findings), so findings flow unchanged through the
 * Evidence Validator, the ReviewResult contract, the CLI, and the Reporter.
 *
 * Honest limitation: the engine does NOT execute tests or read a coverage
 * report. Coverage findings (`MISSING_TEST` etc.) are inferences from the diff
 * and repository context, not measured coverage — treat them as best-effort.
 *
 * Security:
 *   - GROQ_API_KEY read from environment only — never hardcoded or logged.
 *   - TLS verification always enabled (see groq.js).
 *   - LLM temperature kept low for deterministic, factual output.
 */

import { getClient, isGroqAvailable, DEFAULT_MODEL } from '../integrations/groq.js';
import { parseFindings }                             from './findingParser.js';
import {
  TESTING_CATEGORIES,
  ALL_TESTING_TYPES,
  resolveTestingConfig,
  filterTestingFindings,
} from './testingCatalog.js';

// The full set of testing finding types this agent may emit.
// (Exported for the reporter / dedup category mapping.)
export const TESTING_TYPES = ALL_TESTING_TYPES;

// ─────────────────────────────────────────────────────────────────────────────
// Per-category prompt instruction blocks
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_INSTRUCTIONS = {
  coverage: `COVERAGE  (types: "MISSING_TEST", "UNTESTED_EDGE_CASE", "UNTESTED_ERROR_PATH")
Judge test coverage of the CHANGED code. Use the repository context ("Symbols
defined", test files present) when deciding whether a test exists.
  MISSING_TEST:        a new or substantially changed non-trivial function/branch
                       with no accompanying test anywhere in the change or context.
  UNTESTED_EDGE_CASE:  the happy path is tested but empty/boundary/invalid inputs
                       are not.
  UNTESTED_ERROR_PATH: a throw/catch/rejection path with no test exercising it.
  Report the line of the untested production logic (or the test that should be
  extended). Do NOT flag trivial wrappers, getters, config, or generated code.
  Note: you cannot measure coverage precisely — only flag clear gaps.`,

  assertions: `ASSERTIONS  (types: "NO_ASSERTION", "WEAK_ASSERTION", "ASSERTION_ON_MOCK", "SNAPSHOT_OVERUSE")
  NO_ASSERTION [RANGE]: a test that executes code but asserts nothing (no expect/
                        assert). Set line/endLine to the test body.
  WEAK_ASSERTION:       asserts only truthiness / not-null / "toBeDefined" where a
                        specific value or shape is clearly checkable.
  ASSERTION_ON_MOCK:    the assertion effectively checks the mock's own return
                        value, not the real behaviour under test.
  SNAPSHOT_OVERUSE:     a large/opaque snapshot standing in for meaningful
                        assertions.
  Do NOT flag a deliberate single strong assertion, or setup-only helpers.`,

  flakiness: `FLAKINESS  (types: "TIME_DEPENDENT_TEST", "RANDOMNESS_IN_TEST", "ORDER_DEPENDENT_TEST", "NETWORK_IN_UNIT_TEST", "RACE_IN_TEST")
  TIME_DEPENDENT_TEST:  relies on real Date.now()/timers/sleep without faking them.
  RANDOMNESS_IN_TEST:   depends on Math.random / unseeded randomness in assertions.
  ORDER_DEPENDENT_TEST: depends on execution order or leaks state between tests.
  NETWORK_IN_UNIT_TEST: real network / DB / filesystem call in a unit test.
  RACE_IN_TEST:         unawaited async work whose result an assertion then reads.
  Do NOT flag tests that already fake timers/seed randomness/mock the network.`,

  hygiene: `TEST HYGIENE  (types: "SKIPPED_TEST", "EMPTY_TEST", "COMMENTED_OUT_TEST", "DUPLICATE_TEST", "POOR_TEST_NAME")
  SKIPPED_TEST:         .skip / xit / xdescribe, or a focused .only / fit / fdescribe
                        left in (".only" silently drops all other tests — HIGH).
  EMPTY_TEST [RANGE]:   a declared test with an empty or TODO-only body.
  COMMENTED_OUT_TEST [RANGE]: test code commented out instead of removed or fixed.
  DUPLICATE_TEST:       near-identical test cases that should be parameterised.
  POOR_TEST_NAME:       non-descriptive names ("test1", "works", "should work").
  Do NOT flag intentionally documented skips with a clear reason comment (keep LOW).`,

  mocking: `MOCKING  (types: "UNRESTORED_MOCK", "OVER_MOCKING", "MISSING_MOCK_CLEANUP")
  UNRESTORED_MOCK:      a mock/spy/stub created but never reset/restored, leaking
                        across tests.
  OVER_MOCKING [RANGE]: so much is mocked that the test no longer exercises the
                        real logic under test.
  MISSING_MOCK_CLEANUP: no afterEach/restoreAllMocks/resetAllMocks where mocks are used.
  Do NOT flag tests that already restore mocks (afterEach, restoreAllMocks, etc.).`,

  async: `ASYNC CORRECTNESS  (types: "MISSING_AWAIT_ASSERTION", "PROMISE_NOT_RETURNED", "MISSING_DONE_CALLBACK")
  MISSING_AWAIT_ASSERTION: an async assertion (e.g. expect(...).rejects / .resolves)
                           that is not awaited, so failures are silently missed.
  PROMISE_NOT_RETURNED:    a promise in a test not returned/awaited, so a rejection
                           does not fail the test.
  MISSING_DONE_CALLBACK:   a callback-style async test that never calls done().
  Do NOT flag correctly awaited/returned async tests.`,

  isolation: `TEST DATA & ISOLATION  (types: "SHARED_MUTABLE_FIXTURE", "HARDCODED_TEST_DATA", "MISSING_CLEANUP")
  SHARED_MUTABLE_FIXTURE: a shared fixture/object mutated by tests, coupling them.
  HARDCODED_TEST_DATA:    brittle magic values that should be named constants/builders.
  MISSING_CLEANUP:        created files/records/connections not torn down.
  Keep severity modest; prefer clear coupling/leak risks over style preferences.`,

  smells: `TEST SMELLS  (types: "TEST_LOGIC", "MULTIPLE_CONCERNS", "TESTING_IMPLEMENTATION", "TRIVIAL_TEST")
  TEST_LOGIC [RANGE]:        conditionals/loops in a test that obscure what is asserted.
  MULTIPLE_CONCERNS [RANGE]: one test asserting many unrelated behaviours.
  TESTING_IMPLEMENTATION:    asserting private internals instead of observable behaviour.
  TRIVIAL_TEST:              testing the language/framework rather than your code.
  These are advisory; keep severity LOW–MEDIUM unless clearly harmful.`,
};

// ─────────────────────────────────────────────────────────────────────────────
// Prompt building
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the system prompt for the currently enabled testing categories.
 *
 * @param {Object} config  result of resolveTestingConfig()
 * @returns {string}
 */
function buildSystemPrompt(config) {
  const enabledCats = TESTING_CATEGORIES.filter(c => config.enabledCategories.has(c.key));

  // Guard: an enabled category with no instruction block would be silently
  // omitted from the prompt, leaving its types "enabled" but unguided.
  const missing = enabledCats.filter(c => !CATEGORY_INSTRUCTIONS[c.key]);
  if (missing.length > 0) {
    console.warn(
      `[AI-Review] No prompt instructions for enabled testing categor` +
      `${missing.length === 1 ? 'y' : 'ies'}: ${missing.map(c => c.key).join(', ')}.`
    );
  }

  const enabledBlocks = enabledCats
    .map(c => CATEGORY_INSTRUCTIONS[c.key])
    .filter(Boolean);

  const enabledTypeList = [...config.enabledTypes].join(' | ') || '(none)';

  return `You are a meticulous senior test engineer performing an automated review of
the TEST quality of a Pull Request. Analyse the supplied source code and
repository context for the categories below. You review test code and the
test-related aspects of the change — not security or general code quality
(separate reviewers handle those).

Review ONLY these finding types: ${enabledTypeList}
Do not emit any other type.

─────────────────────────────────────────────────────────────────
TESTING CHECK CATALOG (enabled categories only)
─────────────────────────────────────────────────────────────────
${enabledBlocks.join('\n\n─────────────────────────────────────────────────────────────────\n')}

─────────────────────────────────────────────────────────────────
SEVERITY GUIDANCE
─────────────────────────────────────────────────────────────────
- CRITICAL: a test defect that gives false confidence on a critical path
            (e.g. an async assertion never awaited on core behaviour).
- HIGH:     a clear correctness/flakiness problem, or a focused .only that
            silently disables other tests, or an important untested path.
- MEDIUM:   a probable gap or weakness (weak assertions, moderate coverage gap).
- LOW:      a minor or subjective observation (naming, mild smells).

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
  "endLine":     <integer — OPTIONAL; end line for a multi-line/range finding; omit for single-line>,
  "evidence":    "<the exact offending line of code (for a range, a representative line within it)>",
  "explanation": "<concise explanation of the test problem and its risk>",
  "suggestedFix": "<OPTIONAL — the corrected version of the SINGLE flagged line, ready to replace it verbatim; omit for multi-line/range findings or when no clear one-line fix exists>"
}

Rules:
- "line" (and "endLine" when present) must be actual line numbers, not diff offsets.
- For RANGE types (empty/commented-out test, no-assertion test body, over-mocking,
  test-logic block, multiple-concerns block) include "endLine" describing the span.
- "evidence" must be a verbatim or near-verbatim copy of a real line in the reported range.
- Do NOT fabricate evidence — only report what is explicitly present in the supplied code.
- "suggestedFix", when provided, must be a drop-in replacement for the single flagged
  line (same indentation) that corrects the test problem. Omit it for range findings,
  for coverage gaps (which need a whole new test, not a line edit), or when unsure.
- Prefer precision over recall: only report issues you are reasonably confident about.
- Coverage findings are inferences (you cannot run the suite) — only flag clear gaps.
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
  prompt += '\n\nReview the above per the enabled testing catalog. Return only a JSON array of findings.';
  return prompt;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyse a code diff or file content for testing issues.
 *
 * @param {string} diff            - The changed source code or unified diff text
 * @param {string} [repoContext]   - Repository context summary from genesisAdapter
 * @param {Object} [options]
 * @param {string} [options.model]  - Override the Groq model (default: DEFAULT_MODEL)
 * @param {Object} [options.config] - Pre-resolved testing config (defaults to env)
 * @returns {Promise<{ findings: Array, error: string|null, llmUsed: boolean, skipped?: boolean }>}
 */
export async function analyseForTesting(diff, repoContext = '', options = {}) {
  const config = options.config || resolveTestingConfig();

  // Respect the master switch defensively (the engine also gates on it).
  if (!config.enabled) {
    return { findings: [], error: null, llmUsed: false, skipped: true };
  }

  // If every category is disabled there is nothing to ask the model.
  if (config.enabledTypes.size === 0) {
    return { findings: [], error: null, llmUsed: false, skipped: true };
  }

  if (!isGroqAvailable()) {
    return {
      findings: [],
      error:
        'GROQ_API_KEY is not set — LLM testing analysis unavailable. ' +
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
    || process.env.GROQ_TESTING_MODEL
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
    const findings = filterTestingFindings(parseFindings(raw), config);

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
 * Check whether the Testing Agent can operate (Groq API key configured).
 * Does not make a network request.
 *
 * @returns {boolean}
 */
export function isAgentAvailable() {
  return isGroqAvailable();
}
