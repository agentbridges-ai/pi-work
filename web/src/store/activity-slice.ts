import type { StateCreator } from "zustand";
import type { BrowserIncomingMessage } from "../types.js";
import {
  emptyAgentActivity,
  projectAgentActivity,
  type AgentActivityProjection,
} from "../agent-activity-projector.js";
import type { AppState } from "./index.js";
import { deleteFromMap } from "./utils.js";

export interface ActivitySlice {
  agentActivity: Map<string, AgentActivityProjection>;
  projectAgentActivity: (sessionId: string, event: BrowserIncomingMessage) => void;
  resetAgentActivity: (sessionId: string) => void;
  setAgentActivityConnection: (
    sessionId: string,
    connection: AgentActivityProjection["connection"],
  ) => void;
}

export const createActivitySlice: StateCreator<AppState, [], [], ActivitySlice> = (set) => ({
  agentActivity: new Map(),
  projectAgentActivity: (sessionId, event) =>
    set((state) => {
      const current = state.agentActivity.get(sessionId);
      const projected = projectAgentActivity(current, event);
      if (projected === current) return {};
      const agentActivity = new Map(state.agentActivity);
      agentActivity.set(sessionId, projected);
      return { agentActivity };
    }),
  resetAgentActivity: (sessionId) =>
    set((state) => ({ agentActivity: deleteFromMap(state.agentActivity, sessionId) })),
  setAgentActivityConnection: (sessionId, connection) =>
    set((state) => {
      const agentActivity = new Map(state.agentActivity);
      const current = agentActivity.get(sessionId) ?? emptyAgentActivity();
      if (current.connection === connection) return {};
      agentActivity.set(sessionId, { ...current, connection });
      return { agentActivity };
    }),
});
