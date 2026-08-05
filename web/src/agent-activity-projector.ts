import type { BrowserIncomingMessage } from "./types.js";

export type ActivityConnection = "connecting" | "connected" | "reconnecting" | "disconnected";
export type ActivityRun = "starting" | "running" | "settling" | "idle" | "stopped";
export type ActivityOperation = "none" | "retrying" | "compacting";
export type ActivityAttention = "none" | "needs_input" | "review_ready" | "blocked";

export interface PiQueueProjection {
  steering: string[];
  followUp: string[];
  timestamp: number;
}

export type TrustedExtensionEvent = Extract<BrowserIncomingMessage, { type: "pi_extension_event" }>;

export interface AgentActivityProjection {
  generation: number;
  connection: ActivityConnection;
  run: ActivityRun;
  /** Start of the latest foreground turn; scopes transient outputs to that turn. */
  runStartedAt: number | null;
  operation: ActivityOperation;
  attention: ActivityAttention;
  queue: PiQueueProjection;
  extensionEvent: TrustedExtensionEvent | null;
  latestError: string | null;
}

export const emptyAgentActivity = (generation = 0): AgentActivityProjection => ({
  generation,
  connection: "disconnected",
  run: "idle",
  runStartedAt: null,
  operation: "none",
  attention: "none",
  queue: { steering: [], followUp: [], timestamp: 0 },
  extensionEvent: null,
  latestError: null,
});

function errorFromExtension(event: TrustedExtensionEvent): string | null {
  if (event.event !== "error") return null;
  const error = event.payload.error;
  return typeof error === "string" && error.length > 0 ? error : null;
}

function resetForGeneration(
  previous: AgentActivityProjection,
  generation: number,
): AgentActivityProjection {
  return { ...emptyAgentActivity(generation), connection: previous.connection };
}

/**
 * Pure, browser-memory projection of native Pi and trusted-extension events.
 * Pi JSONL remains the transcript authority; this reducer intentionally stores
 * only transient activity signals that can be reconstructed from the stream.
 */
export function projectAgentActivity(
  previous: AgentActivityProjection | undefined,
  event: BrowserIncomingMessage,
): AgentActivityProjection {
  let next = previous ?? emptyAgentActivity();
  const generation =
    event.type === "session_init"
      ? event.session.generation
      : "generation" in event && typeof event.generation === "number"
        ? event.generation
        : undefined;
  if (generation !== undefined) {
    if (generation < next.generation) return next;
    if (generation > next.generation) next = resetForGeneration(next, generation);
  }

  switch (event.type) {
    case "session_init":
      return {
        ...next,
        generation: event.session.generation,
        connection:
          event.session.runState === "disconnected" || event.session.runState === "stopped"
            ? "disconnected"
            : event.session.runState === "reconnecting"
              ? "reconnecting"
              : "connected",
        run:
          event.session.runState === "stopped"
            ? "stopped"
            : event.session.runState === "ready" ||
                event.session.runState === "error" ||
                event.session.runState === "disconnected" ||
                event.session.runState === "reconnecting" ||
                event.session.runState === "compacting"
              ? "idle"
              : event.session.runState === "settling"
                ? "settling"
                : event.session.runState === "starting"
                  ? "starting"
                  : "running",
        operation: event.session.isCompacting ? "compacting" : "none",
        attention:
          event.session.runState === "awaiting_interaction"
            ? "needs_input"
            : event.session.runState === "error"
              ? "blocked"
              : "none",
        latestError: null,
      };
    case "pi_queue":
      return {
        ...next,
        queue: {
          steering: [...event.steering],
          followUp: [...event.followUp],
          timestamp: event.timestamp,
        },
      };
    case "pi_extension_event": {
      const error = errorFromExtension(event);
      return {
        ...next,
        extensionEvent: event,
        ...(event.event === "error" ? { latestError: error, attention: "blocked" } : {}),
      };
    }
    case "interaction_request":
      return {
        ...next,
        run: "running",
        runStartedAt:
          next.run === "idle" || next.run === "stopped"
            ? (event.timestamp ?? next.runStartedAt)
            : next.runStartedAt,
        attention: "needs_input",
      };
    case "interaction_response":
      return next.attention === "needs_input" ? { ...next, attention: "none" } : next;
    case "run_state": {
      const detail = event.detail;
      const operation: ActivityOperation =
        detail?.kind === "provider_retry"
          ? detail.phase === "start"
            ? "retrying"
            : "none"
          : detail?.kind === "compaction"
            ? detail.phase === "start" || detail.willRetry
              ? "compacting"
              : "none"
            : detail?.kind === "summarization_retry"
              ? detail.phase === "finished"
                ? "none"
                : "compacting"
              : event.state === "compacting"
                ? "compacting"
                : "none";
      const detailError = detail && "error" in detail ? detail.error : undefined;
      const retrySucceeded =
        detail?.kind === "provider_retry" && detail.phase === "end" && detail.success;
      const summarizationFinished =
        detail?.kind === "summarization_retry" && detail.phase === "finished";
      const latestError = retrySucceeded || summarizationFinished ? null : (detailError ?? null);
      if (event.state === "reconnecting")
        return {
          ...next,
          connection: "reconnecting",
          operation,
          latestError: event.reason ?? detailError ?? next.latestError,
        };
      if (event.state === "disconnected")
        return {
          ...next,
          connection: "disconnected",
          operation,
          latestError: event.reason ?? detailError ?? next.latestError,
        };
      if (event.state === "stopped")
        return {
          ...next,
          connection: "disconnected",
          run: "stopped",
          operation: "none",
          attention: "none",
          latestError: null,
        };
      if (event.state === "error")
        return {
          ...next,
          connection: "connected",
          run: "idle",
          operation: "none",
          attention: "blocked",
          latestError: event.reason ?? detailError ?? next.latestError,
        };
      if (event.state === "compacting")
        return {
          ...next,
          connection: "connected",
          operation: "compacting",
          attention: "none",
          latestError: detailError ?? null,
        };
      if (event.state === "ready")
        return {
          ...next,
          connection: "connected",
          run: "idle",
          operation,
          attention:
            next.runStartedAt !== null &&
            (next.run === "starting" || next.run === "running" || next.run === "settling")
              ? "review_ready"
              : "none",
          latestError: null,
        };
      if (event.state === "settling")
        return {
          ...next,
          connection: "connected",
          run: "settling",
          operation,
          attention: "none",
          latestError: null,
        };
      const beginsRun = event.state === "starting" || next.run === "idle" || next.run === "stopped";
      return {
        ...next,
        connection: "connected",
        run: event.state === "starting" ? "starting" : "running",
        runStartedAt: beginsRun ? event.timestamp : next.runStartedAt,
        operation,
        attention:
          event.state === "awaiting_interaction"
            ? "needs_input"
            : next.attention === "needs_input"
              ? "needs_input"
              : "none",
        latestError,
      };
    }
    default:
      return next;
  }
}
