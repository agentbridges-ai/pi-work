import type { CreateSessionRequest } from "./session-orchestrator-contract.js";

/**
 * Browser-authorized Pi session creation fields. Server-owned launch authority,
 * provider credentials, and resolved policy are intentionally absent.
 */
const PUBLIC_SESSION_CREATE_KEYS = [
  "backend",
  "agentId",
  "model",
  "thinkingLevel",
  "mode",
  "resumeSessionAt",
  "userSpace",
] as const satisfies readonly (keyof CreateSessionRequest)[];

export function sanitizePublicSessionCreateRequest(value: unknown): CreateSessionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of PUBLIC_SESSION_CREATE_KEYS) {
    if (Object.hasOwn(input, key)) output[key] = input[key];
  }
  return output as CreateSessionRequest;
}
