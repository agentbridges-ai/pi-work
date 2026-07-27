import type { PiModelRef, ThinkingLevel } from "../shared/pi-browser-protocol.js";
import type { ManagedMcpServerConfig } from "./managed-mcp.js";

export type TenantType = "enterprise" | "team" | "personal";
export type RoleScopeKind = "platform" | "tenant" | "org_subtree";
export type AgentKind = "enterprise_shared" | "team_shared" | "personal_custom" | "general";

export const CONTROL_PLANE_PERMISSIONS = [
  "tenant:manage",
  "member:manage",
  "org:manage",
  "role:manage",
  "agent:create",
  "agent:edit",
  "agent:publish",
  "agent:grant",
  "agent:use",
  "knowledge:manage",
  "skill:manage",
  "mcp:manage",
  "network-policy:manage",
  "runtime:view",
  "runtime:manage",
  "session:view",
  "session:terminate",
  "audit:view",
] as const;
export type ControlPlanePermission = (typeof CONTROL_PLANE_PERMISSIONS)[number];

export interface TenantMembership {
  id: string;
  tenantId: string;
  tenantName: string;
  tenantType: TenantType;
  userId: string;
  status: "invited" | "active" | "suspended" | "removed";
  isDefault: boolean;
}

export interface AgentDraftConfig {
  instructions?: string;
  knowledgeRootIds: string[];
  skillPackageIds: string[];
  mcpConnectionIds: string[];
  networkPolicyId?: string;
  /** Canonical `provider/model` globs intersected with platform policy at launch. */
  modelAllowlist: string[];
  defaultModel?: PiModelRef;
  defaultThinkingLevel: ThinkingLevel;
}

export interface PublishedAgentVersion {
  id: string;
  agentDefinitionId: string;
  version: number;
  config: AgentDraftConfig;
  effectivePolicyHash: string;
  publishedAt: string;
}

export interface AgentModelPolicySnapshot {
  modelAllowlist: string[];
  defaultModel?: PiModelRef;
  defaultThinkingLevel: ThinkingLevel;
}

export interface SessionAuthoritySnapshot {
  tenantId: string;
  userId: string;
  agentDefinitionId: string;
  agentVersionId: string;
  effectivePolicyHash: string;
}

export interface ResolvedSessionLaunch {
  instructions: string;
  knowledgeRelativePaths: string[];
  domainLayer: {
    allowedDomains: string[];
    deniedDomains: string[];
  } | null;
  skillFiles: Array<{
    packageId: string;
    path: string;
    content: string;
  }>;
  modelPolicy: AgentModelPolicySnapshot;
  /** Fully materialized in memory; secret HTTP headers must never be serialized. */
  managedMcpServers: ManagedMcpServerConfig[];
}

export interface ResolvedSessionAuthority {
  authority: SessionAuthoritySnapshot;
  launch: ResolvedSessionLaunch;
}
