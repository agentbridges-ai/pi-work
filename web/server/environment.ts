import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export const RUNTIME_MODES = {
  local: "local",
} as const;

export const ENV = {
  ALL_PROXY: "ALL_PROXY",
  AGENT_BROWSER_CHROME_BRIDGE_DAEMON: "AGENT_BROWSER_CHROME_BRIDGE_DAEMON",
  AGENT_BROWSER_CHROME_BRIDGE_EXTENSION_ID: "AGENT_BROWSER_CHROME_BRIDGE_EXTENSION_ID",
  AGENT_BROWSER_CHROME_BRIDGE_LOG: "AGENT_BROWSER_CHROME_BRIDGE_LOG",
  AGENT_BROWSER_CHROME_BRIDGE_PORT: "AGENT_BROWSER_CHROME_BRIDGE_PORT",
  AGENT_BROWSER_CHROME_BRIDGE_PROFILE: "AGENT_BROWSER_CHROME_BRIDGE_PROFILE",
  AGENT_BROWSER_IDLE_TIMEOUT_MS: "AGENT_BROWSER_IDLE_TIMEOUT_MS",
  AGENT_BROWSER_PLUGINS: "AGENT_BROWSER_PLUGINS",
  AGENT_BROWSER_PROVIDER: "AGENT_BROWSER_PROVIDER",
  AGENT_BROWSER_SOCKET_DIR: "AGENT_BROWSER_SOCKET_DIR",
  BETTER_AUTH_SECRET: "BETTER_AUTH_SECRET",
  BETTER_AUTH_URL: "BETTER_AUTH_URL",
  BUN_INSTALL_CACHE_DIR: "BUN_INSTALL_CACHE_DIR",
  DATABASE_URL: "DATABASE_URL",
  DISABLE_AUTOUPDATER: "DISABLE_AUTOUPDATER",
  DISABLE_UPDATES: "DISABLE_UPDATES",
  ENABLE_TOOL_SEARCH: "ENABLE_TOOL_SEARCH",
  GIT_CONFIG_GLOBAL: "GIT_CONFIG_GLOBAL",
  HOME: "HOME",
  HOST: "HOST",
  HOSTNAME: "HOSTNAME",
  HTTP_PROXY: "HTTP_PROXY",
  HTTPS_PROXY: "HTTPS_PROXY",
  PIWORK_API_CONTRACT_VERSION: "PIWORK_API_CONTRACT_VERSION",
  PIWORK_AGENT_BROWSER_BRIDGE_PORT: "PIWORK_AGENT_BROWSER_BRIDGE_PORT",
  PIWORK_AGENT_BROWSER_CLI: "PIWORK_AGENT_BROWSER_CLI",
  PIWORK_AGENT_BROWSER_CONTROL_FILE: "PIWORK_AGENT_BROWSER_CONTROL_FILE",
  PIWORK_AGENT_BROWSER_DIR: "PIWORK_AGENT_BROWSER_DIR",
  PIWORK_AGENT_BROWSER_ENABLED: "PIWORK_AGENT_BROWSER_ENABLED",
  PIWORK_AGENT_BROWSER_SESSION_ID: "PIWORK_AGENT_BROWSER_SESSION_ID",
  PIWORK_BOOTSTRAP_SESSION_LIMIT: "PIWORK_BOOTSTRAP_SESSION_LIMIT",
  PIWORK_BUILD_GIT_SHA: "PIWORK_BUILD_GIT_SHA",
  PIWORK_BUILD_TAG: "PIWORK_BUILD_TAG",
  PIWORK_BUILD_TIME: "PIWORK_BUILD_TIME",
  PIWORK_DATA_ROOT: "PIWORK_DATA_ROOT",
  PIWORK_DEV_CONTROL_PLANE_URL: "PIWORK_DEV_CONTROL_PLANE_URL",
  PIWORK_DISCONNECT_DEBOUNCE_MS: "PIWORK_DISCONNECT_DEBOUNCE_MS",
  PIWORK_EDITOR_PORT: "PIWORK_EDITOR_PORT",
  PIWORK_ENABLE_DEFERRED_MCP_TOOL_SEARCH: "PIWORK_ENABLE_DEFERRED_MCP_TOOL_SEARCH",
  PIWORK_ENABLE_TOOL_SEARCH: "PIWORK_ENABLE_TOOL_SEARCH",
  PIWORK_HOME: "PIWORK_HOME",
  PIWORK_HUB_MAX_UPLOAD_MB: "PIWORK_HUB_MAX_UPLOAD_MB",
  PIWORK_IDLE_KILL_MINUTES: "PIWORK_IDLE_KILL_MINUTES",
  PIWORK_IMAGE_TAG: "PIWORK_IMAGE_TAG",
  PIWORK_INIT_SCRIPT_TIMEOUT: "PIWORK_INIT_SCRIPT_TIMEOUT",
  PIWORK_LOG_DIR: "PIWORK_LOG_DIR",
  PIWORK_LOG_FILE: "PIWORK_LOG_FILE",
  PIWORK_LOG_FORMAT: "PIWORK_LOG_FORMAT",
  PIWORK_LOG_MAX_LINES: "PIWORK_LOG_MAX_LINES",
  PIWORK_MAX_CONCURRENT_SESSIONS: "PIWORK_MAX_CONCURRENT_SESSIONS",
  PIWORK_MAX_MANAGED_PROCESSES: "PIWORK_MAX_MANAGED_PROCESSES",
  PIWORK_MAINTENANCE_LOCK_DIR: "PIWORK_MAINTENANCE_LOCK_DIR",
  PIWORK_OFFICE_PREVIEW_MAX_BYTES: "PIWORK_OFFICE_PREVIEW_MAX_BYTES",
  PIWORK_ONLYOFFICE_BROWSER_ASSET_BASE: "PIWORK_ONLYOFFICE_BROWSER_ASSET_BASE",
  PIWORK_ONLYOFFICE_BROWSER_DIR: "PIWORK_ONLYOFFICE_BROWSER_DIR",
  PIWORK_ONLYOFFICE_BROWSER_FONT_ASSETS_DIR: "PIWORK_ONLYOFFICE_BROWSER_FONT_ASSETS_DIR",
  PIWORK_ONLYOFFICE_BROWSER_PUBLIC_DIR: "PIWORK_ONLYOFFICE_BROWSER_PUBLIC_DIR",
  PIWORK_ORG_ID: "PIWORK_ORG_ID",
  PIWORK_ORG_NAME: "PIWORK_ORG_NAME",
  PIWORK_PI_MODEL_ALLOWLIST: "PIWORK_PI_MODEL_ALLOWLIST",
  PIWORK_RECORD: "PIWORK_RECORD",
  PIWORK_RECORDING_HUB: "PIWORK_RECORDING_HUB",
  PIWORK_RECORDINGS_DIR: "PIWORK_RECORDINGS_DIR",
  PIWORK_RECORDINGS_MAX_LINES: "PIWORK_RECORDINGS_MAX_LINES",
  PIWORK_RECORDINGS_MAX_SESSION_BYTES: "PIWORK_RECORDINGS_MAX_SESSION_BYTES",
  PIWORK_RECORDINGS_MAX_USER_BYTES: "PIWORK_RECORDINGS_MAX_USER_BYTES",
  PIWORK_RECORDINGS_RETENTION_DAYS: "PIWORK_RECORDINGS_RETENTION_DAYS",
  PIWORK_RECONNECT_GRACE_MS: "PIWORK_RECONNECT_GRACE_MS",
  PIWORK_REQUIRE_SESSION_SANDBOX: "PIWORK_REQUIRE_SESSION_SANDBOX",
  PIWORK_RUNNER_LOCK_HEARTBEAT_MS: "PIWORK_RUNNER_LOCK_HEARTBEAT_MS",
  PIWORK_RUNNER_LOCK_PATH: "PIWORK_RUNNER_LOCK_PATH",
  PIWORK_RUNNER_LOCK_STALE_MS: "PIWORK_RUNNER_LOCK_STALE_MS",
  PIWORK_RUNTIME_GID: "PIWORK_RUNTIME_GID",
  PIWORK_RUNTIME_MODE: "PIWORK_RUNTIME_MODE",
  PIWORK_RUNTIME_UID: "PIWORK_RUNTIME_UID",
  PIWORK_MCP_MASTER_KEY: "PIWORK_MCP_MASTER_KEY",
  PIWORK_SERVE_FRONTEND: "PIWORK_SERVE_FRONTEND",
  PIWORK_SESSION_ACTIVATE_PROBE_TIMEOUT_MS: "PIWORK_SESSION_ACTIVATE_PROBE_TIMEOUT_MS",
  PIWORK_SESSION_ACTIVATE_TIMEOUT_MS: "PIWORK_SESSION_ACTIVATE_TIMEOUT_MS",
  PIWORK_SESSION_SANDBOX: "PIWORK_SESSION_SANDBOX",
  PIWORK_SRT_ALLOWED_DOMAINS: "PIWORK_SRT_ALLOWED_DOMAINS",
  PIWORK_USER_DISPLAY_NAME: "PIWORK_USER_DISPLAY_NAME",
  PIWORK_USER_DISK_LAUNCH_HEADROOM_BYTES: "PIWORK_USER_DISK_LAUNCH_HEADROOM_BYTES",
  PIWORK_USER_DISK_MONITOR_INTERVAL_MS: "PIWORK_USER_DISK_MONITOR_INTERVAL_MS",
  PIWORK_USER_DISK_QUOTA_BYTES: "PIWORK_USER_DISK_QUOTA_BYTES",
  PIWORK_USER_ID: "PIWORK_USER_ID",
  PIWORK_USERNAME: "PIWORK_USERNAME",
  PIWORK_USER_SPACE_API_BASE: "PIWORK_USER_SPACE_API_BASE",
  PIWORK_USER_SPACE_API_UNIX: "PIWORK_USER_SPACE_API_UNIX",
  PIWORK_USER_SPACE_API_TOKEN: "PIWORK_USER_SPACE_API_TOKEN",
  PIWORK_USER_SPACE_SESSION_ID: "PIWORK_USER_SPACE_SESSION_ID",
  PIWORK_USER_SPACE_TIMEOUT_MS: "PIWORK_USER_SPACE_TIMEOUT_MS",
  PIWORK_USER_SPACE_MAX_TRANSFER_BYTES: "PIWORK_USER_SPACE_MAX_TRANSFER_BYTES",
  PIWORK_USER_SPACE_TRANSFER_TIMEOUT_MS: "PIWORK_USER_SPACE_TRANSFER_TIMEOUT_MS",
  PIWORK_VERSION: "PIWORK_VERSION",
  PIWORK_WORKSPACE_STATE_PATH: "PIWORK_WORKSPACE_STATE_PATH",
  NODE_ENV: "NODE_ENV",
  NODE_EXTRA_CA_CERTS: "NODE_EXTRA_CA_CERTS",
  NO_PROXY: "NO_PROXY",
  NPM_CONFIG_CACHE: "NPM_CONFIG_CACHE",
  NVM_DIR: "NVM_DIR",
  ONLYOFFICE_BROWSER_FONT_ASSETS_DIR: "ONLYOFFICE_BROWSER_FONT_ASSETS_DIR",
  PATH: "PATH",
  PIP_CACHE_DIR: "PIP_CACHE_DIR",
  PORT: "PORT",
  SANDBOX_RUNTIME: "SANDBOX_RUNTIME",
  SHELL: "SHELL",
  TMPDIR: "TMPDIR",
  USER: "USER",
  USERPROFILE: "USERPROFILE",
  VITE_PORT: "VITE_PORT",
  XDG_CACHE_HOME: "XDG_CACHE_HOME",
  XDG_RUNTIME_DIR: "XDG_RUNTIME_DIR",
  __PIWORK_PACKAGE_ROOT: "__PIWORK_PACKAGE_ROOT",
  http_proxy: "http_proxy",
  no_proxy: "no_proxy",
  npm_package_version: "npm_package_version",
} as const;

export type EnvironmentVariableName = (typeof ENV)[keyof typeof ENV];
export type EnvSource = Record<string, string | undefined>;

function readFrom(source: EnvSource, name: EnvironmentVariableName | string): string | undefined {
  return source[name];
}

export function envValue(name: EnvironmentVariableName | string): string | undefined {
  return readFrom(process.env, name);
}

export function envOptionalString(
  name: EnvironmentVariableName | string,
  trim = true,
): string | undefined {
  const value = envValue(name);
  if (typeof value !== "string") return undefined;
  const next = trim ? value.trim() : value;
  return next || undefined;
}

export function envString(
  name: EnvironmentVariableName | string,
  fallback: string,
  trim = true,
): string {
  return envOptionalString(name, trim) ?? fallback;
}

export function envNumber(name: EnvironmentVariableName | string, fallback: number): number {
  const raw = envOptionalString(name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function envBool(name: EnvironmentVariableName | string, fallback = false): boolean {
  const raw = envOptionalString(name)?.toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes";
}

export function envFlag(name: EnvironmentVariableName | string): boolean {
  return envBool(name, false);
}

export function envList(name: EnvironmentVariableName | string): string[] {
  return (envString(name, "") || "").split(/[\s,]+/).filter(Boolean);
}

export function setEnv(name: EnvironmentVariableName | string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function setEnvDefault(name: EnvironmentVariableName | string, value: string): string {
  process.env[name] = process.env[name] || value;
  return process.env[name] as string;
}

export function getProcessEnv(): EnvSource {
  return process.env;
}

export function getProcessEnvSnapshot(overrides: EnvSource = {}): EnvSource {
  return { ...process.env, ...overrides };
}

export function readEnvFrom(
  source: EnvSource,
  name: EnvironmentVariableName | string,
): string | undefined {
  return readFrom(source, name);
}

export function interpolateEnvValue(value: string, source: EnvSource = process.env): string {
  return value.replace(
    /\$(?:\{([A-Z0-9_]+)\}|([A-Z0-9_]+))/gi,
    (_, braced: string, bare: string) => {
      return readFrom(source, braced || bare) || "";
    },
  );
}

export const environment = {
  ENV,
  get processEnv(): EnvSource {
    return process.env;
  },
  get nodeEnv(): string | undefined {
    return envValue(ENV.NODE_ENV);
  },
  get isProduction(): boolean {
    return envValue(ENV.NODE_ENV) === "production";
  },
  get runtimeMode(): string {
    return envString(ENV.PIWORK_RUNTIME_MODE, RUNTIME_MODES.local);
  },
  get piworkHome(): string {
    return envString(ENV.PIWORK_HOME, join(homedir(), ".piwork"), false);
  },
  get packageRoot(): string | undefined {
    return envOptionalString(ENV.__PIWORK_PACKAGE_ROOT, false);
  },
  get host(): string {
    return envString(ENV.HOST, "127.0.0.1");
  },
  get port(): string | undefined {
    return envOptionalString(ENV.PORT);
  },
  get userHome(): string {
    return envValue(ENV.HOME) || envValue(ENV.USERPROFILE) || homedir();
  },
  get tmpDir(): string {
    return envValue(ENV.TMPDIR) || tmpdir();
  },
  optionalString: envOptionalString,
  string: envString,
  number: envNumber,
  bool: envBool,
  flag: envFlag,
  list: envList,
  set: setEnv,
  setDefault: setEnvDefault,
  snapshot: getProcessEnvSnapshot,
  value: envValue,
};
