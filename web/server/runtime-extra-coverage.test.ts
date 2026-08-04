import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_DEPLOYMENT_PHASES,
  APP_DOMAIN_STATUSES,
  APP_SSL_STATUSES,
  APP_STATUSES,
} from "./apps-types.js";
import {
  getRuntimeDbContext,
  isCompleteRuntimeDbContext,
  runWithRuntimeDbContext,
} from "./runtime-db-context.js";
import { RuntimeSessionIndexStore } from "./runtime-session-index.js";
import { assertRuntimeContainerSecurity } from "./runtime-security-gate.js";
import { ScopedDatabase } from "./scoped-database.js";

const scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  membershipId: "membership-a",
  orgNodeId: "org-root",
  sessionId: "session-a",
  generation: 2,
};

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Runtime isolation support contracts", () => {
  it("keeps App runtime vocabularies explicit", () => {
    expect(APP_STATUSES).toEqual([
      "building",
      "needs_action",
      "deploying",
      "preview",
      "ready",
      "failed",
      "archived",
    ]);
    expect(APP_DEPLOYMENT_PHASES).toContain("awaiting_oauth");
    expect(APP_DOMAIN_STATUSES).toEqual(["pending", "active", "failed", "removing"]);
    expect(APP_SSL_STATUSES).toContain("pending_issuance");
  });

  it("tracks complete and incomplete async RLS contexts", async () => {
    expect(getRuntimeDbContext()).toBeUndefined();
    const context = { userId: "user-a", tenantId: "tenant-a" };
    await expect(
      runWithRuntimeDbContext(context, async () => {
        expect(getRuntimeDbContext()).toEqual(context);
        expect(isCompleteRuntimeDbContext(getRuntimeDbContext())).toBe(false);
        return "done";
      }),
    ).resolves.toBe("done");
    await runWithRuntimeDbContext(scope, async () => {
      expect(isCompleteRuntimeDbContext(getRuntimeDbContext())).toBe(true);
    });
  });

  it("rebuilds the diagnostic session index only inside one tenant", async () => {
    const query = vi.fn(async (..._args: unknown[]) => ({ rows: [], rowCount: 0 }));
    const release = vi.fn();
    const database = {
      connect: vi.fn(async () => ({ query, release })),
    };
    const store = new RuntimeSessionIndexStore({ database: database as never });
    await store.markStopped(scope, "failed");
    await store.rebuild(scope, [{ scope, lifecycle: "running" }]);
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes("delete from runtime_session_index")),
    ).toBe(true);
    await expect(
      store.rebuild(scope, [{ scope: { ...scope, tenantId: "other-tenant" }, lifecycle: "ready" }]),
    ).rejects.toThrow("crossed tenant scope");
    await store.close();
    expect(release).toHaveBeenCalled();
  });

  it("uses raw queries without context and user-scoped transactions for partial context", async () => {
    const poolQuery = vi.fn(async (..._args: unknown[]) => ({ rows: [{ value: 1 }], rowCount: 1 }));
    const clientQuery = vi.fn(async (..._args: unknown[]) => ({
      rows: [{ value: 2 }],
      rowCount: 1,
    }));
    const release = vi.fn();
    const pool = {
      query: poolQuery,
      connect: vi.fn(async () => ({ query: clientQuery, release })),
    };
    const database = new ScopedDatabase(pool as never);
    await expect(database.query("select raw")).resolves.toMatchObject({ rows: [{ value: 1 }] });
    await runWithRuntimeDbContext({ userId: "user-a" }, async () => {
      await expect(database.query("select scoped")).resolves.toMatchObject({
        rows: [{ value: 2 }],
      });
    });
    expect(clientQuery.mock.calls.map(([sql]) => String(sql))).toEqual([
      "begin",
      expect.stringContaining("piwork.user_id"),
      "select scoped",
      "commit",
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("requires the verified nested deployment marker and rejects dangerous modes", async () => {
    vi.stubEnv("PIWORK_RUNTIME_DEPLOYMENT_MODE", "native");
    expect(() => assertRuntimeContainerSecurity()).toThrow(/deployment mode/);

    vi.stubEnv("PIWORK_RUNTIME_DEPLOYMENT_MODE", "compose-nested");
    expect(() => assertRuntimeContainerSecurity()).toThrow(/security gate/);

    vi.stubEnv("PIWORK_RUNTIME_SECURITY_GATE", "verified");
    vi.stubEnv("PIWORK_RUNTIME_PRIVILEGED", "1");
    expect(() => assertRuntimeContainerSecurity()).toThrow(/Privileged/);
    vi.stubEnv("PIWORK_RUNTIME_PRIVILEGED", "0");
    vi.stubEnv("PIWORK_RUNTIME_SECCOMP", "unconfined");
    expect(() => assertRuntimeContainerSecurity()).toThrow(/seccomp/);
    vi.stubEnv("PIWORK_RUNTIME_SECCOMP", "default");
    expect(() => assertRuntimeContainerSecurity()).toThrow(/marker/);
  });

  it("accepts only a private, versioned nested-runtime marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "piwork-runtime-gate-"));
    roots.push(root);
    const marker = join(root, "marker");
    await writeFile(marker, "piwork-runtime-security-v1\n", { mode: 0o600 });
    await chmod(marker, 0o600);
    vi.stubEnv("PIWORK_RUNTIME_DEPLOYMENT_MODE", "compose-nested");
    vi.stubEnv("PIWORK_RUNTIME_SECURITY_GATE", "verified");
    vi.stubEnv("PIWORK_RUNTIME_SECURITY_MARKER", marker);
    expect(() => assertRuntimeContainerSecurity()).not.toThrow();

    await writeFile(marker, "wrong-marker\n");
    expect(() => assertRuntimeContainerSecurity()).toThrow(/invalid/);
  });
});
