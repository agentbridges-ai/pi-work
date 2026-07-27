#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

type RequestInit = { method?: string; headers?: Record<string, string>; body?: string };
type OnlyOfficeFetchRequestInit = RequestInit & { unix?: string };
type HttpResult = { status: number; statusText: string; text: string };
type JsonHttpResult = HttpResult & { body: Record<string, unknown> };
type RetryDependencies = {
  requestJson?: (url: string, init?: RequestInit) => Promise<JsonHttpResult>;
  sleep?: (milliseconds: number) => Promise<void>;
  apiBase?: () => string;
};

export type OnlyOfficeAbortReport = {
  ok: false;
  attempts: number;
  request_id: unknown;
  abortReason: string;
  currentState: unknown;
};

export class OnlyOfficeCliAbortError extends Error {
  constructor(readonly report: OnlyOfficeAbortReport) {
    super(report.abortReason);
    this.name = "OnlyOfficeCliAbortError";
  }
}

if (import.meta.main) {
  main().catch((error) => {
    if (error instanceof OnlyOfficeCliAbortError) {
      console.error(JSON.stringify(error.report, null, 2));
      process.exit(2);
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "active") {
    console.log(JSON.stringify(await fetchJson(`${apiBase()}/active`), null, 2));
    return;
  }
  if (command === "op") {
    const raw = option(args, "--json");
    if (!raw) throw new Error("onlyoffice op requires --json '<operation>'");
    if (args.includes("--target")) {
      throw new Error(
        "onlyoffice op does not support --target; open and focus the intended Office file first.",
      );
    }
    const requestId = option(args, "--request-id") || randomUUID();
    const payload = {
      request_id: requestId,
      operation: JSON.parse(raw) as unknown,
    };
    console.log(JSON.stringify(await requestWithRetries(payload), null, 2));
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

export async function requestWithRetries(
  payload: Record<string, unknown>,
  dependencies: RetryDependencies = {},
): Promise<unknown> {
  const send = dependencies.requestJson ?? requestJson;
  const sleep =
    dependencies.sleep ??
    ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const baseUrl = (dependencies.apiBase ?? apiBase)();
  const operationUrl = `${baseUrl}/operation`;
  let lastBody: Record<string, unknown> = {};
  let attempts = 0;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    attempts = attempt;
    let response: JsonHttpResult;
    try {
      response = await send(operationUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      lastBody = {
        ok: false,
        retryable: true,
        error: error instanceof Error ? error.message : String(error),
      };
      if (attempt < 3) await sleep(750 * attempt);
      continue;
    }
    lastBody = response.body;
    if (response.status >= 200 && response.status < 300) {
      return { ...lastBody, attempts: attempt, request_id: payload.request_id };
    }
    if (lastBody.retryable !== true || attempt === 3) break;
    await sleep(750 * attempt);
  }
  let currentState = lastBody.document ?? null;
  if (attempts === 3 && lastBody.document === undefined) {
    try {
      const active = await send(`${baseUrl}/active`);
      if (active.status >= 200 && active.status < 300) currentState = active.body.document ?? null;
    } catch {}
  }
  throw new OnlyOfficeCliAbortError({
    ok: false,
    attempts,
    request_id: payload.request_id,
    abortReason:
      typeof lastBody.error === "string" ? lastBody.error : "ONLYOFFICE operation failed.",
    currentState,
  });
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function apiBase(): string {
  const configured = process.env.PIWORK_ONLYOFFICE_API_BASE?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const sessionId = process.env.PIWORK_USER_SPACE_SESSION_ID?.trim();
  const port = process.env.PORT || "3457";
  if (!sessionId) throw new Error("PIWORK_USER_SPACE_SESSION_ID is not set.");
  return `http://127.0.0.1:${port}/internal/onlyoffice/${encodeURIComponent(sessionId)}`;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await requestJson(url);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      typeof response.body.error === "string"
        ? response.body.error
        : `${response.status} ${response.statusText}`,
    );
  }
  return response.body;
}

async function requestJson(url: string, init: RequestInit = {}): Promise<JsonHttpResult> {
  const requestInit = buildOnlyOfficeRequestInit(init);
  const response = await fetch(url, requestInit).then(async (value) => ({
    status: value.status,
    statusText: value.statusText,
    text: await value.text(),
  }));
  const parsed = response.text ? (JSON.parse(response.text) as unknown) : {};
  return {
    ...response,
    body:
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
  };
}

export function buildOnlyOfficeRequestInit(
  init: RequestInit = {},
  env: Record<string, string | undefined> = process.env,
): OnlyOfficeFetchRequestInit {
  const token = env.PIWORK_USER_SPACE_API_TOKEN?.trim();
  if (!token) throw new Error("PIWORK_USER_SPACE_API_TOKEN is not set.");
  const socketPath = env.PIWORK_USER_SPACE_API_UNIX?.trim();
  if (socketPath && (!isAbsolute(socketPath) || socketPath.includes("\0"))) {
    throw new Error("PIWORK_USER_SPACE_API_UNIX must be an absolute Unix socket path.");
  }
  return {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
    ...(socketPath ? { unix: socketPath } : {}),
  };
}

function printHelp(): void {
  console.log(
    [
      "Usage:",
      "  onlyoffice active",
      "  onlyoffice op --json '<structured operation>'",
      "  onlyoffice op --request-id '<id>' --json '<operation>'",
    ].join("\n"),
  );
}
