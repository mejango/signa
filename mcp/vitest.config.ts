import { defineConfig } from 'vitest/config';

// This nested package owns its test suite independently of the Center host.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // ponytail: integration tests build the whole server (catalog, knowledge), in tests and setup
    // hooks; under a full parallel run that can pass vitest's defaults (5 s, 10 s for hooks), so the
    // limits cover startup on a loaded machine.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    ...(process.env.CENTER_MCP_REPORT
      ? {
          reporters: ['default', 'json'],
          outputFile: { json: process.env.CENTER_MCP_REPORT },
        }
      : {}),
  },
});
