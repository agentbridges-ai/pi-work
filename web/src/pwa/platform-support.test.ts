import { describe, expect, it } from "vitest";
import { detectPlatformSupport, type PlatformSupportInput } from "./platform-support.js";

const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

function detect(overrides: PlatformSupportInput = {}) {
  return detectPlatformSupport({
    userAgent: DESKTOP_CHROME_UA,
    platform: "Win32",
    maxTouchPoints: 0,
    isSecureContext: true,
    hasServiceWorker: true,
    ...overrides,
  });
}

describe("detectPlatformSupport", () => {
  it.each([
    {
      label: "Chrome from its user agent",
      input: {},
    },
    {
      label: "Chromium from User-Agent Client Hints",
      input: {
        userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Safari/537.36",
        userAgentData: {
          mobile: false,
          brands: [
            { brand: "Not_A Brand", version: "99" },
            { brand: "Chromium", version: "136" },
          ],
        },
      },
    },
    {
      label: "Microsoft Edge",
      input: {
        userAgent: `${DESKTOP_CHROME_UA} Edg/136.0.0.0`,
      },
    },
  ])("supports desktop Chromium: $label", ({ input }) => {
    expect(detect(input)).toMatchObject({
      platform: "desktop-chromium",
      supported: true,
    });
  });

  it.each([
    {
      label: "User-Agent Client Hints reports mobile",
      input: {
        userAgentData: { mobile: true, brands: [{ brand: "Chromium", version: "136" }] },
      },
    },
    {
      label: "Android Chrome",
      input: {
        userAgent:
          "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Mobile Safari/537.36",
      },
    },
    {
      label: "iPhone Safari",
      input: {
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 Version/18.5 Mobile/15E148 Safari/604.1",
      },
    },
    {
      label: "iPadOS requesting a desktop site",
      input: {
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.5 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 5,
      },
    },
  ])("rejects mobile clients before considering their browser: $label", ({ input }) => {
    expect(detect(input)).toMatchObject({
      platform: "mobile",
      supported: false,
    });
  });

  it("classifies desktop Safari explicitly", () => {
    const result = detect({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 0,
    });

    expect(result).toMatchObject({ platform: "safari", supported: false });
  });

  it("classifies desktop Firefox explicitly", () => {
    const result = detect({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:139.0) Gecko/20100101 Firefox/139.0",
      platform: "MacIntel",
    });

    expect(result).toMatchObject({ platform: "firefox", supported: false });
  });

  it.each([
    ["an unknown browser", "ExampleBrowser/1.0"],
    ["an embedded Electron runtime", `${DESKTOP_CHROME_UA} Electron/36.0.0`],
  ])("classifies %s as other", (_label, userAgent) => {
    expect(detect({ userAgent })).toMatchObject({
      platform: "other",
      supported: false,
    });
  });

  it("does not mistake a touch-enabled desktop Chromium device for mobile", () => {
    const result = detect({
      platform: "Win32",
      maxTouchPoints: 10,
    });

    expect(result).toMatchObject({ platform: "desktop-chromium", supported: true });
  });

  it("reports PWA prerequisites without blocking supported desktop Chromium", () => {
    const insecure = detect({ isSecureContext: false });
    expect(insecure).toEqual({
      platform: "desktop-chromium",
      supported: true,
      pwa: {
        available: false,
        secureContext: false,
        serviceWorker: true,
        issues: ["insecure-context"],
      },
    });

    const missingServiceWorker = detect({ hasServiceWorker: false });
    expect(missingServiceWorker).toEqual({
      platform: "desktop-chromium",
      supported: true,
      pwa: {
        available: false,
        secureContext: true,
        serviceWorker: false,
        issues: ["service-worker-unavailable"],
      },
    });
  });

  it("reports every missing PWA prerequisite", () => {
    expect(detect({ isSecureContext: false, hasServiceWorker: false }).pwa).toEqual({
      available: false,
      secureContext: false,
      serviceWorker: false,
      issues: ["insecure-context", "service-worker-unavailable"],
    });
  });

  it("keeps technical PWA capability independent from the product platform gate", () => {
    const result = detect({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.5 Safari/605.1.15",
      platform: "MacIntel",
      maxTouchPoints: 0,
    });

    expect(result.supported).toBe(false);
    expect(result.pwa).toEqual({
      available: true,
      secureContext: true,
      serviceWorker: true,
      issues: [],
    });
  });
});
