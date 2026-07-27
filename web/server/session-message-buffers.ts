import type { BufferedBrowserEvent } from "../shared/pi-browser-protocol.js";
import { BoundedMessageBuffer } from "./bounded-message-buffer.js";
import type { Session } from "./ws-bridge-types.js";

/** Replay is an in-memory transport convenience; Pi JSONL is durable history. */
export const EVENT_BUFFER_LIMIT = 600;
export const EVENT_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

interface SessionBuffers {
  events?: BoundedMessageBuffer<BufferedBrowserEvent>;
}

const buffersBySession = new WeakMap<Session, SessionBuffers>();

function sessionBuffers(session: Session): SessionBuffers {
  const existing = buffersBySession.get(session);
  if (existing) return existing;
  const created: SessionBuffers = {};
  buffersBySession.set(session, created);
  return created;
}

export function replayEventBuffer(
  session: Session,
  maxItems = EVENT_BUFFER_LIMIT,
  maxBytes = EVENT_BUFFER_MAX_BYTES,
): BoundedMessageBuffer<BufferedBrowserEvent> {
  const buffers = sessionBuffers(session);
  if (
    !buffers.events ||
    buffers.events.items !== session.eventBuffer ||
    buffers.events.limits.maxItems !== maxItems ||
    buffers.events.limits.maxBytes !== maxBytes
  ) {
    buffers.events = new BoundedMessageBuffer(session.eventBuffer, {
      maxItems,
      maxBytes,
    });
  }
  return buffers.events;
}

export function resetSessionMessageBuffers(session: Session): void {
  buffersBySession.delete(session);
}
