import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_OAUTH_SCOPE_CATALOG_SOURCE,
  CLOUDFLARE_PERMISSION_NAMES,
  hashCloudflareOAuthScopeEntries,
  parseCloudflareOAuthScopeCatalog,
  resolveCloudflareOAuthScopes,
  verifyCloudflareProviderScopeCatalog,
} from "./apps-cloudflare-oauth-scopes.js";

const scopes = [
  { name: CLOUDFLARE_PERMISSION_NAMES.workersScriptsWrite, id: "provider.workers.write" },
  { name: CLOUDFLARE_PERMISSION_NAMES.workersKvStorageWrite, id: "provider.kv.write" },
  { name: CLOUDFLARE_PERMISSION_NAMES.d1Write, id: "provider.d1.write" },
  { name: CLOUDFLARE_PERMISSION_NAMES.workersR2StorageWrite, id: "provider.r2.write" },
  { name: CLOUDFLARE_PERMISSION_NAMES.zoneRead, id: "provider.zone.read" },
];

function document() {
  return {
    version: 1,
    source: CLOUDFLARE_OAUTH_SCOPE_CATALOG_SOURCE,
    generatedAt: "2026-08-04T08:00:00.000Z",
    scopes,
    hash: hashCloudflareOAuthScopeEntries(scopes),
  };
}

describe("Cloudflare OAuth scope catalog", () => {
  it("selects only the provider IDs required by the manifest", () => {
    const catalog = parseCloudflareOAuthScopeCatalog(document());
    expect(
      resolveCloudflareOAuthScopes(catalog, {
        kv: [{ key: "cache" }],
        d1: [],
        r2: [],
        durableObjects: [],
        exposure: {},
      }),
    ).toEqual({
      names: [
        CLOUDFLARE_PERMISSION_NAMES.workersScriptsWrite,
        CLOUDFLARE_PERMISSION_NAMES.workersKvStorageWrite,
      ],
      ids: ["provider.workers.write", "provider.kv.write"],
    });
  });

  it("rejects a modified bootstrap catalog and provider name-to-ID drift", () => {
    expect(() =>
      parseCloudflareOAuthScopeCatalog({
        ...document(),
        scopes: scopes.map((scope, index) =>
          index === 0 ? { ...scope, id: "attacker.scope" } : scope,
        ),
      }),
    ).toThrow(/hash is invalid/);

    const catalog = parseCloudflareOAuthScopeCatalog(document());
    expect(() =>
      verifyCloudflareProviderScopeCatalog(
        catalog,
        scopes.map((scope, index) => (index === 0 ? { ...scope, id: "provider.changed" } : scope)),
        [CLOUDFLARE_PERMISSION_NAMES.workersScriptsWrite],
      ),
    ).toThrow(/missing or changed/);
  });

  it("fails closed when a manifest capability has no configured provider scope", () => {
    const minimal = [scopes[0]];
    const catalog = parseCloudflareOAuthScopeCatalog({
      ...document(),
      scopes: minimal,
      hash: hashCloudflareOAuthScopeEntries(minimal),
    });
    expect(() =>
      resolveCloudflareOAuthScopes(catalog, {
        kv: [],
        d1: [{ key: "database" }],
        r2: [],
        durableObjects: [],
        exposure: {},
      }),
    ).toThrow(CLOUDFLARE_PERMISSION_NAMES.d1Write);
  });
});
