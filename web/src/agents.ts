export type AgentId = string;

export interface Agent {
  id: AgentId;
  name: string;
  role: string;
  tone: string;
}

export const DEFAULT_AGENT_ID: AgentId = "agent";

export const AGENTS: Agent[] = [
  {
    id: "agent",
    name: "默认 Agent",
    role: "个人可配置的通用 Agent",
    tone: "通用",
  },
];

const agentIds = new Set(AGENTS.map((agent) => agent.id));
const agentDisplayNames = new Set(AGENTS.map((agent) => agent.name));

export function isAgentId(value: string | null | undefined): value is AgentId {
  return !!value && agentIds.has(value as AgentId);
}

export function getAgent(id: string | null | undefined): Agent {
  return AGENTS.find((agent) => agent.id === id) ?? AGENTS[0];
}

export function getAgentDisplayName(id: string | null | undefined): string {
  return getAgent(id).name;
}

export function isAgentDisplayName(value: string | null | undefined): boolean {
  return !!value?.trim() && agentDisplayNames.has(value.trim());
}

export function getAgentIdForSession(
  agentSessionIds: Record<string, string>,
  sessionId: string | null | undefined,
  fallback: AgentId,
): AgentId {
  if (sessionId) {
    for (const agent of AGENTS) {
      if (agentSessionIds[agent.id] === sessionId) return agent.id;
    }
  }
  return fallback;
}
