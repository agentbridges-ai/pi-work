import type { AgentDraftConfig, AgentModelPolicySnapshot } from "./control-plane-types.js";
import { matchesPiModelGlob, validatePiModelGlob, validatePiModelRef } from "./pi-model-policy.js";
import { PI_THINKING_LEVELS } from "./pi-rpc-contract.js";

const DEFAULT_MODEL_ALLOWLIST = ["*/*"] as const;
const DEFAULT_THINKING_LEVEL = "medium" as const;
const AGENT_DRAFT_KEYS = new Set([
  "instructions",
  "knowledgeRootIds",
  "skillPackageIds",
  "mcpConnectionIds",
  "networkPolicyId",
  "modelAllowlist",
  "defaultModel",
  "defaultThinkingLevel",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizedStringList(
  input: Record<string, unknown>,
  key: string,
  fallback: readonly string[] = [],
): string[] {
  const value = input[key];
  if (value === undefined) return [...fallback];
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error(`Agent draft ${key} must be an array with at most 256 entries.`);
  }
  const output: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      throw new Error(`Agent draft ${key} entries must be strings.`);
    }
    const normalized = item.trim();
    if (!normalized || normalized.length > 512 || normalized.includes("\0")) {
      throw new Error(`Agent draft ${key} contains an invalid entry.`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      output.push(normalized);
    }
  }
  return output;
}

export function normalizeAgentDraftConfig(value: unknown): AgentDraftConfig {
  const input = record(value);
  if (!input) throw new Error("Agent draft must be an object.");
  const unsupported = Object.keys(input).filter((key) => !AGENT_DRAFT_KEYS.has(key));
  if (unsupported.length) {
    throw new Error(`Agent draft contains unsupported fields: ${unsupported.sort().join(", ")}.`);
  }
  if (input.instructions !== undefined && typeof input.instructions !== "string") {
    throw new Error("Agent draft instructions must be a string.");
  }
  if (
    input.networkPolicyId !== undefined &&
    (typeof input.networkPolicyId !== "string" ||
      !input.networkPolicyId.trim() ||
      input.networkPolicyId.includes("\0"))
  ) {
    throw new Error("Agent draft networkPolicyId must be a non-empty string.");
  }
  const modelAllowlist = normalizedStringList(input, "modelAllowlist", DEFAULT_MODEL_ALLOWLIST);
  modelAllowlist.forEach(validatePiModelGlob);
  const defaultThinkingLevel =
    input.defaultThinkingLevel === undefined ? DEFAULT_THINKING_LEVEL : input.defaultThinkingLevel;
  if (
    typeof defaultThinkingLevel !== "string" ||
    !(PI_THINKING_LEVELS as readonly string[]).includes(defaultThinkingLevel)
  ) {
    throw new Error("Agent draft defaultThinkingLevel is invalid.");
  }
  const normalizedThinkingLevel = defaultThinkingLevel as AgentDraftConfig["defaultThinkingLevel"];
  const defaultModelValue = input.defaultModel;
  let defaultModel: AgentDraftConfig["defaultModel"];
  if (defaultModelValue !== undefined) {
    const candidate = record(defaultModelValue);
    if (!candidate) throw new Error("Agent draft defaultModel must be an object.");
    const candidateKeys = Object.keys(candidate);
    if (
      candidateKeys.length !== 3 ||
      !candidateKeys.every((key) => key === "key" || key === "provider" || key === "modelId") ||
      typeof candidate.key !== "string" ||
      typeof candidate.provider !== "string" ||
      typeof candidate.modelId !== "string"
    ) {
      throw new Error("Agent draft defaultModel contains unsupported fields.");
    }
    defaultModel = {
      key: candidate.key,
      provider: candidate.provider,
      modelId: candidate.modelId,
    };
    validatePiModelRef(defaultModel);
    if (!modelAllowlist.some((pattern) => matchesPiModelGlob(defaultModel!, pattern))) {
      throw new Error("Agent draft defaultModel is outside modelAllowlist.");
    }
  }
  return {
    ...(typeof input.instructions === "string" ? { instructions: input.instructions } : {}),
    knowledgeRootIds: normalizedStringList(input, "knowledgeRootIds"),
    skillPackageIds: normalizedStringList(input, "skillPackageIds"),
    mcpConnectionIds: normalizedStringList(input, "mcpConnectionIds"),
    ...(typeof input.networkPolicyId === "string"
      ? { networkPolicyId: input.networkPolicyId.trim() }
      : {}),
    modelAllowlist,
    ...(defaultModel ? { defaultModel } : {}),
    defaultThinkingLevel: normalizedThinkingLevel,
  };
}

export function modelPolicyFromDraft(config: AgentDraftConfig): AgentModelPolicySnapshot {
  return {
    modelAllowlist: [...config.modelAllowlist],
    ...(config.defaultModel ? { defaultModel: { ...config.defaultModel } } : {}),
    defaultThinkingLevel: config.defaultThinkingLevel,
  };
}
