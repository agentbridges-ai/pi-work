import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";

// macOS exposes /var (and sometimes TMPDIR) through a system alias to
// /private/var. Production Pi paths intentionally reject redirected roots;
// keep fixtures on the canonical side of that boundary as well.
const canonicalTestTempDir = realpathSync(
  process.platform === "darwin" ? "/private/tmp" : tmpdir(),
);
process.env.TMPDIR = canonicalTestTempDir;
process.env.TMP = canonicalTestTempDir;
process.env.TEMP = canonicalTestTempDir;

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "lcov"],
      reportsDirectory: "coverage",
      include: [
        "bin/**/*.ts",
        "scripts/**/*.ts",
        "server/**/*.ts",
        "shared/**/*.ts",
        "src/**/*.ts",
        "src/**/*.tsx",
        "vite.config.ts",
      ],
      exclude: ["**/*.d.ts", "**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
    },
    include: [
      "scripts/**/*.test.ts",
      "server/**/*.test.ts",
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
    ],
    environmentMatchGlobs: [
      ["src/**/*.test.ts", "jsdom"],
      ["src/**/*.test.tsx", "jsdom"],
    ],
    setupFiles: ["src/test-setup.ts"],
    // Keep full coverage stable on 16 GiB developer Macs where Electron,
    // Chrome, and Postgres already consume most resident memory. CI can raise
    // this explicitly when the runner has a larger memory envelope.
    maxWorkers: Math.max(1, Number(process.env.VITEST_MAX_WORKERS) || 1),
    // Full-suite axe scans can exceed Vitest's 5s default under parallel load.
    testTimeout: 15_000,
    // React 19.2+ only exports `act` in the development CJS build.
    // Without this, jsdom tests load react.production.js which breaks
    // @testing-library/react's act() calls.
    env: { NODE_ENV: "test" },
  },
});
