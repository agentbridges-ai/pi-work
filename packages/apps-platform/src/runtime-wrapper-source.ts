const SAFE_MODULE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/u;

/**
 * Generates the JavaScript module that becomes the actual Worker entrypoint.
 * The user bundle remains a sibling module and is never invoked with the raw
 * Cloudflare environment or unsanitized request.
 */
export function createRuntimeWrapperModuleSource(userMainModule: string): string {
  if (!SAFE_MODULE_PATH.test(userMainModule)) throw new Error("invalid_user_main_module");
  const specifier = JSON.stringify(`./${userMainModule.replace(/^\.\//u, "")}`);
  return `import app from ${specifier};
export * from ${specifier};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u;
const RESERVED_PATH_PREFIX = "/__piwork/";

function response(error, status) {
  return Response.json({ error }, { status, headers: {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  }});
}

function config(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error("invalid_wrapper_config"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      parsed.schemaVersion !== 1 || typeof parsed.appId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(parsed.appId) ||
      !Array.isArray(parsed.allowedBindings) || parsed.allowedBindings.length > 64 ||
      !parsed.allowedBindings.every((name) => typeof name === "string" &&
        IDENTIFIER.test(name) && name !== "PIWORK_WRAPPER_CONFIG") ||
      new Set(parsed.allowedBindings).size !== parsed.allowedBindings.length ||
      Object.keys(parsed).some((key) => !["schemaVersion", "appId", "allowedBindings"].includes(key))) {
    throw new Error("invalid_wrapper_config");
  }
  return parsed;
}

function sanitizedRequest(request) {
  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("proxy-authorization");
  for (const name of Array.from(headers.keys())) {
    if (name.toLowerCase().startsWith("x-piwork-")) headers.delete(name);
  }
  const cookie = headers.get("cookie");
  if (cookie !== null) {
    const retained = cookie.split(";").map((part) => part.trim()).filter((part) => {
      const name = (part.split("=", 1)[0] || "").trim().toLowerCase();
      return !name.includes("better-auth");
    }).join("; ");
    if (retained) headers.set("cookie", retained); else headers.delete("cookie");
  }
  return new Request(request, { headers });
}

export default {
  async fetch(request, env, ctx) {
    let parsed;
    try { parsed = config(env.PIWORK_WRAPPER_CONFIG); }
    catch { return response("wrapper_configuration_invalid", 503); }
    const url = new URL(request.url);
    if (url.pathname === "/__piwork" || url.pathname.startsWith(RESERVED_PATH_PREFIX)) {
      return response("not_found", 404);
    }
    const selected = Object.create(null);
    try {
      for (const name of parsed.allowedBindings) {
        if (!(name in env) || env[name] === undefined) throw new Error("binding_unavailable");
        Object.defineProperty(selected, name, {
          configurable: false, enumerable: true, writable: false, value: env[name]
        });
      }
      Object.freeze(selected);
    } catch { return response("wrapper_binding_unavailable", 503); }
    if (!app || typeof app.fetch !== "function") return response("app_handler_invalid", 503);
    try { return await app.fetch(sanitizedRequest(request), selected, ctx); }
    catch (error) {
      console.error(JSON.stringify({
        event: "app_worker_failed", appId: parsed.appId,
        error: error instanceof Error ? error.name : "unknown"
      }));
      return response("app_worker_failed", 502);
    }
  }
};
`;
}
