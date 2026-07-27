import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelRuntime, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { escapePiConfigLiteral } from "./pi-provider-secrets.js";
import { PiProviderVault } from "./pi-provider-vault.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

describe("Pi provider model exposure", () => {
  it("keeps provider and model-header credentials out of the real available-model payload", async () => {
    const root = mkdtempSync(join(tmpdir(), "piwork-pi-models-"));
    roots.push(root);
    const apiKey = "!api-$KEY-canary";
    const providerHeader = "$PROVIDER_HEADER-canary";
    const modelHeader = "!model-$HEADER-canary";
    const vault = new PiProviderVault([
      {
        name: "managed",
        config: {
          api: "openai-responses",
          apiKey,
          baseUrl: "https://models.example.test/v1",
          headers: { "X-Provider-Key": providerHeader },
          models: [
            {
              id: "model",
              name: "Model",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 100_000,
              maxTokens: 8_192,
              headers: { "X-Model-Key": modelHeader },
            },
          ],
        },
      },
    ]);
    const provider = vault.snapshot()[0]!;
    provider.config.apiKey = escapePiConfigLiteral(provider.config.apiKey);
    for (const [name, value] of Object.entries(provider.config.headers ?? {})) {
      provider.config.headers![name] = escapePiConfigLiteral(value);
    }
    for (const model of provider.config.models) {
      for (const [name, value] of Object.entries(model.headers ?? {})) {
        model.headers![name] = escapePiConfigLiteral(value);
      }
    }
    const runtime = await ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      allowModelNetwork: false,
    });
    runtime.registerProvider(provider.name, provider.config as ProviderConfig);

    const rpcAvailableModels = await runtime.getAvailable(provider.name);
    const frame = JSON.stringify({ type: "response", data: { models: rpcAvailableModels } });
    expect(frame).not.toContain(apiKey);
    expect(frame).not.toContain(providerHeader);
    expect(frame).not.toContain(modelHeader);
    expect(rpcAvailableModels).toHaveLength(1);
    expect(rpcAvailableModels[0]!.headers).toBeUndefined();
  });
});
