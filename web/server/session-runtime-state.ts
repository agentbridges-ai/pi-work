export type SessionRuntimeState =
  "idle" | "preparing" | "starting" | "connecting" | "ready" | "stopping" | "stopped" | "failed";

export interface SessionRuntimeSnapshot {
  sessionId: string;
  state: SessionRuntimeState;
  generation: number;
  reason: string;
  updatedAt: number;
}

const VALID_RUNTIME_TRANSITIONS: Readonly<
  Record<SessionRuntimeState, ReadonlySet<SessionRuntimeState>>
> = {
  idle: new Set(["preparing", "stopping", "failed"]),
  preparing: new Set(["starting", "stopping", "failed"]),
  starting: new Set(["connecting", "stopping", "failed"]),
  connecting: new Set(["ready", "starting", "stopping", "failed"]),
  ready: new Set(["connecting", "stopping", "failed"]),
  stopping: new Set(["stopped", "failed"]),
  stopped: new Set(["preparing"]),
  failed: new Set(["preparing", "stopping"]),
};

/**
 * Generation-aware projection of one session runtime. Lifecycle serialization
 * remains owned by SessionOrchestrator; this class only validates state commits.
 */
export class SessionRuntimeStateMachine {
  private snapshot: SessionRuntimeSnapshot;

  constructor(
    sessionId: string,
    initial: { state?: SessionRuntimeState; generation?: number; reason?: string } = {},
  ) {
    this.snapshot = {
      sessionId,
      state: initial.state ?? "idle",
      generation: initial.generation ?? 0,
      reason: initial.reason ?? "initialized",
      updatedAt: Date.now(),
    };
  }

  get(): SessionRuntimeSnapshot {
    return { ...this.snapshot };
  }

  /** Start a new runtime attempt. A newer generation may supersede any state. */
  begin(generation: number, state: "preparing" | "stopping", reason: string): boolean {
    if (!Number.isSafeInteger(generation) || generation <= this.snapshot.generation) return false;
    this.snapshot = {
      ...this.snapshot,
      state,
      generation,
      reason,
      updatedAt: Date.now(),
    };
    return true;
  }

  /** Commit within the current generation; stale and invalid transitions fail closed. */
  transition(generation: number, state: SessionRuntimeState, reason: string): boolean {
    if (generation !== this.snapshot.generation) return false;
    if (state === this.snapshot.state) {
      this.snapshot = { ...this.snapshot, reason, updatedAt: Date.now() };
      return true;
    }
    if (!VALID_RUNTIME_TRANSITIONS[this.snapshot.state].has(state)) return false;
    this.snapshot = { ...this.snapshot, state, reason, updatedAt: Date.now() };
    return true;
  }
}

export class SessionRuntimeStateRegistry {
  private readonly machines = new Map<string, SessionRuntimeStateMachine>();

  ensure(
    sessionId: string,
    initial: { state?: SessionRuntimeState; generation?: number; reason?: string } = {},
  ): SessionRuntimeStateMachine {
    let machine = this.machines.get(sessionId);
    if (!machine) {
      machine = new SessionRuntimeStateMachine(sessionId, initial);
      this.machines.set(sessionId, machine);
    }
    return machine;
  }

  begin(
    sessionId: string,
    generation: number,
    state: "preparing" | "stopping",
    reason: string,
  ): boolean {
    return this.ensure(sessionId).begin(generation, state, reason);
  }

  transition(
    sessionId: string,
    generation: number,
    state: SessionRuntimeState,
    reason: string,
  ): boolean {
    return this.ensure(sessionId).transition(generation, state, reason);
  }

  get(sessionId: string): SessionRuntimeSnapshot | null {
    return this.machines.get(sessionId)?.get() ?? null;
  }

  remove(sessionId: string): boolean {
    return this.machines.delete(sessionId);
  }

  list(): SessionRuntimeSnapshot[] {
    return Array.from(this.machines.values(), (machine) => machine.get());
  }
}
