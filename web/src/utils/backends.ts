import type { BackendModelInfo } from "../api.js";
import type { AgentMode, PiModelRef, ThinkingLevel } from "../types.js";
import { uiCopy } from "../ui-copy.js";

export interface ModelOption {
  value: string;
  label: string;
  description: string;
  icon: string;
  model: PiModelRef;
  thinkingLevels: ThinkingLevel[];
}

const MODEL_ICONS = ["◆", "●", "◕", "✦"] as const;

function pickIcon(model: PiModelRef, index: number): string {
  const name = `${model.provider}/${model.modelId}`.toLowerCase();
  if (/(max|opus|pro)/.test(name)) return "■";
  if (/(mini|flash|haiku|fast)/.test(name)) return "⚡";
  return MODEL_ICONS[index % MODEL_ICONS.length];
}

/** Convert the server's already policy-filtered models; never add a local fallback. */
export function toModelOptions(models: BackendModelInfo[]): ModelOption[] {
  return models.map((entry, index) => ({
    value: entry.model.key,
    label: entry.label || `${entry.model.provider}/${entry.model.modelId}`,
    description:
      entry.description ||
      (entry.thinkingLevels.some((level) => level !== "off")
        ? uiCopy.piRuntime.reasoningModelDescription
        : uiCopy.piRuntime.standardModelDescription),
    icon: pickIcon(entry.model, index),
    model: entry.model,
    thinkingLevels: entry.thinkingLevels,
  }));
}

export const AGENT_MODES = ["agent", "plan"] as const satisfies readonly AgentMode[];
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

export function normalizeAgentMode(value: unknown): AgentMode {
  return value === "plan" ? "plan" : "agent";
}

export function normalizeThinkingLevel(
  value: unknown,
  fallback: ThinkingLevel = "medium",
): ThinkingLevel {
  return THINKING_LEVELS.includes(value as ThinkingLevel) ? (value as ThinkingLevel) : fallback;
}

export function modelRefEquals(
  left: PiModelRef | undefined,
  right: PiModelRef | undefined,
): boolean {
  return Boolean(
    left &&
    right &&
    left.key === right.key &&
    left.provider === right.provider &&
    left.modelId === right.modelId,
  );
}
