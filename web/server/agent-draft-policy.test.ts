import { describe, expect, it } from "vitest";
import { normalizeAgentDraftConfig } from "./agent-draft-policy.js";

const emptyResources = {
  knowledgeRootIds: [],
  skillPackageIds: [],
  mcpConnectionIds: [],
};

describe("Agent Pi model policy", () => {
  it("normalizes canonical model policy fields with bounded defaults", () => {
    expect(normalizeAgentDraftConfig(emptyResources)).toEqual({
      ...emptyResources,
      modelAllowlist: ["*/*"],
      defaultThinkingLevel: "medium",
    });

    expect(
      normalizeAgentDraftConfig({
        ...emptyResources,
        knowledgeRootIds: [" knowledge-a ", "knowledge-a"],
        modelAllowlist: [" openai/gpt-* ", "openai/gpt-*"],
        defaultModel: {
          key: "openai/gpt-5",
          provider: "openai",
          modelId: "gpt-5",
        },
        defaultThinkingLevel: "xhigh",
      }),
    ).toEqual({
      ...emptyResources,
      knowledgeRootIds: ["knowledge-a"],
      modelAllowlist: ["openai/gpt-*"],
      defaultModel: {
        key: "openai/gpt-5",
        provider: "openai",
        modelId: "gpt-5",
      },
      defaultThinkingLevel: "xhigh",
    });
  });

  it("preserves an explicit deny-all model policy", () => {
    expect(
      normalizeAgentDraftConfig({
        ...emptyResources,
        modelAllowlist: [],
        defaultThinkingLevel: "off",
      }),
    ).toMatchObject({
      modelAllowlist: [],
      defaultThinkingLevel: "off",
    });
  });

  it("rejects unsupported runtime fields and defaults outside the Agent allowlist", () => {
    expect(() =>
      normalizeAgentDraftConfig({
        ...emptyResources,
        modelAllowlist: ["openai/gpt-*"],
        defaultThinkingLevel: "high",
        runtimeUrl: "ws://legacy.invalid",
      }),
    ).toThrow("unsupported fields");

    expect(() =>
      normalizeAgentDraftConfig({
        ...emptyResources,
        modelAllowlist: ["google/gemini-*"],
        defaultModel: {
          key: "openai/gpt-5",
          provider: "openai",
          modelId: "gpt-5",
        },
        defaultThinkingLevel: "high",
      }),
    ).toThrow("outside modelAllowlist");

    expect(() =>
      normalizeAgentDraftConfig({
        ...emptyResources,
        modelAllowlist: ["missing-provider-separator"],
        defaultThinkingLevel: "turbo",
      }),
    ).toThrow();
  });
});
