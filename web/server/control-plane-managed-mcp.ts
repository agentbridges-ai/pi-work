import { markManagedMcpCredential, type ManagedMcpServerConfig } from "./managed-mcp.js";

export interface ControlPlaneMcpRow {
  name: unknown;
  transport: unknown;
  config: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`Managed MCP ${field} must be a positive integer.`);
  }
  return value as number;
}

function stringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  if (
    !input ||
    !Object.entries(input).every(
      ([key, item]) =>
        /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key) &&
        typeof item === "string" &&
        !/[\r\n\0]/u.test(item),
    )
  ) {
    throw new Error(`Managed MCP ${field} is invalid.`);
  }
  return Object.fromEntries(Object.entries(input).map(([key, item]) => [key, item as string]));
}

function mcpToolPolicies(value: unknown): Record<string, { readOnly: boolean }> | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  if (!input) throw new Error("Managed MCP toolPolicies is invalid.");
  const output: Record<string, { readOnly: boolean }> = {};
  for (const [name, policyValue] of Object.entries(input)) {
    const policy = record(policyValue);
    if (
      !/^[A-Za-z0-9_.-]{1,128}$/u.test(name) ||
      !policy ||
      Object.keys(policy).some((key) => key !== "readOnly") ||
      typeof policy.readOnly !== "boolean"
    ) {
      throw new Error("Managed MCP toolPolicies is invalid.");
    }
    output[name] = { readOnly: policy.readOnly };
  }
  return output;
}

function assertOnlyKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const allow = new Set(allowed);
  const unsupported = Object.keys(input).filter((key) => !allow.has(key));
  if (unsupported.length) {
    throw new Error(
      `Managed MCP config contains unsupported fields: ${unsupported.sort().join(", ")}.`,
    );
  }
}

function credentialShaped(value: string): boolean {
  return /(?:^|[^A-Za-z0-9])(?:api[-_]?key|access[-_]?token|token|secret|password|credential|authorization|auth|cookie)(?:$|[^A-Za-z0-9])/iu.test(
    value,
  );
}

function assertCredentialFreeStdioArgs(args: readonly string[]): void {
  if (
    args.some(
      (arg) =>
        credentialShaped(arg.replace(/^--?/u, "")) ||
        /^(?:bearer|basic)\s+/iu.test(arg) ||
        /^(?:sk|key|token|secret)[-_][A-Za-z0-9._~-]{8,}$/u.test(arg),
    )
  ) {
    throw new Error("Managed MCP stdio arguments must not contain credential material.");
  }
}

export function materializeManagedMcpServer(
  row: ControlPlaneMcpRow,
  credential?: string,
): ManagedMcpServerConfig {
  const input = record(row.config) ?? {};
  const name = String(row.name);
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(name)) {
    throw new Error("Managed MCP server name is invalid.");
  }
  const enabled = input.enabled === undefined ? true : input.enabled;
  if (typeof enabled !== "boolean") throw new Error("Managed MCP enabled flag is invalid.");
  const toolPolicies = mcpToolPolicies(input.toolPolicies);
  const connectTimeoutMs = optionalPositiveInteger(input.connectTimeoutMs, "connectTimeoutMs");
  const requestTimeoutMs = optionalPositiveInteger(input.requestTimeoutMs, "requestTimeoutMs");
  const common = {
    name,
    enabled,
    ...(toolPolicies ? { toolPolicies } : {}),
    ...(connectTimeoutMs ? { connectTimeoutMs } : {}),
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
  };
  const transport = String(row.transport);
  if (transport === "stdio") {
    assertOnlyKeys(input, [
      "enabled",
      "toolPolicies",
      "connectTimeoutMs",
      "requestTimeoutMs",
      "command",
      "args",
      "cwd",
      "env",
    ]);
    if (credential !== undefined) {
      throw new Error("Managed MCP stdio credentials require an isolated capability channel.");
    }
    if (
      typeof input.command !== "string" ||
      !input.command ||
      input.command.includes("\0") ||
      (input.args !== undefined &&
        (!Array.isArray(input.args) ||
          input.args.some((item) => typeof item !== "string" || item.includes("\0")))) ||
      (input.cwd !== undefined &&
        (typeof input.cwd !== "string" || !input.cwd || input.cwd.includes("\0")))
    ) {
      throw new Error("Managed MCP stdio config is invalid.");
    }
    const env = stringRecord(input.env, "stdio environment");
    const args = input.args ? [...(input.args as string[])] : [];
    assertCredentialFreeStdioArgs(args);
    if (
      Object.keys(env ?? {}).some(
        (key) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || credentialShaped(key),
      )
    ) {
      throw new Error("Managed MCP stdio environment may contain only non-secret settings.");
    }
    return {
      ...common,
      transport: "stdio",
      command: input.command,
      ...(args.length ? { args } : {}),
      ...(typeof input.cwd === "string" ? { cwd: input.cwd } : {}),
      ...(env ? { env } : {}),
    };
  }
  if (transport !== "sse" && transport !== "streamable-http") {
    throw new Error("Managed MCP transport is unsupported.");
  }
  assertOnlyKeys(input, [
    "enabled",
    "toolPolicies",
    "connectTimeoutMs",
    "requestTimeoutMs",
    "url",
    "headers",
    "credentialHeader",
    "credentialScheme",
  ]);
  if (typeof input.url !== "string") throw new Error("Managed MCP remote URL is required.");
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error("Managed MCP remote URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !url.hostname
  ) {
    throw new Error("Managed MCP remote URL must be credential-free HTTPS.");
  }
  const headers = stringRecord(input.headers, "HTTP headers") ?? {};
  if (Object.keys(headers).some((key) => credentialShaped(key))) {
    throw new Error("Managed MCP credential headers must reference an encrypted secret.");
  }
  if (
    (input.credentialHeader !== undefined &&
      (typeof input.credentialHeader !== "string" ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(input.credentialHeader))) ||
    (input.credentialScheme !== undefined &&
      (typeof input.credentialScheme !== "string" ||
        !/^[A-Za-z][A-Za-z0-9._~-]{0,63}$/u.test(input.credentialScheme)))
  ) {
    throw new Error("Managed MCP credential header configuration is invalid.");
  }
  if (credential !== undefined) {
    if (!credential || /[\r\n\0]/u.test(credential)) {
      throw new Error("Managed MCP encrypted credential is invalid.");
    }
    const header = (input.credentialHeader as string | undefined) ?? "Authorization";
    const scheme =
      (input.credentialScheme as string | undefined) ??
      (header.toLowerCase() === "authorization" ? "Bearer" : "");
    const headerValue = scheme ? `${scheme} ${credential}` : credential;
    const resolved: ManagedMcpServerConfig = {
      ...common,
      transport,
      url: url.toString(),
      ...(Object.keys(headers).length ? { headers } : {}),
    };
    return markManagedMcpCredential(resolved, header, headerValue, credential);
  } else if (input.credentialHeader !== undefined || input.credentialScheme !== undefined) {
    throw new Error("Managed MCP credential metadata requires an encrypted secret.");
  }
  const resolved: ManagedMcpServerConfig = {
    ...common,
    transport,
    url: url.toString(),
    ...(Object.keys(headers).length ? { headers } : {}),
  };
  return resolved;
}
