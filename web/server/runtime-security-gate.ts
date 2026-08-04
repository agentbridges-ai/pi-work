import { existsSync, readFileSync, statSync } from "node:fs";
import { envOptionalString, ENV } from "./environment.js";

/**
 * Runtime nested SRT is selected by the deployment image, not by a browser
 * request or an arbitrary environment toggle. The image entrypoint requires
 * the generated gate marker and rejects the known-dangerous Docker modes.
 */
export function assertRuntimeContainerSecurity(): void {
  const mode = envOptionalString(ENV.PIWORK_RUNTIME_DEPLOYMENT_MODE) || "compose-nested";
  if (mode !== "compose-nested") throw new Error("Runtime container deployment mode is invalid");
  if (envOptionalString(ENV.PIWORK_RUNTIME_SECURITY_GATE) !== "verified") {
    throw new Error("Runtime container security gate has not been verified");
  }
  if (envOptionalString("PIWORK_RUNTIME_PRIVILEGED") === "1") {
    throw new Error("Privileged Runtime containers are forbidden");
  }
  if (envOptionalString("PIWORK_RUNTIME_SECCOMP") === "unconfined") {
    throw new Error("Unconfined Runtime seccomp is forbidden");
  }
  const marker = envOptionalString(ENV.PIWORK_RUNTIME_SECURITY_MARKER);
  if (!marker || !existsSync(marker)) throw new Error("Runtime security marker is missing");
  const info = statSync(marker);
  if (!info.isFile() || (info.mode & 0o077) !== 0)
    throw new Error("Runtime security marker is not private");
  const text = readFileSync(marker, "utf8");
  if (!text.includes("piwork-runtime-security-v1"))
    throw new Error("Runtime security marker is invalid");
}
