/**
 * Versioned, deterministic fixtures for the hidden Recording Hub projection lab.
 * They deliberately use the browser protocol that the real client consumes; a
 * scenario is never a second session or transcript authority.
 */
import type { BrowserIncomingMessage } from "./pi-browser-protocol.js";

export const AGENT_SCENARIO_VERSION = 1 as const;

export type ScenarioFaultKind =
  | "duplicate"
  | "gap"
  | "stale_generation"
  | "disconnect"
  | "late"
  | "cancel"
  | "retry"
  | "compaction";

export interface ScenarioFault {
  id: string;
  kind: ScenarioFaultKind;
  /** Zero-based event index in the unmodified scenario timeline. */
  at: number;
}

export interface AgentScenarioEvent {
  /** Milliseconds since logical time zero; wall-clock time is never used. */
  at: number;
  event: BrowserIncomingMessage;
}

export interface AgentScenario {
  version: typeof AGENT_SCENARIO_VERSION;
  id: string;
  title: string;
  description: string;
  generation: number;
  events: readonly AgentScenarioEvent[];
  faults?: readonly ScenarioFault[];
}

function runState(
  state: "starting" | "ready" | "running" | "settling",
  timestamp: number,
): BrowserIncomingMessage {
  return { type: "run_state", state, generation: 1, timestamp };
}

/** A small canonical fixture which covers streaming and terminal state. */
export const basicAgentScenario: AgentScenario = {
  version: AGENT_SCENARIO_VERSION,
  id: "basic-stream",
  title: "Basic streaming reply",
  description: "A normal run from start through a streamed assistant reply.",
  generation: 1,
  events: [
    { at: 0, event: runState("starting", 0) },
    { at: 10, event: runState("running", 10) },
    {
      at: 20,
      event: {
        type: "message_delta",
        generation: 1,
        messageId: "scenario-assistant-1",
        role: "assistant",
        delta: { kind: "text", contentIndex: 0, delta: "Projection " },
        timestamp: 20,
      },
    },
    {
      at: 30,
      event: {
        type: "message_delta",
        generation: 1,
        messageId: "scenario-assistant-1",
        role: "assistant",
        delta: { kind: "text", contentIndex: 0, delta: "complete." },
        timestamp: 30,
      },
    },
    {
      at: 40,
      event: {
        type: "agent_message",
        generation: 1,
        message: {
          id: "scenario-assistant-1",
          role: "assistant",
          content: [{ type: "text", text: "Projection complete." }],
          timestamp: 40,
        },
      },
    },
    { at: 45, event: runState("settling", 45) },
    { at: 50, event: runState("ready", 50) },
  ],
};

export const agentScenarioFixtures = [basicAgentScenario] as const;
