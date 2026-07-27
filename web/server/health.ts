import { accessSync, constants } from "node:fs";
import type { HealthResponse } from "../shared/api-contracts.js";

export interface ReadinessChecks {
  database: boolean;
  dataRoot: boolean;
  piRuntime: boolean;
  internalFileTransport: boolean;
}

export interface ReadinessResponse extends HealthResponse {
  status: "ready" | "not_ready";
  checks: ReadinessChecks;
}

export function livenessResponse(): HealthResponse {
  return { ok: true, status: "live" };
}

export async function readinessResponse(deps: {
  dataRoot: string;
  databaseReady: () => Promise<boolean>;
  piRuntimeAvailable: boolean;
  internalFileTransportAvailable: boolean;
}): Promise<ReadinessResponse> {
  let dataRoot = false;
  try {
    accessSync(deps.dataRoot, constants.R_OK | constants.W_OK);
    dataRoot = true;
  } catch {}

  const database = await deps.databaseReady().catch(() => false);
  const checks: ReadinessChecks = {
    database,
    dataRoot,
    piRuntime: deps.piRuntimeAvailable,
    internalFileTransport: deps.internalFileTransportAvailable,
  };
  const ok = Object.values(checks).every(Boolean);
  return { ok, status: ok ? "ready" : "not_ready", checks };
}
