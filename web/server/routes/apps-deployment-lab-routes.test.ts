import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { registerAppsDeploymentLabRoutes } from "./apps-deployment-lab-routes.js";

describe("Apps Deployment Lab route", () => {
  it("is disabled by default and in production", async () => {
    const api = new Hono();
    registerAppsDeploymentLabRoutes(api, { env: { NODE_ENV: "development" } });
    expect((await api.request("/lab/apps")).status).toBe(404);
    const production = new Hono();
    registerAppsDeploymentLabRoutes(production, {
      env: { NODE_ENV: "production", PIWORK_APPS_LAB_ENABLED: "1" },
    });
    expect((await production.request("/lab/apps")).status).toBe(404);
  });

  it("replays only a sanitised fixture when explicitly enabled", async () => {
    const api = new Hono();
    registerAppsDeploymentLabRoutes(api, {
      env: { NODE_ENV: "development", PIWORK_APPS_LAB_ENABLED: "1" },
    });
    const response = await api.request("/lab/apps?scenario=domain_conflict");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { fixture: { scenario: string; http: unknown[] } };
    expect(body.fixture.scenario).toBe("domain_conflict");
    expect(body.fixture.http.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toMatch(/apiToken|claimUrl|accessToken|refreshToken/i);
  });

  it("is reachable only through the development API mount", async () => {
    const root = new Hono();
    const api = new Hono();
    registerAppsDeploymentLabRoutes(api, {
      env: { NODE_ENV: "development", PIWORK_APPS_LAB_ENABLED: "true" },
    });
    root.route("/api", api);

    expect((await root.request("/lab/apps")).status).toBe(404);
    expect((await root.request("/api/lab/apps?scenario=temporary_success")).status).toBe(200);
  });
});
