import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BrowserControlCoordinator,
  browserControlStatePath,
  ensureBrowserControlState,
} from "./browser-control-session.js";

describe("BrowserControlCoordinator", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function harness() {
    const root = mkdtempSync(join(tmpdir(), "browser-control-test-"));
    roots.push(root);
    let now = 100;
    const interrupt = vi.fn(() => true);
    const resume = vi.fn(() => ({
      handoffDelivered: true,
      semanticReadbackVerified: true,
    }));
    const stop = vi.fn(async () => undefined);
    const coordinator = new BrowserControlCoordinator({
      statePathFor: () => browserControlStatePath(root),
      interrupt,
      resume,
      stop,
      now: () => ++now,
    });
    return { root, coordinator, interrupt, resume, stop };
  }

  it("persists an agent-owned default state and fences stale epochs", () => {
    const { root, coordinator } = harness();
    const state = coordinator.get("session-a");

    expect(state).toMatchObject({ phase: "agent", epoch: 1, pendingActionRisk: false });
    expect(coordinator.canDispatch("session-a", 1)).toBe(true);
    expect(coordinator.canDispatch("session-a", 2)).toBe(false);
    expect(readFileSync(browserControlStatePath(root), "utf8")).toContain('"phase":"agent"');
  });

  it("raises the epoch before interrupting and records an unconfirmed takeover", async () => {
    const { coordinator, interrupt } = harness();
    interrupt.mockReturnValue(false);

    const state = await coordinator.takeOver("session-a");

    expect(state).toMatchObject({
      phase: "human",
      epoch: 2,
      pendingActionRisk: true,
      reason: "agent_interrupt_unconfirmed",
    });
    expect(coordinator.canDispatch("session-a", 2)).toBe(false);
  });

  it("preserves the risk of a command that may have completed during page takeover", async () => {
    const { coordinator } = harness();

    const state = await coordinator.takeOver("session-a", true);

    expect(state).toMatchObject({
      phase: "human",
      epoch: 2,
      reason: "action_completion_unconfirmed",
      pendingActionRisk: true,
    });
  });

  it("requires a handoff summary and resumes only after it is delivered", async () => {
    const { coordinator, resume } = harness();
    await coordinator.takeOver("session-a");

    await expect(coordinator.resume("session-a", "  ")).rejects.toThrow("summary is required");
    const state = await coordinator.resume("session-a", "Filled the shipping address manually");

    expect(resume).toHaveBeenCalledWith("session-a", "Filled the shipping address manually");
    expect(state).toMatchObject({
      phase: "agent",
      epoch: 3,
      pendingActionRisk: false,
      reason: "handoff_verified",
      lastHandoff: { summary: "Filled the shipping address manually" },
    });
  });

  it("fails closed when the handoff cannot be delivered", async () => {
    const { coordinator, resume } = harness();
    resume.mockReturnValue({ handoffDelivered: false, semanticReadbackVerified: true });
    await coordinator.takeOver("session-a");

    const state = await coordinator.resume("session-a", "Completed MFA");

    expect(state).toMatchObject({
      phase: "uncertain",
      epoch: 3,
      pendingActionRisk: true,
      reason: "handoff_delivery_unconfirmed",
    });
  });

  it("fails closed when the fresh semantic readback cannot be verified", async () => {
    const { coordinator, resume } = harness();
    resume.mockReturnValue({ handoffDelivered: true, semanticReadbackVerified: false });
    await coordinator.takeOver("session-a");

    const state = await coordinator.resume("session-a", "Completed MFA");

    expect(state).toMatchObject({
      phase: "uncertain",
      epoch: 3,
      pendingActionRisk: true,
      reason: "semantic_readback_unconfirmed",
    });
  });

  it("stops idempotently and retains uncertainty when interrupt is unconfirmed", async () => {
    const { coordinator, interrupt, stop } = harness();
    interrupt.mockReturnValue(false);

    const first = await coordinator.stop("session-a");
    const second = await coordinator.stop("session-a");

    expect(first).toMatchObject({ phase: "stopped", epoch: 2, pendingActionRisk: true });
    expect(second).toEqual(first);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("initializes a reusable state file without overwriting an existing fence", async () => {
    const { root, coordinator } = harness();
    await coordinator.takeOver("session-a");

    const state = ensureBrowserControlState(browserControlStatePath(root), "session-a");

    expect(state.phase).toBe("human");
    expect(state.epoch).toBe(2);
  });
});
