import { describe, expect, it, vi } from "vitest";
import {
  SessionRuntimeStateMachine,
  SessionRuntimeStateRegistry,
} from "./session-runtime-state.js";

describe("SessionRuntimeStateMachine", () => {
  it("models the successful runtime lifecycle", () => {
    const machine = new SessionRuntimeStateMachine("session-1");

    expect(machine.begin(1, "preparing", "create")).toBe(true);
    expect(machine.transition(1, "starting", "spawned")).toBe(true);
    expect(machine.transition(1, "connecting", "transport_open")).toBe(true);
    expect(machine.transition(1, "ready", "protocol_ready")).toBe(true);
    expect(machine.begin(2, "stopping", "user_stop")).toBe(true);
    expect(machine.transition(2, "stopped", "process_exited")).toBe(true);
    expect(machine.get()).toMatchObject({
      state: "stopped",
      generation: 2,
      reason: "process_exited",
    });
  });

  it("allows a stopped or failed runtime to start a newer attempt", () => {
    const machine = new SessionRuntimeStateMachine("session-1", {
      state: "failed",
      generation: 3,
      reason: "crash",
    });

    expect(machine.begin(4, "preparing", "relaunch")).toBe(true);
    expect(machine.transition(4, "starting", "spawned")).toBe(true);
    expect(machine.get()).toMatchObject({ state: "starting", generation: 4 });
  });

  it("rejects stale generations without changing the snapshot", () => {
    const machine = new SessionRuntimeStateMachine("session-1");
    machine.begin(4, "preparing", "new_attempt");
    machine.transition(4, "starting", "spawned");
    const current = machine.get();

    expect(machine.transition(3, "failed", "late_exit")).toBe(false);
    expect(machine.begin(4, "stopping", "duplicate_generation")).toBe(false);
    expect(machine.get()).toEqual(current);
  });

  it("rejects invalid same-generation transitions", () => {
    const machine = new SessionRuntimeStateMachine("session-1");
    machine.begin(1, "preparing", "create");

    expect(machine.transition(1, "ready", "skipped_spawn_and_connect")).toBe(false);
    expect(machine.get().state).toBe("preparing");
  });

  it("returns immutable registry snapshots", () => {
    vi.spyOn(Date, "now").mockReturnValue(123);
    try {
      const registry = new SessionRuntimeStateRegistry();
      registry.ensure("session-1");
      const first = registry.get("session-1")!;
      first.state = "failed";

      expect(registry.get("session-1")).toMatchObject({ state: "idle", updatedAt: 123 });
      expect(registry.list()).toHaveLength(1);
      expect(registry.remove("session-1")).toBe(true);
      expect(registry.get("session-1")).toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });
});
