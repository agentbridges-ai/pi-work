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

  it("keeps an interaction pending until the runtime acknowledges its response", () => {
    useStore.getState().addInteraction("session-1", request);
    useStore.getState().markInteractionSubmitting("session-1", request.id, {
      clientMsgId: "client-1",
      generation: 3,
      submittedAt: 1,
    });

    expect(useStore.getState().pendingInteractions.get("session-1")?.has(request.id)).toBe(true);
    expect(useStore.getState().interactionSubmissions.get("session-1")?.get(request.id)).toEqual({
      clientMsgId: "client-1",
      generation: 3,
      submittedAt: 1,
    });

    useStore.getState().completeInteraction("session-1", {
      requestId: request.id,
      kind: "ask",
      status: "submitted",
      answers: [],
    });

    expect(useStore.getState().pendingInteractions.has("session-1")).toBe(false);
    expect(useStore.getState().interactionSubmissions.has("session-1")).toBe(false);
  });

  it("removes one interaction without touching its siblings", () => {
    useStore.getState().addInteraction("session-1", request);
    useStore
      .getState()
      .addInteraction("session-1", { ...request, id: "request-2", toolCallId: "tool-2" });
    useStore.getState().removeInteraction("session-1", request.id);
    expect(useStore.getState().pendingInteractions.get("session-1")?.has("request-2")).toBe(true);
  });

  it("cleans up submission state when a pending interaction is removed", () => {
    useStore.getState().addInteraction("session-1", request);
    useStore.getState().markInteractionSubmitting("session-1", request.id, {
      clientMsgId: "client-1",
      generation: 1,
      submittedAt: 1,
    });
    useStore.getState().removeInteraction("session-1", request.id);
    expect(useStore.getState().interactionSubmissions.has("session-1")).toBe(false);
  });

  it("clears pending interactions for one session during history replay", () => {
    useStore.getState().addInteraction("session-1", request);
    useStore.getState().addInteraction("session-2", { ...request, id: "request-2" });
    useStore.getState().clearPendingInteractions("session-1");
    expect(useStore.getState().pendingInteractions.has("session-1")).toBe(false);
    expect(useStore.getState().pendingInteractions.has("session-2")).toBe(true);
  });

  it("replaces a session snapshot without touching other sessions", () => {
    useStore.getState().addInteraction("session-1", request);
    useStore.getState().addInteraction("session-2", { ...request, id: "request-2" });
    useStore
      .getState()
      .replacePendingInteractions("session-1", [
        { ...request, id: "request-3", toolCallId: "tool-3" },
      ]);
    expect([...useStore.getState().pendingInteractions.get("session-1")!.keys()]).toEqual([
      "request-3",
    ]);
    expect(useStore.getState().pendingInteractions.get("session-2")?.has("request-2")).toBe(true);
  });
});
