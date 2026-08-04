import type {
  AgentMessage,
  BrowserOutgoingMessage,
  PiMessagePart,
} from "../shared/pi-browser-protocol.js";
import {
  isRuntimeContextId,
  WS_PROTOCOL_VERSION,
  type WsEnvelope,
} from "../shared/api-contracts.js";
import { BROWSER_WS_MAX_MESSAGE_BYTES } from "./websocket-transport.js";
import type { Session } from "./ws-bridge-types.js";
import { isDuplicateClientMessage, rememberClientMessage } from "./ws-bridge-replay.js";

export { BROWSER_WS_MAX_MESSAGE_BYTES };
export const USER_MESSAGE_MAX_BYTES = 256 * 1024;

const MAX_ID_BYTES = 256;
const MAX_NAME_BYTES = 256;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const MESSAGE_TYPES = new Set<BrowserOutgoingMessage["type"]>([
  "agent_message",
  "interaction_response",
  "session_subscribe",
  "session_ack",
  "abort",
  "retry",
  "compact",
  "set_model",
  "set_thinking_level",
  "set_mode",
  "mcp_get_status",
  "mcp_toggle",
  "mcp_reconnect",
  "end_session",
  "stop_task",
  "user_space_mount",
  "user_space_unmount",
  "user_space_mutation_authorize",
  "user_space_response",
  "user_space_status",
  "user_space_index_update",
  "onlyoffice_status",
  "onlyoffice_response",
]);

export const IDEMPOTENT_BROWSER_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "agent_message",
  "interaction_response",
  "abort",
  "retry",
  "compact",
  "set_model",
  "set_thinking_level",
  "set_mode",
  "mcp_get_status",
  "mcp_toggle",
  "mcp_reconnect",
  "end_session",
  "stop_task",
  "user_space_mount",
  "user_space_unmount",
  "user_space_status",
  "user_space_index_update",
  "onlyoffice_status",
  "onlyoffice_response",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validString(
  value: unknown,
  maxBytes = MAX_NAME_BYTES,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    (allowEmpty || value.length > 0) &&
    Buffer.byteLength(value, "utf8") <= maxBytes
  );
}

function validId(value: unknown): value is string {
  return validString(value, MAX_ID_BYTES) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value);
}

function validGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validFiniteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validClientMessageId(value: Record<string, unknown>): boolean {
  return value.clientMsgId === undefined || validId(value.clientMsgId);
}

function validMessagePart(value: unknown, browserOriginated: boolean): value is PiMessagePart {
  if (!isRecord(value)) return false;
  if (value.type === "text") {
    return (
      typeof value.text === "string" &&
      Buffer.byteLength(value.text, "utf8") <= USER_MESSAGE_MAX_BYTES
    );
  }
  if (!browserOriginated && value.type === "thinking") {
    return typeof value.thinking === "string";
  }
  return (
    value.type === "image" &&
    validString(value.mediaType, 255) &&
    typeof value.data === "string" &&
    Buffer.byteLength(value.data, "utf8") <= BROWSER_WS_MAX_MESSAGE_BYTES
  );
}

function validAgentMessage(value: unknown): value is AgentMessage {
  if (
    !isRecord(value) ||
    !validId(value.id) ||
    value.role !== "user" ||
    !validFiniteTimestamp(value.timestamp) ||
    !Array.isArray(value.content) ||
    value.content.length === 0 ||
    !value.content.every((part) => validMessagePart(part, true))
  ) {
    return false;
  }
  if (
    value.displayContent !== undefined &&
    (!Array.isArray(value.displayContent) ||
      !value.displayContent.every((part) => validMessagePart(part, true)))
  ) {
    return false;
  }
  const textBytes = [...value.content, ...(value.displayContent ?? [])]
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .reduce((total, part) => total + Buffer.byteLength(part.text, "utf8"), 0);
  return textBytes <= USER_MESSAGE_MAX_BYTES;
}

function validModel(value: unknown): boolean {
  return (
    isRecord(value) &&
    validString(value.key, MAX_NAME_BYTES) &&
    validString(value.provider, MAX_NAME_BYTES) &&
    validString(value.modelId, MAX_NAME_BYTES)
  );
}

function validInteractionResponse(value: Record<string, unknown>): boolean {
  if (
    !validGeneration(value.generation) ||
    !validId(value.requestId) ||
    !["ask", "propose_plan"].includes(String(value.kind)) ||
    !["submitted", "cancelled", "timed_out"].includes(String(value.status)) ||
    (value.timestamp !== undefined && !validFiniteTimestamp(value.timestamp))
  ) {
    return false;
  }
  if (value.kind === "ask") {
    return (
      value.answers === undefined ||
      (Array.isArray(value.answers) &&
        value.answers.length <= 4 &&
        value.answers.every(
          (answer) =>
            isRecord(answer) &&
            validId(answer.questionId) &&
            Array.isArray(answer.selectedOptionIds) &&
            answer.selectedOptionIds.length <= 4 &&
            answer.selectedOptionIds.every(validId) &&
            (answer.freeText === undefined ||
              validString(answer.freeText, USER_MESSAGE_MAX_BYTES, true)),
        ))
    );
  }
  return (
    (value.decision === undefined ||
      ["execute", "continue_planning", "refine"].includes(String(value.decision))) &&
    (value.refinement === undefined || validString(value.refinement, USER_MESSAGE_MAX_BYTES, true))
  );
}

function validMounts(value: unknown): boolean {
  return (
    value === undefined ||
    (Array.isArray(value) &&
      value.length <= 16 &&
      value.every(
        (mount) =>
          isRecord(mount) &&
          validId(mount.mountId) &&
          validString(mount.name, 512) &&
          validString(mount.rootName, 512) &&
          ["expected", "mounted", "offline"].includes(String(mount.status)) &&
          ["readonly", "readwrite"].includes(String(mount.access)) &&
          mount.includeHidden === true,
      ))
  );
}

function validOnlyOfficeStatus(value: Record<string, unknown>): boolean {
  return (
    (value.document === null || isRecord(value.document)) &&
    (value.client_msg_id === undefined || validId(value.client_msg_id))
  );
}

function validOnlyOfficeResponse(value: Record<string, unknown>): boolean {
  return (
    validId(value.request_id) &&
    typeof value.ok === "boolean" &&
    (value.error === undefined || validString(value.error, USER_MESSAGE_MAX_BYTES, true)) &&
    (value.client_msg_id === undefined || validId(value.client_msg_id))
  );
}

function isOutgoingMessage(value: unknown): value is BrowserOutgoingMessage {
  if (
    !isRecord(value) ||
    typeof value.type !== "string" ||
    !MESSAGE_TYPES.has(value.type as BrowserOutgoingMessage["type"]) ||
    !validClientMessageId(value)
  ) {
    return false;
  }
  switch (value.type as BrowserOutgoingMessage["type"]) {
    case "agent_message":
      return (
        validGeneration(value.generation) &&
        validAgentMessage(value.message) &&
        (value.clientMsgId === undefined || value.clientMsgId === value.message.id)
      );
    case "interaction_response":
      return validInteractionResponse(value);
    case "session_subscribe":
    case "session_ack":
      return validGeneration(value.lastSeq);
    case "abort":
      return value.generation === undefined || validGeneration(value.generation);
    case "retry":
      return value.messageId === undefined || validId(value.messageId);
    case "compact":
    case "mcp_get_status":
      return true;
    case "set_model":
      return validModel(value.model);
    case "set_thinking_level":
      return THINKING_LEVELS.has(String(value.thinkingLevel));
    case "set_mode":
      return value.mode === "agent" || value.mode === "plan";
    case "mcp_toggle":
      return validString(value.serverName) && typeof value.enabled === "boolean";
    case "mcp_reconnect":
      return validString(value.serverName);
    case "end_session":
      return value.reason === undefined || validString(value.reason, 4_096, true);
    case "stop_task":
      return validId(value.taskId);
    case "user_space_mount":
    case "user_space_status":
      return (
        (value.user_space === undefined ||
          value.user_space === null ||
          isRecord(value.user_space)) &&
        validMounts(value.mounts)
      );
    case "user_space_unmount":
      return validId(value.mountId);
    case "user_space_mutation_authorize":
      return validId(value.request_id);
    case "user_space_response":
      return (
        validId(value.request_id) &&
        typeof value.ok === "boolean" &&
        (value.error === undefined || validString(value.error, USER_MESSAGE_MAX_BYTES, true)) &&
        (value.commit_lease === undefined || validId(value.commit_lease)) &&
        (value.runtime_epoch === undefined || validId(value.runtime_epoch))
      );
    case "user_space_index_update":
      return (
        (value.mountId === undefined || validId(value.mountId)) &&
        Number.isSafeInteger(value.fileCount) &&
        Number(value.fileCount) >= 0 &&
        validFiniteTimestamp(value.lastIndexedAt)
      );
    case "onlyoffice_status":
      return validOnlyOfficeStatus(value);
    case "onlyoffice_response":
      return validOnlyOfficeResponse(value);
  }
  return false;
}

export interface BrowserEnvelopeContext {
  protocolVersion: 1;
  contextEpoch: number;
  contextId: string;
}

function unwrapEnvelope(
  value: unknown,
  context: BrowserEnvelopeContext,
): BrowserOutgoingMessage | null {
  if (
    !isRecord(value) ||
    value.protocolVersion !== WS_PROTOCOL_VERSION ||
    !validId(value.eventId) ||
    !validGeneration(value.contextEpoch) ||
    !isRuntimeContextId(value.contextId) ||
    value.contextEpoch !== context.contextEpoch ||
    value.contextId !== context.contextId ||
    typeof value.kind !== "string" ||
    !isOutgoingMessage(value.payload) ||
    value.kind !== value.payload.type
  ) {
    return null;
  }
  return (value as unknown as WsEnvelope<BrowserOutgoingMessage>).payload;
}

export function browserMessageByteLength(raw: string | Buffer): number {
  return typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : raw.byteLength;
}

export function isBrowserMessageWithinLimit(raw: string | Buffer): boolean {
  return browserMessageByteLength(raw) <= BROWSER_WS_MAX_MESSAGE_BYTES;
}

export function isUserMessageContentWithinLimit(content: string): boolean {
  return Buffer.byteLength(content, "utf8") <= USER_MESSAGE_MAX_BYTES;
}

export function parseBrowserMessage(
  raw: string | Buffer,
  context: BrowserEnvelopeContext,
): BrowserOutgoingMessage | null {
  if (!isBrowserMessageWithinLimit(raw)) {
    console.warn("[ws-bridge] Ignored oversized browser event");
    return null;
  }
  try {
    const value = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8")) as unknown;
    const message = unwrapEnvelope(value, context);
    if (!message) console.warn("[ws-bridge] Ignored invalid browser event");
    return message;
  } catch {
    console.warn("[ws-bridge] Ignored malformed browser event");
    return null;
  }
}

function clientMessageId(message: BrowserOutgoingMessage): string | undefined {
  if ("clientMsgId" in message && typeof message.clientMsgId === "string") {
    return message.clientMsgId;
  }
  if ("client_msg_id" in message && typeof message.client_msg_id === "string") {
    return message.client_msg_id;
  }
  return undefined;
}

export function deduplicateBrowserMessage(
  message: BrowserOutgoingMessage,
  idempotentTypes: ReadonlySet<string>,
  session: Session,
  processedIdLimit: number,
  persistFn: (session: Session) => void,
): boolean {
  const id = clientMessageId(message);
  if (!idempotentTypes.has(message.type) || !id) return false;
  if (isDuplicateClientMessage(session, id)) return true;
  rememberClientMessage(session, id, processedIdLimit, persistFn);
  return false;
}
