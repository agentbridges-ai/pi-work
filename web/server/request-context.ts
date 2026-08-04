import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import { apiErrorResponse, type ApiErrorCategory } from "../shared/api-contracts.js";
import type { RuntimeDbContext } from "./runtime-db-context.js";
import { runWithRuntimeDbContext } from "./runtime-db-context.js";

export interface RequestContextValue {
  requestId: string;
  userHash?: string;
  sessionId?: string;
  contextEpoch?: number;
}

export interface RequestContextOptions {
  getUserId?: () => string | null | undefined;
  getDatabaseScope?: () => RuntimeDbContext | undefined;
}

const storage = new AsyncLocalStorage<RequestContextValue>();
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const requestIds = new WeakMap<Request, string>();
const ERROR_CATEGORIES = new Set<ApiErrorCategory>([
  "auth",
  "forbidden",
  "validation",
  "not_found",
  "conflict",
  "network",
  "cancelled",
  "server",
]);
const SENSITIVE_ERROR_TEXT =
  /(?:[A-Za-z]:\\|\/(?:Users|home|private|tmp|var|etc|proc|data)\/|authorization|bearer\s|cookie|password|credential|secret|access[_ -]?token)/i;

export function resolveRequestId(value: string | undefined | null): string {
  const candidate = value?.trim() || "";
  return REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

export function getRequestContext(): RequestContextValue | undefined {
  return storage.getStore();
}

export function anonymousUserHash(userId: string): string {
  return createHash("sha256")
    .update("piwork-local-diagnostics\0")
    .update(userId)
    .digest("hex")
    .slice(0, 16);
}

function requestSessionId(request: Request): string | undefined {
  try {
    const pathname = new URL(request.url).pathname;
    return pathname.match(
      /\/(?:sessions|user-space-transfer)\/([A-Za-z0-9_-]{1,200})(?:\/|$)/,
    )?.[1];
  } catch {
    return undefined;
  }
}

function requestContextEpoch(raw: string | undefined): number | undefined {
  if (!raw || !/^\d{1,16}$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function categoryForStatus(status: number): ApiErrorCategory {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 400 && status < 500) return "validation";
  return "server";
}

function defaultPublicMessage(status: number): string {
  if (status === 401) return "Authentication is required.";
  if (status === 403) return "This operation is not permitted.";
  if (status === 404) return "The requested resource was not found.";
  if (status === 409) return "The request conflicts with the current state.";
  if (status >= 400 && status < 500) return "The request was invalid.";
  return "The request could not be completed.";
}

async function normalizeErrorResponse(c: Context, requestId: string): Promise<void> {
  const response = c.res;
  if (response.status < 400) return;

  let body: Record<string, unknown> = {};
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const parsed = (await response.clone().json()) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {}
  }
  if (
    ERROR_CATEGORIES.has(body.category as ApiErrorCategory) &&
    typeof body.code === "string" &&
    body.status === response.status &&
    typeof body.requestId === "string" &&
    typeof body.message === "string"
  )
    return;

  const rawMessage =
    typeof body.message === "string"
      ? body.message
      : typeof body.error === "string"
        ? body.error
        : "";
  const message =
    response.status < 500 &&
    rawMessage.length > 0 &&
    rawMessage.length <= 300 &&
    !SENSITIVE_ERROR_TEXT.test(rawMessage)
      ? rawMessage
      : defaultPublicMessage(response.status);
  const category = ERROR_CATEGORIES.has(body.category as ApiErrorCategory)
    ? (body.category as ApiErrorCategory)
    : categoryForStatus(response.status);
  const code =
    typeof body.code === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(body.code)
      ? body.code
      : `http_${response.status}`;
  const headers = new Headers(response.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Request-ID", requestId);
  c.res = new Response(
    JSON.stringify(apiErrorResponse(category, code, response.status, message, requestId)),
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
}

export function registerRequestContext(api: Hono, options: RequestContextOptions = {}): void {
  api.onError((error, c) => {
    const requestId = requestIds.get(c.req.raw) || resolveRequestId(c.req.header("X-Request-ID"));
    c.header("X-Request-ID", requestId);
    console.error("[api] Unhandled request error", {
      requestId,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return c.json(
      apiErrorResponse(
        "server",
        "internal_error",
        500,
        "The request could not be completed.",
        requestId,
      ),
      500,
    );
  });

  api.use("*", async (c, next) => {
    const requestId = resolveRequestId(c.req.header("X-Request-ID"));
    requestIds.set(c.req.raw, requestId);
    c.header("X-Request-ID", requestId);
    const userId = options.getUserId?.()?.trim();
    const sessionId = requestSessionId(c.req.raw);
    const contextEpoch = requestContextEpoch(c.req.header("X-Piwork-Context-Epoch"));
    const value: RequestContextValue = {
      requestId,
      ...(userId ? { userHash: anonymousUserHash(userId) } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(contextEpoch !== undefined ? { contextEpoch } : {}),
    };
    return storage.run(value, async () => {
      const databaseScope = options.getDatabaseScope?.();
      if (databaseScope) {
        return runWithRuntimeDbContext(databaseScope, async () => {
          await next();
          await normalizeErrorResponse(c, requestId);
        });
      }
      await next();
      await normalizeErrorResponse(c, requestId);
    });
  });
}
