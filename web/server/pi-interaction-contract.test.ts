import { describe, expect, it } from "vitest";
import {
  encodePiAskBatchResponse,
  encodePiAskBatchTitle,
  parsePiAskBatchRequest,
  parsePiAskBatchResponse,
  PI_ASK_BATCH_OPTION,
} from "./pi-ask-interaction.js";
import {
  encodePiPlanRequestTitle,
  parsePiPlanRequest,
  PI_PLAN_OPTIONS,
} from "./pi-plan-interaction.js";

const questions = [
  {
    header: "Style",
    question: "Choose a style",
    options: [
      { label: "Minimal", description: "Keep the UI quiet" },
      { label: "Expressive", description: "Use stronger visual accents" },
    ],
    multiSelect: false,
  },
  {
    header: "Scope",
    question: "Choose the scope",
    options: [
      { label: "Frontend", description: "Change the browser UI" },
      { label: "Backend", description: "Change the server" },
    ],
    multiSelect: true,
  },
];

describe("trusted Pi interaction contracts", () => {
  it("round-trips a grouped Ask request and response", () => {
    const request = parsePiAskBatchRequest(encodePiAskBatchTitle("tool-ask", questions), [
      PI_ASK_BATCH_OPTION,
    ]);
    expect(request).toEqual({ toolCallId: "tool-ask", questions });

    const response = encodePiAskBatchResponse([
      { question: "Choose a style", answer: "Minimal" },
      { question: "Choose the scope", answer: ["Frontend", "Backend"] },
    ]);
    expect(parsePiAskBatchResponse(response, questions)).toEqual([
      { question: "Choose a style", answer: "Minimal" },
      { question: "Choose the scope", answer: ["Frontend", "Backend"] },
    ]);
  });

  it("rejects incomplete Ask groups and mismatched answer modes", () => {
    expect(() => encodePiAskBatchTitle("tool-ask", [])).toThrow(/invalid/u);
    expect(
      parsePiAskBatchResponse(
        encodePiAskBatchResponse([
          { question: "Choose a style", answer: ["Minimal"] },
          { question: "Choose the scope", answer: ["Frontend"] },
        ]),
        questions,
      ),
    ).toBeUndefined();
  });

  it("round-trips a correlated Plan request", () => {
    expect(
      parsePiPlanRequest(encodePiPlanRequestTitle("tool-plan", "1. Inspect"), [...PI_PLAN_OPTIONS]),
    ).toEqual({
      toolCallId: "tool-plan",
      plan: "1. Inspect",
    });
  });
});
