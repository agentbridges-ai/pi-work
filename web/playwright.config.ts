import { defineConfig, devices } from "@playwright/test";

const apiPort = Number(process.env.PORT || 3457);
const vitePort = Number(process.env.VITE_PORT || 3458);
// Keep frontend asset evidence pointed at the separately started Vite server;
// the API server intentionally runs with PIWORK_SERVE_FRONTEND=0 in E2E.
const baseURL = process.env.PIWORK_E2E_BASE_URL || `http://127.0.0.1:${vitePort}`;
const reuseExistingServer = !process.env.CI && process.env.PIWORK_E2E_REUSE_SERVER === "1";

if (!process.env.PIWORK_RUNNER_LOCK_PATH) {
  throw new Error("Run Better Auth E2E through bun run test:e2e to create an isolated runtime");
}

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: "test-results",
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: [
    {
      command: "bun server/index.ts",
      url: `http://127.0.0.1:${apiPort}/api/health/live`,
      reuseExistingServer,
      timeout: 120_000,
      env: {
        ...process.env,
        // Auth E2E exercises route security, not the separate real-Chrome
        // bridge suite. Keep its daemon and control poller out of this job.
        PIWORK_AGENT_BROWSER_ENABLED: "0",
      },
    },
    {
      command: `bunx vite --host 127.0.0.1 --port ${vitePort}`,
      url: baseURL,
      reuseExistingServer,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
});
