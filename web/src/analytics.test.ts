// @vitest-environment jsdom

describe("analytics", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    localStorage.clear();
  });

  it("stays disabled even when legacy analytics environment variables are present", async () => {
    // Validates the local-first product boundary: analytics never initializes a
    // third-party client, even if old analytics env vars are configured.
    vi.stubEnv("VITE_ANALYTICS_KEY", "legacy-test-key");
    vi.stubEnv("VITE_ANALYTICS_HOST", "https://analytics.example.test");
    const mod = await import("./analytics.js");

    expect(mod.initAnalytics()).toBe(false);
    expect(mod.isAnalyticsEnabled()).toBe(false);
    expect(mod.getTelemetryPreferenceEnabled()).toBe(false);
  });

  it("keeps event, error, and pageview capture as safe no-ops", async () => {
    // Callers can keep invoking the wrappers, but nothing leaves the browser.
    const mod = await import("./analytics.js");

    expect(() => mod.captureEvent("test_event", { foo: "bar" })).not.toThrow();
    expect(() => mod.captureException(new Error("boom"), { source: "unit_test" })).not.toThrow();
    expect(() => mod.capturePageView("#/settings")).not.toThrow();
  });

  it("ignores legacy telemetry preference writes", async () => {
    // The setter remains for compatibility while the feature is removed.
    const mod = await import("./analytics.js");

    mod.setTelemetryPreferenceEnabled(true);

    expect(mod.isAnalyticsEnabled()).toBe(false);
    expect(mod.getTelemetryPreferenceEnabled()).toBe(false);
    expect(localStorage.getItem("piwork-telemetry-enabled")).toBeNull();
  });
});
