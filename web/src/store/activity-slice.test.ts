import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "./index.js";

describe("activity slice", () => {
  beforeEach(() => useStore.getState().reset());

  it("keeps projections isolated per session and clears them with session cleanup", () => {
    const store = useStore.getState();
    store.projectAgentActivity("one", {
      type: "pi_queue",
      generation: 1,
      steering: ["a"],
      followUp: [],
      timestamp: 1,
    });
    store.projectAgentActivity("two", {
      type: "pi_queue",
      generation: 1,
      steering: ["b"],
      followUp: [],
      timestamp: 1,
    });
    expect(useStore.getState().agentActivity.get("one")?.queue.steering).toEqual(["a"]);
    expect(useStore.getState().agentActivity.get("two")?.queue.steering).toEqual(["b"]);
    store.unloadSessionRuntime("one");
    expect(useStore.getState().agentActivity.has("one")).toBe(false);
    expect(useStore.getState().agentActivity.has("two")).toBe(true);
  });
});
