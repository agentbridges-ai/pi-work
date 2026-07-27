import { randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  internalFileTransportBaseUrl,
  INTERNAL_FILE_TRANSPORT_HOST,
  startInternalFileConnectProxy,
} from "../server/internal-file-transport.js";
import { resolveBinary } from "../server/path-resolver.js";
import { compileSrtPolicy } from "../server/srt-policy.js";

if (process.platform === "win32") {
  throw new Error("Windows SRT sessions are intentionally disabled until write-deny parity exists");
}
if (process.platform !== "linux") {
  console.log("[srt-canary] protected Piwork file transport is Linux-only; skipping");
  process.exit(0);
}

async function run(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 20_000);
  const code = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolveExit(status ?? 1));
  }).finally(() => clearTimeout(timeout));
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, "..");
const srt = resolveBinary("srt");
if (!srt) throw new Error("Pinned repo-local SRT executable was not found");
const srtPackageRoot = dirname(dirname(realpathSync(srt)));

const root = realpathSync(mkdtempSync(join("/tmp", "piwork-srt-file-transport-")));
const tenantsRoot = join(root, "tenants");
const tenantRoot = join(tenantsRoot, "tenant");
const sessionRoot = join(tenantRoot, "sessions", "current");
const workspaceDir = join(sessionRoot, "workspace");
const homeDir = join(sessionRoot, "home");
const sessionTmpDir = join(sessionRoot, "tmp");
const piConfigDir = join(sessionRoot, "pi-config");
const piSessionsDir = join(sessionRoot, "pi-sessions");
const privateDir = join(sessionRoot, "user-space-checkouts");
for (const path of [workspaceDir, homeDir, sessionTmpDir, piConfigDir, piSessionsDir, privateDir]) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
const settingsPath = join(sessionTmpDir, "settings.json");
const cliBundle = join(workspaceDir, "user-space");
const keyPath = join(root, "server.key");
const certPath = join(root, "server.crt");
const capability = randomUUID();

execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    `/CN=${INTERNAL_FILE_TRANSPORT_HOST}`,
    "-addext",
    `subjectAltName=DNS:${INTERNAL_FILE_TRANSPORT_HOST}`,
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,digitalSignature",
    "-addext",
    "extendedKeyUsage=serverAuth",
  ],
  { stdio: "ignore", timeout: 10_000 },
);
chmodSync(keyPath, 0o600);
chmodSync(certPath, 0o600);

const tlsServer = createHttpsServer(
  { key: readFileSync(keyPath), cert: readFileSync(certPath) },
  (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== `Bearer ${capability}`) {
      response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.url?.endsWith("/mounts")) {
      response.end(
        JSON.stringify({
          user_space: {
            name: "office",
            rootName: "office",
            status: "mounted",
            canRead: true,
            canWrite: true,
          },
        }),
      );
      return;
    }
    if (request.url?.endsWith("/operation")) {
      response.end(JSON.stringify({ content: "srt protected transport ok" }));
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: "not found" }));
  },
);

let proxy: Awaited<ReturnType<typeof startInternalFileConnectProxy>> | null = null;
try {
  await new Promise<void>((resolveListen, reject) => {
    tlsServer.once("error", reject);
    tlsServer.listen(0, "127.0.0.1", resolveListen);
  });
  const tlsAddress = tlsServer.address();
  if (!tlsAddress || typeof tlsAddress === "string") throw new Error("TLS canary has no port");

  proxy = await startInternalFileConnectProxy(tlsAddress.port);

  const built = spawnSync(
    process.execPath,
    [
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--outfile=user-space",
      join(webRoot, "bin/user-space.ts"),
    ],
    { cwd: workspaceDir, encoding: "utf8" },
  );
  if (built.status !== 0) throw new Error((built.stderr || built.stdout).trim());
  chmodSync(cliBundle, 0o500);

  const policyInput = {
    tenantsRoot,
    tenantRoot,
    sessionRoot,
    workspaceDir,
    homeDir,
    tmpDir: sessionTmpDir,
    piConfigDir,
    piSessionsDir,
    deniedSessionDirs: [privateDir],
    knowledgeDirs: [],
    runtimeReadPaths: [srtPackageRoot, certPath],
    requiredInternalDomains: [INTERNAL_FILE_TRANSPORT_HOST],
    domainLayers: [],
  };
  const settings = compileSrtPolicy(
    policyInput as unknown as Parameters<typeof compileSrtPolicy>[0],
  );
  const parentProxy = `http://127.0.0.1:${proxy.port}`;
  settings.network.parentProxy = { http: parentProxy, https: parentProxy, noProxy: "" };
  writeFileSync(settingsPath, JSON.stringify(settings), { mode: 0o600 });

  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const childEnv = {
    PATH: process.env.PATH,
    HOME: homeDir,
    TMPDIR: sessionTmpDir,
    LANG: "C",
    SANDBOX_RUNTIME: "1",
    NODE_EXTRA_CA_CERTS: certPath,
    PIWORK_USER_SPACE_SESSION_ID: sessionId,
    PIWORK_USER_SPACE_API_BASE: internalFileTransportBaseUrl(tlsAddress.port, sessionId),
    PIWORK_USER_SPACE_API_TOKEN: capability,
  };
  const result = await run(
    srt,
    ["--settings", settingsPath, cliBundle, "read", "office/probe.txt"],
    { cwd: workspaceDir, env: childEnv },
  );
  if (result.code !== 0 || result.stdout !== "srt protected transport ok\n") {
    throw new Error(
      `SRT protected file transport canary failed (${result.code}): ${JSON.stringify(result)}`,
    );
  }
  console.log(
    "[srt-canary] neutral Piwork protected-file TLS/CONNECT route is reachable inside SRT",
  );
} finally {
  if (proxy) await proxy.close();
  await new Promise<void>((resolveClose) => tlsServer.close(() => resolveClose()));
  rmSync(root, { recursive: true, force: true });
}
