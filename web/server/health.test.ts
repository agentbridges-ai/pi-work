import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { livenessResponse, readinessResponse } from "./health.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe("health responses", () => {
  it("keeps liveness payload minimal", () => {
    expect(livenessResponse()).toEqual({ ok: true, status: "live" });
  });

  it("reports ready only when every local dependency is available", async () => {
    const dataRoot = join(tmpdir(), `health-${crypto.randomUUID()}`);
    dirs.push(dataRoot);
    mkdirSync(dataRoot, { recursive: true });

    await expect(
      readinessResponse({
        dataRoot,
        databaseReady: async () => true,
        piRuntimeAvailable: true,
        internalFileTransportAvailable: true,
      }),
    ).resolves.toEqual({
      ok: true,
      status: "ready",
      checks: {
        database: true,
        dataRoot: true,
        piRuntime: true,
        internalFileTransport: true,
      },
    });
  });

  it("returns a non-ready payload without exposing paths or errors", async () => {
    const result = await readinessResponse({
      dataRoot: join(tmpdir(), "missing-piwork-health-root"),
      databaseReady: async () => false,
      piRuntimeAvailable: false,
      internalFileTransportAvailable: false,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("not_ready");
    expect(JSON.stringify(result)).not.toContain(tmpdir());
  });
});
