import { describe, expect, it } from "vitest";
import {
  analyzeTemporaryAppCapabilities,
  AppManifestError,
  assertTemporaryAppEligible,
  materializeAppBindingManifest,
  parsePiworkAppManifest,
  parsePiworkAppManifestText,
} from "./app-manifest.js";

const base = { version: 1, runtime: "cloudflare-workers", exposure: { workersDev: true } };

describe("Piwork App manifest", () => {
  it("normalizes explicit create/adopt BYOC resources", () => {
    const manifest = parsePiworkAppManifest({
      ...base,
      resources: {
        kv: [{ key: "cache", binding: "CACHE", mode: "create" }],
        d1: [
          {
            key: "db",
            binding: "DB",
            mode: "adopt",
            databaseId: "1234567890abcdef1234567890abcdef",
          },
        ],
        r2: [{ key: "files", binding: "FILES", mode: "adopt", bucketName: "existing-files" }],
        durableObjects: [
          { binding: "ROOMS", className: "Room", storage: "sqlite", state: "created" },
        ],
      },
    });
    expect(manifest.resources?.d1?.[0]?.databaseId).toBe("1234567890abcdef1234567890abcdef");
    expect(materializeAppBindingManifest(manifest).hasStatefulResources).toBe(true);
  });

  it("allows only stateless Worker and Assets in temporary accounts", () => {
    const eligible = parsePiworkAppManifest(base);
    expect(analyzeTemporaryAppCapabilities(eligible)).toEqual({ eligible: true, reasons: [] });
    const stateful = parsePiworkAppManifest({
      ...base,
      resources: { kv: [{ key: "cache", binding: "CACHE", mode: "create" }] },
    });
    expect(() => assertTemporaryAppEligible(stateful)).toThrow("require_byoc");
  });

  it("requires BYOC for an exact custom domain", () => {
    const manifest = parsePiworkAppManifest({
      ...base,
      exposure: {
        workersDev: true,
        requestedCustomDomain: "App.Example.com.",
      },
    });
    expect(manifest.exposure.requestedCustomDomain).toBe("app.example.com");
    expect(analyzeTemporaryAppCapabilities(manifest).reasons).toContain(
      "custom_domain_requires_byoc",
    );
  });

  it.each([
    [{ version: 2 }, "version"],
    [{ version: 1, runtime: "node", exposure: { workersDev: true } }, "runtime"],
    [{ ...base, storage: { kv: true } }, "unsupported field"],
    [{ ...base, resources: { queue: [] } }, "unsupported field"],
    [
      { ...base, resources: { kv: [{ key: "cache", binding: "CACHE", mode: "adopt" }] } },
      "namespaceId",
    ],
    [
      {
        ...base,
        resources: {
          d1: [{ key: "db", binding: "DB", mode: "create", databaseId: "a".repeat(32) }],
        },
      },
      "allowed only",
    ],
    [
      {
        ...base,
        resources: {
          durableObjects: [
            { binding: "ROOMS", className: "Room", storage: "sqlite", state: "deleted" },
          ],
        },
      },
      "state",
    ],
    [
      { ...base, exposure: { workersDev: true, requestedCustomDomain: "*.example.com" } },
      "requestedCustomDomain",
    ],
    [{ ...base, exposure: { workersDev: true, zoneId: "a".repeat(32) } }, "unsupported field"],
    [
      {
        ...base,
        resources: { r2: [{ key: "files", binding: "FILES", mode: "create", jurisdiction: "us" }] },
      },
      "jurisdiction",
    ],
    [
      {
        ...base,
        resources: { kv: [{ key: "cache", binding: "PIWORK_WRAPPER_CONFIG", mode: "create" }] },
      },
      "platform-reserved",
    ],
    [
      { ...base, resources: { kv: [{ key: "cache", binding: "ASSETS", mode: "create" }] } },
      "platform-reserved",
    ],
  ])("rejects unsupported, ambiguous, or destructive declarations", (value, message) => {
    expect(() => parsePiworkAppManifest(value)).toThrow(message);
  });

  it("returns a structured manifest error for malformed JSON", () => {
    expect(() => parsePiworkAppManifestText("{")).toThrowError(AppManifestError);
  });
});
