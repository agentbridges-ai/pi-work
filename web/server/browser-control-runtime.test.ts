import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserControlRuntime } from "./browser-control-runtime.js";

describe("createBrowserControlRuntime", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function harness(
    options: { snapshotFails?: boolean; injects?: boolean; reachable?: boolean } = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), "browser-control-runtime-"));
    roots.push(root);
    const setSessionControl = vi.fn(async () => ({
      reachable: options.reachable ?? true,
      matched: options.reachable === false ? 0 : 1,
    }));
    const bridge = {
      setSessionControl,
      readSessionSnapshot: options.snapshotFails
        ? vi.fn(async () => Promise.reject(new Error("snapshot failed")))
        : vi.fn(async () => ({ snapshot: '- textbox "Name": Ada', truncated: false })),
      closeSession: vi.fn(async () => undefined),
    };
    const messageBridge = {
      interruptSession: vi.fn(() => true),
      injectUserMessage: vi.fn(() => options.injects ?? true),
    };
    const coordinator = createBrowserControlRuntime({
      agentBrowserBridge: bridge as never,
      messageBridge,
      sessionDirFor: () => root,
    });
    return { coordinator, bridge, messageBridge };
  }

  it("interrupts both provider and agent before yielding control", async () => {
    const { coordinator, bridge, messageBridge } = harness();

    await expect(coordinator.takeOver("session-a")).resolves.toMatchObject({ phase: "human" });

    expect(bridge.setSessionControl).toHaveBeenCalledWith("session-a", "human");
    expect(messageBridge.interruptSession).toHaveBeenCalledWith("session-a");
  });

  it("delivers the handoff together with a fresh semantic snapshot", async () => {
    const { coordinator, bridge, messageBridge } = harness();
    await coordinator.takeOver("session-a");

    const state = await coordinator.resume("session-a", "Completed MFA");

    expect(state).toMatchObject({ phase: "agent", reason: "handoff_verified" });
    expect(bridge.readSessionSnapshot).toHaveBeenCalledOnce();
    expect(messageBridge.injectUserMessage).toHaveBeenCalledWith(
      "session-a",
      expect.stringMatching(/Completed MFA[\s\S]*textbox "Name": Ada/),
    );
  });

  it.each([
    ["provider is unreachable", { reachable: false }],
    ["semantic readback fails", { snapshotFails: true }],
    ["handoff delivery fails", { injects: false }],
  ])("returns provider control to the user when %s", async (_label, options) => {
    const { coordinator, bridge } = harness(options);
    await coordinator.takeOver("session-a");

    await expect(coordinator.resume("session-a", "Completed MFA")).resolves.toMatchObject({
      phase: "uncertain",
      pendingActionRisk: true,
    });
    expect(bridge.setSessionControl).toHaveBeenLastCalledWith("session-a", "human");
  });

  it("stops provider control and closes the owned native session", async () => {
    const { coordinator, bridge } = harness();

    await expect(coordinator.stop("session-a")).resolves.toMatchObject({ phase: "stopped" });

    expect(bridge.setSessionControl).toHaveBeenCalledWith("session-a", "stopped");
    expect(bridge.closeSession).toHaveBeenCalledOnce();
  });

  it("still fences the agent when no provider service is configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "browser-control-runtime-no-provider-"));
    roots.push(root);
    const messageBridge = {
      interruptSession: vi.fn(() => true),
      injectUserMessage: vi.fn(() => true),
    };
    const coordinator = createBrowserControlRuntime({ messageBridge, sessionDirFor: () => root });

    await expect(coordinator.takeOver("session-a")).resolves.toMatchObject({ phase: "human" });
    await expect(coordinator.resume("session-a", "No browser attached")).resolves.toMatchObject({
      phase: "uncertain",
    });
  });
});
