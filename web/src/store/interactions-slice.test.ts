// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(globalThis.window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
});

import { useStore } from "../store.js";
import type { InteractionRequest } from "../types.js";

const request: InteractionRequest = {
  id: "request-1",
  kind: "ask",
  toolCallId: "tool-1",
  questions: [
    {
      id: "question-0",
      question: "Choose",
      options: [],
      allowMultiple: false,
      allowFreeText: true,
    },
  ],
};

beforeEach(() => useStore.getState().reset());

describe("interaction store", () => {
  it("adds and completes native Pi interactions", () => {
    useStore.getState().addInteraction("session-1", request);
    expect(useStore.getState().pendingInteractions.get("session-1")?.get(request.id)).toEqual(
      request,
    );

    useStore.getState().completeInteraction("session-1", {
      requestId: request.id,
      kind: "ask",
      status: "submitted",
      answers: [
        {
          questionId: "question-0",
          selectedOptionIds: [],
          freeText: "Answer",
        },
      ],
    });

    expect(useStore.getState().pendingInteractions.has("session-1")).toBe(false);
    expect(useStore.getState().completedInteractions.get("session-1")).toHaveLength(1);
  });

  it("removes one interaction without touching its siblings", () => {
    useStore.getState().addInteraction("session-1", request);
    useStore
      .getState()
      .addInteraction("session-1", { ...request, id: "request-2", toolCallId: "tool-2" });
    useStore.getState().removeInteraction("session-1", request.id);
    expect(useStore.getState().pendingInteractions.get("session-1")?.has("request-2")).toBe(true);
  });

  it("clears pending interactions for one session during history replay", () => {
    useStore.getState().addInteraction("session-1", request);
    useStore.getState().addInteraction("session-2", { ...request, id: "request-2" });
    useStore.getState().clearPendingInteractions("session-1");
    expect(useStore.getState().pendingInteractions.has("session-1")).toBe(false);
    expect(useStore.getState().pendingInteractions.has("session-2")).toBe(true);
  });
});
