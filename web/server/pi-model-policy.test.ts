import { describe, expect, it, vi } from "vitest";
import {
  matchesPiModelGlob,
  PiModelProbeCache,
  resolvePiModelPolicy,
  type PiModelCandidate,
} from "./pi-model-policy.js";

const models: PiModelCandidate[] = [
  { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" },
  { key: "openai/gpt-5-mini", provider: "openai", modelId: "gpt-5-mini" },
  { key: "google/gemini-pro", provider: "google", modelId: "gemini-pro" },
];

describe("Pi model policy", () => {
  it("matches provider/model globs without crossing the provider separator", () => {
    expect(matchesPiModelGlob(models[0]!, "openai/gpt-*")).toBe(true);
    expect(matchesPiModelGlob(models[0]!, "*/gpt-?")).toBe(true);
    expect(matchesPiModelGlob(models[0]!, "open*/gemini-*")).toBe(false);
    expect(
      matchesPiModelGlob(
        {
          key: "openrouter/anthropic/sonnet",
          provider: "openrouter",
          modelId: "anthropic/sonnet",
        },
        "*/*",
      ),
    ).toBe(true);
  });

  it("intersects platform, agent, credential, and network policy", async () => {
    const result = await resolvePiModelPolicy({
      candidates: models,
      platformAllowlist: ["openai/*", "google/*"],
      agentPolicy: {
        modelAllowlist: ["*/gpt-*"],
        defaultModel: models[0],
        defaultThinkingLevel: "high",
      },
      hasCredential: new Set(["openai"]),
      networkAllows: (model) => model.modelId !== "gpt-5-mini",
    });
    expect(result.models).toEqual([models[0]]);
    expect(result.defaultModel).toEqual(models[0]);
    expect(result.defaultThinkingLevel).toBe("high");
  });

  it("rejects a configured default excluded by effective policy", async () => {
    await expect(
      resolvePiModelPolicy({
        candidates: models,
        platformAllowlist: ["openai/*"],
        agentPolicy: {
          modelAllowlist: ["openai/gpt-5-mini"],
          defaultModel: models[0],
          defaultThinkingLevel: "off",
        },
        hasCredential: new Set(["openai"]),
        networkAllows: () => true,
      }),
    ).rejects.toMatchObject({ code: "invalid_policy" });
  });

  it("caches only short-lived model metadata and deduplicates probes", async () => {
    const probe = vi.fn(async () => models);
    const cache = new PiModelProbeCache({ ttlMs: 1_000, probe });
    const [first, second] = await Promise.all([cache.get("agent-1"), cache.get("agent-1")]);
    expect(first).toEqual(models);
    expect(second).toEqual(models);
    expect(probe).toHaveBeenCalledTimes(1);
    first[0]!.modelId = "mutated";
    expect((await cache.get("agent-1"))[0]!.modelId).toBe("gpt-5");
  });
});
