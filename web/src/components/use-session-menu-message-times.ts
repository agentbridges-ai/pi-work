import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useStore, type AppState } from "../store.js";
import type { PiSessionInfo } from "../types.js";
import { getLastMessageTime } from "./chat-view-session-utils.js";

const EMPTY_SESSION_MESSAGE_TIMES: Readonly<Record<string, number>> = Object.freeze({});

/** Subscribes to the stable timestamp projection used by the session menu. */
export function useSessionMenuMessageTimes(
  sessions: PiSessionInfo[],
  enabled: boolean,
): Readonly<Record<string, number>> {
  const selectMessageTimes = useCallback(
    (state: AppState): Readonly<Record<string, number>> => {
      if (!enabled || sessions.length === 0) return EMPTY_SESSION_MESSAGE_TIMES;
      const times: Record<string, number> = {};
      for (const session of sessions) {
        times[session.sessionId] = getLastMessageTime(
          state.messages.get(session.sessionId),
          session,
        );
      }
      return times;
    },
    [enabled, sessions],
  );
  return useStore(useShallow(selectMessageTimes));
}
