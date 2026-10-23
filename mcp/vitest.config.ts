import { defineConfig } from 'vitest/config';

// This nested package owns its test suite independently of the Center host.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    ...(process.env.CENTER_MCP_REPORT
      ? {
          reporters: ['default', 'json'],
          outputFile: { json: process.env.CENTER_MCP_REPORT },
        }
      : {}),
  },
});
