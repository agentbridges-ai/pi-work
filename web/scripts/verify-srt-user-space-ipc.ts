import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBinary } from "../server/path-resolver.js";

if (process.platform !== "darwin") {
  throw new Error(
    "The SRT Unix-socket path allowlist canary is macOS-only; Linux seccomp cannot filter sockets by path",
  );
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(scriptDir, "..");
const srt = resolveBinary("srt");
if (!srt) throw new Error("Pinned repo-local SRT executable was not found");

const root = realpathSync(mkdtempSync(join(tmpdir(), "piwork-srt-ipc-")));
const socketPath = join(root, "user-space.sock");
const settingsPath = join(root, "settings.json");
const cliBundle = join(root, "user-space");
const capability = randomUUID();

const server = createServer((request, response) => {
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
    response.end(JSON.stringify({ content: "srt unix ipc ok" }));
    return;
  }
  response.writeHead(404).end(JSON.stringify({ error: "not found" }));
});

try {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolveListen);
  });
  chmodSync(socketPath, 0o600);

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
    { cwd: root, encoding: "utf8" },
  );
  if (built.status !== 0) throw new Error((built.stderr || built.stdout).trim());
  chmodSync(cliBundle, 0o500);
  const executableProbe = spawnSync(cliBundle, ["--help"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (executableProbe.status !== 0 || !executableProbe.stdout.includes("user-space read")) {
    throw new Error(
      executableProbe.error?.message ||
        executableProbe.stderr ||
        "compiled User Space CLI did not execute",
    );
  }

  const privateRoots =
    process.platform === "darwin"
      ? ["/Users", "/Volumes", "/tmp", "/private/tmp", "/private/var/folders"]
      : ["/home", "/root", "/tmp", "/var/tmp", "/mnt", "/media", "/run/user"];
  writeFileSync(
    settingsPath,
    JSON.stringify({
      filesystem: {
        denyRead: privateRoots,
        allowRead: [root],
        allowWrite: [root],
        denyWrite: [],
        allowGitConfig: false,
      },
      network: {
        allowedDomains: [],
        deniedDomains: [],
        allowUnixSockets: [socketPath],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
      enableWeakerNestedSandbox: false,
      enableWeakerNetworkIsolation: false,
    }),
    { mode: 0o600 },
  );

  const childEnv = {
    PATH: process.env.PATH,
    HOME: root,
    TMPDIR: root,
    LANG: "C",
    SANDBOX_RUNTIME: "1",
    PIWORK_USER_SPACE_SESSION_ID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    PIWORK_USER_SPACE_API_BASE:
      "http://localhost/internal/user-space-transfer/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    PIWORK_USER_SPACE_API_UNIX: socketPath,
    PIWORK_USER_SPACE_API_TOKEN: capability,
  };
  const directChild = spawn(cliBundle, ["read", "office/probe.txt"], {
    cwd: root,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const directStdout: Buffer[] = [];
  const directStderr: Buffer[] = [];
  directChild.stdout.on("data", (chunk) => directStdout.push(Buffer.from(chunk)));
  directChild.stderr.on("data", (chunk) => directStderr.push(Buffer.from(chunk)));
  const directTimeout = setTimeout(() => directChild.kill("SIGKILL"), 10_000);
  const directExitCode = await new Promise<number>((resolveExit, reject) => {
    directChild.once("error", reject);
    directChild.once("close", (code) => resolveExit(code ?? 1));
  }).finally(() => clearTimeout(directTimeout));
  if (
    directExitCode !== 0 ||
    Buffer.concat(directStdout).toString("utf8") !== "srt unix ipc ok\n"
  ) {
    throw new Error(
      `Compiled User Space CLI baseline failed (${directExitCode}): ${Buffer.concat(directStderr).toString("utf8")}`,
    );
  }
  const envProbe = spawnSync(srt, ["--settings", settingsPath, "/usr/bin/env"], {
    cwd: root,
    env: childEnv,
    encoding: "utf8",
  });
  const observedEnv = new Map(
    envProbe.stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
  );
  for (const name of [
    "PIWORK_USER_SPACE_SESSION_ID",
    "PIWORK_USER_SPACE_API_BASE",
    "PIWORK_USER_SPACE_API_UNIX",
    "PIWORK_USER_SPACE_API_TOKEN",
  ]) {
    if (
      envProbe.status !== 0 ||
      observedEnv.get(name) !== childEnv[name as keyof typeof childEnv]
    ) {
      throw new Error(`SRT did not preserve required child environment metadata: ${name}`);
    }
  }
  const child = spawn(srt, ["--settings", settingsPath, cliBundle, "read", "office/probe.txt"], {
    cwd: root,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveExit(code ?? 1));
  }).finally(() => clearTimeout(timeout));
  const output = Buffer.concat(stdout).toString("utf8");
  if (exitCode !== 0 || output !== "srt unix ipc ok\n") {
    throw new Error(
      `SRT User Space IPC canary failed (${exitCode}): ${JSON.stringify({
        stdout: output,
        stderr: Buffer.concat(stderr).toString("utf8"),
      })}`,
    );
  }
  console.log("[srt-canary] protected User Space Unix socket is reachable inside SRT");
} finally {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  rmSync(root, { recursive: true, force: true });
}
