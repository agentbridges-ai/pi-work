import { describe, expect, it } from "vitest";
import type { PiRunState } from "./types.js";
import { emptyAgentActivity, projectAgentActivity } from "./agent-activity-projector.js";

function sessionInit(runState: PiRunState, generation = 1) {
  return {
    type: "session_init" as const,
    session: {
      sessionId: "session",
      backendType: "pi" as const,
      transport: "pi-rpc" as const,
      piVersion: "0.82.1",
      model: { key: "provider/model", provider: "provider", modelId: "model" },
      thinkingLevel: "off" as const,
      mode: "agent" as const,
      cwd: "/workspace",
      tools: [],
      commands: [],
      skills: [],
      mcpServers: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      runState,
      isCompacting: runState === "compacting",
      generation,
    },
  };
}

describe("agent activity projector", () => {
  it("keeps provider retry independent from the browser transport", () => {
    const connected = projectAgentActivity(emptyAgentActivity(1), {
      type: "run_state",
      generation: 1,
      state: "running",
      timestamp: 1,
    });
    const retrying = projectAgentActivity(connected, {
      type: "run_state",
      generation: 1,
      state: "running",
      timestamp: 2,
      detail: {
        kind: "provider_retry",
        phase: "start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 10,
        error: "rate limited",
      },
    });
    expect(retrying).toMatchObject({
      connection: "connected",
      run: "running",
      operation: "retrying",
    });
    const resumed = projectAgentActivity(retrying, {
      type: "run_state",
      generation: 1,
      state: "running",
      timestamp: 3,
      detail: { kind: "provider_retry", phase: "end", attempt: 1, success: true },
    });
    expect(resumed.operation).toBe("none");
    expect(resumed.latestError).toBeNull();
  });

  it("projects compaction, interaction attention, queues, extension errors, and ready idle", () => {
    let activity = emptyAgentActivity(2);
    activity = projectAgentActivity(activity, {
      type: "run_state",
      generation: 2,
      state: "compacting",
      timestamp: 1,
      detail: { kind: "compaction", phase: "start", reason: "threshold" },
    });
    expect(activity).toMatchObject({ run: "idle", operation: "compacting" });
    activity = projectAgentActivity(activity, {
      type: "interaction_request",
      generation: 2,
      timestamp: 2,
      request: { id: "ask", kind: "ask", toolCallId: "tool", questions: [] },
    });
    expect(activity.attention).toBe("needs_input");
    activity = projectAgentActivity(activity, {
      type: "pi_queue",
      generation: 2,
      steering: ["now"],
      followUp: ["later"],
      timestamp: 3,
    });
    expect(activity.queue).toEqual({ steering: ["now"], followUp: ["later"], timestamp: 3 });
    activity = projectAgentActivity(activity, {
      type: "pi_extension_event",
      generation: 2,
      event: "error",
      timestamp: 4,
      payload: { error: "extension failed" },
    });
    expect(activity).toMatchObject({ attention: "blocked", latestError: "extension failed" });
    activity = projectAgentActivity(activity, {
      type: "run_state",
      generation: 2,
      state: "ready",
      timestamp: 5,
    });
    expect(activity.run).toBe("idle");
    expect(activity).toMatchObject({ attention: "review_ready", latestError: null });
  });

  it("maps initial transport and runtime failures without inventing an active run", () => {
    expect(projectAgentActivity(undefined, sessionInit("disconnected"))).toMatchObject({
      connection: "disconnected",
      run: "idle",
      attention: "none",
    });
    expect(projectAgentActivity(undefined, sessionInit("reconnecting"))).toMatchObject({
      connection: "reconnecting",
      run: "idle",
      attention: "none",
    });
    expect(projectAgentActivity(undefined, sessionInit("error"))).toMatchObject({
      connection: "connected",
      run: "idle",
      attention: "blocked",
    });
  });

  it("clears recovered extension and retry errors on healthy lifecycle events", () => {
    const failed = projectAgentActivity(emptyAgentActivity(1), {
      type: "pi_extension_event",
      generation: 1,
      event: "error",
      payload: {},
      timestamp: 1,
    });
    expect(failed).toMatchObject({ attention: "blocked", latestError: null });

    const running = projectAgentActivity(failed, {
      type: "run_state",
      generation: 1,
      state: "running",
      timestamp: 2,
    });
    expect(running).toMatchObject({ attention: "none", latestError: null, runStartedAt: 2 });

    const retrying = projectAgentActivity(running, {
      type: "run_state",
      generation: 1,
      state: "running",
      timestamp: 3,
      detail: {
        kind: "provider_retry",
        phase: "start",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 10,
        error: "temporary",
      },
    });
    expect(retrying.latestError).toBe("temporary");
    const recovered = projectAgentActivity(retrying, {
      type: "run_state",
      generation: 1,
      state: "running",
      timestamp: 4,
      detail: { kind: "provider_retry", phase: "end", attempt: 1, success: true },
    });
    expect(recovered).toMatchObject({ operation: "none", latestError: null });
  });

  it("finishes summarization retry without leaving a compacting operation", () => {
    const retrying = projectAgentActivity(emptyAgentActivity(1), {
      type: "run_state",
      generation: 1,
      state: "compacting",
      timestamp: 1,
      detail: {
        kind: "summarization_retry",
        phase: "scheduled",
        attempt: 1,
        maxAttempts: 2,
        delayMs: 10,
        error: "overflow",
      },
    });
    const finished = projectAgentActivity(retrying, {
      type: "run_state",
      generation: 1,
      state: "ready",
      timestamp: 2,
      detail: { kind: "summarization_retry", phase: "finished" },
    });
    expect(finished).toMatchObject({ run: "idle", operation: "none", latestError: null });
    expect(finished.attention).toBe("none");
  });

  it("does not let a stale generation mutate a new projection", () => {
    const newest = projectAgentActivity(emptyAgentActivity(1), {
      type: "pi_queue",
      generation: 2,
      steering: ["new"],
      followUp: [],
      timestamp: 2,
    });
    const stale = projectAgentActivity(newest, {
      type: "pi_extension_event",
      generation: 1,
      event: "error",
      payload: { error: "old" },
      timestamp: 3,
    });
    expect(stale).toBe(newest);
    expect(stale.latestError).toBeNull();
  });

  it("projects native agent_end settling as a distinct active run phase", () => {
    const activity = projectAgentActivity(emptyAgentActivity(1), {
      type: "run_state",
      generation: 1,
      state: "settling",
      timestamp: 1,
    });
    expect(activity).toMatchObject({ connection: "connected", run: "settling" });
  });

  it("marks only a completed active run ready for review", () => {
    const initial = projectAgentActivity(emptyAgentActivity(), sessionInit("ready"));
    expect(initial.attention).toBe("none");

    const running = projectAgentActivity(initial, {
      type: "run_state",
      generation: 1,
      state: "running",
      timestamp: 1,
    });
    const settling = projectAgentActivity(running, {
      type: "run_state",
      generation: 1,
      state: "settling",
      timestamp: 2,
    });
    const settled = projectAgentActivity(settling, {
      type: "run_state",
      generation: 1,
      state: "ready",
      timestamp: 3,
    });

    expect(settled).toMatchObject({ run: "idle", attention: "review_ready" });
    expect(settled.runStartedAt).toBe(1);
    const nextRun = projectAgentActivity(settled, {
      type: "run_state",
      generation: 1,
      state: "running",
      timestamp: 4,
    });
    expect(nextRun.attention).toBe("none");
    expect(nextRun.runStartedAt).toBe(4);
  });
});
