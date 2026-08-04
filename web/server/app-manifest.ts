import { isIP } from "node:net";

export const PIWORK_APP_MANIFEST_VERSION = 1 as const;
export const PIWORK_APP_MANIFEST_FILENAME = "piwork.app.json";
export const PIWORK_APP_RUNTIME = "cloudflare-workers" as const;

const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u;
const LOGICAL_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const EXTERNAL_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;

export type AppResourceMode = "create" | "adopt";

export interface AppKvResource {
  key: string;
  binding: string;
  mode: AppResourceMode;
  namespaceId?: string;
}

export interface AppD1Resource {
  key: string;
  binding: string;
  mode: AppResourceMode;
  databaseId?: string;
}

export interface AppR2Resource {
  key: string;
  binding: string;
  mode: AppResourceMode;
  bucketName?: string;
  jurisdiction?: "default" | "eu" | "fedramp";
}

export interface AppDurableObjectResource {
  binding: string;
  className: string;
  storage: "sqlite";
  state: "created";
}

export interface PiworkAppManifestV1 {
  version: typeof PIWORK_APP_MANIFEST_VERSION;
  runtime: typeof PIWORK_APP_RUNTIME;
  resources?: {
    kv?: AppKvResource[];
    d1?: AppD1Resource[];
    r2?: AppR2Resource[];
    durableObjects?: AppDurableObjectResource[];
  };
  exposure: {
    workersDev: true;
    /** User intent only. The zone is selected after OAuth and never trusted from source. */
    requestedCustomDomain?: string;
  };
}

export interface AppBindingManifest {
  kv: AppKvResource[];
  d1: AppD1Resource[];
  r2: AppR2Resource[];
  durableObjects: AppDurableObjectResource[];
  exposure: PiworkAppManifestV1["exposure"];
  hasStatefulResources: boolean;
  temporaryEligible: boolean;
  sensitive: boolean;
}

export interface TemporaryCapabilityAnalysis {
  eligible: boolean;
  reasons: Array<"stateful_resources_require_byoc" | "custom_domain_requires_byoc">;
}

export class AppManifestError extends Error {
  readonly code = "invalid_app_manifest";

  constructor(message: string) {
    super(message);
    this.name = "AppManifestError";
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppManifestError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowlist = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowlist.has(key));
  if (unknown.length > 0) {
    throw new AppManifestError(`${path} contains unsupported field "${unknown[0]}"`);
  }
}

function stringField(
  value: unknown,
  path: string,
  pattern: RegExp,
  normalize: (input: string) => string = (input) => input,
): string {
  if (typeof value !== "string") throw new AppManifestError(`${path} is invalid`);
  const normalized = normalize(value.trim());
  if (!pattern.test(normalized)) throw new AppManifestError(`${path} is invalid`);
  return normalized;
}

function resourceMode(value: unknown, path: string): AppResourceMode {
  if (value !== "create" && value !== "adopt") {
    throw new AppManifestError(`${path} must be create or adopt`);
  }
  return value;
}

function resourceArray<T>(
  value: unknown,
  path: string,
  maximum: number,
  parse: (value: Record<string, unknown>, path: string) => T,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw new AppManifestError(`${path} must contain at most ${maximum} items`);
  }
  return value.map((item, index) => parse(object(item, `${path}[${index}]`), `${path}[${index}]`));
}

function createOrAdopt(
  value: Record<string, unknown>,
  path: string,
  externalField: "namespaceId" | "databaseId" | "bucketName",
  externalPattern: RegExp,
): { key: string; binding: string; mode: AppResourceMode; external?: string } {
  const key = stringField(value.key, `${path}.key`, LOGICAL_KEY_PATTERN, (item) =>
    item.toLowerCase(),
  );
  const binding = stringField(value.binding, `${path}.binding`, IDENTIFIER_PATTERN);
  const mode = resourceMode(value.mode, `${path}.mode`);
  const rawExternal = value[externalField];
  if (mode === "adopt") {
    const external = stringField(rawExternal, `${path}.${externalField}`, externalPattern);
    return { key, binding, mode, external };
  }
  if (rawExternal !== undefined) {
    throw new AppManifestError(`${path}.${externalField} is allowed only when mode is adopt`);
  }
  return { key, binding, mode };
}

function normalizeHostname(value: string): string | null {
  const hostname = value.trim().toLowerCase().replace(/\.$/u, "");
  if (
    !hostname ||
    hostname.includes("*") ||
    hostname === "localhost" ||
    isIP(hostname) !== 0 ||
    hostname.length > 253 ||
    !hostname.includes(".") ||
    hostname
      .split(".")
      .some(
        (label) => !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  ) {
    return null;
  }
  return hostname;
}

function assertUniqueResources(bindings: AppBindingManifest): void {
  const bindingNames = [
    ...bindings.kv.map((entry) => entry.binding),
    ...bindings.d1.map((entry) => entry.binding),
    ...bindings.r2.map((entry) => entry.binding),
    ...bindings.durableObjects.map((entry) => entry.binding),
  ];
  if (new Set(bindingNames).size !== bindingNames.length) {
    throw new AppManifestError("resources contains a duplicate binding");
  }
  if (bindingNames.some((name) => name === "PIWORK_WRAPPER_CONFIG" || name === "ASSETS")) {
    throw new AppManifestError("resources contains a platform-reserved binding");
  }
  for (const [kind, entries] of [
    ["kv", bindings.kv],
    ["d1", bindings.d1],
    ["r2", bindings.r2],
  ] as const) {
    const keys = entries.map((entry) => entry.key);
    if (new Set(keys).size !== keys.length) {
      throw new AppManifestError(`resources.${kind} contains a duplicate key`);
    }
  }
  const classes = bindings.durableObjects.map((entry) => entry.className);
  if (new Set(classes).size !== classes.length) {
    throw new AppManifestError("resources.durableObjects contains a duplicate className");
  }
}

export function analyzeTemporaryAppCapabilities(
  manifest: PiworkAppManifestV1,
): TemporaryCapabilityAnalysis {
  const resources = manifest.resources;
  const hasStatefulResources = Boolean(
    resources?.kv?.length ||
    resources?.d1?.length ||
    resources?.r2?.length ||
    resources?.durableObjects?.length,
  );
  const reasons: TemporaryCapabilityAnalysis["reasons"] = [];
  if (hasStatefulResources) reasons.push("stateful_resources_require_byoc");
  if (manifest.exposure.requestedCustomDomain) reasons.push("custom_domain_requires_byoc");
  return { eligible: reasons.length === 0, reasons };
}

export function assertTemporaryAppEligible(manifest: PiworkAppManifestV1): void {
  const analysis = analyzeTemporaryAppCapabilities(manifest);
  if (!analysis.eligible) {
    throw new AppManifestError(
      `Temporary Cloudflare preview is unavailable: ${analysis.reasons.join(", ")}`,
    );
  }
}

export function parsePiworkAppManifest(value: unknown): PiworkAppManifestV1 {
  const root = object(value, PIWORK_APP_MANIFEST_FILENAME);
  onlyKeys(root, ["version", "runtime", "resources", "exposure"], PIWORK_APP_MANIFEST_FILENAME);
  if (root.version !== PIWORK_APP_MANIFEST_VERSION) {
    throw new AppManifestError(
      `${PIWORK_APP_MANIFEST_FILENAME}.version must be ${PIWORK_APP_MANIFEST_VERSION}`,
    );
  }
  if (root.runtime !== PIWORK_APP_RUNTIME) {
    throw new AppManifestError(
      `${PIWORK_APP_MANIFEST_FILENAME}.runtime must be ${PIWORK_APP_RUNTIME}`,
    );
  }

  const resources = root.resources === undefined ? {} : object(root.resources, "resources");
  onlyKeys(resources, ["kv", "d1", "r2", "durableObjects"], "resources");
  const kv = resourceArray(resources.kv, "resources.kv", 16, (entry, path) => {
    onlyKeys(entry, ["key", "binding", "mode", "namespaceId"], path);
    const parsed = createOrAdopt(entry, path, "namespaceId", EXTERNAL_ID_PATTERN);
    return {
      key: parsed.key,
      binding: parsed.binding,
      mode: parsed.mode,
      ...(parsed.external ? { namespaceId: parsed.external } : {}),
    };
  });
  const d1 = resourceArray(resources.d1, "resources.d1", 8, (entry, path) => {
    onlyKeys(entry, ["key", "binding", "mode", "databaseId"], path);
    const parsed = createOrAdopt(entry, path, "databaseId", EXTERNAL_ID_PATTERN);
    return {
      key: parsed.key,
      binding: parsed.binding,
      mode: parsed.mode,
      ...(parsed.external ? { databaseId: parsed.external } : {}),
    };
  });
  const r2 = resourceArray(resources.r2, "resources.r2", 8, (entry, path) => {
    onlyKeys(entry, ["key", "binding", "mode", "bucketName", "jurisdiction"], path);
    const parsed = createOrAdopt(entry, path, "bucketName", BUCKET_PATTERN);
    let jurisdiction: AppR2Resource["jurisdiction"];
    if (entry.jurisdiction !== undefined) {
      const normalized =
        typeof entry.jurisdiction === "string" ? entry.jurisdiction.trim().toLowerCase() : "";
      if (normalized !== "default" && normalized !== "eu" && normalized !== "fedramp") {
        throw new AppManifestError(`${path}.jurisdiction must be default, eu, or fedramp`);
      }
      jurisdiction = normalized;
    }
    return {
      key: parsed.key,
      binding: parsed.binding,
      mode: parsed.mode,
      ...(parsed.external ? { bucketName: parsed.external } : {}),
      ...(jurisdiction ? { jurisdiction } : {}),
    };
  });
  const durableObjects = resourceArray(
    resources.durableObjects,
    "resources.durableObjects",
    16,
    (entry, path) => {
      onlyKeys(entry, ["binding", "className", "storage", "state"], path);
      if (entry.storage !== "sqlite") {
        throw new AppManifestError(`${path}.storage must be sqlite`);
      }
      if (entry.state !== "created") {
        throw new AppManifestError(`${path}.state must be created`);
      }
      return {
        binding: stringField(entry.binding, `${path}.binding`, IDENTIFIER_PATTERN),
        className: stringField(entry.className, `${path}.className`, IDENTIFIER_PATTERN),
        storage: "sqlite" as const,
        state: "created" as const,
      };
    },
  );

  const exposure = object(root.exposure, "exposure");
  onlyKeys(exposure, ["workersDev", "requestedCustomDomain"], "exposure");
  if (exposure.workersDev !== true) {
    throw new AppManifestError("exposure.workersDev must be true");
  }
  let requestedCustomDomain: string | undefined;
  if (exposure.requestedCustomDomain !== undefined) {
    requestedCustomDomain =
      typeof exposure.requestedCustomDomain === "string"
        ? (normalizeHostname(exposure.requestedCustomDomain) ?? undefined)
        : undefined;
    if (!requestedCustomDomain) {
      throw new AppManifestError("exposure.requestedCustomDomain is invalid");
    }
  }

  const manifest: PiworkAppManifestV1 = {
    version: PIWORK_APP_MANIFEST_VERSION,
    runtime: PIWORK_APP_RUNTIME,
    ...(kv.length || d1.length || r2.length || durableObjects.length
      ? {
          resources: {
            ...(kv.length ? { kv } : {}),
            ...(d1.length ? { d1 } : {}),
            ...(r2.length ? { r2 } : {}),
            ...(durableObjects.length ? { durableObjects } : {}),
          },
        }
      : {}),
    exposure: {
      workersDev: true,
      ...(requestedCustomDomain ? { requestedCustomDomain } : {}),
    },
  };
  assertUniqueResources(materializeAppBindingManifest(manifest));
  return manifest;
}

export function materializeAppBindingManifest(manifest: PiworkAppManifestV1): AppBindingManifest {
  const kv = structuredClone(manifest.resources?.kv ?? []);
  const d1 = structuredClone(manifest.resources?.d1 ?? []);
  const r2 = structuredClone(manifest.resources?.r2 ?? []);
  const durableObjects = structuredClone(manifest.resources?.durableObjects ?? []);
  const analysis = analyzeTemporaryAppCapabilities(manifest);
  return {
    kv,
    d1,
    r2,
    durableObjects,
    exposure: structuredClone(manifest.exposure),
    hasStatefulResources: kv.length + d1.length + r2.length + durableObjects.length > 0,
    temporaryEligible: analysis.eligible,
    sensitive:
      kv.length + d1.length + r2.length + durableObjects.length > 0 ||
      Boolean(manifest.exposure.requestedCustomDomain),
  };
}

export function parsePiworkAppManifestText(text: string): PiworkAppManifestV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AppManifestError(
      `${PIWORK_APP_MANIFEST_FILENAME} is not valid JSON: ${
        error instanceof Error ? error.message : "parse failed"
      }`,
    );
  }
  return parsePiworkAppManifest(parsed);
}
