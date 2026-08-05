/**
 * Compatibility validator for recorded sessions.
 *
 * Compares a recording's browser output messages structurally to detect
 * protocol drift across the Pi RPC and browser boundaries.
 */

import type { Recording } from "../replay.js";
import { filterEntries } from "../replay.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProtocolDiff {
  entryIndex: number;
  expected: { type: string; [key: string]: unknown };
  actual: { type: string; [key: string]: unknown } | null;
  kind: "missing" | "extra" | "type_mismatch" | "field_mismatch";
  details: string;
}

export interface ValidationResult {
  compatible: boolean;
  backendType: string;
  totalMessages: number;
  diffs: ProtocolDiff[];
  messageTypeBreakdown: Record<string, { count: number; issues: number }>;
}

// Fields to ignore during comparison (they change between runs)
const IGNORED_FIELDS = new Set(["ts", "seq", "elapsedMs"]);

const PI_BROWSER_TYPES = new Set([
  "session_init",
  "session_update",
  "agent_message",
  "message_delta",
  "tool_execution",
  "interaction_request",
  "interaction_response",
  "run_state",
  "history_snapshot",
  "error",
  "event_replay",
  "session_name_update",
  "session_lifecycle_update",
  "mcp_status",
  "pi_queue",
  "pi_extension_event",
  "user_space_request",
  "user_space_mutation_request",
  "user_space_mutation_authorization",
  "user_space_blob_checkout_request",
  "user_space_blob_checkin_request",
  "onlyoffice_request",
]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const RUN_STATES = new Set([
  "starting",
  "ready",
  "running",
  "settling",
  "awaiting_interaction",
  "compacting",
  "reconnecting",
  "disconnected",
  "stopped",
  "error",
]);
const TOOL_STATUSES = new Set(["started", "running", "completed", "failed", "cancelled"]);
const INTERACTION_STATUSES = new Set(["submitted", "cancelled", "timed_out"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issue(
  index: number,
  type: string,
  actual: Record<string, unknown>,
  expectedField: string,
  details: string,
): ProtocolDiff {
  return {
    entryIndex: index,
    expected: { type, [expectedField]: "required" },
    actual: actual as { type: string },
    kind: "field_mismatch",
    details: `Entry ${index}: ${details}`,
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a recording's structural consistency.
 *
 * Checks that browser messages have expected types, required fields are present,
 * and message type distribution is reasonable.
 */
export function validateRecording(recording: Recording): ValidationResult {
  const browserMessages = filterEntries(recording.entries, "out", "browser");
  const diffs: ProtocolDiff[] = [];
  const typeBreakdown: Record<string, { count: number; issues: number }> = {};

  for (let i = 0; i < browserMessages.length; i++) {
    const entry = browserMessages[i];
    let parsed: Record<string, unknown>;

    try {
      const value: unknown = JSON.parse(entry.raw);
      if (!isRecord(value)) throw new Error("browser frame must be an object");
      parsed = value;
    } catch {
      diffs.push({
        entryIndex: i,
        expected: { type: "valid_json" },
        actual: null,
        kind: "missing",
        details: `Entry ${i}: unparseable JSON`,
      });
      continue;
    }

    const msgType = String(parsed.type || "unknown");

    if (!typeBreakdown[msgType]) {
      typeBreakdown[msgType] = { count: 0, issues: 0 };
    }
    typeBreakdown[msgType].count++;

    // Validate required fields per message type
    const issues = validateMessageStructure(msgType, parsed, i);
    for (const issue of issues) {
      diffs.push(issue);
      typeBreakdown[msgType].issues++;
    }
  }

  return {
    compatible: diffs.length === 0,
    backendType: recording.header.backend_type,
    totalMessages: browserMessages.length,
    diffs,
    messageTypeBreakdown: typeBreakdown,
  };
}

/**
 * Compare two recordings structurally.
 *
 * Useful for verifying that replaying Pi/browser events through the hub produces
 * the same browser output. Returns diffs where messages diverge.
 */
export function compareRecordings(
  expected: Recording,
  actual: { type: string; [key: string]: unknown }[],
): ProtocolDiff[] {
  const expectedMsgs = filterEntries(expected.entries, "out", "browser");
  const diffs: ProtocolDiff[] = [];

  const maxLen = Math.max(expectedMsgs.length, actual.length);

  for (let i = 0; i < maxLen; i++) {
    if (i >= expectedMsgs.length) {
      diffs.push({
        entryIndex: i,
        expected: { type: "none" },
        actual: actual[i],
        kind: "extra",
        details: `Extra message at index ${i}: type=${actual[i].type}`,
      });
      continue;
    }

    if (i >= actual.length) {
      let expectedParsed: Record<string, unknown>;
      try {
        expectedParsed = JSON.parse(expectedMsgs[i].raw);
      } catch {
        expectedParsed = { type: "unparseable" };
      }
      diffs.push({
        entryIndex: i,
        expected: expectedParsed as { type: string },
        actual: null,
        kind: "missing",
        details: `Missing message at index ${i}: expected type=${expectedParsed.type}`,
      });
      continue;
    }

    let expectedParsed: Record<string, unknown>;
    try {
      expectedParsed = JSON.parse(expectedMsgs[i].raw);
    } catch {
      diffs.push({
        entryIndex: i,
        expected: { type: "unparseable" },
        actual: actual[i],
        kind: "field_mismatch",
        details: `Entry ${i}: expected message has unparseable JSON`,
      });
      continue;
    }

    const actualMsg = actual[i];

    // Type must match
    if (expectedParsed.type !== actualMsg.type) {
      diffs.push({
        entryIndex: i,
        expected: expectedParsed as { type: string },
        actual: actualMsg as { type: string },
        kind: "type_mismatch",
        details: `Type mismatch at index ${i}: expected=${expectedParsed.type}, actual=${actualMsg.type}`,
      });
      continue;
    }

    // Check for missing/extra top-level fields (excluding ignored fields)
    const fieldDiffs = compareFields(expectedParsed, actualMsg, i);
    diffs.push(...fieldDiffs);
  }

  return diffs;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function validateMessageStructure(
  type: string,
  msg: Record<string, unknown>,
  index: number,
): ProtocolDiff[] {
  const issues: ProtocolDiff[] = [];

  // All messages must have a type field
  if (typeof msg.type !== "string" || msg.type.length === 0) {
    issues.push({
      entryIndex: index,
      expected: { type: "any" },
      actual: msg as { type: string },
      kind: "field_mismatch",
      details: `Entry ${index}: missing 'type' field`,
    });
    return issues;
  }

  if (!PI_BROWSER_TYPES.has(type)) {
    issues.push({
      entryIndex: index,
      expected: { type: "Pi browser protocol event" },
      actual: msg as { type: string },
      kind: "type_mismatch",
      details: `Entry ${index}: non-Pi browser message type '${type}' is not allowed`,
    });
    return issues;
  }

  switch (type) {
    case "session_init": {
      if (!isRecord(msg.session)) {
        issues.push(issue(index, type, msg, "session", "session_init missing 'session' object"));
        break;
      }
      const session = msg.session;
      const model = session.model;
      if (
        session.backendType !== "pi" ||
        session.transport !== "pi-rpc" ||
        session.piVersion !== "0.82.1" ||
        typeof session.sessionId !== "string" ||
        !isRecord(model) ||
        typeof model.key !== "string" ||
        typeof model.provider !== "string" ||
        typeof model.modelId !== "string" ||
        !THINKING_LEVELS.has(String(session.thinkingLevel)) ||
        !["agent", "plan"].includes(String(session.mode)) ||
        typeof session.cwd !== "string" ||
        !Array.isArray(session.tools) ||
        !Array.isArray(session.commands) ||
        !Array.isArray(session.skills) ||
        !Array.isArray(session.mcpServers) ||
        !isRecord(session.usage) ||
        !RUN_STATES.has(String(session.runState)) ||
        typeof session.isCompacting !== "boolean" ||
        typeof session.generation !== "number"
      ) {
        issues.push(
          issue(
            index,
            type,
            msg,
            "session",
            "session_init requires a complete native-Pi SessionState",
          ),
        );
      }
      break;
    }
    case "session_update":
      if (!isRecord(msg.session)) {
        issues.push(issue(index, type, msg, "session", "session_update missing 'session' object"));
      }
      break;
    case "agent_message": {
      const message = msg.message;
      if (
        typeof msg.generation !== "number" ||
        !isRecord(message) ||
        typeof message.id !== "string" ||
        !["user", "assistant", "system"].includes(String(message.role)) ||
        !Array.isArray(message.content) ||
        typeof message.timestamp !== "number"
      ) {
        issues.push(
          issue(
            index,
            type,
            msg,
            "message",
            "agent_message requires generation and a Pi message with id, role, content, and timestamp",
          ),
        );
      }
      break;
    }
    case "message_delta":
      if (
        typeof msg.generation !== "number" ||
        typeof msg.messageId !== "string" ||
        msg.role !== "assistant" ||
        !isRecord(msg.delta) ||
        !["text", "thinking", "tool_arguments"].includes(String(msg.delta.kind)) ||
        typeof msg.delta.contentIndex !== "number" ||
        typeof msg.delta.delta !== "string"
      ) {
        issues.push(
          issue(
            index,
            type,
            msg,
            "delta",
            "message_delta requires generation, messageId, and a typed delta",
          ),
        );
      }
      break;
    case "tool_execution":
      if (
        typeof msg.generation !== "number" ||
        typeof msg.toolCallId !== "string" ||
        typeof msg.toolName !== "string" ||
        !TOOL_STATUSES.has(String(msg.status)) ||
        typeof msg.timestamp !== "number"
      ) {
        issues.push(
          issue(
            index,
            type,
            msg,
            "toolCallId",
            "tool_execution requires generation, toolCallId, toolName, status, and timestamp",
          ),
        );
      }
      break;
    case "interaction_request": {
      const request = msg.request;
      if (
        typeof msg.generation !== "number" ||
        !isRecord(request) ||
        typeof request.id !== "string" ||
        !["ask", "propose_plan"].includes(String(request.kind)) ||
        typeof request.toolCallId !== "string" ||
        typeof msg.timestamp !== "number"
      ) {
        issues.push(
          issue(
            index,
            type,
            msg,
            "request",
            "interaction_request requires generation, timestamp, and a Pi interaction request",
          ),
        );
      }
      break;
    }
    case "interaction_response":
      if (
        typeof msg.generation !== "number" ||
        typeof msg.requestId !== "string" ||
        !["ask", "propose_plan"].includes(String(msg.kind)) ||
        !INTERACTION_STATUSES.has(String(msg.status))
      ) {
        issues.push(
          issue(
            index,
            type,
            msg,
            "requestId",
            "interaction_response requires generation, requestId, kind, and status",
          ),
        );
      }
      break;
    case "run_state":
      if (
        typeof msg.generation !== "number" ||
        !RUN_STATES.has(String(msg.state)) ||
        typeof msg.timestamp !== "number"
      ) {
        issues.push(
          issue(index, type, msg, "state", "run_state requires generation, state, and timestamp"),
        );
      }
      break;
    case "history_snapshot":
      if (
        typeof msg.generation !== "number" ||
        !Array.isArray(msg.entries) ||
        typeof msg.total !== "number" ||
        typeof msg.cursor !== "number" ||
        typeof msg.nextCursor !== "number" ||
        typeof msg.hasMore !== "boolean" ||
        !["initial", "page", "gap", "recovery"].includes(String(msg.reason))
      ) {
        issues.push(
          issue(
            index,
            type,
            msg,
            "entries",
            "history_snapshot requires generation, pagination metadata, reason, and entries",
          ),
        );
      }
      break;
    case "mcp_status":
      if (!Array.isArray(msg.servers)) {
        issues.push(issue(index, type, msg, "servers", "mcp_status missing 'servers' array"));
      }
      break;
    case "pi_queue":
      if (
        typeof msg.generation !== "number" ||
        !Array.isArray(msg.steering) ||
        !msg.steering.every((item) => typeof item === "string") ||
        !Array.isArray(msg.followUp) ||
        !msg.followUp.every((item) => typeof item === "string") ||
        typeof msg.timestamp !== "number"
      ) {
        issues.push(
          issue(
            index,
            type,
            msg,
            "steering",
            "pi_queue requires generation, steering, followUp, and timestamp",
          ),
        );
      }
      break;
    case "pi_extension_event":
      if (
        typeof msg.generation !== "number" ||
        typeof msg.event !== "string" ||
        msg.event.length === 0 ||
        !isRecord(msg.payload) ||
        typeof msg.timestamp !== "number"
      ) {
        issues.push(
          issue(
            index,
            type,
            msg,
            "event",
            "pi_extension_event requires generation, event, payload, and timestamp",
          ),
        );
      }
      break;
    case "event_replay":
      if (!Array.isArray(msg.events)) {
        issues.push(issue(index, type, msg, "events", "event_replay missing 'events' array"));
      }
      break;
  }

  return issues;
}

function compareFields(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  index: number,
): ProtocolDiff[] {
  const diffs: ProtocolDiff[] = [];

  const expectedKeys = Object.keys(expected).filter((k) => !IGNORED_FIELDS.has(k));
  const actualKeys = Object.keys(actual).filter((k) => !IGNORED_FIELDS.has(k));

  // Check for missing fields in actual
  for (const key of expectedKeys) {
    if (!(key in actual)) {
      diffs.push({
        entryIndex: index,
        expected: expected as { type: string },
        actual: actual as { type: string },
        kind: "field_mismatch",
        details: `Entry ${index}: missing field '${key}' in actual (type=${expected.type})`,
      });
    }
  }

  // Check for unexpected new fields in actual (informational, not necessarily a break)
  for (const key of actualKeys) {
    if (!(key in expected)) {
      diffs.push({
        entryIndex: index,
        expected: expected as { type: string },
        actual: actual as { type: string },
        kind: "field_mismatch",
        details: `Entry ${index}: new field '${key}' in actual (type=${actual.type})`,
      });
    }
  }

  return diffs;
}
