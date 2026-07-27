import type { ProviderBootstrap } from "./pi-bootstrap-channel.js";
import type { PiModelCandidate, PiThinkingLevelMap } from "./pi-model-policy.js";
import type { PiModel } from "./pi-rpc-contract.js";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function thinkingLevelMap(value: unknown): PiThinkingLevelMap | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => !THINKING_LEVELS.includes(key as (typeof THINKING_LEVELS)[number]),
    ) ||
    Object.values(record).some((entry) => entry !== null && typeof entry !== "string")
  ) {
    return undefined;
  }
  return { ...record } as PiThinkingLevelMap;
}

export interface ModelNetworkDomainLayer {
  allowedDomains: string[];
  deniedDomains: string[];
}

export interface EffectiveModelNetworkPolicy {
  platformDomains: string[];
  allowedDomains: ReadonlySet<string>;
  deniedDomains: ReadonlySet<string>;
}

export function providerHost(
  provider: string,
  providers: readonly ProviderBootstrap[],
  modelId?: string,
): string | null {
  const configured = providers.find((candidate) => candidate.name === provider);
  const configuredModel = configured?.config.models.find((candidate) => candidate.id === modelId);
  if (configuredModel?.baseUrl) {
    return new URL(configuredModel.baseUrl).hostname;
  }
  if (configured?.config.baseUrl) {
    return new URL(configured.config.baseUrl).hostname;
  }
  const defaults: Record<string, string> = {
    anthropic: "api.anthropic.com",
    google: "generativelanguage.googleapis.com",
    openai: "api.openai.com",
  };
  return defaults[provider.toLowerCase()] ?? null;
}

export function normalizedDomain(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  if (/^https?:\/\//u.test(trimmed)) {
    try {
      return new URL(trimmed).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
  return trimmed.replace(/\.$/u, "").replace(/\/$/u, "");
}

/**
 * Computes the same fail-closed domain intersection used by the SRT policy.
 * Without an explicit platform list, injected provider endpoints are the only
 * defaults; an Agent policy may narrow but never widen those endpoints.
 */
export function resolveEffectiveModelNetworkPolicy(
  providers: readonly ProviderBootstrap[],
  explicitPlatformDomains: readonly string[],
  agentLayer: ModelNetworkDomainLayer | null,
): EffectiveModelNetworkPolicy {
  const providerDefaults = providers
    .flatMap((provider) => [
      providerHost(provider.name, providers),
      ...provider.config.models.map((model) => providerHost(provider.name, providers, model.id)),
    ])
    .filter((host): host is string => host !== null);
  const platformDomains = [
    ...new Set(
      (explicitPlatformDomains.length > 0 ? explicitPlatformDomains : providerDefaults)
        .map(normalizedDomain)
        .filter(Boolean),
    ),
  ];
  let allowedDomains = new Set(platformDomains);
  const deniedDomains = new Set(
    (agentLayer?.deniedDomains ?? []).map(normalizedDomain).filter(Boolean),
  );
  if (agentLayer) {
    const agentAllowed = new Set(agentLayer.allowedDomains.map(normalizedDomain).filter(Boolean));
    allowedDomains = new Set([...allowedDomains].filter((domain) => agentAllowed.has(domain)));
  }
  for (const denied of deniedDomains) allowedDomains.delete(denied);
  return { platformDomains, allowedDomains, deniedDomains };
}

export function piModelCandidateFromRpc(model: PiModel): PiModelCandidate {
  const candidate: PiModelCandidate = {
    key: `${model.provider}/${model.id}`,
    provider: model.provider,
    modelId: model.id,
  };
  if (typeof model.name === "string") candidate.name = model.name;
  if (typeof model.reasoning === "boolean") {
    candidate.reasoning = model.reasoning;
  }
  const levelMap = thinkingLevelMap(model.thinkingLevelMap);
  if (levelMap) candidate.thinkingLevelMap = levelMap;
  if (
    typeof model.contextWindow === "number" &&
    Number.isSafeInteger(model.contextWindow) &&
    model.contextWindow > 0
  ) {
    candidate.contextWindow = model.contextWindow;
  }
  if (
    typeof model.maxTokens === "number" &&
    Number.isSafeInteger(model.maxTokens) &&
    model.maxTokens > 0
  ) {
    candidate.maxTokens = model.maxTokens;
  }
  return candidate;
}
