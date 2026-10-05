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

import { getClient, createChatCompletion, isGroqAvailable, DEFAULT_MODEL } from '../integrations/groq.js';
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
Applies to all languages and test frameworks (Jest/Vitest, JUnit 5, Kotest, XCTest).
  MISSING_TEST:        a new or substantially changed non-trivial function/method/branch
                       with no accompanying test anywhere in the change or context.
  UNTESTED_EDGE_CASE:  the happy path is tested but empty/null/boundary/invalid inputs
                       are not — applies equally to JS, Java @Test methods, Swift XCTest.
  UNTESTED_ERROR_PATH: a throw/catch/exception/rejection path with no test exercising it —
                       JS: no .rejects / try-catch in test; Java: no assertThrows();
                       Swift: no XCTAssertThrowsError().
  Report the line of the untested production logic (or the test that should be extended).
  Do NOT flag trivial wrappers, getters, config, data classes, or generated code.
  Note: you cannot measure coverage precisely — only flag clear gaps.`,

  assertions: `ASSERTIONS  (types: "NO_ASSERTION", "WEAK_ASSERTION", "ASSERTION_ON_MOCK", "SNAPSHOT_OVERUSE")
  Applies to all test frameworks — Jest expect(), JUnit 5 Assertions.assert*(),
  Mockito verify(), Hamcrest matchers, XCTest XCTAssert*(), Truth assertions.
  NO_ASSERTION [RANGE]: a test that executes code but asserts nothing.
                        JS: no expect(); Java: no assert*/verify(); Swift: no XCTAssert*().
                        Set line/endLine to the test body.
  WEAK_ASSERTION:       asserts only truthiness / not-null / isNotNull / XCTAssertNotNil
                        where a specific value or shape is clearly checkable.
  ASSERTION_ON_MOCK:    the assertion effectively checks the mock's own return value,
                        not the real behaviour under test — applies to Mockito when(),
                        Jest mockReturnValue(), Swift stub closures.
  SNAPSHOT_OVERUSE:     a large/opaque snapshot (Jest .toMatchSnapshot(), Android
                        screenshot tests) standing in for meaningful assertions.
  Do NOT flag a deliberate single strong assertion, or setup-only helpers.`,

  flakiness: `FLAKINESS  (types: "TIME_DEPENDENT_TEST", "RANDOMNESS_IN_TEST", "ORDER_DEPENDENT_TEST", "NETWORK_IN_UNIT_TEST", "RACE_IN_TEST")
  Applies to all languages and frameworks.
  TIME_DEPENDENT_TEST:  relies on real wall-clock time without faking it —
                        JS: real Date.now()/setTimeout; Java: System.currentTimeMillis()
                        or Thread.sleep() in assertions; Swift: DispatchQueue.asyncAfter
                        without expectations.
  RANDOMNESS_IN_TEST:   depends on unseeded randomness in assertions —
                        JS: Math.random(); Java: new Random() without seed;
                        Swift: Int.random(in:) in an assertion.
  ORDER_DEPENDENT_TEST: depends on execution order or leaks mutable state between tests.
  NETWORK_IN_UNIT_TEST: real network/DB/filesystem call in a unit test —
                        Java: real HTTP client call without WireMock/MockWebServer;
                        Android: real SQLite without Robolectric or in-memory Room DB;
                        Swift: real URLSession without URLProtocol stub.
  RACE_IN_TEST:         unawaited async work whose result an assertion then reads —
                        JS: unawaited promise; Java: missing CountDownLatch/CompletableFuture
                        join; Kotlin: missing runTest/advanceUntilIdle; Swift: missing
                        XCTestExpectation/fulfill()/wait().
  Do NOT flag tests that already fake timers, seed randomness, or mock the network.`,

  hygiene: `TEST HYGIENE  (types: "SKIPPED_TEST", "EMPTY_TEST", "COMMENTED_OUT_TEST", "DUPLICATE_TEST", "POOR_TEST_NAME")
  Applies to all frameworks.
  SKIPPED_TEST:         JS: .skip/xit/xdescribe left in, or focused .only/fit/fdescribe
                        (silently drops all other tests — HIGH);
                        Java: @Disabled/@Ignore without a clear reason;
                        Swift: XCTSkip() or test method renamed to prevent discovery.
  EMPTY_TEST [RANGE]:   a declared test with an empty or TODO-only body —
                        JS: it('...', () => {}); Java: @Test void foo() {};
                        Swift: func testFoo() {}.
  COMMENTED_OUT_TEST [RANGE]: test code commented out instead of removed or fixed.
  DUPLICATE_TEST:       near-identical test cases that should be parameterised —
                        JS: use test.each; Java: @ParameterizedTest; Swift: loop over cases.
  POOR_TEST_NAME:       non-descriptive names ("test1", "works", "shouldWork",
                        "testFoo" with no intent, testMethod1).
  Do NOT flag intentionally documented skips with a clear reason/ticket comment (keep LOW).`,

  mocking: `MOCKING  (types: "UNRESTORED_MOCK", "OVER_MOCKING", "MISSING_MOCK_CLEANUP")
  Applies to all mocking libraries: Jest, Sinon, Mockito, MockK, Swift manual stubs.
  UNRESTORED_MOCK:      a mock/spy/stub created but never reset/restored, leaking
                        across tests —
                        JS: no jest.restoreAllMocks()/afterEach cleanup;
                        Java/Mockito: @Mock fields without @ExtendWith(MockitoExtension.class)
                        or explicit Mockito.reset() / openMocks().close();
                        Kotlin MockK: no unmockkAll() or clearAllMocks() in @AfterEach.
  OVER_MOCKING [RANGE]: so much is mocked that the test no longer exercises real logic.
  MISSING_MOCK_CLEANUP: no cleanup hook where mocks are used —
                        JS: no afterEach/afterAll with restoreAllMocks/resetAllMocks;
                        Java: no @AfterEach teardown when mocks are manually created;
                        Swift: no tearDown() resetting stub state.
  Do NOT flag tests that already restore mocks correctly.`,

  async: `ASYNC CORRECTNESS  (types: "MISSING_AWAIT_ASSERTION", "PROMISE_NOT_RETURNED", "MISSING_DONE_CALLBACK")
  Applies to all async paradigms: JS Promises/async-await, Java CompletableFuture,
  Kotlin coroutines (runTest), Swift async/await and XCTestExpectation.
  MISSING_AWAIT_ASSERTION: an async assertion not properly awaited/joined, so failures
                           are silently missed —
                           JS: expect(...).rejects/.resolves not awaited;
                           Java: CompletableFuture result used without .get()/.join();
                           Kotlin: suspend function called outside runTest or without
                           advanceUntilIdle() before assertion;
                           Swift: async test method missing await, or XCTestExpectation
                           wait not called before assertion.
  PROMISE_NOT_RETURNED:    a JS promise in a test not returned/awaited, so a rejection
                           does not fail the test.
  MISSING_DONE_CALLBACK:   a JS callback-style async test that never calls done().
  Do NOT flag correctly awaited/returned/joined async tests.`,

  isolation: `TEST DATA & ISOLATION  (types: "SHARED_MUTABLE_FIXTURE", "HARDCODED_TEST_DATA", "MISSING_CLEANUP")
  SHARED_MUTABLE_FIXTURE: a shared fixture/object mutated by tests, coupling them —
                          Java: static mutable fields in test class; Kotlin companion object
                          state mutated across tests; JS: module-level mutable var.
  HARDCODED_TEST_DATA:    brittle magic values that should be named constants or builders —
                          applies equally to Java, Kotlin, Swift, and JS tests.
  MISSING_CLEANUP:        created files/DB records/connections/temp dirs not torn down
                          in @AfterEach / afterEach / tearDown() / addTeardownBlock().
  Keep severity modest; prefer clear coupling/leak risks over style preferences.`,

  smells: `TEST SMELLS  (types: "TEST_LOGIC", "MULTIPLE_CONCERNS", "TESTING_IMPLEMENTATION", "TRIVIAL_TEST")
  Applies to all languages.
  TEST_LOGIC [RANGE]:        conditionals/loops in a test that obscure what is asserted.
  MULTIPLE_CONCERNS [RANGE]: one test asserting many unrelated behaviours.
  TESTING_IMPLEMENTATION:    asserting private internals instead of observable behaviour —
                             JS: spying on private methods; Java: reflection to read private
                             fields; Swift: @testable import used to assert internal state
                             that is not part of the public contract.
  TRIVIAL_TEST:              testing the language/framework rather than your code
                             (e.g. assertEquals(2, 1+1)).
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

The code may be written in any language or test framework: Jest/Vitest/Mocha
(JavaScript/TypeScript), JUnit 5/Mockito/Kotest (Java/Kotlin), XCTest (Swift),
or others. Apply the testing catalog to whatever framework is present — the
finding types are framework-agnostic even when examples name a specific framework.

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
- HIGH:     a clear correctness/flakiness problem, or a focused test filter (.only/
            @Disabled without reason) that silently affects other tests, or an important
            untested path.
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
    // Rate-limit-aware: retries 429 / transient 5xx with backoff so a brief
    // Groq rate limit does not drop this agent's findings.
    const response = await createChatCompletion({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
      max_tokens:  4096,
      temperature: 0.1,
    }, { client });

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
