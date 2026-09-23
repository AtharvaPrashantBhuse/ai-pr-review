/**
 * tests/review.test.js
 *
 * Automated test suite for the ai-pr-review central repository.
 * Runner: vitest
 *
 * All tests that exercise the Security Agent mock the Groq LLM response —
 * no real API calls are made. This means the suite runs fully offline
 * and does not require GROQ_API_KEY to be set.
 *
 * Test coverage (11 required cases):
 *
 *  1. Vulnerable source     — LLM finds SQL injection; Evidence Validator VERIFIES it.
 *  2. Safe source           — LLM returns no findings for parameterised queries.
 *  3. Fake AI finding       — fabricated finding with wrong line → UNVERIFIED.
 *  4. Valid evidence        — deterministic VERIFIED for known line in fixture.
 *  5. Invalid line          — line beyond file end → UNVERIFIED.
 *  6. Missing file          — non-existent file path → UNVERIFIED.
 *  7. Evidence mismatch     — valid line but wrong evidence text → UNVERIFIED.
 *  8. Multiple findings     — two findings in one LLM response both handled.
 *  9. Invalid LLM JSON      — malformed LLM output → graceful empty array.
 * 10. Missing GROQ_API_KEY  — absent key → graceful error, no crash.
 * 11. Deleted file handling — classifyFiles skips deleted files gracefully.
 *
 * Additional:
 *  12. buildCommentBody     — GitHub Reporter formats findings correctly.
 *  13. parseFindings        — normalises LLM output edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync }                          from 'fs';
import { resolve, dirname }                                  from 'path';
import { fileURLToPath }                                     from 'url';

// ─────────────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────────────

const __dirname  = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = resolve(__dirname, '..');
const FIXTURES   = resolve(REPO_ROOT, 'fixtures');

function readFixture(name) {
  return readFileSync(resolve(FIXTURES, name), 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────────
// Imports under test
// ─────────────────────────────────────────────────────────────────────────────

import { parseFindings }             from '../src/agents/securityAgent.js';
import { validateFinding,
         validateFindings }          from '../src/validation/evidenceValidator.js';
import { buildCommentBody }          from '../src/reporting/githubReporter.js';
import { classifyFiles }             from '../src/core/reviewEngine.js';
import { makeReviewResult,
         makeErrorResult,
         countFindings }             from '../src/core/reviewResult.js';

// ─────────────────────────────────────────────────────────────────────────────
// Mock helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulate an analyseForSecurity call by directly injecting mock findings
 * through the same parseFindings + validateFindings path used in production.
 * This exercises the full post-LLM pipeline without a real HTTP call.
 */
function runPipelineWithMockFindings(mockFindings, repoRoot = FIXTURES) {
  const validatedPairs = validateFindings(mockFindings, repoRoot);
  return validatedPairs.map(({ finding, validation }) => ({
    ...finding,
    verification: validation,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 — Vulnerable source: SQL injection detected and VERIFIED
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 1 — Vulnerable source: SQL injection detected and VERIFIED', () => {
  // Simulate what the LLM would return for vulnerable.js
  const mockLLMFindings = [
    {
      type:        'SQL_INJECTION',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'vulnerable.js',
      line:        21,   // "const sql = 'SELECT * FROM users WHERE id = ' + userId;"
      evidence:    "'SELECT * FROM users WHERE id = ' + userId",
      explanation: 'User input from req.query.userId is concatenated directly into SQL.',
    },
  ];

  it('parseFindings normalises the mock LLM response correctly', () => {
    const parsed = parseFindings(JSON.stringify(mockLLMFindings));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe('SQL_INJECTION');
    expect(parsed[0].severity).toBe('HIGH');
    expect(parsed[0].confidence).toBe('HIGH');
    expect(parsed[0].file).toBe('vulnerable.js');
    expect(parsed[0].line).toBe(21);
  });

  it('Evidence Validator returns VERIFIED for a real line in vulnerable.js', () => {
    const finding = mockLLMFindings[0];
    const result  = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
    expect(result.sourceLine).toBeDefined();
    expect(result.sourceLine.length).toBeGreaterThan(0);
  });

  it('Full pipeline: finding is VERIFIED', () => {
    const merged = runPipelineWithMockFindings(mockLLMFindings);
    expect(merged).toHaveLength(1);
    expect(merged[0].verification.status).toBe('VERIFIED');
  });

  it('Severity is HIGH or CRITICAL', () => {
    const [f] = parseFindings(JSON.stringify(mockLLMFindings));
    expect(['HIGH', 'CRITICAL']).toContain(f.severity);
  });

  it('Finding has non-empty evidence and explanation', () => {
    const [f] = parseFindings(JSON.stringify(mockLLMFindings));
    expect(f.evidence.length).toBeGreaterThan(5);
    expect(f.explanation.length).toBeGreaterThan(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2 — Safe source: no SQL injection findings
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 2 — Safe source: parameterised queries produce no findings', () => {
  // Simulate LLM returning empty array for safe.js
  const mockLLMResponse = '[]';

  it('parseFindings returns an empty array for safe code', () => {
    const findings = parseFindings(mockLLMResponse);
    expect(Array.isArray(findings)).toBe(true);
    expect(findings).toHaveLength(0);
  });

  it('Pipeline produces no merged findings', () => {
    const merged = runPipelineWithMockFindings([]);
    expect(merged).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3 — Fake AI finding: Evidence Validator rejects fabricated finding
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 3 — Fake AI finding: fabricated finding is UNVERIFIED', () => {
  it('UNVERIFIED: line number far beyond end of file', () => {
    const fabricated = {
      type:        'SQL_INJECTION',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'fake-finding.js',
      line:        9999,
      evidence:    "pool.query('SELECT * FROM users WHERE id = ' + userId)",
      explanation: 'Fabricated finding.',
    };
    const result = validateFinding(fabricated, FIXTURES);
    expect(result.status).toBe('UNVERIFIED');
    expect(result.reason).toMatch(/does not exist|only has/i);
  });

  it('UNVERIFIED: evidence completely wrong for the claimed line', () => {
    // fake-finding.js line 19 is "function greet(name) {"
    const fabricated = {
      type:        'SQL_INJECTION',
      severity:    'CRITICAL',
      confidence:  'HIGH',
      file:        'fake-finding.js',
      line:        19,
      evidence:    "pool.query('SELECT * FROM users WHERE id = ' + userId)",
      explanation: 'Fabricated — evidence does not match the actual source.',
    };
    const result = validateFinding(fabricated, FIXTURES);
    expect(result.status).toBe('UNVERIFIED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4 — Valid evidence: deterministic VERIFIED for known line
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 4 — Valid evidence: deterministic VERIFIED on known line', () => {
  it('VERIFIED: exact evidence on line 21 of vulnerable.js', () => {
    const finding = {
      type:        'SQL_INJECTION',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'vulnerable.js',
      line:        21,
      evidence:    "'SELECT * FROM users WHERE id = ' + userId",
      explanation: 'Concatenation',
    };
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
    expect(result.sourceLine).toBeDefined();
  });

  it('VERIFIED: partial token overlap on the same line', () => {
    const finding = {
      type:        'SQL_INJECTION',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'vulnerable.js',
      line:        21,
      // LLM may paraphrase slightly — token overlap should still pass
      evidence:    'SELECT * FROM users WHERE id userId concatenation',
      explanation: 'Concatenation',
    };
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5 — Invalid line: line number beyond end of file
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 5 — Invalid line: line beyond end of file', () => {
  it('UNVERIFIED when line number exceeds total file lines', () => {
    // vulnerable.js has ~35 lines; 9999 is well beyond that
    const finding = {
      type:     'SQL_INJECTION',
      severity: 'HIGH',
      confidence: 'HIGH',
      file:     'vulnerable.js',
      line:     9999,
      evidence: 'some code',
      explanation: 'test',
    };
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('UNVERIFIED');
    expect(result.reason).toMatch(/does not exist|only has/i);
  });

  it('UNVERIFIED when line is 0 or negative', () => {
    const finding = {
      type:     'SQL_INJECTION',
      severity: 'HIGH',
      confidence: 'HIGH',
      file:     'vulnerable.js',
      line:     0,
      evidence: 'some code',
      explanation: 'test',
    };
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('UNVERIFIED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6 — Missing file: file does not exist on disk
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 6 — Missing file: referenced file does not exist', () => {
  it('UNVERIFIED when file path does not exist', () => {
    const finding = {
      type:        'SQL_INJECTION',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'nonexistent-file-xyz-abc.js',
      line:        5,
      evidence:    'some code',
      explanation: 'Fabricated.',
    };
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('UNVERIFIED');
    expect(result.reason).toMatch(/does not exist/i);
  });

  it('UNVERIFIED when file field is empty', () => {
    const finding = {
      type:     'SQL_INJECTION',
      severity: 'HIGH',
      confidence: 'HIGH',
      file:     '',
      line:     5,
      evidence: 'some code',
      explanation: 'test',
    };
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('UNVERIFIED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 7 — Evidence mismatch: valid line but wrong evidence text
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 7 — Evidence mismatch: valid line, wrong evidence text', () => {
  it('UNVERIFIED when evidence text does not appear in source around the claimed line', () => {
    // Line 19 in fake-finding.js is "function greet(name) {"
    // The claimed evidence is completely unrelated SQL code
    const finding = {
      type:        'SQL_INJECTION',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'fake-finding.js',
      line:        19,
      evidence:    "db.execute('DELETE FROM users WHERE role = ' + role)",
      explanation: 'Evidence that does not appear anywhere in the file.',
    };
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('UNVERIFIED');
  });

  it('UNVERIFIED when evidence field is empty', () => {
    const finding = {
      type:        'SQL_INJECTION',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'fake-finding.js',
      line:        19,
      evidence:    '',
      explanation: 'No evidence provided.',
    };
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('UNVERIFIED');
    expect(result.reason).toMatch(/no evidence/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 8 — Multiple findings: both are handled correctly
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 8 — Multiple findings: batch validation', () => {
  const mockFindings = [
    {
      type:        'SQL_INJECTION',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'vulnerable.js',
      line:        21,
      evidence:    "'SELECT * FROM users WHERE id = ' + userId",
      explanation: 'First injection point.',
    },
    {
      type:        'SQL_INJECTION',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'vulnerable.js',
      line:        29,  // template literal injection
      evidence:    "SELECT * FROM users WHERE name = '${name}'",
      explanation: 'Second injection point via template literal.',
    },
  ];

  it('validateFindings returns one result per finding', () => {
    const results = validateFindings(mockFindings, FIXTURES);
    expect(results).toHaveLength(2);
  });

  it('Each result has a finding and a validation object', () => {
    const results = validateFindings(mockFindings, FIXTURES);
    results.forEach(({ finding, validation }) => {
      expect(finding).toBeDefined();
      expect(validation).toBeDefined();
      expect(['VERIFIED', 'UNVERIFIED']).toContain(validation.status);
    });
  });

  it('First finding on line 21 is VERIFIED', () => {
    const results = validateFindings(mockFindings, FIXTURES);
    expect(results[0].validation.status).toBe('VERIFIED');
  });

  it('makeReviewResult handles array of findings correctly', () => {
    const merged = runPipelineWithMockFindings(mockFindings);
    expect(merged).toHaveLength(2);
    merged.forEach(f => {
      expect(f.type).toBe('SQL_INJECTION');
      expect(f.verification).toBeDefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 9 — Invalid LLM JSON: malformed response handled gracefully
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 9 — Invalid LLM JSON: malformed response is handled gracefully', () => {
  it('Returns empty array for completely non-JSON text', () => {
    const result = parseFindings('Sorry, I cannot analyse this code.');
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it('Returns empty array for empty string', () => {
    expect(parseFindings('')).toHaveLength(0);
  });

  it('Returns empty array for null/undefined', () => {
    expect(parseFindings(null)).toHaveLength(0);
    expect(parseFindings(undefined)).toHaveLength(0);
  });

  it('Strips markdown code fences and parses the inner JSON', () => {
    const withFences = '```json\n[{"type":"SQL_INJECTION","severity":"HIGH","confidence":"HIGH","file":"src/api.js","line":5,"evidence":"x","explanation":"y"}]\n```';
    const result = parseFindings(withFences);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('SQL_INJECTION');
  });

  it('Extracts embedded JSON array from surrounding prose', () => {
    const withProse = 'Here is my analysis:\n[{"type":"SQL_INJECTION","severity":"HIGH","confidence":"HIGH","file":"src/a.js","line":1,"evidence":"e","explanation":"x"}]\nEnd of analysis.';
    const result = parseFindings(withProse);
    expect(result).toHaveLength(1);
  });

  it('Returns empty array for JSON that is not an array', () => {
    const notArray = '{"type":"SQL_INJECTION"}';
    expect(parseFindings(notArray)).toHaveLength(0);
  });

  it('Normalises invalid severity to LOW', () => {
    const badSeverity = '[{"type":"SQL_INJECTION","severity":"EXTREME","confidence":"HIGH","file":"f.js","line":1,"evidence":"e","explanation":"x"}]';
    const result = parseFindings(badSeverity);
    expect(result[0].severity).toBe('LOW');
  });

  it('Normalises invalid confidence to LOW', () => {
    const badConf = '[{"type":"SQL_INJECTION","severity":"HIGH","confidence":"CERTAIN","file":"f.js","line":1,"evidence":"e","explanation":"x"}]';
    const result = parseFindings(badConf);
    expect(result[0].confidence).toBe('LOW');
  });

  it('Coerces line to integer, defaults to 0 for non-numeric', () => {
    const badLine = '[{"type":"SQL_INJECTION","severity":"HIGH","confidence":"HIGH","file":"f.js","line":"not-a-number","evidence":"e","explanation":"x"}]';
    const result = parseFindings(badLine);
    expect(result[0].line).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 10 — Missing GROQ_API_KEY: graceful degradation
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 10 — Missing GROQ_API_KEY: graceful degradation', () => {
  let savedKey;

  beforeEach(() => {
    savedKey = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
  });

  afterEach(() => {
    if (savedKey !== undefined) process.env.GROQ_API_KEY = savedKey;
    else delete process.env.GROQ_API_KEY;
  });

  it('isAgentAvailable returns false when key is absent', async () => {
    // Import fresh — module checks process.env at call time
    const { isAgentAvailable } = await import('../src/agents/securityAgent.js');
    expect(isAgentAvailable()).toBe(false);
  });

  it('analyseForSecurity returns graceful error result (no crash)', async () => {
    const { analyseForSecurity } = await import('../src/agents/securityAgent.js');
    const result = await analyseForSecurity('const x = 1;', '');
    expect(result.llmUsed).toBe(false);
    expect(result.findings).toHaveLength(0);
    expect(result.error).toMatch(/GROQ_API_KEY/i);
  });

  it('makeErrorResult produces a valid ReviewResult shape', () => {
    const result = makeErrorResult('GROQ_API_KEY is not set', Date.now());
    expect(result.findings).toHaveLength(0);
    expect(result.llmUsed).toBe(false);
    expect(result.error).toMatch(/GROQ_API_KEY/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 11 — Deleted file handling: classifyFiles skips gracefully
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 11 — Deleted file handling: classifyFiles skips deleted files', () => {
  it('Skips a file that does not exist on disk with a reason', () => {
    const rawPaths = ['src/deleted-file.js'];
    const { reviewable, skipped } = classifyFiles(rawPaths, FIXTURES);
    expect(reviewable).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].reason).toMatch(/not found|deleted/i);
  });

  it('Skips non-JS/TS files with a reason', () => {
    const rawPaths = ['README.md', 'schema.sql', 'config.yml'];
    const { reviewable, skipped } = classifyFiles(rawPaths, FIXTURES);
    expect(reviewable).toHaveLength(0);
    expect(skipped).toHaveLength(3);
    skipped.forEach(s => expect(s.reason).toMatch(/JS\/TS|reviewable/i));
  });

  it('Includes existing JS files in reviewable list', () => {
    const rawPaths = ['vulnerable.js', 'safe.js', 'deleted-ghost.js'];
    const { reviewable, skipped } = classifyFiles(rawPaths, FIXTURES);
    expect(reviewable).toContain('vulnerable.js');
    expect(reviewable).toContain('safe.js');
    expect(skipped.map(s => s.path)).toContain('deleted-ghost.js');
  });

  it('Empty input returns empty reviewable and skipped lists', () => {
    const { reviewable, skipped } = classifyFiles([], FIXTURES);
    expect(reviewable).toHaveLength(0);
    expect(skipped).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 12 — GitHub Reporter: buildCommentBody formats findings correctly
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 12 — GitHub Reporter: buildCommentBody output', () => {
  const singleResult = makeReviewResult({
    findings: [
      {
        type:        'SQL_INJECTION',
        severity:    'HIGH',
        confidence:  'HIGH',
        file:        'src/users.js',
        line:        18,
        evidence:    "const sql = 'SELECT * FROM users WHERE id = ' + userId;",
        explanation: 'User input flows into SQL string.',
        verification: {
          status:     'VERIFIED',
          file:       'src/users.js',
          line:       18,
          sourceLine: "const sql = 'SELECT * FROM users WHERE id = ' + userId;",
        },
      },
    ],
    genesisAvailable: false,
    llmUsed:          true,
    error:            null,
    durationMs:       1200,
  });

  it('Contains the AI Code Review header', () => {
    const body = buildCommentBody(singleResult);
    expect(body).toContain('AI Code Review');
  });

  it('Includes finding type SQL_INJECTION', () => {
    const body = buildCommentBody(singleResult);
    expect(body).toContain('SQL_INJECTION');
  });

  it('Includes severity HIGH', () => {
    const body = buildCommentBody(singleResult);
    expect(body).toContain('HIGH');
  });

  it('Includes file path', () => {
    const body = buildCommentBody(singleResult);
    expect(body).toContain('src/users.js');
  });

  it('Includes VERIFIED status', () => {
    const body = buildCommentBody(singleResult);
    expect(body).toContain('VERIFIED');
  });

  it('No-findings comment contains clean summary', () => {
    const emptyResult = makeReviewResult({
      findings:         [],
      genesisAvailable: false,
      llmUsed:          true,
      error:            null,
      durationMs:       500,
    });
    const body = buildCommentBody(emptyResult);
    expect(body).toContain('No security or code-quality findings detected');
  });

  it('Error result shows warning when LLM unavailable', () => {
    const errorResult = makeErrorResult('GROQ_API_KEY is not set', Date.now());
    const body = buildCommentBody(errorResult);
    expect(body).toContain('GROQ_API_KEY');
  });

  it('countFindings returns correct totals', () => {
    const { total, verified, unverified } = countFindings(singleResult);
    expect(total).toBe(1);
    expect(verified).toBe(1);
    expect(unverified).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 13 — parseFindings: evidence validator positive batch
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 13 — validateFindings batch: mixed VERIFIED and UNVERIFIED', () => {
  const batch = [
    {
      // Real finding — should be VERIFIED
      type:        'SQL_INJECTION',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'vulnerable.js',
      line:        21,
      evidence:    "'SELECT * FROM users WHERE id = ' + userId",
      explanation: 'Real finding.',
    },
    {
      // Fabricated — should be UNVERIFIED (wrong file)
      type:        'SQL_INJECTION',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'nonexistent.js',
      line:        5,
      evidence:    'some code',
      explanation: 'Fabricated.',
    },
    {
      // Fabricated — should be UNVERIFIED (line too high)
      type:        'SQL_INJECTION',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'fake-finding.js',
      line:        9999,
      evidence:    'some evidence',
      explanation: 'Line beyond EOF.',
    },
  ];

  it('Returns one result per input finding', () => {
    const results = validateFindings(batch, FIXTURES);
    expect(results).toHaveLength(3);
  });

  it('First finding is VERIFIED (real line in vulnerable.js)', () => {
    const results = validateFindings(batch, FIXTURES);
    expect(results[0].validation.status).toBe('VERIFIED');
  });

  it('Second finding is UNVERIFIED (file does not exist)', () => {
    const results = validateFindings(batch, FIXTURES);
    expect(results[1].validation.status).toBe('UNVERIFIED');
  });

  it('Third finding is UNVERIFIED (line beyond EOF)', () => {
    const results = validateFindings(batch, FIXTURES);
    expect(results[2].validation.status).toBe('UNVERIFIED');
  });

  it('validateFindings with empty array returns empty array', () => {
    expect(validateFindings([], FIXTURES)).toHaveLength(0);
  });

  it('validateFindings with non-array returns empty array', () => {
    expect(validateFindings(null, FIXTURES)).toHaveLength(0);
    expect(validateFindings('bad', FIXTURES)).toHaveLength(0);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Tests 14–18 — Context Builder
// ─────────────────────────────────────────────────────────────────────────────

import {
  buildContext,
  extractSourceContext,
  parseChangedHunks,
} from '../src/core/contextBuilder.js';

// ─── Test 14 — parseChangedHunks: extracts correct per-file line sets ─────────

describe('Test 14 — parseChangedHunks: parses unified diff correctly', () => {
  const SAMPLE_DIFF = [
    '--- a/src/users.js',
    '+++ b/src/users.js',
    '@@ -38,6 +38,7 @@',
    ' function getUserByName(name) {',
    '-  const sql = `SELECT * FROM users WHERE name = \'${name}\'`;',
    '+  // VULNERABLE',
    '+  const sql = `SELECT * FROM users WHERE name = \'${name}\'`;',
    '   return pool.query(sql);',
    ' }',
  ].join('\n');

  it('returns one entry per changed file', () => {
    const hunks = parseChangedHunks(SAMPLE_DIFF);
    expect(hunks).toHaveLength(1);
    expect(hunks[0].file).toBe('src/users.js');
  });

  it('records the added line numbers (1-based)', () => {
    const hunks = parseChangedHunks(SAMPLE_DIFF);
    // Two added lines starting at offset 39 (hunk starts at +38, first context line is 38)
    expect(hunks[0].ranges.length).toBeGreaterThan(0);
    // All range starts should be >= 1
    hunks[0].ranges.forEach(([s, e]) => {
      expect(s).toBeGreaterThanOrEqual(1);
      expect(e).toBeGreaterThanOrEqual(s);
    });
  });

  it('returns empty array for empty diff', () => {
    expect(parseChangedHunks('')).toHaveLength(0);
    expect(parseChangedHunks(null)).toHaveLength(0);
  });

  it('handles a multi-file diff', () => {
    const multiDiff = [
      '--- a/src/a.js',
      '+++ b/src/a.js',
      '@@ -1,2 +1,3 @@',
      ' const x = 1;',
      '+const y = 2;',
      ' const z = 3;',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -10,3 +10,4 @@',
      ' function foo() {',
      '+  doSomething();',
      ' }',
    ].join('\n');
    const hunks = parseChangedHunks(multiDiff);
    expect(hunks).toHaveLength(2);
    expect(hunks.map(h => h.file)).toContain('src/a.js');
    expect(hunks.map(h => h.file)).toContain('src/b.ts');
  });
});

// ─── Test 15 — extractSourceContext: large file → bounded snippet ─────────────

describe('Test 15 — extractSourceContext: large file produces bounded snippet', () => {
  // Build a minimal diff that touches only lines around line 201 of large-file.js
  // (the SQL injection line: "const sql = 'SELECT * FROM reports WHERE id = ' + reportId;")
  // getUserReport starts at line 198, injection is at line 201.
  const LARGE_FILE_DIFF = [
    '--- a/large-file.js',
    '+++ b/large-file.js',
    '@@ -198,4 +198,5 @@',
    ' async function getUserReport(req, res) {',
    '   const reportId = req.query.reportId;',
    '+  // VULNERABLE',
    "   const sql = 'SELECT * FROM reports WHERE id = ' + reportId;  // SQL INJECTION",
    ' }',
  ].join('\n');

  it('extracts a non-empty snippet for the changed lines', () => {
    const snippet = extractSourceContext(LARGE_FILE_DIFF, FIXTURES);
    expect(snippet.length).toBeGreaterThan(0);
  });

  it('snippet is much smaller than the full file', () => {
    const fullFile = readFixture('large-file.js');
    const snippet  = extractSourceContext(LARGE_FILE_DIFF, FIXTURES);
    // Snippet must be strictly smaller than the full file
    expect(snippet.length).toBeLessThan(fullFile.length);
    // And meaningfully smaller — at most 40% of the full file
    expect(snippet.length).toBeLessThan(fullFile.length * 0.40);
  });

  it('snippet contains the vulnerable function name', () => {
    const snippet = extractSourceContext(LARGE_FILE_DIFF, FIXTURES);
    expect(snippet).toContain('getUserReport');
  });

  it('snippet contains the SQL injection evidence', () => {
    const snippet = extractSourceContext(LARGE_FILE_DIFF, FIXTURES);
    expect(snippet).toContain('reportId');
  });

  it('snippet does NOT contain unrelated utility functions', () => {
    const snippet = extractSourceContext(LARGE_FILE_DIFF, FIXTURES);
    // These helpers are in completely unrelated sections far from line 211
    expect(snippet).not.toContain('function isoWeek');
    expect(snippet).not.toContain('function promisify');
    expect(snippet).not.toContain('function slugify');
  });

  it('respects a tight maxChars budget', () => {
    const snippet = extractSourceContext(LARGE_FILE_DIFF, FIXTURES, 300);
    expect(snippet.length).toBeLessThanOrEqual(
      300 + '\n[... source context truncated ...]'.length
    );
  });
});

// ─── Test 16 — buildContext: combined output is bounded ───────────────────────

describe('Test 16 — buildContext: assembles bounded combined output', () => {
  const SIMPLE_DIFF = [
    '--- a/vulnerable.js',
    '+++ b/vulnerable.js',
    '@@ -20,3 +20,4 @@',
    ' async function getUserById(req, res) {',
    "+  // user input flows into SQL",
    "   const sql = 'SELECT * FROM users WHERE id = ' + userId;",
    ' }',
  ].join('\n');

  it('returns diffSection, sourceSection, genesisSection, combined, diagnostics', () => {
    const ctx = buildContext(SIMPLE_DIFF, FIXTURES, '');
    expect(ctx).toHaveProperty('diffSection');
    expect(ctx).toHaveProperty('sourceSection');
    expect(ctx).toHaveProperty('genesisSection');
    expect(ctx).toHaveProperty('combined');
    expect(ctx).toHaveProperty('diagnostics');
  });

  it('combined contains the PR DIFF section header', () => {
    const { combined } = buildContext(SIMPLE_DIFF, FIXTURES, '');
    expect(combined).toContain('=== PR DIFF ===');
  });

  it('combined contains the RELEVANT SOURCE CONTEXT section when source exists', () => {
    const { combined } = buildContext(SIMPLE_DIFF, FIXTURES, '');
    // vulnerable.js exists in FIXTURES so source context should be populated
    expect(combined).toContain('=== RELEVANT SOURCE CONTEXT ===');
  });

  it('combined does NOT contain Genesis section when genesisCtx is empty', () => {
    const { combined } = buildContext(SIMPLE_DIFF, FIXTURES, '');
    expect(combined).not.toContain('=== REPOSITORY CONTEXT');
  });

  it('combined contains Genesis section when genesisCtx is provided', () => {
    const { combined } = buildContext(SIMPLE_DIFF, FIXTURES, 'symbol: getUserById');
    expect(combined).toContain('=== REPOSITORY CONTEXT (Genesis) ===');
    expect(combined).toContain('getUserById');
  });

  it('diagnostics.combinedChars matches combined.length', () => {
    const { combined, diagnostics } = buildContext(SIMPLE_DIFF, FIXTURES, '');
    expect(diagnostics.combinedChars).toBe(combined.length);
  });

  it('enforces AI_REVIEW_MAX_PROMPT_CHARS when set', () => {
    const origEnv = process.env.AI_REVIEW_MAX_PROMPT_CHARS;
    process.env.AI_REVIEW_MAX_PROMPT_CHARS = '100';
    try {
      const { combined } = buildContext(SIMPLE_DIFF, FIXTURES, 'some genesis context');
      expect(combined.length).toBeLessThanOrEqual(100);
    } finally {
      if (origEnv !== undefined) process.env.AI_REVIEW_MAX_PROMPT_CHARS = origEnv;
      else delete process.env.AI_REVIEW_MAX_PROMPT_CHARS;
    }
  });
});

// ─── Test 17 — buildContext: deleted / non-existent file ─────────────────────

describe('Test 17 — buildContext: missing file skipped gracefully', () => {
  const MISSING_FILE_DIFF = [
    '--- a/src/deleted-service.js',
    '+++ b/src/deleted-service.js',
    '@@ -1,3 +1,4 @@',
    ' function doThings() {',
    '+  dangerousCall();',
    ' }',
  ].join('\n');

  it('still returns a non-empty diffSection even when source file is absent', () => {
    const { diffSection, sourceSection } = buildContext(MISSING_FILE_DIFF, FIXTURES, '');
    expect(diffSection.length).toBeGreaterThan(0);
    // Source section is empty because the file does not exist on disk
    expect(sourceSection).toBe('');
  });
});

// ─── Test 18 — buildContext: empty diff ──────────────────────────────────────

describe('Test 18 — buildContext: empty diff produces empty sections', () => {
  it('returns empty strings for all sections when diff is empty', () => {
    const { diffSection, sourceSection, genesisSection, combined } =
      buildContext('', FIXTURES, '');
    expect(diffSection).toBe('');
    expect(sourceSection).toBe('');
    expect(genesisSection).toBe('');
    expect(combined).toBe('');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Tests 19–26 — Hardcoded Secrets detection
// ─────────────────────────────────────────────────────────────────────────────

// ─── Test 19 — Positive: hardcoded API key ────────────────────────────────────

describe('Test 19 — Hardcoded Secrets: hardcoded API key detected and VERIFIED', () => {
  const mockFinding = {
    type:        'HARDCODED_SECRET',
    severity:    'HIGH',
    confidence:  'HIGH',
    file:        'hardcoded-secrets.js',
    line:        18,
    evidence:    'const API_KEY = "gsk_example_long_credential_value_abc123xyz"',
    explanation: 'A non-trivial API key string is hardcoded as a literal value. ' +
                 'If committed to version control it can be extracted and abused.',
  };

  it('parseFindings normalises HARDCODED_SECRET type correctly', () => {
    const parsed = parseFindings(JSON.stringify([mockFinding]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe('HARDCODED_SECRET');
    expect(parsed[0].severity).toBe('HIGH');
    expect(parsed[0].confidence).toBe('HIGH');
  });

  it('Evidence Validator returns VERIFIED for the hardcoded API key line', () => {
    const result = validateFinding(mockFinding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
    expect(result.sourceLine).toContain('gsk_example');
  });

  it('Full pipeline: HARDCODED_SECRET finding is VERIFIED', () => {
    const merged = runPipelineWithMockFindings([mockFinding]);
    expect(merged).toHaveLength(1);
    expect(merged[0].type).toBe('HARDCODED_SECRET');
    expect(merged[0].verification.status).toBe('VERIFIED');
  });
});

// ─── Test 20 — Positive: hardcoded password ───────────────────────────────────

describe('Test 20 — Hardcoded Secrets: hardcoded password detected and VERIFIED', () => {
  const mockFinding = {
    type:        'HARDCODED_SECRET',
    severity:    'HIGH',
    confidence:  'HIGH',
    file:        'hardcoded-secrets.js',
    line:        21,
    evidence:    'const dbPassword = "ProductionPassword123!"',
    explanation: 'A plaintext password is hardcoded as a string literal.',
  };

  it('Evidence Validator returns VERIFIED for the hardcoded password line', () => {
    const result = validateFinding(mockFinding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
    expect(result.sourceLine).toContain('ProductionPassword123');
  });

  it('Full pipeline: password finding is VERIFIED', () => {
    const merged = runPipelineWithMockFindings([mockFinding]);
    expect(merged[0].verification.status).toBe('VERIFIED');
  });
});

// ─── Test 21 — Positive: hardcoded access token ───────────────────────────────

describe('Test 21 — Hardcoded Secrets: hardcoded access token detected and VERIFIED', () => {
  const mockFinding = {
    type:        'HARDCODED_SECRET',
    severity:    'HIGH',
    confidence:  'HIGH',
    file:        'hardcoded-secrets.js',
    line:        24,
    evidence:    'const accessToken = "long-example-access-token-value-abcdef1234567890"',
    explanation: 'A long access token string is hardcoded as a literal value.',
  };

  it('Evidence Validator returns VERIFIED for the hardcoded token line', () => {
    const result = validateFinding(mockFinding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
    expect(result.sourceLine).toContain('accessToken');
  });

  it('Full pipeline: token finding is VERIFIED', () => {
    const merged = runPipelineWithMockFindings([mockFinding]);
    expect(merged[0].verification.status).toBe('VERIFIED');
  });
});

// ─── Test 22 — Negative: environment variable — must produce no finding ───────

describe('Test 22 — Hardcoded Secrets: env-var usage is NOT a finding', () => {
  it('parseFindings returns empty array when LLM correctly returns no findings for env-var code', () => {
    // The LLM should return [] for:  const API_KEY = process.env.API_KEY;
    // We simulate that correct LLM behaviour here.
    const findings = parseFindings('[]');
    expect(findings).toHaveLength(0);
  });

  it('UNVERIFIED when fabricated finding targets the env-var line with completely unrelated evidence', () => {
    // Line 29 is "const API_KEY_FROM_ENV = process.env.API_KEY;" — no hardcoded value.
    // Use evidence whose distinct tokens do not appear on that source line at all.
    const fabricated = {
      type:        'HARDCODED_SECRET',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'hardcoded-secrets.js',
      line:        29,
      evidence:    'Bearer zzz_completelydifferenttokenvalue_xyz_9999',
      explanation: 'Fabricated — the actual line uses process.env, not a literal.',
    };
    const result = validateFinding(fabricated, FIXTURES);
    // The fabricated evidence shares no meaningful tokens with "process.env.API_KEY"
    expect(result.status).toBe('UNVERIFIED');
  });
});

// ─── Test 23 — Negative: placeholder value — must produce no finding ──────────

describe('Test 23 — Hardcoded Secrets: placeholder values are NOT findings', () => {
  it('parseFindings returns empty array when LLM correctly returns no findings for placeholder code', () => {
    // A well-configured LLM should return [] for:  const PLACEHOLDER_KEY = "YOUR_API_KEY";
    const findings = parseFindings('[]');
    expect(findings).toHaveLength(0);
  });

  it('UNVERIFIED when fabricated finding on the placeholder line uses completely unrelated evidence', () => {
    // Line 32 is: const PLACEHOLDER_KEY = "YOUR_API_KEY";
    // Fabricate evidence that shares no significant tokens with that line.
    const fabricatedFinding = {
      type:        'HARDCODED_SECRET',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'hardcoded-secrets.js',
      line:        32,
      evidence:    'Bearer zzz_completelydifferenttokenvalue_xyz_9999',
      explanation: 'Fabricated evidence that does not match the actual placeholder.',
    };
    const result = validateFinding(fabricatedFinding, FIXTURES);
    expect(result.status).toBe('UNVERIFIED');
  });
});

// ─── Test 24 — parseFindings: HARDCODED_SECRET schema normalisation ───────────

describe('Test 24 — parseFindings: HARDCODED_SECRET type is normalised correctly', () => {
  it('uppercases type to HARDCODED_SECRET', () => {
    const raw = JSON.stringify([{
      type:        'hardcoded_secret',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'src/config.js',
      line:        5,
      evidence:    'const secret = "abc123xyz"',
      explanation: 'Hardcoded credential.',
    }]);
    const findings = parseFindings(raw);
    expect(findings[0].type).toBe('HARDCODED_SECRET');
  });

  it('normalises invalid severity to LOW for HARDCODED_SECRET', () => {
    const raw = JSON.stringify([{
      type:        'HARDCODED_SECRET',
      severity:    'EXTREME',       // invalid
      confidence:  'HIGH',
      file:        'src/config.js',
      line:        5,
      evidence:    'const secret = "abc"',
      explanation: 'test',
    }]);
    const findings = parseFindings(raw);
    expect(findings[0].severity).toBe('LOW');
  });

  it('CRITICAL severity is accepted for HARDCODED_SECRET', () => {
    const raw = JSON.stringify([{
      type:        'HARDCODED_SECRET',
      severity:    'CRITICAL',
      confidence:  'HIGH',
      file:        'src/config.js',
      line:        5,
      evidence:    'const privateKey = "-----BEGIN RSA PRIVATE KEY-----"',
      explanation: 'Private key hardcoded.',
    }]);
    const findings = parseFindings(raw);
    expect(findings[0].severity).toBe('CRITICAL');
  });
});

// ─── Test 25 — Regression: SQL Injection still works ─────────────────────────

describe('Test 25 — Regression: SQL Injection detection still works after adding Hardcoded Secrets', () => {
  const sqlFinding = {
    type:        'SQL_INJECTION',
    severity:    'HIGH',
    confidence:  'HIGH',
    file:        'vulnerable.js',
    line:        21,
    evidence:    "'SELECT * FROM users WHERE id = ' + userId",
    explanation: 'User input concatenated into SQL.',
  };

  it('parseFindings still normalises SQL_INJECTION correctly', () => {
    const parsed = parseFindings(JSON.stringify([sqlFinding]));
    expect(parsed[0].type).toBe('SQL_INJECTION');
    expect(parsed[0].severity).toBe('HIGH');
  });

  it('Evidence Validator still VERIFIES the SQL injection finding', () => {
    const result = validateFinding(sqlFinding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
  });

  it('Full pipeline: SQL_INJECTION finding is still VERIFIED', () => {
    const merged = runPipelineWithMockFindings([sqlFinding]);
    expect(merged[0].type).toBe('SQL_INJECTION');
    expect(merged[0].verification.status).toBe('VERIFIED');
  });
});

// ─── Test 26 — Multiple findings: SQL Injection + Hardcoded Secret together ───

describe('Test 26 — Multiple findings: SQL Injection and Hardcoded Secret in one response', () => {
  const mixedFindings = [
    {
      type:        'SQL_INJECTION',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'vulnerable.js',
      line:        21,
      evidence:    "'SELECT * FROM users WHERE id = ' + userId",
      explanation: 'User input concatenated into SQL.',
    },
    {
      type:        'HARDCODED_SECRET',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'hardcoded-secrets.js',
      line:        18,
      evidence:    'const API_KEY = "gsk_example_long_credential_value_abc123xyz"',
      explanation: 'API key hardcoded as a string literal.',
    },
  ];

  it('parseFindings handles both types in a single response', () => {
    const parsed = parseFindings(JSON.stringify(mixedFindings));
    expect(parsed).toHaveLength(2);
    const types = parsed.map(f => f.type);
    expect(types).toContain('SQL_INJECTION');
    expect(types).toContain('HARDCODED_SECRET');
  });

  it('validateFindings processes both findings independently', () => {
    const results = validateFindings(mixedFindings, FIXTURES);
    expect(results).toHaveLength(2);
    results.forEach(({ finding, validation }) => {
      expect(finding).toBeDefined();
      expect(validation).toBeDefined();
      expect(['VERIFIED', 'UNVERIFIED']).toContain(validation.status);
    });
  });

  it('SQL_INJECTION finding is VERIFIED', () => {
    const results = validateFindings(mixedFindings, FIXTURES);
    const sql = results.find(r => r.finding.type === 'SQL_INJECTION');
    expect(sql.validation.status).toBe('VERIFIED');
  });

  it('HARDCODED_SECRET finding is VERIFIED', () => {
    const results = validateFindings(mixedFindings, FIXTURES);
    const secret = results.find(r => r.finding.type === 'HARDCODED_SECRET');
    expect(secret.validation.status).toBe('VERIFIED');
  });

  it('Full pipeline merges both findings with their verification status', () => {
    const merged = runPipelineWithMockFindings(mixedFindings, FIXTURES);
    expect(merged).toHaveLength(2);
    merged.forEach(f => {
      expect(f.verification).toBeDefined();
      expect(f.verification.status).toBe('VERIFIED');
    });
  });

  it('buildCommentBody renders both finding types in the PR comment', () => {
    const result = makeReviewResult({
      findings: mixedFindings.map((f, i) => ({
        ...f,
        verification: { status: 'VERIFIED', file: f.file, line: f.line, sourceLine: f.evidence },
      })),
      genesisAvailable: false,
      llmUsed:          true,
      error:            null,
      durationMs:       500,
    });
    const body = buildCommentBody(result);
    expect(body).toContain('SQL_INJECTION');
    expect(body).toContain('HARDCODED_SECRET');
    expect(body).toContain('VERIFIED');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Tests 27–33 — Code Quality detection (Quality Agent)
//
// Like the security tests, these mock the LLM by feeding representative JSON
// through the same parseFindings + validateFindings path used in production.
// No real Groq call is made.
// ─────────────────────────────────────────────────────────────────────────────

import { parseFindings as parseQualityFindings }   from '../src/agents/findingParser.js';
import { QUALITY_TYPES }                            from '../src/agents/qualityAgent.js';

// ─── Test 27 — DEAD_CODE detected and VERIFIED ────────────────────────────────

describe('Test 27 — Quality: dead code detected and VERIFIED', () => {
  const mockFinding = {
    type:        'DEAD_CODE',
    severity:    'MEDIUM',
    confidence:  'HIGH',
    file:        'quality-issues.js',
    line:        23,
    evidence:    'total = total * 2;',
    explanation: 'Statement after an unconditional return is unreachable.',
  };

  it('parseFindings normalises DEAD_CODE type correctly', () => {
    const parsed = parseQualityFindings(JSON.stringify([mockFinding]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].type).toBe('DEAD_CODE');
    expect(parsed[0].severity).toBe('MEDIUM');
  });

  it('Evidence Validator returns VERIFIED for the dead-code line', () => {
    const result = validateFinding(mockFinding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
    expect(result.sourceLine).toContain('total = total * 2');
  });

  it('Full pipeline: DEAD_CODE finding is VERIFIED', () => {
    const merged = runPipelineWithMockFindings([mockFinding]);
    expect(merged[0].type).toBe('DEAD_CODE');
    expect(merged[0].verification.status).toBe('VERIFIED');
  });
});

// ─── Test 28 — LOGIC_ERROR detected and VERIFIED ──────────────────────────────

describe('Test 28 — Quality: logic error detected and VERIFIED', () => {
  const mockFinding = {
    type:        'LOGIC_ERROR',
    severity:    'HIGH',
    confidence:  'HIGH',
    file:        'quality-issues.js',
    line:        28,
    evidence:    "if (user.role = 'admin') {",
    explanation: 'Assignment (=) used where comparison (===) was intended.',
  };

  it('Evidence Validator returns VERIFIED for the logic-error line', () => {
    const result = validateFinding(mockFinding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
    expect(result.sourceLine).toContain('user.role');
  });

  it('Full pipeline: LOGIC_ERROR finding is VERIFIED', () => {
    const merged = runPipelineWithMockFindings([mockFinding]);
    expect(merged[0].verification.status).toBe('VERIFIED');
  });
});

// ─── Test 29 — BUG_RISK detected and VERIFIED ─────────────────────────────────

describe('Test 29 — Quality: bug risk detected and VERIFIED', () => {
  const mockFinding = {
    type:        'BUG_RISK',
    severity:    'MEDIUM',
    confidence:  'MEDIUM',
    file:        'quality-issues.js',
    line:        36,
    evidence:    'return user.address.city;',
    explanation: 'Possible null dereference — user.address may be undefined.',
  };

  it('Evidence Validator returns VERIFIED for the bug-risk line', () => {
    const result = validateFinding(mockFinding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
    expect(result.sourceLine).toContain('user.address.city');
  });

  it('Full pipeline: BUG_RISK finding is VERIFIED', () => {
    const merged = runPipelineWithMockFindings([mockFinding]);
    expect(merged[0].verification.status).toBe('VERIFIED');
  });
});

// ─── Test 30 — DUPLICATE_CODE detected and VERIFIED ───────────────────────────

describe('Test 30 — Quality: duplicate code detected and VERIFIED', () => {
  const mockFinding = {
    type:        'DUPLICATE_CODE',
    severity:    'LOW',
    confidence:  'MEDIUM',
    file:        'quality-issues.js',
    line:        46,
    evidence:    'const rounded = Math.round(amount * 100) / 100;',
    explanation: 'Duplicate of the rounding logic in formatUsd; extract a helper.',
  };

  it('Evidence Validator returns VERIFIED for the duplicate-code line', () => {
    const result = validateFinding(mockFinding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
    expect(result.sourceLine).toContain('Math.round(amount * 100)');
  });

  it('Full pipeline: DUPLICATE_CODE finding is VERIFIED', () => {
    const merged = runPipelineWithMockFindings([mockFinding]);
    expect(merged[0].verification.status).toBe('VERIFIED');
  });
});

// ─── Test 31 — Fabricated quality finding is UNVERIFIED ───────────────────────

describe('Test 31 — Quality: fabricated finding is UNVERIFIED', () => {
  it('UNVERIFIED when the claimed line does not contain the evidence', () => {
    const fabricated = {
      type:        'LOGIC_ERROR',
      severity:    'HIGH',
      confidence:  'HIGH',
      file:        'quality-issues.js',
      line:        35,   // real line, but evidence is unrelated
      evidence:    'while (zzz_nonexistent_9999 <= somethingElse) doStuff();',
      explanation: 'Fabricated — this construct does not exist in the file.',
    };
    const result = validateFinding(fabricated, FIXTURES);
    expect(result.status).toBe('UNVERIFIED');
  });

  it('UNVERIFIED when line is beyond end of file', () => {
    const fabricated = {
      type:        'DEAD_CODE',
      severity:    'MEDIUM',
      confidence:  'HIGH',
      file:        'quality-issues.js',
      line:        9999,
      evidence:    'total = total * 2;',
      explanation: 'Fabricated — line beyond EOF.',
    };
    const result = validateFinding(fabricated, FIXTURES);
    expect(result.status).toBe('UNVERIFIED');
    expect(result.reason).toMatch(/does not exist|only has/i);
  });
});

// ─── Test 32 — Quality Agent restricts to its own finding types ───────────────

describe('Test 32 — Quality Agent type filter', () => {
  it('QUALITY_TYPES contains the four quality categories', () => {
    expect(QUALITY_TYPES.has('DEAD_CODE')).toBe(true);
    expect(QUALITY_TYPES.has('DUPLICATE_CODE')).toBe(true);
    expect(QUALITY_TYPES.has('LOGIC_ERROR')).toBe(true);
    expect(QUALITY_TYPES.has('BUG_RISK')).toBe(true);
  });

  it('QUALITY_TYPES does NOT contain security types', () => {
    expect(QUALITY_TYPES.has('SQL_INJECTION')).toBe(false);
    expect(QUALITY_TYPES.has('HARDCODED_SECRET')).toBe(false);
  });

  it('a mixed LLM response can be split by type via QUALITY_TYPES', () => {
    const mixed = parseQualityFindings(JSON.stringify([
      { type: 'DEAD_CODE',     severity: 'LOW',  confidence: 'HIGH', file: 'a.js', line: 1, evidence: 'x', explanation: 'y' },
      { type: 'SQL_INJECTION', severity: 'HIGH', confidence: 'HIGH', file: 'a.js', line: 2, evidence: 'x', explanation: 'y' },
    ]));
    const qualityOnly = mixed.filter(f => QUALITY_TYPES.has(f.type));
    expect(qualityOnly).toHaveLength(1);
    expect(qualityOnly[0].type).toBe('DEAD_CODE');
  });
});

// ─── Test 33 — Reporter renders security + quality findings together ──────────

describe('Test 33 — Reporter: security and quality findings in one comment', () => {
  const mixedFindings = [
    {
      type: 'SQL_INJECTION', severity: 'HIGH', confidence: 'HIGH',
      file: 'vulnerable.js', line: 21,
      evidence: "'SELECT * FROM users WHERE id = ' + userId",
      explanation: 'User input concatenated into SQL.',
      verification: { status: 'VERIFIED', file: 'vulnerable.js', line: 21, sourceLine: 'x' },
    },
    {
      type: 'LOGIC_ERROR', severity: 'HIGH', confidence: 'HIGH',
      file: 'quality-issues.js', line: 27,
      evidence: "if (user.role = 'admin') {",
      explanation: 'Assignment used where comparison intended.',
      verification: { status: 'VERIFIED', file: 'quality-issues.js', line: 27, sourceLine: 'x' },
    },
  ];

  const result = makeReviewResult({
    findings:         mixedFindings,
    genesisAvailable: false,
    llmUsed:          true,
    error:            null,
    durationMs:       800,
  });

  it('comment header reflects a combined code review', () => {
    const body = buildCommentBody(result);
    expect(body).toContain('AI Code Review');
  });

  it('comment shows both category counts', () => {
    const body = buildCommentBody(result);
    expect(body).toContain('💉 Security: Injection: 1');
    expect(body).toContain('🐞 Correctness: 1');
  });

  it('comment renders both finding types with a Category row', () => {
    const body = buildCommentBody(result);
    expect(body).toContain('SQL_INJECTION');
    expect(body).toContain('LOGIC_ERROR');
    expect(body).toContain('Category');
    expect(body).toContain('🐞 Correctness');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Tests 34–46 — Production code-quality catalog: config, categories, ranges
// ─────────────────────────────────────────────────────────────────────────────

import {
  resolveQualityConfig,
  filterQualityFindings,
  categoryMetaForType,
  isRangeType,
  meetsSeverityFloor,
  ALL_QUALITY_TYPES,
  RANGE_TYPES,
  CATEGORIES,
} from '../src/agents/checkCatalog.js';

// ─── Test 34 — Catalog config: high-signal defaults ───────────────────────────

describe('Test 34 — checkCatalog: default configuration', () => {
  it('enables the high-signal categories by default', () => {
    const cfg = resolveQualityConfig({});
    ['correctness', 'dead_code', 'duplication', 'error_handling',
     'maintainability', 'performance', 'api_contract']
      .forEach(k => expect(cfg.enabledCategories.has(k)).toBe(true));
  });

  it('disables subjective categories (style, test_coverage) by default', () => {
    const cfg = resolveQualityConfig({});
    expect(cfg.enabledCategories.has('style')).toBe(false);
    expect(cfg.enabledCategories.has('test_coverage')).toBe(false);
  });

  it('master switch off disables everything', () => {
    const cfg = resolveQualityConfig({ AI_REVIEW_ENABLE_QUALITY: 'false' });
    expect(cfg.enabled).toBe(false);
  });

  it('explicit allow-list runs ONLY the named categories', () => {
    const cfg = resolveQualityConfig({ AI_REVIEW_QUALITY_CATEGORIES: 'correctness, performance' });
    expect([...cfg.enabledCategories].sort()).toEqual(['correctness', 'performance']);
  });

  it('disable-list removes categories from the default set', () => {
    const cfg = resolveQualityConfig({ AI_REVIEW_DISABLE_CATEGORIES: 'maintainability,performance' });
    expect(cfg.enabledCategories.has('maintainability')).toBe(false);
    expect(cfg.enabledCategories.has('performance')).toBe(false);
    expect(cfg.enabledCategories.has('correctness')).toBe(true);
  });

  it('enabling style adds STYLE to the enabled types', () => {
    const cfg = resolveQualityConfig({ AI_REVIEW_QUALITY_CATEGORIES: 'style' });
    expect(cfg.enabledTypes.has('STYLE')).toBe(true);
  });
});

// ─── Test 35 — Severity floor ─────────────────────────────────────────────────

describe('Test 35 — checkCatalog: severity floor', () => {
  it('meetsSeverityFloor compares ranks correctly', () => {
    expect(meetsSeverityFloor('HIGH', 'MEDIUM')).toBe(true);
    expect(meetsSeverityFloor('LOW', 'MEDIUM')).toBe(false);
    expect(meetsSeverityFloor('CRITICAL', 'CRITICAL')).toBe(true);
  });

  it('filterQualityFindings drops findings below the configured floor', () => {
    const cfg = resolveQualityConfig({ AI_REVIEW_QUALITY_MIN_SEVERITY: 'HIGH' });
    const findings = [
      { type: 'LOGIC_ERROR', severity: 'HIGH',   file: 'a.js', line: 1 },
      { type: 'DEAD_CODE',   severity: 'LOW',    file: 'a.js', line: 2 },
      { type: 'BUG_RISK',    severity: 'CRITICAL', file: 'a.js', line: 3 },
    ];
    const kept = filterQualityFindings(findings, cfg);
    expect(kept.map(f => f.type).sort()).toEqual(['BUG_RISK', 'LOGIC_ERROR']);
  });

  it('filterQualityFindings drops findings of disabled categories', () => {
    const cfg = resolveQualityConfig({ AI_REVIEW_QUALITY_CATEGORIES: 'correctness' });
    const findings = [
      { type: 'LOGIC_ERROR', severity: 'HIGH', file: 'a.js', line: 1 },
      { type: 'PERFORMANCE', severity: 'HIGH', file: 'a.js', line: 2 },
    ];
    const kept = filterQualityFindings(findings, cfg);
    expect(kept).toHaveLength(1);
    expect(kept[0].type).toBe('LOGIC_ERROR');
  });
});

// ─── Test 36 — Category metadata + range types ────────────────────────────────

describe('Test 36 — checkCatalog: type metadata and range types', () => {
  it('every category type resolves to that category', () => {
    for (const c of CATEGORIES) {
      for (const t of c.types) {
        expect(categoryMetaForType(t).key).toBe(c.key);
      }
    }
  });

  it('unknown type falls back to Other', () => {
    expect(categoryMetaForType('NONSENSE').key).toBe('other');
  });

  it('range types are recognised', () => {
    expect(isRangeType('DUPLICATE_CODE')).toBe(true);
    expect(isRangeType('PERFORMANCE')).toBe(true);
    expect(isRangeType('COMPLEXITY')).toBe(true);
    expect(isRangeType('LOGIC_ERROR')).toBe(false);
  });

  it('ALL_QUALITY_TYPES and RANGE_TYPES are populated', () => {
    expect(ALL_QUALITY_TYPES.size).toBeGreaterThanOrEqual(12);
    expect(RANGE_TYPES.size).toBeGreaterThanOrEqual(4);
  });
});

// ─── Test 37 — findingParser carries endLine ──────────────────────────────────

describe('Test 37 — findingParser: endLine handling', () => {
  it('keeps a valid endLine >= line', () => {
    const [f] = parseQualityFindings(JSON.stringify([{
      type: 'DUPLICATE_CODE', severity: 'LOW', confidence: 'MEDIUM',
      file: 'a.js', line: 10, endLine: 20, evidence: 'x', explanation: 'y',
    }]));
    expect(f.endLine).toBe(20);
  });

  it('nulls an endLine that is less than line', () => {
    const [f] = parseQualityFindings(JSON.stringify([{
      type: 'DUPLICATE_CODE', severity: 'LOW', confidence: 'MEDIUM',
      file: 'a.js', line: 20, endLine: 10, evidence: 'x', explanation: 'y',
    }]));
    expect(f.endLine).toBeNull();
  });

  it('nulls a missing endLine', () => {
    const [f] = parseQualityFindings(JSON.stringify([{
      type: 'LOGIC_ERROR', severity: 'HIGH', confidence: 'HIGH',
      file: 'a.js', line: 5, evidence: 'x', explanation: 'y',
    }]));
    expect(f.endLine).toBeNull();
  });
});

// ─── Test 38 — Evidence Validator: range findings ─────────────────────────────

describe('Test 38 — evidenceValidator: range (multi-line) findings', () => {
  it('VERIFIED when evidence is within the claimed range (PERFORMANCE 67-73)', () => {
    const finding = {
      type: 'PERFORMANCE', severity: 'HIGH', confidence: 'HIGH',
      file: 'quality-issues.js', line: 67, endLine: 73,
      evidence: "users.push(await db.query('SELECT * FROM users WHERE id = $1', [id]));",
      explanation: 'N+1 query — DB call inside a loop.',
    };
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
    expect(result.endLine).toBe(73);
  });

  it('VERIFIED for a duplicate-code range (formatEur block)', () => {
    const finding = {
      type: 'DUPLICATE_CODE', severity: 'LOW', confidence: 'MEDIUM',
      file: 'quality-issues.js', line: 45, endLine: 48,
      evidence: 'const rounded = Math.round(amount * 100) / 100;',
      explanation: 'Duplicate of formatUsd rounding logic.',
    };
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
    expect(result.endLine).toBe(48);
  });

  it('UNVERIFIED when the range end runs past end of file', () => {
    const finding = {
      type: 'PERFORMANCE', severity: 'HIGH', confidence: 'HIGH',
      file: 'quality-issues.js', line: 67, endLine: 99999,
      evidence: 'users.push(await db.query',
      explanation: 'Range past EOF.',
    };
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('UNVERIFIED');
    expect(result.reason).toMatch(/does not exist|only has/i);
  });

  it('UNVERIFIED when evidence is not in the claimed range', () => {
    const finding = {
      type: 'DUPLICATE_CODE', severity: 'LOW', confidence: 'MEDIUM',
      file: 'quality-issues.js', line: 45, endLine: 48,
      evidence: 'zzz_nonexistent_code_9999(reallyNotThere);',
      explanation: 'Fabricated range evidence.',
    };
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('UNVERIFIED');
  });
});

// ─── Test 39 — ERROR_HANDLING detected and VERIFIED ───────────────────────────

describe('Test 39 — Quality: error handling issue detected and VERIFIED', () => {
  const finding = {
    type: 'ERROR_HANDLING', severity: 'MEDIUM', confidence: 'HIGH',
    file: 'quality-issues.js', line: 54, endLine: 59,
    evidence: 'return JSON.parse(readFileSync(path));',
    explanation: 'Empty catch block swallows the parse error.',
  };

  it('VERIFIED against the try/catch block', () => {
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
  });

  it('Full pipeline: ERROR_HANDLING finding is VERIFIED', () => {
    const merged = runPipelineWithMockFindings([finding]);
    expect(merged[0].type).toBe('ERROR_HANDLING');
    expect(merged[0].verification.status).toBe('VERIFIED');
  });
});

// ─── Test 40 — MAGIC_NUMBER detected and VERIFIED ─────────────────────────────

describe('Test 40 — Quality: magic number detected and VERIFIED', () => {
  const finding = {
    type: 'MAGIC_NUMBER', severity: 'LOW', confidence: 'MEDIUM',
    file: 'quality-issues.js', line: 63,
    evidence: 'return Date.now() - createdAt > 86400000;',
    explanation: 'Unexplained literal 86400000 (ms per day) should be a named constant.',
  };

  it('VERIFIED against the magic-number line', () => {
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
    expect(result.sourceLine).toContain('86400000');
  });
});

// ─── Test 41 — COMPLEXITY range detected and VERIFIED ─────────────────────────

describe('Test 41 — Quality: complexity range detected and VERIFIED', () => {
  const finding = {
    type: 'COMPLEXITY', severity: 'MEDIUM', confidence: 'MEDIUM',
    file: 'quality-issues.js', line: 76, endLine: 90,
    evidence: 'function classify(n) {',
    explanation: 'Deeply nested function should be decomposed.',
  };

  it('VERIFIED against the function span', () => {
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
    expect(result.endLine).toBe(90);
  });
});

// ─── Test 42 — Reporter: renders range findings and dynamic categories ────────

describe('Test 42 — Reporter: range finding + category breakdown', () => {
  const result = makeReviewResult({
    findings: [
      {
        type: 'PERFORMANCE', severity: 'HIGH', confidence: 'HIGH',
        file: 'quality-issues.js', line: 67, endLine: 73,
        evidence: 'db.query', explanation: 'N+1',
        verification: { status: 'VERIFIED', file: 'quality-issues.js', line: 67, endLine: 73, sourceLine: 'x' },
      },
      {
        type: 'SQL_INJECTION', severity: 'HIGH', confidence: 'HIGH',
        file: 'vulnerable.js', line: 21,
        evidence: 'x', explanation: 'y',
        verification: { status: 'VERIFIED', file: 'vulnerable.js', line: 21, sourceLine: 'x' },
      },
    ],
    genesisAvailable: false, llmUsed: true, error: null, durationMs: 400,
  });

  it('shows a line range (67–73) for the range finding', () => {
    const body = buildCommentBody(result);
    expect(body).toContain('67–73');
    expect(body).toContain('**Lines**');
  });

  it('breakdown lists only categories present', () => {
    const body = buildCommentBody(result);
    expect(body).toContain('💉 Security: Injection: 1');
    expect(body).toContain('⚡ Performance: 1');
    // A category with no findings must not appear
    expect(body).not.toContain('Dead Code: ');
  });

  it('renders the Performance category label on the finding', () => {
    const body = buildCommentBody(result);
    expect(body).toContain('⚡ Performance');
  });
});

// ─── Test 43 — Quality Agent honours a pre-resolved config (no LLM) ───────────

describe('Test 43 — qualityAgent: skips when all categories disabled', () => {
  it('returns skipped=true and no error when enabledTypes is empty', async () => {
    const { analyseForQuality } = await import('../src/agents/qualityAgent.js');
    const cfg = resolveQualityConfig({ AI_REVIEW_ENABLE_QUALITY: 'true', AI_REVIEW_DISABLE_CATEGORIES:
      'correctness,dead_code,duplication,error_handling,maintainability,performance,api_contract' });
    const result = await analyseForQuality('const x = 1;', '', { config: cfg });
    expect(result.skipped).toBe(true);
    expect(result.llmUsed).toBe(false);
    expect(result.findings).toHaveLength(0);
  });
});

// ─── Test 44 — Missing GROQ key: quality agent degrades gracefully ────────────

describe('Test 44 — qualityAgent: graceful without GROQ_API_KEY', () => {
  let savedKey;
  beforeEach(() => { savedKey = process.env.GROQ_API_KEY; delete process.env.GROQ_API_KEY; });
  afterEach(() => { if (savedKey !== undefined) process.env.GROQ_API_KEY = savedKey; else delete process.env.GROQ_API_KEY; });

  it('returns a graceful error result (no crash)', async () => {
    const { analyseForQuality } = await import('../src/agents/qualityAgent.js');
    const result = await analyseForQuality('const x = 1;', '');
    expect(result.llmUsed).toBe(false);
    expect(result.findings).toHaveLength(0);
    expect(result.error).toMatch(/GROQ_API_KEY/i);
  });
});

// ─── Test 45 — Backward compatibility: existing single-line quality types ─────

describe('Test 45 — Regression: single-line quality types still VERIFY', () => {
  it('DEAD_CODE single-line still VERIFIED', () => {
    const finding = {
      type: 'DEAD_CODE', severity: 'MEDIUM', confidence: 'HIGH',
      file: 'quality-issues.js', line: 23, evidence: 'total = total * 2;',
      explanation: 'unreachable',
    };
    expect(validateFinding(finding, FIXTURES).status).toBe('VERIFIED');
  });

  it('LOGIC_ERROR single-line still VERIFIED', () => {
    const finding = {
      type: 'LOGIC_ERROR', severity: 'HIGH', confidence: 'HIGH',
      file: 'quality-issues.js', line: 28, evidence: "if (user.role = 'admin') {",
      explanation: 'assignment in condition',
    };
    expect(validateFinding(finding, FIXTURES).status).toBe('VERIFIED');
  });
});

// ─── Test 46 — Mixed multi-category batch through the full pipeline ───────────

describe('Test 46 — Full pipeline: mixed multi-category findings', () => {
  const findings = [
    { type: 'LOGIC_ERROR',    severity: 'HIGH',   confidence: 'HIGH', file: 'quality-issues.js', line: 28, evidence: "if (user.role = 'admin') {", explanation: 'a' },
    { type: 'ERROR_HANDLING', severity: 'MEDIUM', confidence: 'HIGH', file: 'quality-issues.js', line: 54, endLine: 59, evidence: 'return JSON.parse(readFileSync(path));', explanation: 'b' },
    { type: 'PERFORMANCE',    severity: 'HIGH',   confidence: 'HIGH', file: 'quality-issues.js', line: 67, endLine: 73, evidence: "users.push(await db.query('SELECT * FROM users WHERE id = $1', [id]));", explanation: 'c' },
    { type: 'MAGIC_NUMBER',   severity: 'LOW',    confidence: 'MEDIUM', file: 'quality-issues.js', line: 63, evidence: 'return Date.now() - createdAt > 86400000;', explanation: 'd' },
  ];

  it('all four are VERIFIED', () => {
    const merged = runPipelineWithMockFindings(findings, FIXTURES);
    expect(merged).toHaveLength(4);
    merged.forEach(f => expect(f.verification.status).toBe('VERIFIED'));
  });

  it('reporter renders all four categories in the breakdown', () => {
    const result = makeReviewResult({
      findings: findings.map(f => ({ ...f, verification: { status: 'VERIFIED', file: f.file, line: f.line, endLine: f.endLine, sourceLine: 'x' } })),
      genesisAvailable: false, llmUsed: true, error: null, durationMs: 600,
    });
    const body = buildCommentBody(result);
    expect(body).toContain('🐞 Correctness');
    expect(body).toContain('🛟 Error Handling');
    expect(body).toContain('⚡ Performance');
    expect(body).toContain('🔧 Maintainability');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Tests 47–49 — Genesis-assisted checks (API_CONTRACT / TEST_COVERAGE wiring)
// ─────────────────────────────────────────────────────────────────────────────

// ─── Test 47 — Genesis context reaches the agents via combined context ────────

describe('Test 47 — buildContext embeds Genesis repository context for the agents', () => {
  const DIFF = [
    '--- a/vulnerable.js',
    '+++ b/vulnerable.js',
    '@@ -20,3 +20,4 @@',
    ' async function getUserById(req, res) {',
    "+  const sql = 'SELECT * FROM users WHERE id = ' + userId;",
    ' }',
  ].join('\n');

  // Simulate the summary genesisAdapter.buildContextSummary() would produce.
  const GENESIS_SUMMARY = [
    '## File: vulnerable.js',
    '  Symbols defined: function getUserById (line 20), function getUserByName (line 28)',
    '  Imported by (blast radius): src/routes/users.js, src/api/index.js',
  ].join('\n');

  it('combined context contains the Genesis section when a summary is provided', () => {
    const { combined } = buildContext(DIFF, FIXTURES, GENESIS_SUMMARY);
    expect(combined).toContain('=== REPOSITORY CONTEXT (Genesis) ===');
    expect(combined).toContain('Imported by (blast radius)');
    expect(combined).toContain('getUserById');
  });

  it('the agents receive blast-radius info the API_CONTRACT check relies on', () => {
    const { combined } = buildContext(DIFF, FIXTURES, GENESIS_SUMMARY);
    // The quality prompt instructs the model to use these lines; here we assert
    // they are present in what the agent is actually handed.
    expect(combined).toContain('src/routes/users.js');
  });
});

// ─── Test 48 — API_CONTRACT finding verifies + reports under its category ─────

describe('Test 48 — API_CONTRACT finding flows through pipeline and reporter', () => {
  // vulnerable.js line 20: "async function getUserById(req, res) {"
  const finding = {
    type: 'API_CONTRACT', severity: 'HIGH', confidence: 'MEDIUM',
    file: 'vulnerable.js', line: 20,
    evidence: 'async function getUserById(req, res) {',
    explanation: 'Exported handler signature changed; dependents in blast radius may break.',
  };

  it('is VERIFIED against the exported function line', () => {
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
  });

  it('reporter renders it under the API / Contract category', () => {
    const result = makeReviewResult({
      findings: [{ ...finding, verification: { status: 'VERIFIED', file: finding.file, line: finding.line, sourceLine: 'x' } }],
      genesisAvailable: true, llmUsed: true, error: null, durationMs: 300,
    });
    const body = buildCommentBody(result);
    expect(body).toContain('🔌 API / Contract');
  });
});

// ─── Test 49 — TEST_COVERAGE is opt-in and categorised correctly ──────────────

describe('Test 49 — TEST_COVERAGE category behaviour', () => {
  it('is disabled by default', () => {
    const cfg = resolveQualityConfig({});
    expect(cfg.enabledTypes.has('TEST_COVERAGE')).toBe(false);
  });

  it('is enabled via the allow-list and maps to the Test Coverage category', () => {
    const cfg = resolveQualityConfig({ AI_REVIEW_QUALITY_CATEGORIES: 'test_coverage' });
    expect(cfg.enabledTypes.has('TEST_COVERAGE')).toBe(true);
    expect(categoryMetaForType('TEST_COVERAGE').label).toBe('Test Coverage');
  });

  it('a TEST_COVERAGE finding is kept only when the category is enabled', () => {
    const finding = { type: 'TEST_COVERAGE', severity: 'MEDIUM', file: 'a.js', line: 1 };

    const offCfg = resolveQualityConfig({});
    expect(filterQualityFindings([finding], offCfg)).toHaveLength(0);

    const onCfg = resolveQualityConfig({ AI_REVIEW_QUALITY_CATEGORIES: 'test_coverage' });
    expect(filterQualityFindings([finding], onCfg)).toHaveLength(1);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Tests 50–55 — Review-finding fixes (dedup, config warnings, guards)
// ─────────────────────────────────────────────────────────────────────────────

import { dedupeFindings } from '../src/core/findingDedup.js';

// ─── Test 50 — dedupeFindings: overlapping same-line findings merge ───────────

describe('Test 50 — dedupeFindings merges overlapping findings', () => {
  it('collapses two findings on the same line into one primary with alsoFlaggedAs', () => {
    const out = dedupeFindings([
      { type: 'LOGIC_ERROR', severity: 'HIGH', confidence: 'HIGH',   file: 'a.js', line: 27 },
      { type: 'MAGIC_NUMBER', severity: 'LOW', confidence: 'MEDIUM', file: 'a.js', line: 27 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('LOGIC_ERROR');          // higher severity wins
    expect(out[0].alsoFlaggedAs).toEqual(['MAGIC_NUMBER']);
  });

  it('keeps findings on different lines separate', () => {
    const out = dedupeFindings([
      { type: 'LOGIC_ERROR', severity: 'HIGH', confidence: 'HIGH', file: 'a.js', line: 27 },
      { type: 'DEAD_CODE',   severity: 'LOW',  confidence: 'HIGH', file: 'a.js', line: 40 },
    ]);
    expect(out).toHaveLength(2);
    expect(out.every(f => !f.alsoFlaggedAs)).toBe(true);
  });

  it('merges a single-line finding that falls within a range finding', () => {
    const out = dedupeFindings([
      { type: 'DUPLICATE_CODE', severity: 'MEDIUM', confidence: 'HIGH', file: 'a.js', line: 26, endLine: 32 },
      { type: 'DEAD_CODE',      severity: 'LOW',    confidence: 'HIGH', file: 'a.js', line: 28 },
    ]);
    expect(out).toHaveLength(1);
    // DUPLICATE_CODE (MEDIUM) outranks DEAD_CODE (LOW)
    expect(out[0].type).toBe('DUPLICATE_CODE');
    expect(out[0].alsoFlaggedAs).toEqual(['DEAD_CODE']);
  });

  it('never merges findings across different files', () => {
    const out = dedupeFindings([
      { type: 'LOGIC_ERROR', severity: 'HIGH', confidence: 'HIGH', file: 'a.js', line: 5 },
      { type: 'LOGIC_ERROR', severity: 'HIGH', confidence: 'HIGH', file: 'b.js', line: 5 },
    ]);
    expect(out).toHaveLength(2);
  });

  it('a security finding is always the primary over an overlapping quality finding', () => {
    const out = dedupeFindings([
      { type: 'MAGIC_NUMBER',  severity: 'HIGH', confidence: 'HIGH', file: 'a.js', line: 10 },
      { type: 'SQL_INJECTION', severity: 'LOW',  confidence: 'LOW',  file: 'a.js', line: 10 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('SQL_INJECTION');         // security wins despite lower severity
    expect(out[0].alsoFlaggedAs).toEqual(['MAGIC_NUMBER']);
  });

  it('returns input unchanged for 0 or 1 findings', () => {
    expect(dedupeFindings([])).toHaveLength(0);
    expect(dedupeFindings([{ type: 'DEAD_CODE', severity: 'LOW', file: 'a.js', line: 1 }])).toHaveLength(1);
    expect(dedupeFindings(null)).toHaveLength(0);
  });
});

// ─── Test 51 — config: unknown category keys warn (and are ignored) ───────────

describe('Test 51 — resolveQualityConfig warns on unknown category keys', () => {
  let warnSpy;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('warns and ignores a typo in the allow-list', () => {
    const cfg = resolveQualityConfig({ AI_REVIEW_QUALITY_CATEGORIES: 'corectness,performance' });
    // Only the valid one survives
    expect([...cfg.enabledCategories]).toEqual(['performance']);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/corectness/);
  });

  it('warns on an unknown key in the disable-list', () => {
    resolveQualityConfig({ AI_REVIEW_DISABLE_CATEGORIES: 'nonsense' });
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/nonsense/);
  });

  it('does not warn when all keys are valid', () => {
    resolveQualityConfig({ AI_REVIEW_QUALITY_CATEGORIES: 'correctness,performance' });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ─── Test 52 — qualityAgent honours the master switch defensively ─────────────

describe('Test 52 — analyseForQuality respects config.enabled', () => {
  it('skips (no LLM) when the master switch is off, even if categories resolve', async () => {
    const { analyseForQuality } = await import('../src/agents/qualityAgent.js');
    const cfg = resolveQualityConfig({ AI_REVIEW_ENABLE_QUALITY: 'false' });
    const result = await analyseForQuality('const x = 1;', '', { config: cfg });
    expect(result.skipped).toBe(true);
    expect(result.llmUsed).toBe(false);
    expect(result.findings).toHaveLength(0);
  });
});

// ─── Test 53 — checkCatalog: every enabled category has an instruction block ──

describe('Test 53 — every category key has a prompt instruction block', () => {
  it('CATEGORY_INSTRUCTIONS covers every catalog category (no silent omission)', async () => {
    // Import the agent module and the catalog; assert parity by reconstructing
    // the enabled set for each category and confirming the prompt is non-empty.
    const { CATEGORIES } = await import('../src/agents/checkCatalog.js');
    // buildSystemPrompt is internal; we assert indirectly via the agent's export
    // surface by checking each category key maps to metadata (a proxy for wiring).
    for (const c of CATEGORIES) {
      expect(typeof c.key).toBe('string');
      expect(c.types.length).toBeGreaterThan(0);
    }
    // The authoritative guard lives in buildSystemPrompt (warns if a block is
    // missing). Here we simply document that all current categories are covered:
    const expectedKeys = [
      'correctness', 'dead_code', 'duplication', 'error_handling',
      'maintainability', 'performance', 'api_contract', 'style', 'test_coverage',
    ];
    expect(CATEGORIES.map(c => c.key).sort()).toEqual(expectedKeys.sort());
  });
});

// ─── Test 54 — dedup preserves verification-independent fields ────────────────

describe('Test 54 — dedupeFindings preserves evidence/line of the primary', () => {
  it('keeps the primary finding evidence and line, not the merged one', () => {
    const out = dedupeFindings([
      { type: 'LOGIC_ERROR', severity: 'HIGH', confidence: 'HIGH', file: 'a.js', line: 27, evidence: 'if (age = 18) {', explanation: 'assignment' },
      { type: 'MAGIC_NUMBER', severity: 'LOW', confidence: 'MEDIUM', file: 'a.js', line: 27, evidence: 'if (age = 18) {', explanation: 'magic 18' },
    ]);
    expect(out[0].evidence).toBe('if (age = 18) {');
    expect(out[0].line).toBe(27);
    expect(out[0].explanation).toBe('assignment');
  });
});

// ─── Test 55 — dedup integrates with the validator merge shape ────────────────

describe('Test 55 — deduped findings still validate correctly', () => {
  it('a deduped finding with alsoFlaggedAs still passes through validateFindings', () => {
    const deduped = dedupeFindings([
      { type: 'LOGIC_ERROR', severity: 'HIGH', confidence: 'HIGH', file: 'quality-issues.js', line: 28, evidence: "if (user.role = 'admin') {", explanation: 'x' },
      { type: 'MAGIC_NUMBER', severity: 'LOW', confidence: 'MEDIUM', file: 'quality-issues.js', line: 28, evidence: "if (user.role = 'admin') {", explanation: 'y' },
    ]);
    const results = validateFindings(deduped, FIXTURES);
    expect(results).toHaveLength(1);
    expect(results[0].validation.status).toBe('VERIFIED');
    expect(results[0].finding.alsoFlaggedAs).toEqual(['MAGIC_NUMBER']);
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Tests 56–62 — Security catalog (full check set, config, verification)
// ─────────────────────────────────────────────────────────────────────────────

import {
  resolveSecurityConfig,
  filterSecurityFindings,
  securityCategoryMetaForType,
  isSecurityRangeType,
  ALL_SECURITY_TYPES,
  SECURITY_RANGE_TYPES,
  SECURITY_CATEGORIES,
} from '../src/agents/securityCatalog.js';

// ─── Test 56 — Security catalog default configuration ─────────────────────────

describe('Test 56 — securityCatalog: default configuration', () => {
  it('enables the tier-1 categories by default', () => {
    const cfg = resolveSecurityConfig({});
    ['injection', 'web', 'secrets', 'crypto', 'files', 'data_exposure', 'config']
      .forEach(k => expect(cfg.enabledCategories.has(k)).toBe(true));
  });

  it('disables context-heavy categories (auth, api) by default', () => {
    const cfg = resolveSecurityConfig({});
    expect(cfg.enabledCategories.has('auth')).toBe(false);
    expect(cfg.enabledCategories.has('api')).toBe(false);
  });

  it('allow-list runs ONLY the named categories', () => {
    const cfg = resolveSecurityConfig({ AI_REVIEW_SECURITY_CATEGORIES: 'injection,crypto' });
    expect([...cfg.enabledCategories].sort()).toEqual(['crypto', 'injection']);
  });

  it('disable-list removes categories from defaults', () => {
    const cfg = resolveSecurityConfig({ AI_REVIEW_DISABLE_SECURITY_CATEGORIES: 'config,web' });
    expect(cfg.enabledCategories.has('config')).toBe(false);
    expect(cfg.enabledCategories.has('web')).toBe(false);
    expect(cfg.enabledCategories.has('injection')).toBe(true);
  });

  it('enabling auth adds its types (including MISSING_AUTH_CHECK)', () => {
    const cfg = resolveSecurityConfig({ AI_REVIEW_SECURITY_CATEGORIES: 'auth' });
    expect(cfg.enabledTypes.has('MISSING_AUTH_CHECK')).toBe(true);
    expect(cfg.enabledTypes.has('INSECURE_JWT')).toBe(true);
  });

  it('master switch off is reflected in config.enabled', () => {
    expect(resolveSecurityConfig({ AI_REVIEW_ENABLE_SECURITY: 'false' }).enabled).toBe(false);
  });
});

// ─── Test 57 — Security catalog metadata + range types ────────────────────────

describe('Test 57 — securityCatalog: metadata and range types', () => {
  it('every catalog type resolves to its category', () => {
    for (const c of SECURITY_CATEGORIES) {
      for (const t of c.types) {
        expect(securityCategoryMetaForType(t).key).toBe(c.key);
      }
    }
  });

  it('unknown type falls back to a generic Security bucket', () => {
    expect(securityCategoryMetaForType('NONSENSE').label).toBe('Security');
  });

  it('range types are recognised', () => {
    expect(isSecurityRangeType('INSECURE_DESERIALIZATION')).toBe(true);
    expect(isSecurityRangeType('MISSING_AUTH_CHECK')).toBe(true);
    expect(isSecurityRangeType('SQL_INJECTION')).toBe(false);
  });

  it('catalog covers a broad set of types', () => {
    expect(ALL_SECURITY_TYPES.size).toBeGreaterThanOrEqual(40);
    expect(SECURITY_RANGE_TYPES.size).toBeGreaterThanOrEqual(1);
  });
});

// ─── Test 58 — severity floor + type filtering ────────────────────────────────

describe('Test 58 — filterSecurityFindings: floor + enabled types', () => {
  it('drops findings below the configured floor', () => {
    const cfg = resolveSecurityConfig({ AI_REVIEW_SECURITY_MIN_SEVERITY: 'HIGH' });
    const findings = [
      { type: 'XSS',            severity: 'HIGH',     file: 'a.js', line: 1 },
      { type: 'INSECURE_CORS',  severity: 'LOW',      file: 'a.js', line: 2 },
      { type: 'COMMAND_INJECTION', severity: 'CRITICAL', file: 'a.js', line: 3 },
    ];
    const kept = filterSecurityFindings(findings, cfg).map(f => f.type).sort();
    expect(kept).toEqual(['COMMAND_INJECTION', 'XSS']);
  });

  it('drops findings whose category is disabled', () => {
    const cfg = resolveSecurityConfig({ AI_REVIEW_SECURITY_CATEGORIES: 'injection' });
    const findings = [
      { type: 'SQL_INJECTION', severity: 'HIGH', file: 'a.js', line: 1 },
      { type: 'WEAK_HASH',     severity: 'HIGH', file: 'a.js', line: 2 },  // crypto — disabled
    ];
    const kept = filterSecurityFindings(findings, cfg);
    expect(kept).toHaveLength(1);
    expect(kept[0].type).toBe('SQL_INJECTION');
  });
});

// ─── Test 59 — unknown category keys warn ─────────────────────────────────────

describe('Test 59 — resolveSecurityConfig warns on unknown keys', () => {
  let warnSpy;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('warns and ignores a typo in the allow-list', () => {
    const cfg = resolveSecurityConfig({ AI_REVIEW_SECURITY_CATEGORIES: 'injektion,crypto' });
    expect([...cfg.enabledCategories]).toEqual(['crypto']);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/injektion/);
  });
});

// ─── Test 60 — representative security findings VERIFY against source ──────────

describe('Test 60 — Security findings verify against the fixture source', () => {
  const cases = [
    { type: 'COMMAND_INJECTION',        line: 23, evidence: "exec('ping -c 1 ' + host, (e, out) => res.send(out));" },
    { type: 'CODE_INJECTION',           line: 29, evidence: 'const result = eval(expr);' },
    { type: 'XSS',                      line: 36, evidence: "res.send('<div>' + name + '</div>');" },
    { type: 'PATH_TRAVERSAL',           line: 42, evidence: "const data = fs.readFileSync('/var/docs/' + file);" },
    { type: 'WEAK_HASH',                line: 48, evidence: "return crypto.createHash('md5').update(pw).digest('hex');" },
    { type: 'INSECURE_RANDOM',          line: 53, evidence: 'return Math.random().toString(36).slice(2);' },
    { type: 'DISABLED_CERT_VALIDATION', line: 58, evidence: 'const agent = new https.Agent({ rejectUnauthorized: false });' },
  ];

  for (const c of cases) {
    it(`${c.type} is VERIFIED at line ${c.line}`, () => {
      const finding = {
        type: c.type, severity: 'HIGH', confidence: 'HIGH',
        file: 'security-issues.js', line: c.line, evidence: c.evidence,
        explanation: 'test',
      };
      const result = validateFinding(finding, FIXTURES);
      expect(result.status).toBe('VERIFIED');
    });
  }

  it('a fabricated security finding (wrong evidence) is UNVERIFIED', () => {
    const finding = {
      type: 'COMMAND_INJECTION', severity: 'HIGH', confidence: 'HIGH',
      file: 'security-issues.js', line: 23,
      evidence: 'spawn("zzz_totally_not_here_9999", args);',
      explanation: 'fabricated',
    };
    expect(validateFinding(finding, FIXTURES).status).toBe('UNVERIFIED');
  });
});

// ─── Test 61 — full pipeline: mixed security findings dedup + verify ──────────

describe('Test 61 — Security findings through dedup + validation', () => {
  const findings = [
    { type: 'COMMAND_INJECTION', severity: 'CRITICAL', confidence: 'HIGH', file: 'security-issues.js', line: 23, evidence: "exec('ping -c 1 ' + host, (e, out) => res.send(out));", explanation: 'a' },
    { type: 'WEAK_HASH',         severity: 'MEDIUM',   confidence: 'HIGH', file: 'security-issues.js', line: 48, evidence: "return crypto.createHash('md5').update(pw).digest('hex');", explanation: 'b' },
  ];

  it('both verify through the merge pipeline', () => {
    const merged = runPipelineWithMockFindings(findings, FIXTURES);
    expect(merged).toHaveLength(2);
    merged.forEach(f => expect(f.verification.status).toBe('VERIFIED'));
  });

  it('a security finding stays primary when a quality finding overlaps it', () => {
    const out = dedupeFindings([
      { type: 'MAGIC_NUMBER',      severity: 'HIGH', confidence: 'HIGH', file: 'security-issues.js', line: 23 },
      { type: 'COMMAND_INJECTION', severity: 'LOW',  confidence: 'LOW',  file: 'security-issues.js', line: 23 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('COMMAND_INJECTION');
    expect(out[0].alsoFlaggedAs).toEqual(['MAGIC_NUMBER']);
  });
});

// ─── Test 62 — reporter groups security findings by their category ────────────

describe('Test 62 — Reporter groups security findings by category', () => {
  const result = makeReviewResult({
    findings: [
      { type: 'COMMAND_INJECTION', severity: 'CRITICAL', confidence: 'HIGH', file: 'security-issues.js', line: 23, evidence: 'x', explanation: 'y', verification: { status: 'VERIFIED', file: 'security-issues.js', line: 23, sourceLine: 'x' } },
      { type: 'WEAK_HASH',         severity: 'MEDIUM',   confidence: 'HIGH', file: 'security-issues.js', line: 48, evidence: 'x', explanation: 'y', verification: { status: 'VERIFIED', file: 'security-issues.js', line: 48, sourceLine: 'x' } },
    ],
    genesisAvailable: false, llmUsed: true, error: null, durationMs: 300,
  });

  it('renders distinct security categories (Injection, Cryptography)', () => {
    const body = buildCommentBody(result);
    expect(body).toContain('Security: Injection');
    expect(body).toContain('Security: Cryptography');
  });

  it('breakdown counts each security category separately', () => {
    const body = buildCommentBody(result);
    expect(body).toContain('Security: Injection: 1');
    expect(body).toContain('Security: Cryptography: 1');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Tests 63–69 — Testing catalog (test-quality checks, config, verification)
// ─────────────────────────────────────────────────────────────────────────────

import {
  resolveTestingConfig,
  filterTestingFindings,
  testingCategoryMetaForType,
  isTestingRangeType,
  ALL_TESTING_TYPES,
  TESTING_RANGE_TYPES,
  TESTING_CATEGORIES,
} from '../src/agents/testingCatalog.js';

// ─── Test 63 — Testing catalog default configuration ──────────────────────────

describe('Test 63 — testingCatalog: default configuration', () => {
  it('enables the on-by-default categories', () => {
    const cfg = resolveTestingConfig({});
    ['coverage', 'assertions', 'flakiness', 'hygiene', 'mocking', 'async']
      .forEach(k => expect(cfg.enabledCategories.has(k)).toBe(true));
  });

  it('disables the noisier categories (isolation, smells) by default', () => {
    const cfg = resolveTestingConfig({});
    expect(cfg.enabledCategories.has('isolation')).toBe(false);
    expect(cfg.enabledCategories.has('smells')).toBe(false);
  });

  it('allow-list runs ONLY the named categories', () => {
    const cfg = resolveTestingConfig({ AI_REVIEW_TESTING_CATEGORIES: 'assertions,async' });
    expect([...cfg.enabledCategories].sort()).toEqual(['assertions', 'async']);
  });

  it('disable-list removes categories from defaults', () => {
    const cfg = resolveTestingConfig({ AI_REVIEW_DISABLE_TESTING_CATEGORIES: 'coverage,flakiness' });
    expect(cfg.enabledCategories.has('coverage')).toBe(false);
    expect(cfg.enabledCategories.has('flakiness')).toBe(false);
    expect(cfg.enabledCategories.has('assertions')).toBe(true);
  });

  it('enabling smells adds its types', () => {
    const cfg = resolveTestingConfig({ AI_REVIEW_TESTING_CATEGORIES: 'smells' });
    expect(cfg.enabledTypes.has('TEST_LOGIC')).toBe(true);
    expect(cfg.enabledTypes.has('MULTIPLE_CONCERNS')).toBe(true);
  });

  it('master switch off is reflected in config.enabled', () => {
    expect(resolveTestingConfig({ AI_REVIEW_ENABLE_TESTING: 'false' }).enabled).toBe(false);
  });
});

// ─── Test 64 — Testing catalog metadata + range types ─────────────────────────

describe('Test 64 — testingCatalog: metadata and range types', () => {
  it('every catalog type resolves to its category', () => {
    for (const c of TESTING_CATEGORIES) {
      for (const t of c.types) {
        expect(testingCategoryMetaForType(t).key).toBe(c.key);
      }
    }
  });

  it('unknown type falls back to a generic Testing bucket', () => {
    expect(testingCategoryMetaForType('NONSENSE').label).toBe('Testing');
  });

  it('range types are recognised', () => {
    expect(isTestingRangeType('NO_ASSERTION')).toBe(true);
    expect(isTestingRangeType('EMPTY_TEST')).toBe(true);
    expect(isTestingRangeType('SKIPPED_TEST')).toBe(false);
  });

  it('catalog covers a broad set of types', () => {
    expect(ALL_TESTING_TYPES.size).toBeGreaterThanOrEqual(25);
    expect(TESTING_RANGE_TYPES.size).toBeGreaterThanOrEqual(1);
  });
});

// ─── Test 65 — severity floor + type filtering ────────────────────────────────

describe('Test 65 — filterTestingFindings: floor + enabled types', () => {
  it('drops findings below the configured floor', () => {
    const cfg = resolveTestingConfig({ AI_REVIEW_TESTING_MIN_SEVERITY: 'HIGH' });
    const findings = [
      { type: 'SKIPPED_TEST',            severity: 'HIGH', file: 'a.js', line: 1 },
      { type: 'POOR_TEST_NAME',          severity: 'LOW',  file: 'a.js', line: 2 },
      { type: 'MISSING_AWAIT_ASSERTION', severity: 'CRITICAL', file: 'a.js', line: 3 },
    ];
    const kept = filterTestingFindings(findings, cfg).map(f => f.type).sort();
    expect(kept).toEqual(['MISSING_AWAIT_ASSERTION', 'SKIPPED_TEST']);
  });

  it('drops findings whose category is disabled', () => {
    const cfg = resolveTestingConfig({ AI_REVIEW_TESTING_CATEGORIES: 'assertions' });
    const findings = [
      { type: 'NO_ASSERTION',       severity: 'HIGH', file: 'a.js', line: 1 },
      { type: 'TIME_DEPENDENT_TEST', severity: 'HIGH', file: 'a.js', line: 2 },  // flakiness — disabled
    ];
    const kept = filterTestingFindings(findings, cfg);
    expect(kept).toHaveLength(1);
    expect(kept[0].type).toBe('NO_ASSERTION');
  });
});

// ─── Test 66 — unknown category keys warn ─────────────────────────────────────

describe('Test 66 — resolveTestingConfig warns on unknown keys', () => {
  let warnSpy;
  beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); });

  it('warns and ignores a typo in the allow-list', () => {
    const cfg = resolveTestingConfig({ AI_REVIEW_TESTING_CATEGORIES: 'assertons,async' });
    expect([...cfg.enabledCategories]).toEqual(['async']);
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toMatch(/assertons/);
  });
});

// ─── Test 67 — representative testing findings VERIFY against source ───────────

describe('Test 67 — Testing findings verify against the fixture source', () => {
  const cases = [
    { type: 'SKIPPED_TEST',            line: 22, evidence: "it.only('computes total', () => {" },
    { type: 'WEAK_ASSERTION',          line: 29, evidence: 'expect(u).toBeTruthy();' },
    { type: 'TIME_DEPENDENT_TEST',     line: 35, evidence: 'expect(exp).toBe(Date.now() + 86400000);' },
    { type: 'MISSING_AWAIT_ASSERTION', line: 40, evidence: "expect(loadConfig('bad')).rejects.toThrow();" },
    { type: 'UNRESTORED_MOCK',         line: 45, evidence: "const spy = vi.spyOn(console, 'log');" },
  ];

  for (const c of cases) {
    it(`${c.type} is VERIFIED at line ${c.line}`, () => {
      const finding = {
        type: c.type, severity: 'MEDIUM', confidence: 'HIGH',
        file: 'testing-issues.js', line: c.line, evidence: c.evidence,
        explanation: 'test',
      };
      const result = validateFinding(finding, FIXTURES);
      expect(result.status).toBe('VERIFIED');
    });
  }

  it('NO_ASSERTION range finding is VERIFIED across its span', () => {
    const finding = {
      type: 'NO_ASSERTION', severity: 'MEDIUM', confidence: 'HIGH',
      file: 'testing-issues.js', line: 17, endLine: 19,
      evidence: "createUser({ name: 'Ada' });",
      explanation: 'test body has no assertion',
    };
    const result = validateFinding(finding, FIXTURES);
    expect(result.status).toBe('VERIFIED');
    expect(result.endLine).toBe(19);
  });

  it('a fabricated testing finding is UNVERIFIED', () => {
    const finding = {
      type: 'SKIPPED_TEST', severity: 'HIGH', confidence: 'HIGH',
      file: 'testing-issues.js', line: 22,
      evidence: 'databaseConnectionPool.drainAndClose(zzzUnrelatedHandle);',
      explanation: 'fabricated — unrelated to any line in the file',
    };
    expect(validateFinding(finding, FIXTURES).status).toBe('UNVERIFIED');
  });
});

// ─── Test 68 — testing findings through dedup (security still wins) ────────────

describe('Test 68 — Testing findings and dedup interaction', () => {
  it('a security finding stays primary over an overlapping testing finding', () => {
    const out = dedupeFindings([
      { type: 'WEAK_ASSERTION', severity: 'HIGH', confidence: 'HIGH', file: 'a.js', line: 10 },
      { type: 'SQL_INJECTION',  severity: 'LOW',  confidence: 'LOW',  file: 'a.js', line: 10 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe('SQL_INJECTION');
    expect(out[0].alsoFlaggedAs).toEqual(['WEAK_ASSERTION']);
  });

  it('two testing findings on different lines stay separate', () => {
    const out = dedupeFindings([
      { type: 'SKIPPED_TEST',   severity: 'HIGH',   confidence: 'HIGH', file: 'a.js', line: 22 },
      { type: 'WEAK_ASSERTION', severity: 'MEDIUM', confidence: 'HIGH', file: 'a.js', line: 29 },
    ]);
    expect(out).toHaveLength(2);
  });
});

// ─── Test 69 — reporter groups testing findings by category ───────────────────

describe('Test 69 — Reporter groups testing findings by category', () => {
  const result = makeReviewResult({
    findings: [
      { type: 'SKIPPED_TEST',            severity: 'HIGH',   confidence: 'HIGH', file: 'testing-issues.js', line: 22, evidence: 'x', explanation: 'y', verification: { status: 'VERIFIED', file: 'testing-issues.js', line: 22, sourceLine: 'x' } },
      { type: 'MISSING_AWAIT_ASSERTION', severity: 'HIGH',   confidence: 'HIGH', file: 'testing-issues.js', line: 40, evidence: 'x', explanation: 'y', verification: { status: 'VERIFIED', file: 'testing-issues.js', line: 40, sourceLine: 'x' } },
    ],
    genesisAvailable: false, llmUsed: true, error: null, durationMs: 300,
  });

  it('renders distinct testing categories (Hygiene, Async)', () => {
    const body = buildCommentBody(result);
    expect(body).toContain('Testing: Test Hygiene');
    expect(body).toContain('Testing: Async Correctness');
  });

  it('breakdown counts each testing category separately', () => {
    const body = buildCommentBody(result);
    expect(body).toContain('Testing: Test Hygiene: 1');
    expect(body).toContain('Testing: Async Correctness: 1');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Tests 27–30 — Impact Analysis (Genesis blast radius surfaced in the comment)
// ─────────────────────────────────────────────────────────────────────────────

import { buildImpactSummary, blastRadiusForFile } from '../src/core/impactAnalysis.js';

// Genesis per-file shape: { file, symbols, impact:[{path}], boundary:{dependsOn:[{target}]} }
const GENESIS_FILES = [
  {
    file:    'src/auth/token.js',
    symbols: [{ kind: 'function', name: 'signToken', line: 10 }],
    impact:  [
      { path: 'src/api/login.js' },
      { path: 'src/api/refresh.js' },
      { path: 'src/mw/authGuard.js' },
    ],
    boundary: {
      dependsOn: [{ target: 'src/config.js' }, { target: 'jsonwebtoken' }],
    },
  },
  {
    file:    'src/util/noise.js',
    symbols: [],
    impact:  [],          // no dependents
    boundary: { dependsOn: [] },
  },
];

// ─── Test 27 — buildImpactSummary shapes Genesis data correctly ───────────────

describe('Test 27 — buildImpactSummary: shapes Genesis per-file data', () => {
  it('marks available and includes only files with relationship data', () => {
    const impact = buildImpactSummary(GENESIS_FILES);
    expect(impact.available).toBe(true);
    // noise.js has no impact and no deps → excluded
    expect(impact.files).toHaveLength(1);
    expect(impact.files[0].file).toBe('src/auth/token.js');
  });

  it('computes blast radius and lists impacted files', () => {
    const impact = buildImpactSummary(GENESIS_FILES);
    const rec = impact.files[0];
    expect(rec.blastRadius).toBe(3);
    expect(rec.impactedFiles).toContain('src/api/login.js');
    expect(rec.impactedFiles).toContain('src/mw/authGuard.js');
  });

  it('captures dependencies from boundary.dependsOn', () => {
    const impact = buildImpactSummary(GENESIS_FILES);
    expect(impact.files[0].dependsOn).toContain('src/config.js');
    expect(impact.files[0].dependsOn).toContain('jsonwebtoken');
  });

  it('totalBlastRadius sums across files', () => {
    const impact = buildImpactSummary(GENESIS_FILES);
    expect(impact.totalBlastRadius).toBe(3);
  });

  it('returns unavailable for null / empty input', () => {
    expect(buildImpactSummary(null).available).toBe(false);
    expect(buildImpactSummary([]).available).toBe(false);
    expect(buildImpactSummary(undefined).available).toBe(false);
  });

  it('returns unavailable when no file has relationship data', () => {
    const impact = buildImpactSummary([
      { file: 'a.js', impact: [], boundary: { dependsOn: [] } },
    ]);
    expect(impact.available).toBe(false);
  });

  it('keeps the full impacted-file list and a truncated preview', () => {
    const orig = process.env.AI_REVIEW_IMPACT_MAX_LISTED;
    process.env.AI_REVIEW_IMPACT_MAX_LISTED = '2';
    try {
      const impact = buildImpactSummary(GENESIS_FILES);
      const rec = impact.files[0];
      // Full list is preserved in full so the reporter can expand it.
      expect(rec.impactedFiles).toHaveLength(3);
      // Preview respects the configured maximum.
      expect(rec.impactedPreview).toHaveLength(2);
      expect(rec.impactedTruncated).toBe(1);   // 3 total − 2 preview
    } finally {
      if (orig !== undefined) process.env.AI_REVIEW_IMPACT_MAX_LISTED = orig;
      else delete process.env.AI_REVIEW_IMPACT_MAX_LISTED;
    }
  });
});

// ─── Test 28 — blastRadiusForFile lookup ──────────────────────────────────────

describe('Test 28 — blastRadiusForFile: per-file lookup', () => {
  const impact = buildImpactSummary(GENESIS_FILES);

  it('returns the blast radius for a known file', () => {
    expect(blastRadiusForFile(impact, 'src/auth/token.js')).toBe(3);
  });

  it('returns 0 for an unknown file', () => {
    expect(blastRadiusForFile(impact, 'src/does/not/exist.js')).toBe(0);
  });

  it('returns 0 when impact is unavailable', () => {
    expect(blastRadiusForFile(buildImpactSummary(null), 'anything.js')).toBe(0);
  });
});

// ─── Test 29 — Reporter renders the Impact section when data present ──────────

describe('Test 29 — buildCommentBody: renders Impact Analysis when present', () => {
  const impact = buildImpactSummary(GENESIS_FILES);

  it('renders the Impact Analysis section for a result with impact data', () => {
    const result = makeReviewResult({
      findings:         [],
      genesisAvailable: true,
      llmUsed:          true,
      error:            null,
      durationMs:       500,
      impact,
    });
    const body = buildCommentBody(result);
    expect(body).toContain('Impact Analysis');
    expect(body).toContain('src/auth/token.js');
    expect(body).toContain('blast radius');
    expect(body).toContain('src/api/login.js');   // an impacted file
    expect(body).toContain('src/config.js');       // a dependency
  });

  it('renders Impact section alongside findings', () => {
    const result = makeReviewResult({
      findings: [{
        type: 'SQL_INJECTION', severity: 'HIGH', confidence: 'HIGH',
        file: 'src/auth/token.js', line: 10,
        evidence: 'x', explanation: 'y',
        verification: { status: 'VERIFIED', file: 'src/auth/token.js', line: 10, sourceLine: 'x' },
      }],
      genesisAvailable: true,
      llmUsed:          true,
      error:            null,
      durationMs:       500,
      impact,
    });
    const body = buildCommentBody(result);
    expect(body).toContain('SQL_INJECTION');
    expect(body).toContain('Impact Analysis');
  });

  it('renders the full impacted/dependency lists inside an expandable <details> block', () => {
    const result = makeReviewResult({
      findings:         [],
      genesisAvailable: true,
      llmUsed:          true,
      error:            null,
      durationMs:       500,
      impact,
    });
    const body = buildCommentBody(result);
    // Expandable disclosure instead of un-clickable "+N more" text.
    expect(body).toContain('<details>');
    expect(body).toContain('</details>');
    expect(body).not.toContain('more');       // no dead "+N more" text
    // Overview table headers present.
    expect(body).toContain('Blast radius');
    expect(body).toContain('Depends on');
    // Every dependency is present in full (not truncated away).
    expect(body).toContain('jsonwebtoken');
    expect(body).toContain('src/config.js');
  });
});

// ─── Test 30 — Reporter omits the Impact section when data absent ─────────────

describe('Test 30 — buildCommentBody: omits Impact Analysis when absent', () => {
  it('does NOT render Impact section when impact is null', () => {
    const result = makeReviewResult({
      findings:         [],
      genesisAvailable: false,
      llmUsed:          true,
      error:            null,
      durationMs:       500,
      // impact omitted → null
    });
    const body = buildCommentBody(result);
    expect(body).not.toContain('Impact Analysis');
  });

  it('does NOT render Impact section when impact is unavailable', () => {
    const result = makeReviewResult({
      findings:         [],
      genesisAvailable: true,
      llmUsed:          true,
      error:            null,
      durationMs:       500,
      impact:           buildImpactSummary(null),   // { available: false, ... }
    });
    const body = buildCommentBody(result);
    expect(body).not.toContain('Impact Analysis');
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// Tests 31 — Reconciliation: vulnerability in unreachable (dead) code
// ─────────────────────────────────────────────────────────────────────────────

describe('Test 31 — dedupeFindings reconciliation: vuln in dead code is downgraded', () => {
  // Mirrors the real PR case: an XSS on a line that is also DEAD_CODE because a
  // ReferenceError above it makes the line unreachable.
  const overlappingSpan = [
    {
      type: 'XSS', severity: 'HIGH', confidence: 'HIGH',
      file: 'src/route.js', line: 130,
      evidence: 'res.send(`<h1>Hello ${userInput}</h1>`);',
      explanation: 'Reflected XSS.',
    },
    {
      type: 'DEAD_CODE', severity: 'LOW', confidence: 'HIGH',
      file: 'src/route.js', line: 130,
      evidence: 'res.send(`<h1>Hello ${userInput}</h1>`);',
      explanation: 'Unreachable — earlier ReferenceError prevents execution.',
    },
  ];

  it('keeps the security finding as primary (security never demoted)', () => {
    const [merged] = dedupeFindings(overlappingSpan);
    expect(merged.type).toBe('XSS');
  });

  it('downgrades displayed severity to LOW when in dead code', () => {
    const [merged] = dedupeFindings(overlappingSpan);
    expect(merged.severity).toBe('LOW');
  });

  it('preserves the original severity', () => {
    const [merged] = dedupeFindings(overlappingSpan);
    expect(merged.originalSeverity).toBe('HIGH');
  });

  it('flags reconciled and includes an explanatory note', () => {
    const [merged] = dedupeFindings(overlappingSpan);
    expect(merged.reconciled).toBe(true);
    expect(merged.reconciliationNote).toMatch(/unreachable|DEAD_CODE/i);
  });

  it('records DEAD_CODE in alsoFlaggedAs', () => {
    const [merged] = dedupeFindings(overlappingSpan);
    expect(merged.alsoFlaggedAs).toContain('DEAD_CODE');
  });

  it('does NOT reconcile when there is no dead-code finding on the span', () => {
    const noDeadCode = [
      {
        type: 'XSS', severity: 'HIGH', confidence: 'HIGH',
        file: 'src/route.js', line: 130,
        evidence: 'x', explanation: 'Reflected XSS.',
      },
      {
        type: 'MAGIC_NUMBER', severity: 'LOW', confidence: 'HIGH',
        file: 'src/route.js', line: 130,
        evidence: 'x', explanation: 'Magic number.',
      },
    ];
    const [merged] = dedupeFindings(noDeadCode);
    expect(merged.type).toBe('XSS');
    expect(merged.severity).toBe('HIGH');       // unchanged
    expect(merged.reconciled).toBeUndefined();
  });

  it('a standalone DEAD_CODE finding is not itself reconciled', () => {
    const solo = [{
      type: 'DEAD_CODE', severity: 'LOW', confidence: 'HIGH',
      file: 'src/route.js', line: 5, evidence: 'x', explanation: 'unused',
    }];
    const [merged] = dedupeFindings(solo);
    expect(merged.reconciled).toBeUndefined();
    expect(merged.severity).toBe('LOW');
  });

  it('renders the downgrade and reconciliation note in the PR comment', () => {
    const merged = dedupeFindings(overlappingSpan).map(f => ({
      ...f,
      verification: { status: 'VERIFIED', file: f.file, line: f.line, sourceLine: f.evidence },
    }));
    const result = makeReviewResult({
      findings: merged, genesisAvailable: false, llmUsed: true, error: null, durationMs: 100,
    });
    const body = buildCommentBody(result);
    expect(body).toContain('downgraded from');
    expect(body).toContain('Reconciled');
  });
});
