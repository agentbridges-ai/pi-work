import type { CurrentUser } from "../api.js";
import { DEFAULT_AGENT_ID, AGENTS, type AgentId } from "../agents.js";
import type { UserSpaceMount } from "../types.js";

export interface LoadedUserScopedState {
  currentSessionId: string | null;
  sessionNames: Map<string, string>;
  selectedAgentId: AgentId;
  agentSessionIds: Record<AgentId, string>;
  agentSessionHistoryIds: Record<AgentId, string[]>;
  agentUserSpaces: Record<AgentId, UserSpaceMount[]>;
}

export function rawUserIdFromCurrentUser(
  user: Pick<CurrentUser, "userId" | "uuid"> | null | undefined,
): string {
  return user?.uuid || user?.userId || "";
}

export function userScopeKeyFromCurrentUser(
  user: Pick<CurrentUser, "userId" | "uuid" | "tenantId"> | null | undefined,
): string {
  const userId = rawUserIdFromCurrentUser(user);
  if (!userId) return "";
  return JSON.stringify([userId, user?.tenantId || ""]);
}

export function emptyAgentSessionIds(): Record<AgentId, string> {
  return Object.fromEntries(AGENTS.map((agent) => [agent.id, ""])) as Record<AgentId, string>;
}

export function emptyAgentSessionHistoryIds(): Record<AgentId, string[]> {
  return AGENTS.reduce(
    (acc, agent) => {
      acc[agent.id] = [];
      return acc;
    },
    {} as Record<AgentId, string[]>,
  );
}

export function emptyAgentUserSpaces(): Record<AgentId, UserSpaceMount[]> {
  return AGENTS.reduce(
    (acc, agent) => {
      acc[agent.id] = [];
      return acc;
    },
    {} as Record<AgentId, UserSpaceMount[]>,
  );
}

export function loadUserScopedState(userKey: string | null | undefined): LoadedUserScopedState {
  void userKey;
  return {
    currentSessionId: null,
    sessionNames: new Map(),
    selectedAgentId: DEFAULT_AGENT_ID,
    agentSessionIds: emptyAgentSessionIds(),
    agentSessionHistoryIds: emptyAgentSessionHistoryIds(),
    agentUserSpaces: emptyAgentUserSpaces(),
  };
}
