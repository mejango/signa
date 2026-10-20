import { defineConfig } from "vitest/config";

// The connect subpaths (`/core`, `/wagmi`, `/react`) keep the coverage bar they had in the SDK.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "../.generated/coverage/connect",
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["**/*.test.{ts,tsx}"],
      thresholds: { statements: 100, branches: 95, functions: 100, lines: 100 },
    },
  },
});
