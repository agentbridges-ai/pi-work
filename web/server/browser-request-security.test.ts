import { describe, expect, it, vi } from "vitest";
import {
  EXPECTED_MEMBERSHIP_ID_HEADER,
  EXPECTED_TENANT_ID_HEADER,
  HUB_UPLOAD_BODY_LIMIT_BYTES,
  JSON_REQUEST_BODY_LIMIT_BYTES,
  USER_SPACE_BINARY_BODY_LIMIT_BYTES,
  buildTrustedBrowserOrigins,
  requestOriginAllowed,
  resolveTenantBoundRuntimePrincipal,
  secureAuthenticatedCookieApiRequest,
  secureCookieApiRequest,
} from "./browser-request-security.js";
import type { AuthenticatedUser } from "./auth-types.js";

const TRUSTED_ORIGIN = "https://workbench.example";
const TRUSTED_ORIGINS = [TRUSTED_ORIGIN];

function apiRequest(path: string, init: RequestInit & { origin?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.origin !== undefined) headers.set("Origin", init.origin);
  const requestInit: RequestInit & { duplex?: "half" } = { ...init, headers };
  if (init.body instanceof ReadableStream) requestInit.duplex = "half";
  return new Request(`https://api.example${path}`, requestInit);
}

function streamingBody(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("trusted browser origins", () => {
  it("builds one exact shared allowlist for Better Auth, API, and local Vite", () => {
    expect(
      buildTrustedBrowserOrigins({
        betterAuthUrl: "https://Workbench.Example/",
        apiPort: 3457,
        vitePort: 3458,
        includeDevelopmentOrigins: true,
      }),
    ).toEqual([
      "https://workbench.example",
      "http://127.0.0.1:3457",
      "http://localhost:3457",
      "http://127.0.0.1:3458",
      "http://localhost:3458",
    ]);
  });

  it("does not implicitly trust development or adjacent loopback origins in production", () => {
    expect(
      buildTrustedBrowserOrigins({
        betterAuthUrl: TRUSTED_ORIGIN,
        apiPort: 3456,
        vitePort: 3458,
        includeDevelopmentOrigins: false,
      }),
    ).toEqual([TRUSTED_ORIGIN]);
  });

  it("falls back to the exact local API origins when no public origin is configured", () => {
    expect(
      buildTrustedBrowserOrigins({
        apiPort: 3456,
        vitePort: 3458,
        includeDevelopmentOrigins: false,
      }),
    ).toEqual(["http://127.0.0.1:3456", "http://localhost:3456"]);
  });

  it("requires an exact, well-formed Origin", () => {
    expect(
      requestOriginAllowed(
        apiRequest("/ws/browser/session", { origin: TRUSTED_ORIGIN }),
        TRUSTED_ORIGINS,
      ),
    ).toBe(true);

    for (const origin of [
      undefined,
      "null",
      "https://workbench.example.evil.test",
      "https://workbench.example/path",
      "http://127.0.0.1:3459",
    ]) {
      expect(
        requestOriginAllowed(apiRequest("/ws/browser/session", { origin }), TRUSTED_ORIGINS),
      ).toBe(false);
    }
  });
});

describe("Cookie API request security", () => {
  it("uses the intended default hard limits", () => {
    expect(JSON_REQUEST_BODY_LIMIT_BYTES).toBe(1024 * 1024);
    expect(USER_SPACE_BINARY_BODY_LIMIT_BYTES).toBe(100 * 1024 * 1024);
    expect(HUB_UPLOAD_BODY_LIMIT_BYTES).toBe(50 * 1024 * 1024);
  });

  it("rejects an unauthenticated slow protected body without consuming it", async () => {
    const body = new ReadableStream<Uint8Array>({
      // Deliberately never enqueue or close: reading before authentication
      // would leave the request pending indefinitely.
      start() {},
    });
    const request = apiRequest("/api/user-space-transfer/session/blob/checkout/token/upload", {
      method: "PUT",
      origin: TRUSTED_ORIGIN,
      headers: { "Content-Type": "application/octet-stream" },
      body,
    });
    const authenticate = vi.fn(async () => ({
      ok: false as const,
      response: Response.json({ error: "Unauthorized" }, { status: 401 }),
    }));

    const result = await secureAuthenticatedCookieApiRequest(
      request,
      { trustedOrigins: TRUSTED_ORIGINS },
      authenticate,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(request.bodyUsed).toBe(false);
    await request.body?.cancel();
  });

  it("buffers an authenticated protected body after authentication", async () => {
    const request = apiRequest("/api/preferences", {
      method: "PUT",
      origin: TRUSTED_ORIGIN,
      headers: { "Content-Type": "application/json" },
      body: streamingBody('{"language":', '"zh-CN"}'),
    });
    const authenticate = vi.fn(async (candidate: Request) => {
      expect(candidate.bodyUsed).toBe(false);
      return { ok: true as const };
    });

    const result = await secureAuthenticatedCookieApiRequest(
      request,
      { trustedOrigins: TRUSTED_ORIGINS },
      authenticate,
    );

    expect(result.ok).toBe(true);
    expect(authenticate).toHaveBeenCalledOnce();
    expect(request.bodyUsed).toBe(true);
    if (result.ok) {
      await expect(result.request.json()).resolves.toEqual({ language: "zh-CN" });
    }
  });

  it("accepts runtimes whose request-body reader cannot release its lock", async () => {
    const request = apiRequest("/api/preferences", {
      method: "PUT",
      origin: TRUSTED_ORIGIN,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "zh-CN" }),
    });
    const stream = request.body;
    expect(stream).not.toBeNull();
    if (!stream) return;

    const getReader = stream.getReader.bind(stream);
    vi.spyOn(stream, "getReader").mockImplementation(() => {
      const reader = getReader();
      return {
        read: reader.read.bind(reader),
        cancel: reader.cancel.bind(reader),
      } as ReadableStreamDefaultReader<Uint8Array>;
    });

    const result = await secureCookieApiRequest(request, {
      trustedOrigins: TRUSTED_ORIGINS,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      await expect(result.request.json()).resolves.toEqual({ language: "zh-CN" });
    }
  });

  it("does not replace a valid body result when a runtime release hook throws", async () => {
    const request = apiRequest("/api/preferences", {
      method: "PUT",
      origin: TRUSTED_ORIGIN,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language: "en-US" }),
    });
    const stream = request.body;
    expect(stream).not.toBeNull();
    if (!stream) return;

    const getReader = stream.getReader.bind(stream);
    vi.spyOn(stream, "getReader").mockImplementation(() => {
      const reader = getReader();
      const releaseLock = Object.setPrototypeOf(() => {
        throw new TypeError("Runtime lock release failed");
      }, null) as () => void;
      return {
        read: reader.read.bind(reader),
        cancel: reader.cancel.bind(reader),
        releaseLock,
      } as ReadableStreamDefaultReader<Uint8Array>;
    });

    const result = await secureCookieApiRequest(request, {
      trustedOrigins: TRUSTED_ORIGINS,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      await expect(result.request.json()).resolves.toEqual({ language: "en-US" });
    }
  });

  it("performs cheap origin and declared-size checks before authentication", async () => {
    const authenticate = vi.fn(async () => ({ ok: true as const }));
    const foreignOrigin = await secureAuthenticatedCookieApiRequest(
      apiRequest("/api/preferences", {
        method: "PUT",
        origin: "https://attacker.example",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
      { trustedOrigins: TRUSTED_ORIGINS },
      authenticate,
    );
    const oversized = await secureAuthenticatedCookieApiRequest(
      apiRequest("/api/preferences", {
        method: "PUT",
        origin: TRUSTED_ORIGIN,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(JSON_REQUEST_BODY_LIMIT_BYTES + 1),
        },
        body: "{}",
      }),
      { trustedOrigins: TRUSTED_ORIGINS },
      authenticate,
    );

    expect(foreignOrigin.ok).toBe(false);
    if (!foreignOrigin.ok) expect(foreignOrigin.response.status).toBe(403);
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.response.status).toBe(413);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("fails closed for unsafe requests with a missing or foreign Origin", async () => {
    for (const origin of [undefined, "https://attacker.example"]) {
      const result = await secureCookieApiRequest(
        apiRequest("/api/sessions", { method: "POST", origin }),
        { trustedOrigins: TRUSTED_ORIGINS },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(403);
    }
  });

  it("does not apply the Cookie API policy to internal capability routes", async () => {
    const request = apiRequest("/internal/user-space-transfer/session/operation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "read_file" }),
    });
    const result = await secureCookieApiRequest(request, {
      trustedOrigins: TRUSTED_ORIGINS,
    });
    expect(result).toEqual({ ok: true, request });
  });

  it("allows safe requests without Origin and bodyless actions with a trusted Origin", async () => {
    const safe = await secureCookieApiRequest(apiRequest("/api/sessions"), {
      trustedOrigins: TRUSTED_ORIGINS,
    });
    expect(safe.ok).toBe(true);

    const action = await secureCookieApiRequest(
      apiRequest("/api/sessions/session/recording/start", {
        method: "POST",
        origin: TRUSTED_ORIGIN,
      }),
      { trustedOrigins: TRUSTED_ORIGINS },
    );
    expect(action.ok).toBe(true);
  });

  it("accepts application/json and application/*+json, then rebuilds the body", async () => {
    for (const contentType of ["application/json; charset=utf-8", "application/vnd.piwork+json"]) {
      const result = await secureCookieApiRequest(
        apiRequest("/api/preferences", {
          method: "PUT",
          origin: TRUSTED_ORIGIN,
          headers: { "Content-Type": contentType },
          body: JSON.stringify({ language: "zh-CN" }),
        }),
        { trustedOrigins: TRUSTED_ORIGINS },
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        await expect(result.request.json()).resolves.toEqual({ language: "zh-CN" });
      }
    }
  });

  it("returns 415 for a non-JSON product API body and 400 for malformed JSON", async () => {
    const headerCases: HeadersInit[] = [{}, { "Content-Type": "text/plain" }];
    for (const headers of headerCases) {
      const wrongType = await secureCookieApiRequest(
        apiRequest("/api/preferences", {
          method: "PUT",
          origin: TRUSTED_ORIGIN,
          headers,
          body: "{}",
        }),
        { trustedOrigins: TRUSTED_ORIGINS },
      );
      expect(wrongType.ok).toBe(false);
      if (!wrongType.ok) expect(wrongType.response.status).toBe(415);
    }

    const malformed = await secureCookieApiRequest(
      apiRequest("/api/preferences", {
        method: "PUT",
        origin: TRUSTED_ORIGIN,
        headers: { "Content-Type": "application/json" },
        body: "{not-json",
      }),
      { trustedOrigins: TRUSTED_ORIGINS },
    );
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.response.status).toBe(400);
  });

  it("rejects an oversized Content-Length before consuming the body", async () => {
    const result = await secureCookieApiRequest(
      apiRequest("/api/preferences", {
        method: "PUT",
        origin: TRUSTED_ORIGIN,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(JSON_REQUEST_BODY_LIMIT_BYTES + 1),
        },
        body: "{}",
      }),
      { trustedOrigins: TRUSTED_ORIGINS },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it("rejects a malformed Content-Length", async () => {
    const result = await secureCookieApiRequest(
      apiRequest("/api/preferences", {
        method: "PUT",
        origin: TRUSTED_ORIGIN,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": "not-a-number",
        },
        body: "{}",
      }),
      { trustedOrigins: TRUSTED_ORIGINS },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });

  it("enforces the byte limit while reading a request without Content-Length", async () => {
    const result = await secureCookieApiRequest(
      apiRequest("/api/preferences", {
        method: "PUT",
        origin: TRUSTED_ORIGIN,
        headers: { "Content-Type": "application/json" },
        body: streamingBody('{"a":', "true}"),
      }),
      { trustedOrigins: TRUSTED_ORIGINS, limits: { jsonBytes: 8 } },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
  });

  it("preserves Better Auth form and JSON request compatibility", async () => {
    const form = await secureCookieApiRequest(
      apiRequest("/api/auth/sign-in/email", {
        method: "POST",
        origin: TRUSTED_ORIGIN,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "email=user%40example.test&password=secret",
      }),
      { trustedOrigins: TRUSTED_ORIGINS },
    );
    expect(form.ok).toBe(true);
    if (form.ok) {
      await expect(form.request.text()).resolves.toBe("email=user%40example.test&password=secret");
    }

    const json = await secureCookieApiRequest(
      apiRequest("/api/auth/sign-in/email", {
        method: "POST",
        origin: TRUSTED_ORIGIN,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@example.test", password: "secret" }),
      }),
      { trustedOrigins: TRUSTED_ORIGINS },
    );
    expect(json.ok).toBe(true);
  });

  it("allows only the explicit bounded User Space binary upload exception", async () => {
    const upload = await secureCookieApiRequest(
      apiRequest("/api/user-space-transfer/session/blob/checkout/transfer/upload", {
        method: "PUT",
        origin: TRUSTED_ORIGIN,
        headers: { "Content-Type": "image/png" },
        body: new Uint8Array([1, 2, 3]),
      }),
      { trustedOrigins: TRUSTED_ORIGINS, limits: { userSpaceBinaryBytes: 3 } },
    );
    expect(upload.ok).toBe(true);
    if (upload.ok) {
      expect(new Uint8Array(await upload.request.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    }

    const oversized = await secureCookieApiRequest(
      apiRequest("/api/user-space-transfer/session/blob/checkout/transfer/upload", {
        method: "PUT",
        origin: TRUSTED_ORIGIN,
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
      { trustedOrigins: TRUSTED_ORIGINS, limits: { userSpaceBinaryBytes: 3 } },
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.response.status).toBe(413);
  });

  it("allows only bounded text or multipart Recording Hub uploads", async () => {
    for (const contentType of ["text/plain", "multipart/form-data; boundary=example"]) {
      const upload = await secureCookieApiRequest(
        apiRequest("/api/hub/recordings/upload", {
          method: "POST",
          origin: TRUSTED_ORIGIN,
          headers: { "Content-Type": contentType },
          body: "data",
        }),
        { trustedOrigins: TRUSTED_ORIGINS, limits: { hubUploadBytes: 4 } },
      );
      expect(upload.ok).toBe(true);
    }

    const wrongType = await secureCookieApiRequest(
      apiRequest("/api/hub/recordings/upload", {
        method: "POST",
        origin: TRUSTED_ORIGIN,
        headers: { "Content-Type": "application/octet-stream" },
        body: "data",
      }),
      { trustedOrigins: TRUSTED_ORIGINS },
    );
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.response.status).toBe(415);

    const oversized = await secureCookieApiRequest(
      apiRequest("/api/hub/recordings/upload", {
        method: "POST",
        origin: TRUSTED_ORIGIN,
        headers: { "Content-Type": "text/plain" },
        body: "data!",
      }),
      { trustedOrigins: TRUSTED_ORIGINS, limits: { hubUploadBytes: 4 } },
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.response.status).toBe(413);
  });
});

describe("tenant-bound runtime API requests", () => {
  const authenticatedUser: AuthenticatedUser = {
    userId: "user-a",
    uuid: "user-a",
    username: "user-a",
    displayName: "User A",
    orgId: "local",
    orgName: "Local",
    roles: [],
  };
  const tenantAUser: AuthenticatedUser = {
    ...authenticatedUser,
    tenantId: "tenant-a",
    tenantName: "Tenant A",
    tenantType: "team",
    membershipId: "membership-a",
    orgId: "tenant-a",
    orgName: "Tenant A",
  };
  const tenantBUser: AuthenticatedUser = {
    ...authenticatedUser,
    tenantId: "tenant-b",
    tenantName: "Tenant B",
    tenantType: "team",
    membershipId: "membership-b",
    orgId: "tenant-b",
    orgName: "Tenant B",
  };

  function tenantRequest(
    path: string,
    method: "GET" | "PUT",
    tenantId: string,
    membershipId: string,
  ) {
    return apiRequest(path, {
      method,
      headers: {
        [EXPECTED_TENANT_ID_HEADER]: tenantId,
        [EXPECTED_MEMBERSHIP_ID_HEADER]: membershipId,
        ...(method === "PUT" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "PUT" ? { body: "{}" } : {}),
    });
  }

  it("rejects a tenant A request that arrives after the authenticated user switched to B", async () => {
    const result = await resolveTenantBoundRuntimePrincipal(
      tenantRequest("/api/workspace/session-state", "PUT", "tenant-a", "membership-a"),
      authenticatedUser,
      async () => tenantBUser,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(409);
      await expect(result.response.json()).resolves.toMatchObject({
        code: "tenant_context_conflict",
      });
    }
  });

  it("accepts normal GET, PUT, and tenant switching only after an exact live membership match", async () => {
    for (const request of [
      tenantRequest("/api/workspace/bootstrap", "GET", "tenant-a", "membership-a"),
      tenantRequest("/api/workspace/session-state", "PUT", "tenant-a", "membership-a"),
      tenantRequest("/api/tenants/active", "PUT", "tenant-a", "membership-a"),
    ]) {
      const result = await resolveTenantBoundRuntimePrincipal(
        request,
        authenticatedUser,
        async () => tenantAUser,
      );
      expect(result).toEqual({ ok: true, user: tenantAUser });
    }
  });

  it("does not treat forged tenant headers as authorization", async () => {
    const result = await resolveTenantBoundRuntimePrincipal(
      tenantRequest("/api/workspace/bootstrap", "GET", "tenant-b", "membership-b"),
      authenticatedUser,
      async () => tenantAUser,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(409);
  });

  it("fails closed when a runtime request omits its tenant binding", async () => {
    const result = await resolveTenantBoundRuntimePrincipal(
      apiRequest("/api/workspace/bootstrap"),
      authenticatedUser,
      async () => tenantAUser,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(409);
  });

  it("accepts a headerless session resource only when its server-side owner is the live membership", async () => {
    const request = apiRequest("/api/sessions/session-a/history");
    const accepted = await resolveTenantBoundRuntimePrincipal(
      request,
      authenticatedUser,
      async () => tenantAUser,
      { resourcePrincipal: tenantAUser },
    );
    expect(accepted).toEqual({ ok: true, user: tenantAUser });

    const stale = await resolveTenantBoundRuntimePrincipal(
      request,
      authenticatedUser,
      async () => tenantBUser,
      { resourcePrincipal: tenantAUser },
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.response.status).toBe(409);
  });

  it("allows first-time onboarding without a pre-existing browser tenant principal", async () => {
    const result = await resolveTenantBoundRuntimePrincipal(
      apiRequest("/api/onboarding/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "personal" }),
      }),
      authenticatedUser,
      async () => tenantAUser,
    );

    expect(result).toEqual({ ok: true, user: tenantAUser });
  });
});
