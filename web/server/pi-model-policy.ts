import { PI_THINKING_LEVELS, type PiThinkingLevel } from "./pi-rpc-contract.js";
import type { PiModelRef } from "../shared/pi-browser-protocol.js";

export type { PiModelRef } from "../shared/pi-browser-protocol.js";

export type PiThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;

export interface PiModelCandidate extends PiModelRef {
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: PiThinkingLevelMap;
  contextWindow?: number;
  maxTokens?: number;
}

export interface PiAgentModelPolicy {
  /** `provider/model` globs. An empty list denies every model. */
  modelAllowlist: string[];
  defaultModel?: PiModelRef;
  defaultThinkingLevel: PiThinkingLevel;
}

export interface ResolvePiModelPolicyOptions {
  candidates: readonly PiModelCandidate[];
  platformAllowlist: readonly string[];
  agentPolicy: PiAgentModelPolicy;
  hasCredential:
    ReadonlySet<string> | ((model: Readonly<PiModelCandidate>) => boolean | Promise<boolean>);
  networkAllows(model: Readonly<PiModelCandidate>): boolean | Promise<boolean>;
}

export interface ResolvedPiModelPolicy {
  models: PiModelCandidate[];
  defaultModel?: PiModelRef;
  defaultThinkingLevel: PiThinkingLevel;
}

export class PiModelPolicyError extends Error {
  readonly code: "invalid_policy" | "invalid_model";

  constructor(code: PiModelPolicyError["code"], message: string) {
    super(message);
    this.name = "PiModelPolicyError";
    this.code = code;
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function canonicalKey(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

export function validatePiModelRef(model: PiModelRef): void {
  if (
    typeof model !== "object" ||
    model === null ||
    !nonEmpty(model.provider) ||
    /[\s\u0000-\u001F\u007F]/u.test(model.provider) ||
    model.provider !== model.provider.trim() ||
    model.provider.includes("/") ||
    !nonEmpty(model.modelId) ||
    /[\s\u0000-\u001F\u007F]/u.test(model.modelId) ||
    model.modelId !== model.modelId.trim() ||
    model.modelId.startsWith("/") ||
    model.modelId.endsWith("/") ||
    !nonEmpty(model.key) ||
    /[\s\u0000-\u001F\u007F]/u.test(model.key) ||
    model.key !== model.key.trim() ||
    model.key !== canonicalKey(model.provider, model.modelId)
  ) {
    throw new PiModelPolicyError(
      "invalid_model",
      "Pi model reference must use its canonical provider/model key.",
    );
  }
}

export function validatePiModelGlob(pattern: string): void {
  const separator = pattern.indexOf("/");
  if (
    !nonEmpty(pattern) ||
    separator < 1 ||
    separator === pattern.length - 1 ||
    /[\s\u0000-\u001F\u007F[\]{}()\\]/u.test(pattern)
  ) {
    throw new PiModelPolicyError(
      "invalid_policy",
      "Pi model allowlist contains an invalid provider/model glob.",
    );
  }
}

function globRegex(pattern: string): RegExp {
  validatePiModelGlob(pattern);
  const separator = pattern.indexOf("/");
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    const inProvider = index < separator;
    if (character === "*") source += inProvider ? "[^/]*" : ".*";
    else if (character === "?") source += inProvider ? "[^/]" : ".";
    else source += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  source += "$";
  return new RegExp(source, "u");
}

export function matchesPiModelGlob(model: PiModelRef, pattern: string): boolean {
  return globRegex(pattern).test(canonicalKey(model.provider, model.modelId));
}

function allowedBy(model: PiModelCandidate, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchesPiModelGlob(model, pattern));
}

async function credentialAllows(
  credential:
    ReadonlySet<string> | ((model: Readonly<PiModelCandidate>) => boolean | Promise<boolean>),
  model: PiModelCandidate,
): Promise<boolean> {
  if (typeof credential === "function") return credential(model);
  return (
    credential.has(model.provider) ||
    credential.has(model.key) ||
    credential.has(canonicalKey(model.provider, "*"))
  );
}

function sameModel(left: PiModelRef, right: PiModelRef): boolean {
  return (
    left.key === right.key && left.provider === right.provider && left.modelId === right.modelId
  );
}

export async function resolvePiModelPolicy(
  options: ResolvePiModelPolicyOptions,
): Promise<ResolvedPiModelPolicy> {
  if (
    !Array.isArray(options.platformAllowlist) ||
    !Array.isArray(options.agentPolicy.modelAllowlist) ||
    !PI_THINKING_LEVELS.includes(options.agentPolicy.defaultThinkingLevel)
  ) {
    throw new PiModelPolicyError("invalid_policy", "Pi model policy is invalid.");
  }
  options.platformAllowlist.forEach(validatePiModelGlob);
  options.agentPolicy.modelAllowlist.forEach(validatePiModelGlob);
  const seen = new Set<string>();
  const models: PiModelCandidate[] = [];
  for (const candidate of options.candidates) {
    validatePiModelRef(candidate);
    if (seen.has(candidate.key)) {
      throw new PiModelPolicyError(
        "invalid_model",
        "Pi model probe returned a duplicate model key.",
      );
    }
    seen.add(candidate.key);
    if (
      !allowedBy(candidate, options.platformAllowlist) ||
      !allowedBy(candidate, options.agentPolicy.modelAllowlist) ||
      !(await credentialAllows(options.hasCredential, candidate)) ||
      !(await options.networkAllows(candidate))
    ) {
      continue;
    }
    models.push({ ...candidate });
  }
  models.sort((left, right) => left.key.localeCompare(right.key));
  const configuredDefault = options.agentPolicy.defaultModel;
  if (configuredDefault) {
    validatePiModelRef(configuredDefault);
    if (!models.some((model) => sameModel(model, configuredDefault))) {
      throw new PiModelPolicyError(
        "invalid_policy",
        "Configured default Pi model is not effective under current policy.",
      );
    }
  }
  return {
    models,
    ...(configuredDefault ? { defaultModel: { ...configuredDefault } } : {}),
    defaultThinkingLevel: options.agentPolicy.defaultThinkingLevel,
  };
}

export interface PiModelProbeCacheOptions {
  ttlMs?: number;
  probe(agentId: string, signal?: AbortSignal): Promise<PiModelCandidate[]>;
}

interface CachedProbe {
  expiresAt: number;
  models: PiModelCandidate[];
}

/**
 * Short-lived cache around a caller-supplied controlled Pi RPC probe. The
 * callback owns SRT/bootstrap lifecycle; this class never receives credentials.
 */
export class PiModelProbeCache {
  readonly ttlMs: number;
  private readonly probe: PiModelProbeCacheOptions["probe"];
  private readonly cache = new Map<string, CachedProbe>();
  private readonly pending = new Map<string, Promise<PiModelCandidate[]>>();

  constructor(options: PiModelProbeCacheOptions) {
    this.ttlMs = options.ttlMs ?? 15_000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1 || this.ttlMs > 60_000) {
      throw new PiModelPolicyError(
        "invalid_policy",
        "Pi model probe TTL must be between 1 ms and 60 seconds.",
      );
    }
    this.probe = options.probe;
  }

  async get(agentId: string, signal?: AbortSignal): Promise<PiModelCandidate[]> {
    if (!nonEmpty(agentId)) {
      throw new PiModelPolicyError("invalid_policy", "Agent id is required.");
    }
    const cached = this.cache.get(agentId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.models.map((model) => ({ ...model }));
    }
    const existing = this.pending.get(agentId);
    if (existing) return (await existing).map((model) => ({ ...model }));
    const pending = (async () => {
      const models = await this.probe(agentId, signal);
      const seen = new Set<string>();
      for (const model of models) {
        validatePiModelRef(model);
        if (seen.has(model.key)) {
          throw new PiModelPolicyError("invalid_model", "Pi model probe returned duplicate keys.");
        }
        seen.add(model.key);
      }
      const safe = models.map((model) => ({ ...model }));
      this.cache.set(agentId, {
        expiresAt: Date.now() + this.ttlMs,
        models: safe,
      });
      return safe;
    })().finally(() => this.pending.delete(agentId));
    this.pending.set(agentId, pending);
    return (await pending).map((model) => ({ ...model }));
  }

  invalidate(agentId?: string): void {
    if (agentId === undefined) this.cache.clear();
    else this.cache.delete(agentId);
  }
}
