import { describe, expect, it, vi } from "vitest";
import { basicAgentScenario, type ScenarioFault } from "../../shared/agent-scenario.js";
import { ScenarioPlayback } from "../../shared/scenario-playback.js";

describe("ScenarioPlayback", () => {
  it("uses a manual logical clock for play, pause, speed, step, and seek", () => {
    const received: string[] = [];
    const reset = vi.fn(() => {
      received.length = 0;
    });
    const playback = new ScenarioPlayback(basicAgentScenario, {
      onReset: reset,
      onEvent: (event) => received.push(event.type),
    });
    playback.play();
    expect(playback.advance(10)).toBe(2);
    playback.pause();
    expect(playback.advance(1_000)).toBe(0);
    playback.setSpeed(2);
    playback.play();
    expect(playback.advance(5)).toBe(1);
    playback.seek(40);
    expect(playback.step()?.type).toBe("run_state");
    expect(reset).toHaveBeenCalledOnce();
    expect(received).toEqual([
      "run_state",
      "run_state",
      "message_delta",
      "message_delta",
      "agent_message",
      "run_state",
    ]);
  });

  it.each<ScenarioFault["kind"]>([
    "duplicate",
    "gap",
    "stale_generation",
    "disconnect",
    "late",
    "cancel",
    "retry",
    "compaction",
  ])("injects the %s fault deterministically", (kind) => {
    const playback = new ScenarioPlayback(basicAgentScenario, {
      faults: [
        {
          id: kind,
          kind,
          at: kind === "gap" ? 4 : 1,
        },
      ],
    });
    const received = [] as ReturnType<ScenarioPlayback["step"]>[];
    while (playback.getProgress().state !== "finished") received.push(playback.step());
    if (kind === "gap") {
      expect(received).toHaveLength(basicAgentScenario.events.length);
      expect(received).toContainEqual(
        expect.objectContaining({
          type: "history_snapshot",
          reason: "gap",
          entries: [
            expect.objectContaining({
              event: expect.objectContaining({ type: "agent_message" }),
            }),
          ],
        }),
      );
    } else expect(received).toHaveLength(basicAgentScenario.events.length + 1);
    if (kind === "stale_generation") {
      expect(
        received.some(
          (event) => event !== undefined && "generation" in event && event.generation === 0,
        ),
      ).toBe(true);
    }
    if (["disconnect", "cancel", "retry", "compaction"].includes(kind)) {
      expect(received).toContainEqual(
        expect.objectContaining({ type: "run_state", reason: `scenario:${kind}` }),
      );
    }
    if (kind === "retry") {
      expect(received).toContainEqual(
        expect.objectContaining({
          type: "run_state",
          state: "running",
          detail: expect.objectContaining({ kind: "provider_retry" }),
        }),
      );
      expect(received).not.toContainEqual(
        expect.objectContaining({ type: "run_state", state: "reconnecting" }),
      );
    }
  });

  it("does not invent generation on a protocol event without one", () => {
    const playback = new ScenarioPlayback(
      {
        ...basicAgentScenario,
        events: [{ at: 0, event: { type: "session_update", session: {} } }],
      },
      { faults: [{ id: "stale", kind: "stale_generation", at: 0 }] },
    );

    expect(playback.step()).toEqual({ type: "session_update", session: {} });
    expect(playback.getProgress().total).toBe(1);
  });
});
