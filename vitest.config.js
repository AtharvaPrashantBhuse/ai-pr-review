/**
 * vitest.config.js
 *
 * Test configuration for the ai-pr-review central repository.
 *
 * All unit tests mock the Groq LLM — no real API calls are made
 * during the automated test suite.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node environment — this is a pure Node.js module
    environment: 'node',

    // Only pick up tests inside tests/
    include: ['tests/**/*.test.js'],

    // Timeout per test — generous for any integration-style tests
    testTimeout: 30_000,

    // beforeAll hook timeout
    hookTimeout: 30_000,

    // forks pool avoids open-handle warnings from any cached modules
    pool: 'forks',

    // Verbose so CI logs show each test name
    reporter: 'verbose',
  },
});
