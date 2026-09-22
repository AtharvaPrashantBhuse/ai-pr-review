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

  it('Contains the AI Security Review header', () => {
    const body = buildCommentBody(singleResult);
    expect(body).toContain('AI Security Review');
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
    expect(body).toContain('No SQL Injection findings detected');
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
