export type ApiErrorCategory =
  | "auth"
  | "forbidden"
  | "validation"
  | "not_found"
  | "conflict"
  | "network"
  | "cancelled"
  | "server";

export interface ApiError {
  category: ApiErrorCategory;
  code: string;
  status: number;
  requestId: string;
  message: string;
}

/** Legacy shapes remain readable while routes migrate to the shared contract. */
export type LegacyApiErrorResponse = {
  error: Omit<ApiError, "status"> | string;
  code?: string;
  category?: ApiErrorCategory;
  requestId?: string;
  message?: string;
};

export type ApiErrorResponse = ApiError | LegacyApiErrorResponse;

export interface WsEnvelope<T = unknown> {
  protocolVersion: 1;
  contextEpoch: number;
  contextId: string;
  eventId: string;
  kind: string;
  payload: T;
}

export interface HealthResponse {
  ok: boolean;
  status: "live" | "ready" | "not_ready";
}

export const WS_PROTOCOL_VERSION = 1 as const;
export const RUNTIME_CONTEXT_ID_HEX_LENGTH = 32;

/** A 128-bit, lowercase hexadecimal browser runtime capability identifier. */
export function isRuntimeContextId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === RUNTIME_CONTEXT_ID_HEX_LENGTH &&
    /^[a-f0-9]+$/.test(value)
  );
}

export function apiErrorResponse(
  category: ApiErrorCategory,
  code: string,
  status: number,
  message: string,
  requestId: string,
): ApiError {
  return {
    category,
    code,
    status,
    requestId,
    message,
  };
}
