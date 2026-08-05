import { describe, expect, it } from "vitest";
import {
  APP_DEPLOYMENT_LAB_SCENARIOS,
  appsDeploymentLabEnabled,
  getAppsDeploymentLabFixture,
  listAppsDeploymentLabFixtures,
} from "./apps-deployment-lab.js";

describe("Apps Deployment Lab", () => {
  it("contains all public provider replay scenarios without secrets", () => {
    const fixtures = listAppsDeploymentLabFixtures();
    expect(fixtures.map((fixture) => fixture.scenario)).toEqual([...APP_DEPLOYMENT_LAB_SCENARIOS]);
    const serialised = JSON.stringify(fixtures);
    expect(serialised).not.toMatch(/apiToken|accessToken|refreshToken|claimToken|Bearer/i);
    expect(fixtures.every((fixture) => fixture.events.length > 0 && fixture.http.length > 0)).toBe(
      true,
    );
  });

  it("returns a defensive copy and does not run a local runtime", () => {
    const first = getAppsDeploymentLabFixture("temporary_success");
    first.events[0]!.phase = "failed";
    expect(getAppsDeploymentLabFixture("temporary_success").events[0]!.phase).toBe("queued");
  });

  it("is dev-only and explicitly disabled by default", () => {
    expect(appsDeploymentLabEnabled({ NODE_ENV: "development" })).toBe(false);
    expect(
      appsDeploymentLabEnabled({ NODE_ENV: "development", PIWORK_APPS_LAB_ENABLED: "1" }),
    ).toBe(true);
    expect(appsDeploymentLabEnabled({ NODE_ENV: "production", PIWORK_APPS_LAB_ENABLED: "1" })).toBe(
      false,
    );
  });
});
