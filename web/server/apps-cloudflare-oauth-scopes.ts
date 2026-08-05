import { createHash } from "node:crypto";

export const CLOUDFLARE_OAUTH_SCOPE_CATALOG_VERSION = 1 as const;
export const CLOUDFLARE_OAUTH_SCOPE_CATALOG_SOURCE =
  "https://api.cloudflare.com/client/v4/oauth/scopes" as const;

export const CLOUDFLARE_PERMISSION_NAMES = {
  workersScriptsWrite: "Workers Scripts Write",
  workersKvStorageWrite: "Workers KV Storage Write",
  d1Write: "D1 Write",
  workersR2StorageWrite: "Workers R2 Storage Write",
  zoneRead: "Zone Read",
} as const;

export interface CloudflareOAuthScopeCatalogEntry {
  name: string;
  id: string;
}

export interface CloudflareOAuthScopeCatalog {
  version: typeof CLOUDFLARE_OAUTH_SCOPE_CATALOG_VERSION;
  source: typeof CLOUDFLARE_OAUTH_SCOPE_CATALOG_SOURCE;
  generatedAt: string;
  scopes: ReadonlyMap<string, string>;
  hash: string;
}

export interface CloudflareProviderOAuthScope {
  name: string;
  id: string;
}

const NAME_PATTERN = /^[^\u0000-\u001f\u007f]{1,200}$/u;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/u;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function entry(value: unknown, label: string): CloudflareOAuthScopeCatalogEntry {
  const item = record(value, label);
  const unknown = Object.keys(item).filter((key) => key !== "name" && key !== "id");
  if (unknown.length) throw new Error(`${label} contains an unsupported field.`);
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const id = typeof item.id === "string" ? item.id.trim() : "";
  if (!NAME_PATTERN.test(name)) throw new Error(`${label}.name is invalid.`);
  if (!ID_PATTERN.test(id)) throw new Error(`${label}.id is invalid.`);
  return { name, id };
}

function canonicalScopeEntries(entries: readonly CloudflareOAuthScopeCatalogEntry[]): string {
  return JSON.stringify(
    [...entries]
      .map(({ name, id }) => ({ name, id }))
      .sort(
        (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      ),
  );
}

export function hashCloudflareOAuthScopeEntries(
  entries: readonly CloudflareOAuthScopeCatalogEntry[],
): string {
  return `sha256:${createHash("sha256").update(canonicalScopeEntries(entries)).digest("hex")}`;
}

export function parseCloudflareOAuthScopeCatalog(value: unknown): CloudflareOAuthScopeCatalog {
  const document =
    typeof value === "string"
      ? record(JSON.parse(value), "scope catalog")
      : record(value, "scope catalog");
  const allowed = new Set(["version", "source", "generatedAt", "scopes", "hash"]);
  if (Object.keys(document).some((key) => !allowed.has(key))) {
    throw new Error("Cloudflare OAuth scope catalog contains an unsupported field.");
  }
  if (document.version !== CLOUDFLARE_OAUTH_SCOPE_CATALOG_VERSION) {
    throw new Error("Cloudflare OAuth scope catalog version is unsupported.");
  }
  if (document.source !== CLOUDFLARE_OAUTH_SCOPE_CATALOG_SOURCE) {
    throw new Error("Cloudflare OAuth scope catalog source is invalid.");
  }
  const generatedAt = typeof document.generatedAt === "string" ? document.generatedAt : "";
  if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("Cloudflare OAuth scope catalog generatedAt is invalid.");
  }
  if (
    !Array.isArray(document.scopes) ||
    document.scopes.length === 0 ||
    document.scopes.length > 10_000
  ) {
    throw new Error("Cloudflare OAuth scope catalog scopes are invalid.");
  }
  const entries = document.scopes.map((value, index) =>
    entry(value, `scope catalog scopes[${index}]`),
  );
  if (new Set(entries.map(({ name }) => name)).size !== entries.length) {
    throw new Error("Cloudflare OAuth scope catalog contains a duplicate name.");
  }
  if (new Set(entries.map(({ id }) => id)).size !== entries.length) {
    throw new Error("Cloudflare OAuth scope catalog contains a duplicate id.");
  }
  const hash = typeof document.hash === "string" ? document.hash : "";
  if (!HASH_PATTERN.test(hash) || hash !== hashCloudflareOAuthScopeEntries(entries)) {
    throw new Error("Cloudflare OAuth scope catalog hash is invalid.");
  }
  return {
    version: CLOUDFLARE_OAUTH_SCOPE_CATALOG_VERSION,
    source: CLOUDFLARE_OAUTH_SCOPE_CATALOG_SOURCE,
    generatedAt: new Date(generatedAt).toISOString(),
    scopes: new Map(entries.map(({ name, id }) => [name, id])),
    hash,
  };
}

function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

export function requiredCloudflarePermissionNames(bindingManifest: unknown): string[] {
  const manifest = record(bindingManifest, "binding manifest");
  const required: string[] = [CLOUDFLARE_PERMISSION_NAMES.workersScriptsWrite];
  if (hasEntries(manifest.kv)) required.push(CLOUDFLARE_PERMISSION_NAMES.workersKvStorageWrite);
  if (hasEntries(manifest.d1)) required.push(CLOUDFLARE_PERMISSION_NAMES.d1Write);
  if (hasEntries(manifest.r2)) required.push(CLOUDFLARE_PERMISSION_NAMES.workersR2StorageWrite);
  const exposure =
    manifest.exposure === undefined ? {} : record(manifest.exposure, "binding manifest exposure");
  if (typeof exposure.requestedCustomDomain === "string" && exposure.requestedCustomDomain.trim()) {
    required.push(CLOUDFLARE_PERMISSION_NAMES.zoneRead);
  }
  return required;
}

export function resolveCloudflareOAuthScopes(
  catalog: CloudflareOAuthScopeCatalog,
  bindingManifest: unknown,
): { names: string[]; ids: string[] } {
  const names = requiredCloudflarePermissionNames(bindingManifest);
  const ids = names.map((name) => {
    const id = catalog.scopes.get(name);
    if (!id) throw new Error(`Cloudflare OAuth scope catalog is missing ${name}.`);
    return id;
  });
  return { names, ids };
}

export function verifyCloudflareProviderScopeCatalog(
  catalog: CloudflareOAuthScopeCatalog,
  providerScopes: readonly CloudflareProviderOAuthScope[],
  requiredNames: readonly string[],
): void {
  const byName = new Map<string, string>();
  const ids = new Set<string>();
  for (const [index, value] of providerScopes.entries()) {
    const parsed = entry(value, `provider scopes[${index}]`);
    if (byName.has(parsed.name) || ids.has(parsed.id)) {
      throw new Error("Cloudflare OAuth provider scope catalog contains duplicates.");
    }
    byName.set(parsed.name, parsed.id);
    ids.add(parsed.id);
  }
  for (const name of requiredNames) {
    const configured = catalog.scopes.get(name);
    const provider = byName.get(name);
    if (!configured || !provider || provider !== configured) {
      throw new Error(`Cloudflare OAuth provider scope ${name} is missing or changed.`);
    }
  }
}
