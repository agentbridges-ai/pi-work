import type { Hono } from "hono";
import type { AuthenticatedUser } from "../auth-types.js";
import {
  AppCloudflareNeedsOAuthError,
  type AppCloudflareAccountService,
} from "../apps-cloudflare-account-service.js";
import type {
  AppCloudflareAccountContext,
  AppCloudflareBrowserConfig,
  AppCloudflareQueuedDeployment,
} from "../apps-cloudflare-account-types.js";
import { ENV, envFlag, environment } from "../environment.js";

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function registerAppsCloudflareRoutes(
  api: Hono,
  deps: {
    service: AppCloudflareAccountService;
    getCurrentUser: () => AuthenticatedUser | null;
    onDeploymentTargetQueued?: (
      context: AppCloudflareAccountContext,
      deployment: AppCloudflareQueuedDeployment,
    ) => Promise<void>;
    temporaryEnabled?: () => boolean;
    byocEnabled?: () => boolean;
    turnstileEnabled?: () => boolean;
    turnstileSiteKey?: () => string | undefined;
  },
): void {
  const temporaryEnabled = (): boolean =>
    (deps.temporaryEnabled || (() => envFlag(ENV.PIWORK_APPS_TEMPORARY_ENABLED)))();
  const byocEnabled = (): boolean =>
    (deps.byocEnabled || (() => envFlag(ENV.PIWORK_APPS_BYOC_ENABLED)))();
  const turnstileEnabled = (): boolean =>
    (deps.turnstileEnabled || (() => envFlag(ENV.PIWORK_APPS_TURNSTILE_ENABLED)))();
  const requireTemporary = (): void => {
    if (!temporaryEnabled()) {
      throw new Error("Cloudflare temporary App publishing is disabled.");
    }
  };
  const requireByoc = (): void => {
    if (!byocEnabled()) {
      throw new Error("Cloudflare BYOC publishing is disabled.");
    }
  };

  const getBrowserConfig = (): AppCloudflareBrowserConfig => {
    const useTurnstile = turnstileEnabled();
    const siteKey = (
      useTurnstile
        ? (
            deps.turnstileSiteKey ||
            (() => environment.optionalString(ENV.PIWORK_APPS_TURNSTILE_SITE_KEY, false))
          )()
        : undefined
    )?.trim();
    if (useTurnstile && !siteKey) {
      throw new Error("Cloudflare Turnstile site key is not configured.");
    }
    return {
      temporaryEnabled: temporaryEnabled(),
      byocEnabled: byocEnabled(),
      turnstileEnabled: useTurnstile,
      siteKey: siteKey || null,
    };
  };
  const current = (): {
    user: AuthenticatedUser;
    context: AppCloudflareAccountContext;
  } => {
    const user = deps.getCurrentUser();
    if (!user) throw new Error("Unauthorized");
    if (!user.tenantId || !user.membershipId) throw new Error("Tenant membership not found.");
    return {
      user,
      context: {
        tenantId: user.tenantId,
        userId: user.userId,
        membershipId: user.membershipId,
      },
    };
  };

  const error = (c: any, cause: unknown) => {
    if (cause instanceof AppCloudflareNeedsOAuthError) {
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          error: cause.message,
          code: cause.code,
          requiredPermissionNames: cause.requiredPermissionNames,
        },
        409,
      );
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "temporary_preview_rate_limited"
    ) {
      const retryAfterSeconds =
        "retryAfterSeconds" in cause &&
        typeof cause.retryAfterSeconds === "number" &&
        Number.isFinite(cause.retryAfterSeconds)
          ? Math.max(1, Math.ceil(cause.retryAfterSeconds))
          : 1;
      c.header("Cache-Control", "no-store");
      c.header("Retry-After", String(retryAfterSeconds));
      return c.json({ error: message, code: "temporary_preview_rate_limited" }, 429);
    }
    const status = /Unauthorized/i.test(message)
      ? 401
      : /Forbidden|not permitted/i.test(message)
        ? 403
        : /not found/i.test(message)
          ? 404
          : /already|expired|stale|unavailable|inactive|selected/i.test(message)
            ? 409
            : /not configured|provisioning failed|exchange failed|refresh failed/i.test(message)
              ? 503
              : /disabled/i.test(message)
                ? 503
                : 400;
    c.header("Cache-Control", "no-store");
    return c.json({ error: message }, status);
  };

  const listConnections = async (c: any) => {
    try {
      requireByoc();
      return c.json({ connections: await deps.service.listConnections(current().context) });
    } catch (cause) {
      return error(c, cause);
    }
  };
  const config = async (c: any) => {
    try {
      current();
      c.header("Cache-Control", "no-store");
      return c.json(getBrowserConfig());
    } catch (cause) {
      return error(c, cause);
    }
  };
  api.get("/cloudflare/config", config);
  api.get("/apps/cloudflare/config", config);

  api.get("/cloudflare/connections", listConnections);
  api.get("/apps/cloudflare/connections", listConnections);

  api.get("/cloudflare/connections/:id", async (c) => {
    try {
      requireByoc();
      const connection = await deps.service.getConnection(current().context, c.req.param("id"));
      c.header("Cache-Control", "no-store");
      return c.json({ connection });
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.post("/apps/cloudflare/connections/:id/refresh", async (c) => {
    try {
      const connection = await deps.service.refreshConnection(current().context, c.req.param("id"));
      c.header("Cache-Control", "no-store");
      return c.json({ connection });
    } catch (cause) {
      return error(c, cause);
    }
  });

  const deleteConnection = async (c: any) => {
    try {
      requireByoc();
      await deps.service.revokeConnection(current().context, c.req.param("id"));
      return c.body(null, 204);
    } catch (cause) {
      return error(c, cause);
    }
  };
  api.delete("/cloudflare/connections/:id", deleteConnection);
  api.delete("/apps/cloudflare/connections/:id", deleteConnection);

  api.get("/cloudflare/connections/:id/zones", async (c) => {
    try {
      requireByoc();
      const zones = await deps.service.listConnectionZones(current().context, c.req.param("id"));
      c.header("Cache-Control", "no-store");
      return c.json({ zones });
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.get("/apps/cloudflare/temporary", async (c) => {
    try {
      return c.json({ previews: await deps.service.listTemporaryAccounts(current().context) });
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.post("/apps/cloudflare/temporary", async (c) => {
    try {
      requireTemporary();
      const body = await c.req.json().catch(() => ({}));
      const deploymentId = stringValue(body.deploymentId);
      if (!deploymentId) return c.json({ error: "deploymentId is required" }, 400);
      const ipAddress =
        stringValue(c.req.header("cf-connecting-ip")) ||
        stringValue(c.req.header("x-real-ip")) ||
        "unknown";
      const preview = await deps.service.provisionTemporaryAccount(current().context, {
        deploymentId,
        ipAddress: ipAddress.slice(0, 128),
        acceptedTermsOfService: body.acceptedTermsOfService === true,
        acceptedPrivacyPolicy: body.acceptedPrivacyPolicy === true,
        turnstileToken: stringValue(body.turnstileToken) || undefined,
      });
      c.header("Cache-Control", "no-store");
      return c.json({ preview }, 201);
    } catch (cause) {
      return error(c, cause);
    }
  });

  // The claim URL is itself a bearer credential. It is never returned as JSON,
  // cached, or made available to a tenant administrator who is not the owner.
  api.get("/apps/cloudflare/temporary/:id/claim", async (c) => {
    try {
      requireByoc();
      const claim = await deps.service.getTemporaryClaimUrl(current().context, c.req.param("id"));
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      return c.redirect(claim.claimUrl, 302);
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.get("/apps/deployments/:id", async (c) => {
    try {
      const deployment = await deps.service.getDeployment(current().context, c.req.param("id"));
      c.header("Cache-Control", "no-store");
      return c.json({ deployment });
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.get("/apps/deployments/:id/events", async (c) => {
    try {
      const events = await deps.service.listDeploymentEvents(current().context, c.req.param("id"));
      c.header("Cache-Control", "no-store");
      return c.json({ events });
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.get("/apps/deployments/:id/claim", async (c) => {
    try {
      requireByoc();
      const claim = await deps.service.getDeploymentClaimUrl(current().context, c.req.param("id"));
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      return c.redirect(claim.claimUrl, 302);
    } catch (cause) {
      return error(c, cause);
    }
  });

  const startOAuth = async (c: any) => {
    try {
      requireByoc();
      const requestContext = current().context;
      const body = await c.req.json().catch(() => ({}));
      const purpose = body.purpose;
      if (purpose !== "direct" && purpose !== "claim") {
        return c.json({ error: "purpose must be direct or claim" }, 400);
      }
      const deploymentId = stringValue(body.deploymentId);
      if (!deploymentId) return c.json({ error: "deploymentId is required" }, 400);
      const scope = body.scope === "tenant" ? "tenant" : "user";
      const authorization = await deps.service.startOAuth(requestContext, {
        purpose,
        scope,
        deploymentId,
        temporaryAccountId:
          stringValue(body.temporaryPreviewId) || stringValue(body.temporaryAccountId) || undefined,
        returnPath: stringValue(body.returnPath) || undefined,
      });
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      return c.json(authorization);
    } catch (cause) {
      return error(c, cause);
    }
  };
  api.post("/cloudflare/oauth/start", startOAuth);
  api.post("/apps/cloudflare/oauth/start", startOAuth);

  const finishOAuth = async (c: any) => {
    try {
      requireByoc();
      const state = stringValue(c.req.query("state"));
      const code = stringValue(c.req.query("code"));
      const providerError = stringValue(c.req.query("error"));
      if (!state) throw new Error("Cloudflare OAuth callback requires state.");
      const result = providerError
        ? await deps.service.cancelOAuth(current().context, state)
        : code
          ? await deps.service.finishOAuth(current().context, { state, code })
          : null;
      if (!result) throw new Error("Cloudflare OAuth callback requires code.");
      const redirect = new URL(result.returnPath, "https://piwork.invalid");
      redirect.searchParams.set("cloudflare", providerError ? "denied" : "connected");
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      return c.redirect(`${redirect.pathname}${redirect.search}${redirect.hash}`, 302);
    } catch (cause) {
      return error(c, cause);
    }
  };
  api.get("/cloudflare/oauth/callback", finishOAuth);
  api.get("/apps/cloudflare/oauth/callback", finishOAuth);

  api.get("/apps/cloudflare/targets/:appId", async (c) => {
    try {
      return c.json({
        target: await deps.service.getAppTarget(current().context, c.req.param("appId")),
      });
    } catch (cause) {
      return error(c, cause);
    }
  });

  api.post("/apps/deployments/:id/target", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const requestContext = current().context;
      if (body.target === "temporary") requireTemporary();
      if (body.target === "byoc") requireByoc();
      const deployment =
        body.target === "temporary"
          ? await (async () => {
              const terms =
                body.termsAcceptance && typeof body.termsAcceptance === "object"
                  ? body.termsAcceptance
                  : {};
              const ipAddress =
                stringValue(c.req.header("cf-connecting-ip")) ||
                stringValue(c.req.header("x-real-ip")) ||
                "unknown";
              const preview = await deps.service.provisionTemporaryAccount(requestContext, {
                deploymentId: c.req.param("id"),
                ipAddress: ipAddress.slice(0, 128),
                acceptedTermsOfService: terms.acceptedTermsOfService === true,
                acceptedPrivacyPolicy: terms.acceptedPrivacyPolicy === true,
                turnstileToken:
                  stringValue(terms.turnstileToken) ||
                  stringValue(body.turnstileToken) ||
                  undefined,
              });
              try {
                return await deps.service.selectDeploymentTarget(
                  requestContext,
                  c.req.param("id"),
                  {
                    target: "temporary",
                    temporaryAccountId: preview.id,
                  },
                );
              } catch (cause) {
                await deps.service
                  .releaseUnassignedTemporaryAccount(requestContext, c.req.param("id"), preview.id)
                  .catch(() => undefined);
                throw cause;
              }
            })()
          : body.target === "byoc"
            ? await deps.service.selectDeploymentTarget(requestContext, c.req.param("id"), {
                target: "byoc",
                connectionId: stringValue(body.connectionId),
              })
            : null;
      if (!deployment) return c.json({ error: "target must be temporary or byoc" }, 400);
      const resumable =
        deployment.phase === "queued" ||
        deployment.phase === "provisioning" ||
        deployment.phase === "deploying";
      if (resumable) await deps.onDeploymentTargetQueued?.(requestContext, deployment);
      const detail = await deps.service.getDeployment(requestContext, deployment.deploymentId);
      c.header("Cache-Control", "no-store");
      return c.json({ deployment: detail }, resumable ? 202 : 200);
    } catch (cause) {
      return error(c, cause);
    }
  });
}
