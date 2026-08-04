import type { Hono } from "hono";
import {
  appsDeploymentLabEnabled,
  APP_DEPLOYMENT_LAB_SCENARIOS,
  getAppsDeploymentLabFixture,
} from "../apps-deployment-lab.js";

/** Development-only event/HTTP fixture replay; it never starts a Worker. */
export function registerAppsDeploymentLabRoutes(
  api: Hono,
  options: { env?: NodeJS.ProcessEnv } = {},
): void {
  api.get("/lab/apps", (c) => {
    if (!appsDeploymentLabEnabled(options.env)) return c.json({ error: "Not found" }, 404);
    const requested = c.req.query("scenario");
    const scenario = APP_DEPLOYMENT_LAB_SCENARIOS.includes(
      requested as (typeof APP_DEPLOYMENT_LAB_SCENARIOS)[number],
    )
      ? (requested as (typeof APP_DEPLOYMENT_LAB_SCENARIOS)[number])
      : APP_DEPLOYMENT_LAB_SCENARIOS[0];
    c.header("Cache-Control", "no-store");
    return c.json({
      scenarios: APP_DEPLOYMENT_LAB_SCENARIOS,
      fixture: getAppsDeploymentLabFixture(scenario),
    });
  });
}
