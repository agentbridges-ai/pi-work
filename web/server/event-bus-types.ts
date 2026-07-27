// Typed event map for the Piwork internal event bus.
// Each key is a namespaced event name; values are the payload passed to handlers.

import type { BrowserIncomingMessage } from "./session-types.js";
import type { SessionPhase } from "./session-state-machine.js";

export interface PiworkEventMap {
  // ── Session lifecycle ──────────────────────────────────────────────

  /** Native Pi confirmed the model currently selected for this session. */
  "session:model-confirmed": { sessionId: string; model: string };

  /** The per-session Pi rpc-entry process exited. */
  "session:exited": { sessionId: string; exitCode: number | null };

  /** Pi RPC disconnected and the runtime needs a generation-safe relaunch. */
  "session:relaunch-needed": {
    sessionId: string;
    reason?: "browser_open" | "queued_message" | "disconnect";
  };

  /** Idle-kill threshold reached with no connected browsers. */
  "session:idle-kill": { sessionId: string };

  /** User prompt became available for auto-naming. Emitted as soon as the bridge receives the prompt. */
  "session:user-prompt-received": {
    sessionId: string;
    firstUserMessage: string;
  };

  /** Session phase changed (formal state machine transition). */
  "session:phase-changed": {
    sessionId: string;
    from: SessionPhase;
    to: SessionPhase;
    trigger: string;
  };

  // ── Per-session messages (high volume) ─────────────────────────────

  /** An assistant message was processed and broadcast to browsers. */
  "message:assistant": {
    sessionId: string;
    message: BrowserIncomingMessage;
  };

  /** A stream event was processed and broadcast to browsers. */
  "message:stream_event": {
    sessionId: string;
    message: BrowserIncomingMessage;
  };

  /** A result (turn completion) was processed and broadcast to browsers. */
  "message:result": { sessionId: string; message: BrowserIncomingMessage };
}
