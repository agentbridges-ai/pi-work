import type { PersistedSession, SessionStore } from "./session-store.js";
import type { Session } from "./ws-bridge-types.js";

/**
 * Persist only product authority and delivery metadata. Conversation history,
 * runtime state, interactions, replay frames and model state belong to Pi
 * JSONL or live memory and must never be mirrored into session.json.
 */
export function serializeForStore(session: Session): PersistedSession {
  return {
    id: session.id,
    authority: session.authority,
    piSessionRelativePath: session.piSessionRelativePath,
    offlineQueue: session.offlineQueue.map((entry) => ({
      ...entry,
      message: {
        ...entry.message,
        content: entry.message.content.map((part) => ({ ...part })),
      },
    })),
    processedClientMessageIds: [...session.processedClientMessageIds],
    archived: session.archived,
    archivedAt: session.archivedAt,
  };
}

export function persistSession(session: Session, store: SessionStore | null): void {
  if (!store) return;
  store.save(serializeForStore(session));
}
