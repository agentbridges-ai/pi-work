import { closeSync, fstatSync, readSync } from "node:fs";
import {
  isProviderModelBootstrap,
  type ProviderBootstrap,
  type ProviderModelBootstrap,
} from "./pi-bootstrap-channel.js";
import type { PiModelCandidate } from "./pi-model-policy.js";

const MAX_BOOTSTRAP_BYTES = 4 * 1024 * 1024;
const PROVIDER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

interface ProviderBootstrapDocument {
  version: 1;
  providers: ProviderBootstrap[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmpty(value: unknown, max = 1_000_000): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0")
  );
}

function stringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, item]) => nonEmpty(key, 256) && typeof item === "string" && !item.includes("\0"),
    )
  );
}

function normalizeModel(value: unknown): ProviderModelBootstrap {
  if (!isProviderModelBootstrap(value)) {
    throw new Error("Pi provider model is invalid");
  }
  const model = value;
  return {
    id: model.id,
    name: model.name,
    ...(model.api !== undefined ? { api: model.api } : {}),
    ...(model.baseUrl !== undefined ? { baseUrl: model.baseUrl } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.thinkingLevelMap !== undefined
      ? { thinkingLevelMap: { ...model.thinkingLevelMap } }
      : {}),
    ...(model.input !== undefined ? { input: [...model.input] } : {}),
    ...(model.cost !== undefined ? { cost: structuredClone(model.cost) } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
    ...(model.headers !== undefined ? { headers: { ...model.headers } } : {}),
    ...(model.compat !== undefined ? { compat: structuredClone(model.compat) } : {}),
  };
}

function normalizeProvider(value: unknown): ProviderBootstrap {
  const input = record(value);
  const config = record(input.config);
  if (
    !nonEmpty(input.name, 128) ||
    !PROVIDER_NAME.test(input.name) ||
    !nonEmpty(config.apiKey) ||
    !nonEmpty(config.api, 128) ||
    !Array.isArray(config.models) ||
    (config.name !== undefined && !nonEmpty(config.name, 256)) ||
    (config.baseUrl !== undefined && !nonEmpty(config.baseUrl, 4_096)) ||
    (config.headers !== undefined && !stringRecord(config.headers)) ||
    (config.authHeader !== undefined && typeof config.authHeader !== "boolean")
  ) {
    throw new Error("Pi provider bootstrap is invalid");
  }
  if (config.baseUrl !== undefined) {
    const url = new URL(config.baseUrl);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    ) {
      throw new Error("Pi provider base URL is invalid");
    }
  }
  const models = config.models.map(normalizeModel);
  if (models.some((model) => model.api !== undefined && model.api !== config.api)) {
    throw new Error("Pi provider model API overrides are not supported");
  }
  return {
    name: input.name,
    config: {
      ...(typeof config.name === "string" ? { name: config.name } : {}),
      ...(typeof config.baseUrl === "string" ? { baseUrl: config.baseUrl } : {}),
      apiKey: config.apiKey,
      api: config.api,
      ...(config.headers ? { headers: { ...config.headers } } : {}),
      ...(typeof config.authHeader === "boolean" ? { authHeader: config.authHeader } : {}),
      models,
    },
  };
}

function normalizeDocument(value: unknown): ProviderBootstrapDocument {
  const document = record(value);
  if (
    document.version !== 1 ||
    !Array.isArray(document.providers) ||
    Object.keys(document).some((key) => key !== "version" && key !== "providers")
  ) {
    throw new Error("Pi provider bootstrap document is invalid");
  }
  const providers = document.providers.map(normalizeProvider);
  if (new Set(providers.map((provider) => provider.name)).size !== providers.length) {
    throw new Error("Pi provider bootstrap contains duplicate providers");
  }
  return { version: 1, providers };
}

function readBoundedFd(fd: number): Buffer {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BOOTSTRAP_BYTES) {
    throw new Error("Pi provider bootstrap descriptor is not a bounded regular file");
  }
  const bytes = Buffer.allocUnsafe(stat.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (count === 0) throw new Error("Pi provider bootstrap descriptor ended early");
    offset += count;
  }
  return bytes;
}

/**
 * Reads provider credentials exactly once from an inherited descriptor. The
 * environment carries only the descriptor number; credential bytes are never
 * copied into process/child environment, argv, logs, or session files.
 */
export function loadPiProviderBootstrapFromInheritedFd(
  source: NodeJS.ProcessEnv = process.env,
): ProviderBootstrap[] {
  const rawFd = source.PIWORK_PI_PROVIDER_BOOTSTRAP_FD;
  if (!rawFd) return [];
  if (!/^(?:[3-9]|[1-9]\d{1,5})$/u.test(rawFd)) {
    throw new Error("PIWORK_PI_PROVIDER_BOOTSTRAP_FD is invalid");
  }
  const fd = Number(rawFd);
  let bytes: Buffer | undefined;
  try {
    bytes = readBoundedFd(fd);
    const document = normalizeDocument(JSON.parse(bytes.toString("utf8")));
    if (document.providers.length === 0) {
      throw new Error("Pi provider bootstrap must contain at least one provider");
    }
    return document.providers;
  } finally {
    bytes?.fill(0);
    try {
      closeSync(fd);
    } catch {}
    delete source.PIWORK_PI_PROVIDER_BOOTSTRAP_FD;
  }
}

export class PiProviderVault {
  private readonly providers: ProviderBootstrap[];

  constructor(providers: readonly ProviderBootstrap[]) {
    this.providers = normalizeDocument({
      version: 1,
      providers: structuredClone(providers),
    }).providers;
  }

  snapshot(): ProviderBootstrap[] {
    return structuredClone(this.providers);
  }

  credentialProviders(): ReadonlySet<string> {
    return new Set(this.providers.map((provider) => provider.name));
  }

  modelCandidates(): PiModelCandidate[] {
    return this.providers.flatMap((provider) =>
      provider.config.models.flatMap((raw) => {
        const model = record(raw);
        if (!nonEmpty(model.id, 512)) return [];
        const key = `${provider.name}/${model.id}`;
        return [
          {
            key,
            provider: provider.name,
            modelId: model.id,
            ...(typeof model.name === "string" ? { name: model.name } : {}),
            ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
            ...(model.thinkingLevelMap !== undefined
              ? { thinkingLevelMap: { ...model.thinkingLevelMap } }
              : {}),
            ...(typeof model.contextWindow === "number"
              ? { contextWindow: model.contextWindow }
              : {}),
            ...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
          },
        ];
      }),
    );
  }
}
