import { describe, expect, it } from "vitest";
import {
  AGENT_MODES,
  THINKING_LEVELS,
  modelRefEquals,
  normalizeAgentMode,
  normalizeThinkingLevel,
  toModelOptions,
} from "./backends.js";
import { setUiCopyLanguage } from "../ui-copy.js";

describe("Pi model helpers", () => {
  it("converts only server-provided model refs without a local fallback", () => {
    const options = toModelOptions([
      {
        model: { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" },
        label: "GPT-5",
        description: "General",
        thinkingLevels: ["off", "high"],
      },
    ]);
    expect(options).toHaveLength(1);
    expect(options[0]?.value).toBe("openai/gpt-5");
    expect(options[0]?.model.provider).toBe("openai");
    expect(options[0]?.thinkingLevels).toEqual(["off", "high"]);
    expect(toModelOptions([])).toEqual([]);
  });

  it("localizes policy-probed model descriptions when the server returns no display copy", () => {
    setUiCopyLanguage("zh-CN");
    const [option] = toModelOptions([
      {
        model: { key: "openai/gpt-5", provider: "openai", modelId: "gpt-5" },
        label: "GPT-5",
        thinkingLevels: ["off", "high"],
      },
    ]);
    expect(option?.description).toContain("推理");
    setUiCopyLanguage("en-US");
  });

  it("compares the complete provider/model identity", () => {
    const model = { key: "key", provider: "provider", modelId: "model" };
    expect(modelRefEquals(model, { ...model })).toBe(true);
    expect(modelRefEquals(model, { ...model, provider: "other" })).toBe(false);
  });

  it("exposes exactly the Pi modes and thinking levels", () => {
    expect(AGENT_MODES).toEqual(["agent", "plan"]);
    expect(THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(normalizeAgentMode("legacy")).toBe("agent");
    expect(normalizeThinkingLevel("xhigh")).toBe("xhigh");
  });
});
