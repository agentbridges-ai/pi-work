import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(import.meta.dirname, "prepare-provider-bootstrap.ts");
const baseEnvironment = {
  ...process.env,
  PIWORK_PI_PROVIDER_NAME: "deepseek",
  PIWORK_PI_PROVIDER_BASE_URL: "https://api.deepseek.com",
  PIWORK_PI_PROVIDER_API: "openai-completions",
  PIWORK_PI_PROVIDER_MODELS: "deepseek-v4-flash,deepseek-v4-pro",
};

function prepare(extraEnvironment: Record<string, string> = {}) {
  const result = spawnSync("bun", [script], {
    env: { ...baseEnvironment, ...extraEnvironment },
    input: "test-secret\n",
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("provider bootstrap preparation", () => {
  it("uses the provider Authorization header by default", () => {
    const payload = prepare();
    const config = payload.providers[0].config;

    expect(config.authHeader).toBe(true);
    expect(config.headers).toBeUndefined();
    expect(config.models[0].cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tiers: [],
    });
    expect(config.models[0]).toMatchObject({
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: null,
        max: "max",
      },
      compat: {
        thinkingFormat: "deepseek",
        supportsReasoningEffort: true,
      },
    });
  });

  it("uses authenticated Cloudflare AI Gateway without exposing provider auth", () => {
    const payload = prepare({
      PIWORK_PI_PROVIDER_BASE_URL: "https://gateway.ai.cloudflare.com/v1/account/prod-llm/deepseek",
      PIWORK_PI_PROVIDER_API_KEY_HEADER: "cf-aig-authorization",
    });
    const config = payload.providers[0].config;

    expect(config.authHeader).toBe(false);
    expect(config.headers).toEqual({
      "cf-aig-authorization": "Bearer test-secret",
      "cf-aig-collect-log-payload": "false",
    });
    expect(config.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "deepseek-v4-pro",
          thinkingLevelMap: expect.objectContaining({ high: "high", max: "max" }),
          compat: {
            thinkingFormat: "deepseek",
            supportsReasoningEffort: true,
          },
        }),
      ]),
    );
  });
});
