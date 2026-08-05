import { env, exports } from "cloudflare:workers";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  createAppWorkerWrapper,
  parseAppWorkerWrapperConfig,
  type AppWorkerWrapperEnv,
} from "../src/wrapper";
import { createRuntimeWrapperModuleSource } from "../src/runtime-wrapper-source";

describe("ordinary Worker wrapper", () => {
  it("strips Piwork credentials and exposes no undeclared bindings", async () => {
    const response = await exports.default.fetch("https://app.example.test/", {
      headers: {
        authorization: "Bearer user-token",
        "proxy-authorization": "Basic proxy-token",
        cookie: "app_session=keep; better-auth.session_token=remove",
        "x-piwork-forged": "remove",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authorization: null,
      proxyAuthorization: null,
      cookie: "app_session=keep",
      piworkHeader: null,
      visibleBindings: [],
    });
  });

  it("reserves Piwork paths from App code", async () => {
    for (const path of ["/__piwork", "/__piwork/control"]) {
      const response = await exports.default.fetch(`https://app.example.test${path}`);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "not_found" });
    }
  });

  it("passes only declared, present resource bindings", async () => {
    const wrapper = createAppWorkerWrapper({
      fetch(_request, bindings) {
        return Response.json(Object.keys(bindings));
      },
    });
    const response = await wrapper.fetch!(
      new Request("https://app.example.test/"),
      wrapperEnv({
        allowedBindings: ["CACHE"],
        CACHE: { namespace: "app" },
        SECRET: "hidden",
      }),
      createExecutionContext(),
    );

    await expect(response.json()).resolves.toEqual(["CACHE"]);
  });

  it("fails closed when a declared resource binding is absent", async () => {
    const wrapper = createAppWorkerWrapper({ fetch: () => new Response("unexpected") });
    const response = await wrapper.fetch!(
      new Request("https://app.example.test/"),
      wrapperEnv({ allowedBindings: ["DB"] }),
      createExecutionContext(),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "wrapper_binding_unavailable" });
  });

  it("rejects unknown configuration and binding names", () => {
    expect(() => parseAppWorkerWrapperConfig("not-json")).toThrow("invalid_wrapper_config");
    expect(() =>
      parseAppWorkerWrapperConfig(
        JSON.stringify({
          schemaVersion: 1,
          appId: "app_test",
          exposure: "legacy",
          allowedBindings: [],
        }),
      ),
    ).toThrow("invalid_wrapper_config");
    expect(() =>
      parseAppWorkerWrapperConfig(
        JSON.stringify({
          schemaVersion: 1,
          appId: "app_test",
          allowedBindings: ["PIWORK_WRAPPER_CONFIG"],
        }),
      ),
    ).toThrow("invalid_wrapper_config");
  });

  it("generates the production wrapper entrypoint with the same security boundary", () => {
    const source = createRuntimeWrapperModuleSource("worker.mjs");
    expect(source).toContain('import app from "./worker.mjs"');
    expect(source).toContain('export * from "./worker.mjs"');
    expect(source).toContain('headers.delete("authorization")');
    expect(source).toContain('name.toLowerCase().startsWith("x-piwork-")');
    expect(source).toContain("better-auth");
    expect(source).toContain('url.pathname === "/__piwork"');
  });
});

function wrapperEnv(
  overrides: Record<string, unknown> & {
    allowedBindings?: string[];
  } = {},
): AppWorkerWrapperEnv {
  const { allowedBindings = [], ...bindings } = overrides;
  return {
    ...env,
    ...bindings,
    PIWORK_WRAPPER_CONFIG: JSON.stringify({
      schemaVersion: 1,
      appId: "app_test",
      allowedBindings,
    }),
  } as AppWorkerWrapperEnv;
}
