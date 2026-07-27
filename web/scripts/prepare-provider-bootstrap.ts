export {};

const providerName = process.env.PIWORK_PI_PROVIDER_NAME?.trim();
const baseUrl = process.env.PIWORK_PI_PROVIDER_BASE_URL?.trim();
const api = process.env.PIWORK_PI_PROVIDER_API?.trim();
const apiKeyHeader = process.env.PIWORK_PI_PROVIDER_API_KEY_HEADER?.trim();
const modelIds = (process.env.PIWORK_PI_PROVIDER_MODELS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const apiKey = (await Bun.stdin.text()).trim();
const DEEPSEEK_V4_MODEL = /^deepseek-v4(?:-|$)/iu;
const DEEPSEEK_V4_THINKING_LEVEL_MAP = {
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
} as const;

if (!providerName || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(providerName)) {
  throw new Error("PIWORK_PI_PROVIDER_NAME is invalid");
}
if (!baseUrl || !api || modelIds.length === 0 || !apiKey) {
  throw new Error("Pi provider bootstrap configuration is incomplete");
}
const parsedBaseUrl = new URL(baseUrl);
if (
  parsedBaseUrl.protocol !== "https:" ||
  parsedBaseUrl.username ||
  parsedBaseUrl.password ||
  parsedBaseUrl.search ||
  parsedBaseUrl.hash
) {
  throw new Error("PIWORK_PI_PROVIDER_BASE_URL must be a credential-free HTTPS URL");
}
if (
  new Set(modelIds).size !== modelIds.length ||
  modelIds.some((modelId) => !/^[A-Za-z0-9._:/@*-]{1,512}$/u.test(modelId))
) {
  throw new Error("PIWORK_PI_PROVIDER_MODELS is invalid");
}
if (
  apiKeyHeader &&
  (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(apiKeyHeader) ||
    apiKeyHeader.toLowerCase() === "authorization")
) {
  throw new Error("PIWORK_PI_PROVIDER_API_KEY_HEADER is invalid");
}

const models = modelIds.map((id) => {
  const isDeepSeekV4 = providerName.toLowerCase() === "deepseek" && DEEPSEEK_V4_MODEL.test(id);
  return {
    id,
    name: id,
    reasoning: true,
    ...(isDeepSeekV4
      ? {
          thinkingLevelMap: DEEPSEEK_V4_THINKING_LEVEL_MAP,
          compat: {
            thinkingFormat: "deepseek",
            supportsReasoningEffort: true,
          },
        }
      : {}),
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tiers: [],
    },
    contextWindow: 1_000_000,
    maxTokens: 393_216,
  };
});

process.stdout.write(
  JSON.stringify({
    version: 1,
    providers: [
      {
        name: providerName,
        config: {
          name: providerName,
          baseUrl: parsedBaseUrl.toString().replace(/\/$/u, ""),
          apiKey,
          api,
          authHeader: !apiKeyHeader,
          ...(apiKeyHeader
            ? {
                headers: {
                  [apiKeyHeader]: `Bearer ${apiKey}`,
                  ...(apiKeyHeader.toLowerCase() === "cf-aig-authorization"
                    ? { "cf-aig-collect-log-payload": "false" }
                    : {}),
                },
              }
            : {}),
          models,
        },
      },
    ],
  }),
);
