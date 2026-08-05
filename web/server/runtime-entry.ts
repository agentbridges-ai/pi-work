import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { environment, ENV } from "./environment.js";
import { PiRuntimeService } from "./pi-runtime-service.js";
import { RuntimeControlAuthenticator } from "./runtime-control-protocol.js";
import { RuntimeControlServer } from "./runtime-control-server.js";
import { ensurePiRuntimeLayout } from "./pi-runtime-layout.js";
import { assertRuntimeContainerSecurity } from "./runtime-security-gate.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const dataRoot = resolve(environment.string(ENV.PIWORK_DATA_ROOT, "/var/lib/piwork/data", false));
const socketPath = resolve(
  environment.string(ENV.PIWORK_RUNTIME_SOCKET, "/run/piwork-runtime/runtime.sock", false),
);
const controlKeyPath = resolve(
  environment.string(
    ENV.PIWORK_RUNTIME_CONTROL_KEY_FILE,
    "/run/secrets/piwork-runtime-control",
    false,
  ),
);

function readControlKey(path: string): Buffer {
  const info = statSync(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0) {
    throw new Error("Runtime control key must be a private regular file");
  }
  const value = readFileSync(path);
  if (value.length < 32) throw new Error("Runtime control key is too short");
  return value;
}

ensurePiRuntimeLayout(dataRoot);
assertRuntimeContainerSecurity();
const trustedExtensionPath = [
  join(currentDir, "pi-trusted-extension.ts"),
  join(currentDir, "pi-trusted-extension.js"),
].find(existsSync);
if (!trustedExtensionPath) throw new Error("Runtime trusted Pi extension is unavailable");
const key = readControlKey(controlKeyPath);
const service = new PiRuntimeService({
  dataRoot,
  trustedExtensionPath,
  executionMode: "compose-nested",
});
const server = new RuntimeControlServer({
  socketPath,
  authenticator: new RuntimeControlAuthenticator(key),
  handler: service.handler(),
});
await server.start();

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await service.shutdown().catch(() => undefined);
  await server.close().catch(() => undefined);
};
process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
