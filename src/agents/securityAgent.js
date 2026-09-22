/**
 * src/agents/securityAgent.js
 *
 * Security Agent — identifies security vulnerabilities in changed code.
 *
 * Currently detects:
 *   1. SQL Injection (type: "SQL_INJECTION")
 *   2. Hardcoded Secrets (type: "HARDCODED_SECRET")
 *
 * Responsibility: security analysis only. This agent:
 *   1. Receives changed source code and optional repository context (from Genesis).
 *   2. Constructs a security-focused prompt.
 *   3. Submits the prompt to the LLM via the Groq integration layer.
 *   4. Parses and normalises the structured JSON findings returned by the LLM.
 *
 * The Security Agent does NOT:
 *   - Make HTTP requests directly  (that is groq.js's responsibility)
 *   - Validate findings against source  (that is evidenceValidator.js)
 *   - Report to GitHub  (that is githubReporter.js)
 *   - Detect quality or correctness issues  (out of scope for this MVP)
 *
 * Architecture:
 *   Review Engine
 *        |  (diff text + Genesis context)
 *        v
 *   securityAgent.analyseForSecurity()
 *        |
 *        v
 *   groq.js → Groq API → LLM
 *        |
 *        v
 *   Raw JSON findings  →  parsed & normalised
 *        |
 *        v
 *   { findings[], error, llmUsed }
 *
 * Finding shape:
 * {
 *   type:        "SQL_INJECTION" | "HARDCODED_SECRET"  // SCREAMING_SNAKE_CASE
 *   severity:    "HIGH"                 // LOW | MEDIUM | HIGH | CRITICAL
 *   confidence:  "HIGH"                 // LOW | MEDIUM | HIGH
 *   file:        "src/users.js"         // relative file path
 *   line:        18                     // 1-based line number in the TARGET file
 *   evidence:    "const sql = ..."      // the specific vulnerable construct
 *   explanation: "User input flows..."  // why this is a vulnerability
 * }
 *
 * Security:
 *   - GROQ_API_KEY read from environment only — never hardcoded or logged.
 *   - TLS verification always enabled (see groq.js).
 *   - LLM temperature kept at 0.1 for deterministic, factual security output.
 */

import { getClient, isGroqAvailable, DEFAULT_MODEL } from '../integrations/groq.js';

// ─────────────────────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a senior application-security engineer performing a code review.
Your task is to analyse the supplied source code and repository context for two classes of vulnerability:

  1. SQL Injection
  2. Hardcoded Secrets

─────────────────────────────────────────────────────────────────
CATEGORY 1 — SQL INJECTION  (type: "SQL_INJECTION")
─────────────────────────────────────────────────────────────────
Flag when user-controlled input is concatenated directly into a SQL query string without parameterisation:
- req.query / req.body / req.params / function arguments embedded into SQL via string concatenation.
- Template literals that interpolate user input into SQL strings.

Do NOT flag:
- Parameterised queries using $1, $2, ?, or named parameters — SAFE.
- Prepared statements — SAFE.
- Static SQL with no user-controlled input — SAFE.
- Theoretical or speculative issues — only report clear, exploitable injection.

─────────────────────────────────────────────────────────────────
CATEGORY 2 — HARDCODED SECRETS  (type: "HARDCODED_SECRET")
─────────────────────────────────────────────────────────────────
Flag when a secret credential is written as a literal value directly in source code.

Credential types to look for:
- API keys and API tokens (e.g. "sk-...", "gsk_...", "AIza...", "AKIA...")
- Access tokens, bearer tokens, OAuth client secrets
- Passwords and database passwords assigned as string literals
- JWT signing secrets
- AWS / GCP / Azure credential strings
- GitHub personal access tokens (ghp_..., github_pat_...)
- Private keys and certificate private keys (PEM blocks: "-----BEGIN ... PRIVATE KEY-----")
- Service account credentials and connection strings containing passwords

Flag only when BOTH of these are true:
  a) The value is a non-trivial string literal (not read from an environment variable or config file).
  b) The value and surrounding context suggest it is a real credential, not a placeholder.

Do NOT flag:
- Environment variable reads: process.env.SECRET, os.environ["KEY"], config.get("pass") — SAFE.
- Variable declarations where the value is process.env.* or equivalent — SAFE.
- Obvious template placeholders: "YOUR_API_KEY", "<API_KEY>", "replace-me", "example-token",
  "YOUR_SECRET", "TODO", "xxx", "test", "dummy", "changeme" — NOT a real secret.
- Short generic strings used as configuration flags or identifiers (e.g. "admin", "user", "dev").
- Test fixture values that are clearly non-production (e.g. in files named *.test.js, *.spec.js,
  fixture files with comment "test only").

For a HARDCODED_SECRET finding, set severity as follows:
- CRITICAL: private key, root credential, or production key with broad access scope.
- HIGH: API key / token / password that appears to be real and in production code.
- MEDIUM: suspicious credential-like value where confidence is lower.

─────────────────────────────────────────────────────────────────
OUTPUT FORMAT
─────────────────────────────────────────────────────────────────
Return ONLY a valid JSON array. No markdown, no commentary, no text outside the JSON.
If no vulnerabilities are found return an empty array: []

Each finding must follow this exact schema:
{
  "type":        "SQL_INJECTION" | "HARDCODED_SECRET",
  "severity":    "<LOW|MEDIUM|HIGH|CRITICAL>",
  "confidence":  "<LOW|MEDIUM|HIGH>",
  "file":        "<relative file path exactly as shown in the code, or 'unknown' if not determinable>",
  "line":        <integer — 1-based line number in the file after the change>,
  "evidence":    "<the exact line of code containing the vulnerability>",
  "explanation": "<concise explanation of why this is a vulnerability and what the risk is>"
}

Rules:
- Use HIGH or CRITICAL severity only when there is a clear, direct exploitation path or exposure risk.
- The "line" field must be the actual line number in the file, not the diff offset.
- The "evidence" field must be a verbatim or near-verbatim copy of the vulnerable line.
- If the full file is shown, derive exact line numbers by counting from line 1.
- If only a partial diff is shown, estimate line numbers from the diff context markers (+/- lines).
- Do not fabricate evidence — only report what is explicitly present in the supplied code.`;

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyse a code diff or file content for SQL Injection and Hardcoded Secret vulnerabilities.
 *
 * @param {string} diff            - The changed source code or unified diff text
 * @param {string} [repoContext]   - Repository context summary from genesisAdapter
 * @param {Object} [options]
 * @param {string} [options.model] - Override the Groq model (default: DEFAULT_MODEL)
 * @returns {Promise<{ findings: Array, error: string|null, llmUsed: boolean }>}
 */
export async function analyseForSecurity(diff, repoContext = '', options = {}) {
  // Check the key at call time (not just at client-build time) so that
  // tests which delete the env var after the singleton is built still get
  // the correct response.
  if (!isGroqAvailable()) {
    return {
      findings: [],
      error:
        'GROQ_API_KEY is not set — LLM security analysis unavailable. ' +
        'Set GROQ_API_KEY in .env.local or as a GitHub repository secret.',
      llmUsed: false,
    };
  }

  const client = await getClient();

  // Defensive: client should be non-null because we checked the key above,
  // but guard in case buildClient() fails for another reason (e.g. proxy error).
  if (!client) {
    return {
      findings: [],
      error:    'Failed to initialise Groq client — check GROQ_API_KEY and network connectivity.',
      llmUsed:  false,
    };
  }

  const model      = options.model || process.env.GROQ_SECURITY_MODEL || DEFAULT_MODEL;
  const userPrompt = buildUserPrompt(diff, repoContext);

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: userPrompt   },
      ],
      max_tokens:  4096,
      temperature: 0.1,  // low temperature for deterministic, factual security output
    });

    const raw      = response.choices?.[0]?.message?.content || '';
    const findings = parseFindings(raw);

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
 * Check whether the Security Agent can operate (Groq API key configured).
 * Does not make a network request.
 *
 * @returns {boolean}
 */
export function isAgentAvailable() {
  return isGroqAvailable();
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the user-facing LLM prompt by combining Genesis context (if any)
 * with the diff/source to review.
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
  prompt += '\n\nAnalyse the above for SQL Injection and Hardcoded Secret vulnerabilities. Return only a JSON array of findings.';

  return prompt;
}

/**
 * Parse and normalise the raw LLM response into a validated findings array.
 *
 * The LLM sometimes wraps its JSON in markdown code fences — we strip those.
 * Fields are coerced to their expected types and invalid enum values are
 * replaced with safe defaults so downstream code never sees unexpected shapes.
 *
 * @param {string} raw - Raw text response from the LLM
 * @returns {Array}    - Normalised findings array (may be empty)
 */
export function parseFindings(raw) {
  let text = (raw || '').trim();

  // Strip markdown code fences  (```json ... ``` or ``` ... ```)
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Try to extract a JSON array embedded in surrounding prose
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { return []; }
    } else {
      return [];
    }
  }

  if (!Array.isArray(parsed)) return [];

  const VALID_SEVERITY   = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
  const VALID_CONFIDENCE = new Set(['LOW', 'MEDIUM', 'HIGH']);

  return parsed
    .filter(f => f && typeof f === 'object')
    .map(f => ({
      type:        String(f.type        || 'UNKNOWN').toUpperCase(),
      severity:    VALID_SEVERITY.has(String(f.severity   || '').toUpperCase())
                     ? String(f.severity).toUpperCase()    : 'LOW',
      confidence:  VALID_CONFIDENCE.has(String(f.confidence || '').toUpperCase())
                     ? String(f.confidence).toUpperCase()  : 'LOW',
      file:        String(f.file        || 'unknown'),
      line:        parseInt(f.line, 10) || 0,
      evidence:    String(f.evidence    || ''),
      explanation: String(f.explanation || ''),
    }))
    .filter(f => f.type && f.file);
}
