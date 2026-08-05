import type { Hono } from "hono";
import {
  NATIVE_FILE_ACTIONS,
  NATIVE_HELPER_MAX_FILE_BYTES,
  type NativeFileAction,
  type NativeFileSource,
  type NativeHelperAnchor,
  type NativeHelperService,
  nativeHelperService,
} from "../native-helper.js";
import { requireSessionId } from "../path-policy.js";

function finiteQueryNumber(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw Object.assign(new Error("Invalid native helper anchor rectangle"), { status: 400 });
  }
  return parsed;
}

function optionalFiniteQueryNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw Object.assign(new Error("Invalid native file source metadata"), { status: 400 });
  }
  return parsed;
}

function requiredQuery(value: string | undefined, name: string, maxLength = 1_024): string {
  const normalized = value?.trim() || "";
  if (!normalized || normalized.length > maxLength) {
    throw Object.assign(new Error(`Invalid native file ${name}`), { status: 400 });
  }
  return normalized;
}

function parseAction(value: string | undefined): NativeFileAction {
  if (!value || !(NATIVE_FILE_ACTIONS as readonly string[]).includes(value)) {
    throw Object.assign(new Error("Unsupported native file action"), { status: 400 });
  }
  return value as NativeFileAction;
}

function parseSource(
  spaceValue: string | undefined,
  pathValue: string | undefined,
  mountIdValue: string | undefined,
  baselineSha256Value: string | undefined,
  baselineMtimeValue: string | undefined,
): NativeFileSource {
  const space = spaceValue === "user" ? "user" : spaceValue === "agent" ? "agent" : null;
  if (!space) {
    throw Object.assign(new Error("Invalid native file source space"), { status: 400 });
  }
  const path = requiredQuery(pathValue, "source path", 4_096);
  const mountId = mountIdValue?.trim() || undefined;
  if (space === "user" && !mountId) {
    throw Object.assign(new Error("User Space native actions require a mount id"), { status: 400 });
  }
  const baselineSha256 = baselineSha256Value?.trim().toLowerCase() || undefined;
  if (baselineSha256 && !/^[a-f0-9]{64}$/u.test(baselineSha256)) {
    throw Object.assign(new Error("Invalid native file baseline digest"), { status: 400 });
  }
  return {
    space,
    path,
    ...(mountId ? { mountId } : {}),
    ...(baselineSha256 ? { baselineSha256 } : {}),
    ...(baselineMtimeValue !== undefined
      ? { baselineMtime: optionalFiniteQueryNumber(baselineMtimeValue) }
      : {}),
  };
}

function parseAnchor(query: (name: string) => string | undefined): NativeHelperAnchor | undefined {
  const coordinates = ["x", "y", "width", "height"].map((name) => query(name));
  if (coordinates.every((value) => value === undefined)) return undefined;
  if (coordinates.some((value) => value === undefined)) {
    throw Object.assign(new Error("Incomplete native helper anchor rectangle"), { status: 400 });
  }
  return {
    x: finiteQueryNumber(coordinates[0]),
    y: finiteQueryNumber(coordinates[1]),
    width: finiteQueryNumber(coordinates[2]),
    height: finiteQueryNumber(coordinates[3]),
  };
}

function errorStatus(error: unknown): 400 | 404 | 409 | 413 | 500 | 501 | 503 {
  const value = (error as { status?: unknown })?.status;
  if ([400, 404, 409, 413, 501, 503].includes(Number(value))) {
    return Number(value) as 400 | 404 | 409 | 413 | 501 | 503;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("unavailable") || message.includes("timed out") ? 503 : 500;
}

export function registerNativeHelperRoutes(
  api: Hono,
  options: { service?: NativeHelperService; getOwnerKey?: () => string } = {},
): void {
  const service = options.service ?? nativeHelperService;
  const ownerKey = () => options.getOwnerKey?.() || "local-user";

  api.get("/native-helper/status", async (c) => {
    const status = await service.status({ refreshLatest: c.req.query("refresh") === "1" });
    return c.json(status, { headers: { "Cache-Control": "no-store, max-age=0" } });
  });

  api.post("/sessions/:id/native-file-actions", async (c) => {
    try {
      const sessionId = requireSessionId(c.req.param("id"));
      const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
      if (bytes.byteLength > NATIVE_HELPER_MAX_FILE_BYTES) {
        return c.json({ error: "Native file exceeds the 100 MiB limit" }, 413);
      }
      const operation = await service.createFileAction({
        ownerKey: ownerKey(),
        sessionId,
        action: parseAction(c.req.query("action")),
        bytes,
        filename: requiredQuery(c.req.query("filename"), "name"),
        source: parseSource(
          c.req.query("space"),
          c.req.query("path"),
          c.req.query("mountId"),
          c.req.query("baselineSha256"),
          c.req.query("baselineMtime"),
        ),
        anchor: parseAnchor((name) => c.req.query(name)),
      });
      return c.json({ operation }, 202);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        errorStatus(error),
      );
    }
  });

  api.get("/sessions/:id/native-file-actions", async (c) => {
    try {
      const sessionId = requireSessionId(c.req.param("id"));
      return c.json({ operations: await service.listFileActions(ownerKey(), sessionId) });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        errorStatus(error),
      );
    }
  });

  api.post("/sessions/:id/native-file-actions/:operationId/reclaim", async (c) => {
    try {
      const sessionId = requireSessionId(c.req.param("id"));
      const result = await service.reclaimFileAction(
        ownerKey(),
        sessionId,
        c.req.param("operationId"),
      );
      return new Response(Buffer.from(result.bytes), {
        headers: {
          "Content-Type": "application/octet-stream",
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
          "X-Piwork-Native-Operation-Id": result.operation.id,
          "X-Piwork-Native-Baseline-Sha256": result.operation.baselineSha256,
          "X-Piwork-Native-Managed-Sha256": result.managedSha256,
          "X-Piwork-Native-Changed": String(result.changed),
        },
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        errorStatus(error),
      );
    }
  });

  api.delete("/sessions/:id/native-file-actions/:operationId", async (c) => {
    try {
      const sessionId = requireSessionId(c.req.param("id"));
      await service.cancelFileAction(c.req.param("operationId"), sessionId, ownerKey());
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        errorStatus(error),
      );
    }
  });
}
