import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { streamSimple as nativePiStreamSimple } from "@earendil-works/pi-ai/compat";
import type { ProviderBootstrap } from "./pi-bootstrap-channel.js";

const REDACTED = "[REDACTED]";

/**
 * Pi configuration values treat a leading `!` as a command and `$NAME` as an
 * environment reference. Bootstrap credentials are literals, so quote both
 * metacharacters using Pi 0.82.1's own config-value escape syntax.
 */
export function escapePiConfigLiteral(value: string): string {
  const escapedDollars = value.replaceAll("$", () => "$$");
  return escapedDollars.startsWith("!") ? `$${escapedDollars}` : escapedDollars;
}

function modelHeaderValues(provider: ProviderBootstrap): string[] {
  return provider.config.models.flatMap((model) => Object.values(model.headers ?? {}));
}

/**
 * Returns both the secret as received and the escaped representation handed to
 * Pi. The latter matters for fail-closed diagnostics raised before Pi resolves
 * the literal configuration value.
 */
export function providerSensitiveValues(providers: readonly ProviderBootstrap[]): string[] {
  const values = providers.flatMap((provider) => [
    provider.config.apiKey,
    ...Object.values(provider.config.headers ?? {}),
    ...modelHeaderValues(provider),
  ]);
  return [
    ...new Set(
      values
        .filter((value) => value.length > 0)
        .flatMap((value) => [value, escapePiConfigLiteral(value)])
        .filter((value) => value.length > 0),
    ),
  ].sort((left, right) => right.length - left.length);
}

export function redactPiSensitiveText(value: string, sensitiveValues: readonly string[]): string {
  let output = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive.length > 0) output = output.split(sensitive).join(REDACTED);
  }
  return output;
}

export function redactPiSensitiveValue<T>(
  value: T,
  sensitiveValues: readonly string[],
  seen = new WeakMap<object, unknown>(),
): T {
  if (typeof value === "string") {
    return redactPiSensitiveText(value, sensitiveValues) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  const cached = seen.get(value);
  if (cached !== undefined) return cached as T;
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(redactPiSensitiveValue(item, sensitiveValues, seen));
    return output as T;
  }
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, item] of Object.entries(value)) {
    // Protocol/message field names are structural. Rewriting them could turn a
    // valid Pi terminal event into a non-terminal stream if a very short
    // credential happened to match "type", "error", or another field name.
    output[key] = redactPiSensitiveValue(item, sensitiveValues, seen);
  }
  return output as T;
}

function failureMessage(
  model: Model<Api>,
  error: unknown,
  sensitiveValues: readonly string[],
  aborted: boolean,
): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: redactPiSensitiveText(
      error instanceof Error ? error.message : String(error),
      sensitiveValues,
    ),
    timestamp: Date.now(),
  };
}

/**
 * Wraps Pi's pinned native provider dispatcher and redacts every streamed
 * partial/final event before AgentSession, compaction, retry, JSONL, or RPC can
 * observe it.
 */
export function createRedactingPiStreamSimple(
  sensitiveValues: readonly string[],
): (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream {
  const secrets = [...sensitiveValues];
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        const source = nativePiStreamSimple(model, context, options);
        for await (const event of source) {
          output.push(redactPiSensitiveValue(event, secrets) as AssistantMessageEvent);
        }
      } catch (error) {
        const message = failureMessage(model, error, secrets, options?.signal?.aborted === true);
        output.push({
          type: "error",
          reason: message.stopReason === "aborted" ? "aborted" : "error",
          error: message,
        });
      } finally {
        output.end();
      }
    })();
    return output;
  };
}
