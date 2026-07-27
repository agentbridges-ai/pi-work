import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPiProviderBootstrapFromInheritedFd, PiProviderVault } from "./pi-provider-vault.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function provider(apiKey = "secret-model-key") {
  return {
    name: "managed",
    config: {
      apiKey,
      api: "openai-completions",
      baseUrl: "https://models.example.test/v1",
      models: [
        {
          id: "reasoner",
          name: "Reasoner",
          reasoning: true,
          thinkingLevelMap: {
            minimal: null,
            low: null,
            medium: null,
            high: "high",
            xhigh: null,
            max: "max",
          },
          contextWindow: 128_000,
          maxTokens: 16_384,
        },
      ],
    },
  };
}

describe("PiProviderVault", () => {
  it("consumes an inherited descriptor and removes its environment binding", () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-provider-vault-"));
    roots.push(root);
    const path = join(root, "bootstrap.json");
    writeFileSync(path, JSON.stringify({ version: 1, providers: [provider()] }), {
      mode: 0o600,
    });
    const fd = openSync(path, "r");
    const source: NodeJS.ProcessEnv = {
      PIWORK_PI_PROVIDER_BOOTSTRAP_FD: String(fd),
    };

    const providers = loadPiProviderBootstrapFromInheritedFd(source);

    expect(source).not.toHaveProperty("PIWORK_PI_PROVIDER_BOOTSTRAP_FD");
    expect(providers).toEqual([provider()]);
    expect(() => closeSync(fd)).toThrow();
  });

  it("exposes credential-blind model candidates and defensive snapshots", () => {
    const vault = new PiProviderVault([provider()]);
    const snapshot = vault.snapshot();
    snapshot[0]!.config.apiKey = "mutated";

    expect(vault.snapshot()[0]!.config.apiKey).toBe("secret-model-key");
    expect(vault.modelCandidates()).toEqual([
      {
        key: "managed/reasoner",
        provider: "managed",
        modelId: "reasoner",
        name: "Reasoner",
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          low: null,
          medium: null,
          high: "high",
          xhigh: null,
          max: "max",
        },
        contextWindow: 128_000,
        maxTokens: 16_384,
      },
    ]);
    expect(JSON.stringify(vault.modelCandidates())).not.toContain("secret-model-key");
  });

  it("rejects unknown model fields instead of forwarding them through get_available_models", () => {
    const injected = provider() as ReturnType<typeof provider> & {
      config: ReturnType<typeof provider>["config"] & {
        models: Array<
          ReturnType<typeof provider>["config"]["models"][number] & {
            credentialCanary?: string;
          }
        >;
      };
    };
    injected.config.models[0]!.credentialCanary = "must-never-reach-pi-rpc";

    expect(() => new PiProviderVault([injected])).toThrow(/model is invalid/u);
  });

  it("keeps model headers memory-only while exposing credential-blind candidates", () => {
    const configured = provider();
    configured.config.models[0] = {
      ...configured.config.models[0]!,
      headers: { "X-Model-Key": "!nested-$MODEL_SECRET" },
    } as (typeof configured.config.models)[number];
    const vault = new PiProviderVault([configured]);

    expect(JSON.stringify(vault.modelCandidates())).not.toContain("nested-$MODEL_SECRET");
    expect(vault.snapshot()[0]!.config.models[0]!.headers).toEqual({
      "X-Model-Key": "!nested-$MODEL_SECRET",
    });
  });

  it("rejects provider and model URL query credentials before Pi RPC can expose them", () => {
    const topLevel = provider();
    topLevel.config.baseUrl = "https://models.example.test/v1?api_key=top-secret";
    expect(() => new PiProviderVault([topLevel])).toThrow(/base URL is invalid/u);

    const nested = provider();
    nested.config.models[0] = {
      ...nested.config.models[0]!,
      baseUrl: "https://other.example.test/v1?token=nested-secret",
    } as (typeof nested.config.models)[number];
    expect(() => new PiProviderVault([nested])).toThrow(/model is invalid/u);
  });
});
