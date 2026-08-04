import { describe, expect, it } from "vitest";
import { assertSecureNetworkExposure, isLoopbackHost } from "./network-security.js";

describe("network exposure startup policy", () => {
  it.each(["127.0.0.1", "127.10.20.30", "localhost", "::1", "[::1]"])(
    "recognizes loopback host %s",
    (host) => expect(isLoopbackHost(host)).toBe(true),
  );

  it.each(["0.0.0.0", "192.168.1.10", "example.test", "::"])(
    "recognizes non-loopback host %s",
    (host) => expect(isLoopbackHost(host)).toBe(false),
  );

  it("permits the frictionless local bootstrap configuration", () => {
    expect(() =>
      assertSecureNetworkExposure({
        host: "127.0.0.1",
        publicOrigin: "http://127.0.0.1:3457",
        registrationEnabled: true,
        sessionSandbox: undefined,
        requireSessionSandbox: false,
      }),
    ).not.toThrow();
  });

  it("rejects open registration or an optional sandbox on a network listener", () => {
    expect(() =>
      assertSecureNetworkExposure({
        host: "0.0.0.0",
        publicOrigin: "http://example.test",
        registrationEnabled: true,
        sessionSandbox: "srt",
        requireSessionSandbox: false,
      }),
    ).toThrow(/registration.*sandbox/i);
  });

  it("rejects a network listener without an exact HTTPS public origin", () => {
    for (const publicOrigin of [
      undefined,
      "http://piwork.example.test",
      "https://user:pass@piwork.example.test",
      "https://piwork.example.test/path",
      "https://piwork.example.test?token=secret",
    ]) {
      expect(() =>
        assertSecureNetworkExposure({
          host: "10.0.0.5",
          publicOrigin,
          registrationEnabled: false,
          sessionSandbox: "srt",
          requireSessionSandbox: true,
        }),
      ).toThrow(/HTTPS origin/i);
    }
  });

  it("permits a closed-registration HTTPS listener with fail-closed SRT", () => {
    expect(() =>
      assertSecureNetworkExposure({
        host: "10.0.0.5",
        publicOrigin: "https://piwork.example.test",
        registrationEnabled: false,
        sessionSandbox: "srt",
        requireSessionSandbox: true,
      }),
    ).not.toThrow();
  });

  it("permits the fixed Compose internal proxy listener only with required SRT", () => {
    expect(() =>
      assertSecureNetworkExposure({
        host: "0.0.0.0",
        publicOrigin: "http://127.0.0.1:3457",
        registrationEnabled: true,
        sessionSandbox: "srt",
        requireSessionSandbox: true,
        internalProxyOnly: true,
      }),
    ).not.toThrow();

    expect(() =>
      assertSecureNetworkExposure({
        host: "0.0.0.0",
        registrationEnabled: true,
        sessionSandbox: undefined,
        requireSessionSandbox: false,
        internalProxyOnly: true,
      }),
    ).toThrow(/SRT/i);
  });
});
