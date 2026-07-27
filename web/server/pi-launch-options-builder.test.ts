import { describe, expect, it } from "vitest";
import type { ProviderBootstrap } from "./pi-bootstrap-channel.js";
import { piModelCandidateFromRpc, resolveEffectiveModelNetworkPolicy } from "./pi-launch-policy.js";

function provider(name: string, baseUrl?: string): ProviderBootstrap {
  return {
    name,
    config: {
      apiKey: "test-only",
      api: "openai-completions",
      models: [],
      ...(baseUrl ? { baseUrl } : {}),
    },
  };
}

describe("Pi launch policy helpers", () => {
  it("defaults the platform network boundary to injected provider endpoints", () => {
    const policy = resolveEffectiveModelNetworkPolicy(
      [provider("openai"), provider("private", "https://models.example.com/v1")],
      [],
      null,
    );

    expect(policy.platformDomains).toEqual(["api.openai.com", "models.example.com"]);
    expect([...policy.allowedDomains]).toEqual(policy.platformDomains);
  });

  it("intersects platform and Agent domains and applies explicit denies", () => {
    const policy = resolveEffectiveModelNetworkPolicy(
      [provider("openai")],
      ["api.openai.com", "mcp.example.com"],
      {
        allowedDomains: ["API.OPENAI.COM", "agent-only.example.com"],
        deniedDomains: ["api.openai.com"],
      },
    );

    expect([...policy.allowedDomains]).toEqual([]);
    expect([...policy.deniedDomains]).toEqual(["api.openai.com"]);
    expect(policy.platformDomains).not.toContain("agent-only.example.com");
  });

  it("copies only well-typed Pi model metadata from the RPC boundary", () => {
    expect(
      piModelCandidateFromRpc({
        provider: "openai",
        id: "gpt-5",
        name: "GPT-5",
        reasoning: true,
        thinkingLevelMap: {
          minimal: null,
          high: "high",
          max: "max",
        },
        contextWindow: 400_000,
        maxTokens: 128_000,
      }),
    ).toEqual({
      key: "openai/gpt-5",
      provider: "openai",
      modelId: "gpt-5",
      name: "GPT-5",
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        high: "high",
        max: "max",
      },
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
    expect(
      piModelCandidateFromRpc({
        provider: "openai",
        id: "gpt-5-mini",
        reasoning: "yes",
        thinkingLevelMap: { impossible: "max" },
        contextWindow: Number.NaN,
        maxTokens: -1,
      }),
    ).toEqual({
      key: "openai/gpt-5-mini",
      provider: "openai",
      modelId: "gpt-5-mini",
    });
  });
});
