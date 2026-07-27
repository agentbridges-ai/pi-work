import type {
  BrowserIncomingMessage,
  ReplayableBrowserIncomingMessage,
} from "../shared/pi-browser-protocol.js";
import { EVENT_BUFFER_MAX_BYTES, replayEventBuffer } from "./session-message-buffers.js";
import type { Session } from "./ws-bridge-types.js";

export function isDuplicateClientMessage(session: Session, clientMsgId: string): boolean {
  return session.processedClientMessageIdSet.has(clientMsgId);
}

export function rememberClientMessage(
  session: Session,
  clientMsgId: string,
  processedClientMsgIdLimit: number,
  persistSession: (session: Session) => void,
): void {
  session.processedClientMessageIds.push(clientMsgId);
  session.processedClientMessageIdSet.add(clientMsgId);
  if (session.processedClientMessageIds.length > processedClientMsgIdLimit) {
    const overflow = session.processedClientMessageIds.length - processedClientMsgIdLimit;
    const removed = session.processedClientMessageIds.splice(0, overflow);
    for (const id of removed) session.processedClientMessageIdSet.delete(id);
  }
  persistSession(session);
}

export function shouldBufferForReplay(
  message: BrowserIncomingMessage,
): message is ReplayableBrowserIncomingMessage {
  return (
    message.type !== "session_init" &&
    message.type !== "history_snapshot" &&
    message.type !== "event_replay"
  );
}

/**
 * Agent messages are recoverable from the exact Pi JSONL. All other events are
 * ephemeral product/runtime state and are replayed from the bounded memory
 * buffer when available.
 */
export function isHistoryBackedEvent(message: ReplayableBrowserIncomingMessage): boolean {
  return message.type === "agent_message";
}

export function sequenceEvent(
  session: Session,
  message: BrowserIncomingMessage,
  eventBufferLimit: number,
  eventBufferMaxBytes: number = EVENT_BUFFER_MAX_BYTES,
): BrowserIncomingMessage {
  const seq = session.nextEventSeq++;
  const sequenced = { ...message, seq } as BrowserIncomingMessage;
  if (shouldBufferForReplay(message)) {
    const result = replayEventBuffer(session, eventBufferLimit, eventBufferMaxBytes).append({
      seq,
      message,
    });
    if (!result.accepted) {
      console.warn("[ws-bridge] Event exceeds the replay buffer byte budget", {
        sessionId: session.id,
        messageType: message.type,
        eventBufferMaxBytes,
      });
    }
  }
  return sequenced;
}
