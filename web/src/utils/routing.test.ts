// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  parseHash,
  parseRoute,
  sessionPath,
  navigateToSession,
  navigateHome,
  navigateApps,
  setRouteContext,
} from "./routing.js";

describe("parseHash", () => {
  it("returns home for empty string", () => {
    expect(parseHash("")).toEqual({ page: "home" });
  });

  it("returns home for bare hash", () => {
    expect(parseHash("#/")).toEqual({ page: "home" });
  });

  it("returns home for unknown routes", () => {
    expect(parseHash("#/unknown")).toEqual({ page: "home" });
  });

  it("maps removed settings route to home", () => {
    expect(parseHash("#/settings")).toEqual({ page: "home" });
  });

  it("maps removed integrations route to home", () => {
    expect(parseHash("#/integrations")).toEqual({ page: "home" });
  });

  it("maps removed linear integration route to home", () => {
    expect(parseHash("#/integrations/linear")).toEqual({ page: "home" });
  });

  it("maps removed prompts route to home", () => {
    expect(parseHash("#/prompts")).toEqual({ page: "home" });
  });

  it("maps removed environments route to home", () => {
    expect(parseHash("#/environments")).toEqual({ page: "home" });
  });

  it("parses unknown removed routes as home", () => {
    expect(parseHash("#/legacy-builder")).toEqual({ page: "home" });
  });

  it("maps removed scheduled route to home", () => {
    expect(parseHash("#/scheduled")).toEqual({ page: "home" });
  });

  it("maps removed playground route to home", () => {
    expect(parseHash("#/playground")).toEqual({ page: "home" });
  });

  it("does not treat legacy hash session routes as valid session routes", () => {
    expect(parseHash("#/session/a1b2c3d4-e5f6-7890-abcd-ef1234567890")).toEqual({ page: "home" });
    expect(parseHash("#/session/abc123")).toEqual({ page: "home" });
  });

  it("returns home for session route with empty ID", () => {
    expect(parseHash("#/session/")).toEqual({ page: "home" });
  });
});

describe("parseRoute", () => {
  it("parses user and agent scoped session paths", () => {
    expect(
      parseRoute({
        pathname: "/testuser.mikoto/agent/session/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
        search: "",
        hash: "",
      }),
    ).toEqual({
      page: "session",
      userUuid: "testuser.mikoto",
      agentId: "agent",
      sessionId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    });
  });

  it("parses local path session routes without a hash", () => {
    expect(parseRoute({ pathname: "/session/abc123", search: "", hash: "" })).toEqual({
      page: "session",
      sessionId: "abc123",
    });
  });

  it("maps removed static demo routes to home", () => {
    expect(parseRoute({ pathname: "/theme-demo", search: "", hash: "" })).toEqual({ page: "home" });
    expect(parseRoute({ pathname: "/playground", search: "", hash: "" })).toEqual({ page: "home" });
  });

  it("parses the Apps resource route", () => {
    expect(parseRoute({ pathname: "/apps", search: "", hash: "" })).toEqual({ page: "apps" });
  });

  it("parses the development-only projection lab route", () => {
    expect(parseRoute({ pathname: "/lab/projection", search: "", hash: "" })).toEqual({
      page: "projectionLab",
    });
  });

  it("ignores legacy hash session routes", () => {
    expect(parseRoute({ pathname: "/", search: "", hash: "#/session/abc123" })).toEqual({
      page: "home",
    });
  });

  it("maps legacy non-session hash routes to home", () => {
    expect(parseRoute({ pathname: "/", search: "", hash: "#/settings" })).toEqual({ page: "home" });
  });
});

describe("sessionPath", () => {
  beforeEach(() => {
    setRouteContext({});
  });

  it("builds scoped path for a session ID", () => {
    expect(sessionPath("abc123", { userUuid: "testuser.mikoto", agentId: "agent" })).toBe(
      "/testuser.mikoto/agent/session/abc123",
    );
  });

  it("falls back to local path when no user context is available", () => {
    expect(sessionPath("abc123")).toBe("/session/abc123");
  });
});

describe("navigateToSession", () => {
  beforeEach(() => {
    setRouteContext({});
    history.replaceState(null, "", "/");
  });

  it("sets the path to a scoped session route", () => {
    navigateToSession("test-id", false, { userUuid: "testuser.mikoto", agentId: "agent" });
    expect(window.location.pathname).toBe("/testuser.mikoto/agent/session/test-id");
    expect(window.location.hash).toBe("");
  });

  it("uses replaceState when replace=true", () => {
    const spy = vi.spyOn(history, "replaceState");
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    navigateToSession("test-id", true, { userUuid: "testuser.mikoto", agentId: "agent" });
    expect(spy).toHaveBeenCalledWith(null, "", "/testuser.mikoto/agent/session/test-id");
    expect(dispatchSpy).toHaveBeenCalledWith(expect.any(PopStateEvent));
    spy.mockRestore();
    dispatchSpy.mockRestore();
  });

  it("does not dispatch a route change when the target session path is already current", () => {
    history.replaceState(null, "", "/testuser.mikoto/agent/session/test-id");
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    navigateToSession("test-id", true, { userUuid: "testuser.mikoto", agentId: "agent" });
    expect(dispatchSpy).not.toHaveBeenCalled();
    dispatchSpy.mockRestore();
  });
});

describe("navigateHome", () => {
  beforeEach(() => {
    setRouteContext({ userUuid: "testuser.mikoto", agentId: "agent" });
    history.replaceState(null, "", "/testuser.mikoto/agent/session/test");
  });

  it("navigates to the scoped user/agent home path", () => {
    navigateHome();
    expect(window.location.pathname).toBe("/testuser.mikoto/agent");
    expect(window.location.hash).toBe("");
  });

  it("uses replaceState when replace=true", () => {
    const spy = vi.spyOn(history, "replaceState");
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    navigateHome(true);
    expect(spy).toHaveBeenCalledWith(null, "", "/testuser.mikoto/agent");
    expect(dispatchSpy).toHaveBeenCalledWith(expect.any(PopStateEvent));
    spy.mockRestore();
    dispatchSpy.mockRestore();
  });

  it("does not dispatch a route change when the target home path is already current", () => {
    history.replaceState(null, "", "/testuser.mikoto/agent");
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    navigateHome(true);
    expect(dispatchSpy).not.toHaveBeenCalled();
    dispatchSpy.mockRestore();
  });

  it("can navigate to the root route after logout", () => {
    navigateHome(true, { userUuid: null, agentId: null });
    expect(window.location.pathname).toBe("/");
    expect(window.location.hash).toBe("");
  });
});

describe("navigateApps", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/session/test");
  });

  it("navigates to the Apps resource route", () => {
    navigateApps();
    expect(window.location.pathname).toBe("/apps");
    expect(window.location.hash).toBe("");
  });
});
