export interface AppWorkerWrapperConfig {
  schemaVersion: 1;
  appId: string;
  allowedBindings: string[];
}

export interface AppWorkerWrapperEnv {
  PIWORK_WRAPPER_CONFIG: string;
  [binding: string]: unknown;
}

export interface AppModuleHandler<UserEnv extends Record<string, unknown>> {
  fetch(request: Request, env: UserEnv, ctx: ExecutionContext): Response | Promise<Response>;
}

const APP_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/u;
const USER_BINDING_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u;
const RESERVED_PATH_PREFIX = "/__piwork/";

export function createAppWorkerWrapper<UserEnv extends Record<string, unknown>>(
  app: AppModuleHandler<UserEnv>,
): ExportedHandler<AppWorkerWrapperEnv> {
  return {
    async fetch(request, env, ctx) {
      let config: AppWorkerWrapperConfig;
      try {
        config = parseAppWorkerWrapperConfig(env.PIWORK_WRAPPER_CONFIG);
      } catch {
        return wrapperError("wrapper_configuration_invalid", 503);
      }

      const url = new URL(request.url);
      if (url.pathname === "/__piwork" || url.pathname.startsWith(RESERVED_PATH_PREFIX)) {
        return wrapperError("not_found", 404);
      }

      let userEnv: UserEnv;
      try {
        userEnv = selectUserBindings(env, config.allowedBindings) as UserEnv;
      } catch {
        return wrapperError("wrapper_binding_unavailable", 503);
      }

      try {
        return await app.fetch(sanitizeAppRequest(request), userEnv, ctx);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "app_worker_failed",
            appId: config.appId,
            error: error instanceof Error ? error.name : "unknown",
          }),
        );
        return wrapperError("app_worker_failed", 502);
      }
    },
  };
}

export function parseAppWorkerWrapperConfig(value: string): AppWorkerWrapperConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("invalid_wrapper_config");
  }
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.appId !== "string" ||
    !APP_ID_PATTERN.test(parsed.appId) ||
    !Array.isArray(parsed.allowedBindings) ||
    parsed.allowedBindings.length > 64 ||
    !parsed.allowedBindings.every(
      (binding) =>
        typeof binding === "string" &&
        USER_BINDING_PATTERN.test(binding) &&
        binding !== "PIWORK_WRAPPER_CONFIG",
    ) ||
    new Set(parsed.allowedBindings).size !== parsed.allowedBindings.length ||
    Object.keys(parsed).some((key) => !["schemaVersion", "appId", "allowedBindings"].includes(key))
  ) {
    throw new Error("invalid_wrapper_config");
  }
  return {
    schemaVersion: 1,
    appId: parsed.appId,
    allowedBindings: [...parsed.allowedBindings],
  };
}

export function sanitizeAppRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("proxy-authorization");
  for (const name of Array.from(headers.keys())) {
    if (name.toLowerCase().startsWith("x-piwork-")) headers.delete(name);
  }

  const cookie = headers.get("cookie");
  if (cookie !== null) {
    const retained = cookie
      .split(";")
      .map((part) => part.trim())
      .filter((part) => {
        const name = part.split("=", 1)[0]?.trim().toLowerCase() ?? "";
        return !name.includes("better-auth");
      })
      .join("; ");
    if (retained === "") headers.delete("cookie");
    else headers.set("cookie", retained);
  }

  return new Request(request, { headers });
}

function selectUserBindings(
  env: AppWorkerWrapperEnv,
  names: readonly string[],
): Readonly<Record<string, unknown>> {
  const selected: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of names) {
    if (!(name in env) || env[name] === undefined) throw new Error("binding_unavailable");
    Object.defineProperty(selected, name, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: env[name],
    });
  }
  return Object.freeze(selected);
}

function wrapperError(error: string, status: number): Response {
  return Response.json(
    { error },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
