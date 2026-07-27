import type { ServerWebSocket } from "bun";
import type { BrowserIncomingMessage } from "../shared/pi-browser-protocol.js";
import {
  isRuntimeContextId,
  WS_PROTOCOL_VERSION,
  type WsEnvelope,
} from "../shared/api-contracts.js";
import type { RecorderManager } from "./recorder.js";
import { EVENT_BUFFER_LIMIT, EVENT_BUFFER_MAX_BYTES } from "./session-message-buffers.js";
import type { BrowserSocketData, Session } from "./ws-bridge-types.js";
import { sequenceEvent } from "./ws-bridge-replay.js";

export { EVENT_BUFFER_LIMIT, EVENT_BUFFER_MAX_BYTES };

function serializeForBrowser(
  socket: ServerWebSocket<BrowserSocketData>,
  message: BrowserIncomingMessage,
  eventId: string,
): string {
  const data = socket.data;
  if (
    data.kind !== "browser" ||
    data.protocolVersion !== WS_PROTOCOL_VERSION ||
    !Number.isSafeInteger(data.contextEpoch) ||
    data.contextEpoch < 0 ||
    !isRuntimeContextId(data.contextId)
  ) {
    throw new Error("Browser socket is missing its runtime context envelope");
  }
  const envelope: WsEnvelope<BrowserIncomingMessage> = {
    protocolVersion: WS_PROTOCOL_VERSION,
    contextEpoch: data.contextEpoch,
    contextId: data.contextId,
    eventId,
    kind: message.type,
    payload: message,
  };
  return JSON.stringify(envelope);
}

function safeSend(
  socket: ServerWebSocket<BrowserSocketData>,
  message: BrowserIncomingMessage,
  eventId: string,
): boolean {
  try {
    socket.send(serializeForBrowser(socket, message, eventId));
    return true;
  } catch {
    return false;
  }
}

export function broadcastToBrowsers(
  session: Session,
  message: BrowserIncomingMessage,
  options: {
    eventBufferLimit?: number;
    eventBufferMaxBytes?: number;
    recorder: RecorderManager | null;
  },
): BrowserIncomingMessage {
  const sequenced = sequenceEvent(
    session,
    message,
    options.eventBufferLimit ?? EVENT_BUFFER_LIMIT,
    options.eventBufferMaxBytes ?? EVENT_BUFFER_MAX_BYTES,
  );
  options.recorder?.record(
    session.id,
    "out",
    JSON.stringify(sequenced),
    "browser",
    "pi",
    session.state.cwd,
  );
  for (const socket of [...session.browserSockets]) {
    if (!safeSend(socket, sequenced, `server-${session.id}-${sequenced.seq ?? 0}`)) {
      session.browserSockets.delete(socket);
    }
  }
  return sequenced;
}

/** Send a point-to-point control/snapshot response without consuming a seq. */
export function sendToBrowser(
  socket: ServerWebSocket<BrowserSocketData>,
  message: BrowserIncomingMessage,
): boolean {
  const suffix =
    typeof message.seq === "number"
      ? String(message.seq)
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return safeSend(socket, message, `server-${socket.data.sessionId}-${suffix}`);
}
