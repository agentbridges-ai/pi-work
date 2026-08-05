import type { ServerWebSocket } from "bun";
import type {
  BrowserIncomingMessage,
  HistorySnapshotEvent,
} from "../shared/pi-browser-protocol.js";
import type { BrowserSocketData, Session } from "./ws-bridge-types.js";
import type { ReplayableBrowserIncomingMessage } from "../shared/pi-browser-protocol.js";

type Send = (
  socket: ServerWebSocket<BrowserSocketData>,
  message: BrowserIncomingMessage,
) => boolean | void;

export async function handleSessionSubscribe(
  session: Session,
  socket: ServerWebSocket<BrowserSocketData> | undefined,
  lastSeq: number,
  send: Send,
  loadHistory: (reason: HistorySnapshotEvent["reason"]) => Promise<HistorySnapshotEvent>,
  isHistoryBackedEvent: (message: ReplayableBrowserIncomingMessage) => boolean,
): Promise<void> {
  if (!socket || !session.browserSockets.has(socket)) return;
  const normalized = Math.max(0, Math.floor(lastSeq));
  const latest = Math.max(0, session.nextEventSeq - 1);
  const cursorAhead = normalized > latest;
  const replayFrom = cursorAhead ? 0 : normalized;
  socket.data.subscribed = true;
  socket.data.lastAckSeq = replayFrom;

  const sendHistory = async (reason: HistorySnapshotEvent["reason"]) => {
    try {
      send(socket, await loadHistory(reason));
    } catch {
      send(socket, {
        type: "error",
        code: "pi_history_unavailable",
        message: "Pi session history is unavailable.",
        retryable: true,
      });
    }
  };

  const sentHistory = replayFrom === 0;
  if (sentHistory) {
    await sendHistory(cursorAhead ? "recovery" : "initial");
  }

  if (session.eventBuffer.length === 0) {
    if (replayFrom > 0) await sendHistory("recovery");
    send(socket, {
      type: "run_state",
      state: session.state.runState,
      generation: session.state.generation,
      timestamp: Date.now(),
      usage: session.state.usage,
    });
    return;
  }

  const earliest = session.eventBuffer[0]?.seq ?? session.nextEventSeq;
  const hasGap = replayFrom > 0 && replayFrom < earliest - 1;
  if (hasGap) await sendHistory("gap");

  const missed = session.eventBuffer.filter(
    (event) =>
      event.seq > replayFrom && (!(hasGap || sentHistory) || !isHistoryBackedEvent(event.message)),
  );
  if (missed.length > 0) {
    send(socket, { type: "event_replay", events: missed });
  }
  send(socket, {
    type: "run_state",
    state: session.state.runState,
    generation: session.state.generation,
    timestamp: Date.now(),
    usage: session.state.usage,
  });
}

export function handleSessionAck(
  session: Session,
  socket: ServerWebSocket<BrowserSocketData> | undefined,
  lastSeq: number,
): void {
  const normalized = Math.max(0, Math.floor(lastSeq));
  if (socket && session.browserSockets.has(socket)) {
    socket.data.lastAckSeq = Math.max(socket.data.lastAckSeq ?? 0, normalized);
  }
  session.lastAckSeq = Math.max(session.lastAckSeq, normalized);
}
