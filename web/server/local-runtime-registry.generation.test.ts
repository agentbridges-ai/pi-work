import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedUser } from "./auth-types.js";
import { agentBrowserSessionName } from "./agent-browser-runtime.js";
import {
  disposeLocalRuntimeComponents,
  LocalRuntimeRegistry,
  type LocalRuntime,
  wakeAppsOutboxWorker,
} from "./local-runtime-registry.js";

function tenantUser(tenantId: string): AuthenticatedUser {
  return {
    userId: "shared-user",
    uuid: "shared-user",
    username: "alice",
    displayName: "Alice",
    orgId: tenantId,
    orgName: tenantId,
    tenantId,
    tenantName: tenantId,
    tenantType: "team",
    membershipId: `${tenantId}-membership`,
    roles: [],
  };
}

describe("LocalRuntimeRegistry authority", () => {
  it("wakes Apps recovery without awaiting provider execution", async () => {
    let finish!: (value: number) => void;
    const inFlight = new Promise<number>((resolve) => {
      finish = resolve;
    });
    const pollOnce = vi.fn(() => inFlight);

    await expect(wakeAppsOutboxWorker({ pollOnce })).resolves.toBeUndefined();
    expect(pollOnce).toHaveBeenCalledOnce();

    finish(0);
    await inFlight;
  });

  it("revokes session routing immediately and drains leases before disposal", async () => {
    const registry = new LocalRuntimeRegistry(3456);
    let finishDispose!: () => void;
    const dispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDispose = resolve;
        }),
    );
    const runtime = {
      user: tenantUser("tenant-1"),
      dispose,
    } as unknown as LocalRuntime;
    const internals = registry as unknown as {
      runtimes: Map<string, LocalRuntime>;
    };
    internals.runtimes.set("tenant-1:shared-user", runtime);
    registry.bindSession("tenant-1:shared-user", "session-1");

    const lease = registry.acquireSession("session-1");
    expect(lease?.runtime).toBe(runtime);

    const revoking = registry.revokePrincipal("tenant-1", "shared-user");
    expect(registry.getRuntimeForSession("session-1")).toBeNull();
    expect(registry.acquireSession("session-1")).toBeNull();
    expect(dispose).not.toHaveBeenCalled();

    lease?.release();
    lease?.release();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    finishDispose();
    await revoking;
  });

  it("keeps a revoked principal tombstoned until explicit activation", async () => {
    const registry = new LocalRuntimeRegistry(3456);
    const runtime = {
      user: tenantUser("tenant-1"),
      dispose: vi.fn(async () => undefined),
    } as unknown as LocalRuntime;
    const internals = registry as unknown as {
      getOrCreateRuntime(user: AuthenticatedUser): LocalRuntime;
      runtimes: Map<string, LocalRuntime>;
    };
    const create = vi.spyOn(internals, "getOrCreateRuntime").mockReturnValue(runtime);
    internals.runtimes.set("tenant-1:shared-user", runtime);

    const lease = registry.acquirePrincipal(tenantUser("tenant-1"));
    expect(lease?.runtime).toBe(runtime);
    const revoking = registry.revokePrincipal("tenant-1", "shared-user");
    expect(registry.acquirePrincipal(tenantUser("tenant-1"))).toBeNull();

    lease?.release();
    await revoking;
    expect(runtime.dispose).toHaveBeenCalledOnce();

    await registry.activatePrincipal("tenant-1", "shared-user");
    const replacement = registry.acquirePrincipal(tenantUser("tenant-1"));
    expect(replacement?.runtime).toBe(runtime);
    replacement?.release();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("routes agent-browser controls only to the owning Pi runtime", async () => {
    const registry = new LocalRuntimeRegistry(3456);
    const takeOver = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const runtime = { browserControl: { takeOver, stop } } as unknown as LocalRuntime;
    const internals = registry as unknown as { runtimes: Map<string, LocalRuntime> };
    internals.runtimes.set("tenant-1:shared-user", runtime);
    registry.bindSession("tenant-1:shared-user", "session-1");
    const event = {
      sequence: 1,
      ownerSessionId: agentBrowserSessionName("session-1"),
      bridgeSessionId: "bridge-1",
      action: "takeover" as const,
      tabId: 4,
      pendingActionRisk: true,
      createdAt: "2026-07-17T00:00:00.000Z",
    };

    await expect(registry.handleAgentBrowserControlEvent(event)).resolves.toBe(true);
    expect(takeOver).toHaveBeenCalledWith("session-1", true);
    await expect(
      registry.handleAgentBrowserControlEvent({ ...event, action: "stop" }),
    ).resolves.toBe(true);
    expect(stop).toHaveBeenCalledWith("session-1");
    await expect(
      registry.handleAgentBrowserControlEvent({
        ...event,
        ownerSessionId: agentBrowserSessionName("another-session"),
      }),
    ).resolves.toBe(false);
  });
});

function disposalHarness() {
  const order: string[] = [];
  return {
    order,
    components: {
      orchestrator: {
        shutdown: vi.fn(() => {
          order.push("orchestrator");
        }),
      },
      launcher: {
        killAll: vi.fn(async () => {
          order.push("pi-launcher");
        }),
      },
      browserSessions: {
        closeAll: vi.fn(async () => {
          order.push("agent-browser");
        }),
      },
      launchBuilder: {
        dispose: vi.fn(async () => {
          order.push("launch-builder");
        }),
      },
      userSpaceBroker: {
        dispose: vi.fn(() => {
          order.push("user-space");
        }),
      },
      onlyOfficeBroker: {
        dispose: vi.fn(() => {
          order.push("onlyoffice");
        }),
      },
      wsBridge: {
        dispose: vi.fn(async () => {
          order.push("browser-ws");
        }),
      },
      sessionStore: {
        dispose: vi.fn(() => {
          order.push("session-store");
        }),
      },
      recorder: {
        dispose: vi.fn(() => {
          order.push("recorder");
        }),
      },
    },
  };
}

describe("Pi runtime disposal", () => {
  it("drains Pi generations before broker, bridge, and store cleanup", async () => {
    const { order, components } = disposalHarness();
    let finishDrain!: () => void;
    const drained = new Promise<void>((resolve) => {
      finishDrain = resolve;
    });
    components.launcher.killAll = vi.fn(async () => {
      order.push("pi-launcher:start");
      await drained;
      order.push("pi-launcher:drained");
    });

    const disposing = disposeLocalRuntimeComponents(components);
    await Promise.resolve();
    expect(order).toEqual(["orchestrator", "pi-launcher:start"]);

    finishDrain();
    await disposing;
    expect(order).toEqual([
      "orchestrator",
      "pi-launcher:start",
      "pi-launcher:drained",
      "agent-browser",
      "launch-builder",
      "user-space",
      "onlyoffice",
      "browser-ws",
      "session-store",
      "recorder",
    ]);
  });

  it("attempts every cleanup and aggregates Pi disposal failures", async () => {
    const { order, components } = disposalHarness();
    const launcherFailure = new Error("Pi generation drain failed");
    const builderFailure = new Error("Pi launch broker cleanup failed");
    components.launcher.killAll = vi.fn(async () => {
      order.push("pi-launcher");
      throw launcherFailure;
    });
    components.launchBuilder.dispose = vi.fn(async () => {
      order.push("launch-builder");
      throw builderFailure;
    });

    await expect(disposeLocalRuntimeComponents(components)).rejects.toMatchObject({
      errors: [launcherFailure, builderFailure],
    });
    expect(order).toEqual([
      "orchestrator",
      "pi-launcher",
      "agent-browser",
      "launch-builder",
      "user-space",
      "onlyoffice",
      "browser-ws",
      "session-store",
      "recorder",
    ]);
  });
});
