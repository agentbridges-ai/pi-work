import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
} from "@earendil-works/pi-ai";

const nativeStreamSimple = vi.hoisted(() => vi.fn());
vi.mock("@earendil-works/pi-ai/compat", () => ({
  streamSimple: nativeStreamSimple,
}));

import {
  createRedactingPiStreamSimple,
  escapePiConfigLiteral,
  redactPiSensitiveValue,
} from "./pi-provider-secrets.js";

const roots: string[] = [];

afterEach(() => {
  nativeStreamSimple.mockReset();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

function model(): Model<Api> {
  return {
    id: "model",
    name: "Model",
    api: "openai-responses",
    provider: "managed",
    baseUrl: "https://models.example.test/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_192,
  };
}

function errorMessage(canary: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: `provider echoed ${canary}` }],
    api: "openai-responses",
    provider: "managed",
    model: "model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: `401 response body: ${canary}`,
    timestamp: 1,
  };
}

describe("Pi provider secret boundary", () => {
  it("round-trips literal credentials through Pi 0.82.1 without env expansion or commands", async () => {
    const packageEntry = new URL(
      "../node_modules/@earendil-works/pi-coding-agent/dist/index.js",
      import.meta.url,
    );
    const resolver = (await import(
      new URL("./core/resolve-config-value.js", packageEntry).href
    )) as {
      resolveConfigValueUncached(value: string, env?: Record<string, string>): string | undefined;
    };
    const root = mkdtempSync(join(tmpdir(), "piwork-pi-literal-"));
    roots.push(root);
    const marker = join(root, "must-not-exist");
    const values = [
      "plain-secret",
      "$HOME-${TOKEN}-$$-tail",
      `!touch ${marker}`,
      "!$TOKEN",
      "$!already-looking-escaped",
    ];
    for (const value of values) {
      expect(
        resolver.resolveConfigValueUncached(escapePiConfigLiteral(value), {
          HOME: "expanded-home",
          TOKEN: "expanded-token",
        }),
      ).toBe(value);
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("redacts provider echo events before normal, retry, and compaction consumers", async () => {
    const canary = "sk-provider-echo-canary";
    nativeStreamSimple.mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const message = errorMessage(canary);
      stream.push({ type: "start", partial: message });
      stream.push({ type: "error", reason: "error", error: message });
      stream.end();
      return stream;
    });
    const result = await createRedactingPiStreamSimple([canary])(model(), {
      messages: [],
    } as Context).result();

    expect(JSON.stringify(result)).not.toContain(canary);
    expect(result.errorMessage).toBe("401 response body: [REDACTED]");
    expect(result.content).toEqual([{ type: "text", text: "provider echoed [REDACTED]" }]);
  });

  it("pins Pi 0.82.1 message_end replacement before RPC listeners and JSONL append", () => {
    const agentSession = readFileSync(
      new URL(
        "../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js",
        import.meta.url,
      ),
      "utf8",
    );
    const extension = agentSession.indexOf("await this._emitExtensionEvent(event);");
    const rpcListener = agentSession.indexOf('this._emit(event.type === "agent_end"');
    const persistence = agentSession.indexOf("this.sessionManager.appendMessage(event.message);");

    expect(extension).toBeGreaterThan(-1);
    expect(rpcListener).toBeGreaterThan(extension);
    expect(persistence).toBeGreaterThan(rpcListener);
  });

  it("preserves ordinary errors and object structure when no sensitive literal is present", () => {
    const input = {
      role: "assistant",
      errorMessage: "429 rate limit exceeded",
      nested: ["safe detail"],
    };
    expect(redactPiSensitiveValue(input, ["sk-other-secret"])).toEqual(input);
  });
});
