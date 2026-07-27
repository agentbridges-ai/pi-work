import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";

describe("paths", () => {
  const originalEnv = process.env.PIWORK_HOME;

  afterEach(() => {
    // Restore original env
    if (originalEnv === undefined) {
      delete process.env.PIWORK_HOME;
    } else {
      process.env.PIWORK_HOME = originalEnv;
    }
  });

  it("defaults to ~/.piwork/ when PIWORK_HOME is not set", async () => {
    delete process.env.PIWORK_HOME;
    // Dynamic import to pick up env change (module is already cached, so we
    // test the value computed at import time — which uses the env at startup)
    const { PIWORK_HOME } = await import("./paths.js");
    // When env var is unset at module load time, it should be ~/.piwork
    expect(PIWORK_HOME).toBe(join(homedir(), ".piwork"));
  });

  it("exports a string path", async () => {
    const { PIWORK_HOME } = await import("./paths.js");
    expect(typeof PIWORK_HOME).toBe("string");
    expect(PIWORK_HOME.length).toBeGreaterThan(0);
  });
});
