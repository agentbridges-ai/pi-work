import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { AuthenticatedUser } from "../auth-types.js";
import type { AppsRuntimeUiOperations } from "../apps-runtime-coordinator.js";
import type { AppsControlPlane } from "../apps-control-plane.js";
import type {
  AppContinueDevelopmentResponse,
  AppListScope,
  AppOperationContext,
} from "../apps-types.js";

function numberValue(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function registerAppsRoutes(
  api: Hono,
  deps: {
    service: AppsControlPlane;
    runtime?: AppsRuntimeUiOperations;
    getCurrentUser: () => AuthenticatedUser | null;
    continueDevelopment?: (
      source: AppContinueDevelopmentResponse,
      user: AuthenticatedUser,
    ) => Promise<{ sessionId: string; restoredFromSnapshot: boolean }>;
  },
): void {
  const current = (): AuthenticatedUser & { tenantId: string; membershipId: string } => {
    const user = deps.getCurrentUser();
    if (!user) throw new Error("Unauthorized");
    if (!user.tenantId || !user.membershipId) throw new Error("Tenant membership not found.");
    return user as AuthenticatedUser & { tenantId: string; membershipId: string };
  };
  const context = (
    c: { req: { header: (name: string) => string | undefined } },
    explicitIntent = false,
    idempotencyKey?: string,
  ): AppOperationContext => {
    const user = current();
    const generation = Math.max(
      0,
      Math.floor(numberValue(c.req.header("x-piwork-context-generation"), 0)),
    );
    return {
      tenantId: user.tenantId,
      userId: user.userId,
      membershipId: user.membershipId,
      generation,
      rootTask: true,
      readOnly: false,
      mode: "ui",
      explicitIntent,
      idempotencyKey:
        stringValue(idempotencyKey) ||
        stringValue(c.req.header("idempotency-key")) ||
        (explicitIntent ? `ui:${randomUUID()}` : undefined),
    };
  };
  const error = (c: any, cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    const status = /Unauthorized/i.test(message)
      ? 401
      : /Forbidden|not permitted|requires tenant administrator/i.test(message)
        ? 403
        : /not found/i.test(message)
          ? 404
          : /stale|conflict|already|archived|deployment in progress/i.test(message)
            ? 409
            : 400;
    return c.json({ error: message }, status);
  };

  api.get("/apps", async (c) => {
    try {
      const scope = (c.req.query("scope") || "mine") as AppListScope;
      return c.json(
        await deps.service.listApps(context(c), {
          scope,
          sessionId: stringValue(c.req.query("sessionId")) || undefined,
          cursor: stringValue(c.req.query("cursor")) || undefined,
          limit: numberValue(c.req.query("limit"), 25),
        }),
      );
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.get("/apps/:id", async (c) => {
    try {
      return c.json({ app: await deps.service.getApp(context(c), c.req.param("id")) });
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.patch("/apps/:id", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const name = stringValue(body.name);
      if (!name) return c.json({ error: "name is required" }, 400);
      return c.json({ app: await deps.service.rename(context(c), c.req.param("id"), name) });
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.get("/apps/:id/versions", async (c) => {
    try {
      return c.json(
        await deps.service.listVersions(
          context(c),
          c.req.param("id"),
          stringValue(c.req.query("cursor")) || undefined,
          numberValue(c.req.query("limit"), 20),
        ),
      );
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.post("/apps/:id/rollback", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const deploymentId = stringValue(body.deploymentId);
      if (!deploymentId) return c.json({ error: "deploymentId is required" }, 400);
      const operationContext = context(c, true, stringValue(body.idempotencyKey));
      return c.json(
        await (deps.runtime?.rollback(
          operationContext,
          c.req.param("id"),
          deploymentId,
          c.req.raw.signal,
        ) ?? deps.service.rollback(operationContext, c.req.param("id"), deploymentId)),
      );
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.put("/apps/:id/domains", async (c) => {
    try {
      if (!deps.runtime) throw new Error("Cloudflare App runtime is unavailable.");
      const body = await c.req.json().catch(() => ({}));
      const connectionId = stringValue(body.connectionId);
      const zoneId = stringValue(body.zoneId);
      const hostname = stringValue(body.hostname);
      if (!connectionId || !zoneId || !hostname) {
        return c.json({ error: "connectionId, zoneId and hostname are required" }, 400);
      }
      if (body.confirmImpact !== true) {
        return c.json({ error: "confirmImpact must be true" }, 400);
      }
      const operationContext = context(c, true, stringValue(body.idempotencyKey));
      const app = await deps.runtime.setCustomDomain(operationContext, c.req.param("id"), {
        connectionId,
        zoneId,
        hostname,
        confirmImpact: true,
      });
      return c.json({ app });
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.delete("/apps/:id/domains", async (c) => {
    try {
      if (!deps.runtime) throw new Error("Cloudflare App runtime is unavailable.");
      const body = await c.req.json().catch(() => ({}));
      const connectionId = stringValue(body.connectionId);
      const zoneId = stringValue(body.zoneId);
      const hostname = stringValue(body.hostname);
      if (!connectionId || !zoneId || !hostname) {
        return c.json({ error: "connectionId, zoneId and hostname are required" }, 400);
      }
      if (body.confirmImpact !== true) {
        return c.json({ error: "confirmImpact must be true" }, 400);
      }
      const operationContext = context(c, true, stringValue(body.idempotencyKey));
      const app = await deps.runtime.removeCustomDomain(operationContext, c.req.param("id"), {
        connectionId,
        zoneId,
        hostname,
        confirmImpact: true,
      });
      return c.json({ app });
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.delete("/apps/:id", async (c) => {
    try {
      const operationContext = context(c, true);
      const app = await (deps.runtime?.delete(operationContext, c.req.param("id")) ??
        deps.service.archive(operationContext, c.req.param("id")));
      return c.json({ app });
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.post("/apps/:id/restore", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const operationContext = context(c, true, stringValue(body.idempotencyKey));
      const app = await (deps.runtime?.restore(operationContext, c.req.param("id")) ??
        deps.service.restore(operationContext, c.req.param("id")));
      return c.json({ app });
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.post("/apps/:id/continue-development", async (c) => {
    try {
      const source = await deps.service.continueDevelopment(context(c), c.req.param("id"));
      if (deps.continueDevelopment) {
        return c.json(await deps.continueDevelopment(source, current()));
      }
      if (!source.sourceSessionId) {
        throw new Error(
          "App source session is unavailable and snapshot restore is not configured.",
        );
      }
      return c.json({ sessionId: source.sourceSessionId, restoredFromSnapshot: false });
    } catch (cause) {
      return error(c, cause);
    }
  });
}
