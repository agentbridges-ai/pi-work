import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type CapturedOperation = { operation: string; input: Record<string, unknown> };

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const token = "cli-test-capability";
let server: Server;
let apiBase = "";
let operations: CapturedOperation[] = [];

beforeAll(async () => {
  server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    if (request.url === "/mounts") {
      response.writeHead(200, { "Content-Type": "application/json" });
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
    if (request.url === "/operation" && request.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of request)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedOperation;
      operations.push(body);
      const result =
        body.operation === "read_file"
          ? { content: "line two" }
          : body.operation === "shell_exec"
            ? { stdout: "shell ok\n", stderr: "", exitCode: 0 }
            : { message: "ok" };
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(result));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server did not expose a TCP port");
  apiBase = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
});

beforeEach(() => {
  operations = [];
});

describe("user-space CLI public contract", () => {
  it("exposes only the four pi-aligned top-level tools", async () => {
    const help = await runCli(["--help"]);
    const removed = await runCli(["grep", "needle"]);

    expect(help.code).toBe(0);
    expect(help.stdout).toContain("user-space read");
    expect(help.stdout).toContain("user-space write");
    expect(help.stdout).toContain("user-space edit");
    expect(help.stdout).toContain("user-space bash");
    expect(help.stdout).toContain("Binary transfer is available only inside bash");
    expect(help.stdout).toContain(
      "checkout rootName/path returns a session-relative Agent Space shared/path",
    );
    expect(help.stdout).not.toContain("user-space grep");
    expect(help.stdout).not.toContain("user-space glob");
    expect(removed.code).toBe(1);
    expect(removed.stderr).toContain("limited to read, write, edit, and bash");
  });

  it("requires root-qualified paths and forwards pi offset/limit", async () => {
    const result = await runCli(["read", "office/notes/a.txt", "--offset", "2", "--limit", "1"]);
    const unqualified = await runCli(["read", "notes/a.txt"]);
    const legacyRange = await runCli(["read", "office/notes/a.txt", "--start-line", "2"]);

    expect(result).toMatchObject({ code: 0, stdout: "line two\n" });
    expect(operations[0]).toEqual({
      operation: "read_file",
      input: { path: "notes/a.txt", offset: 2, limit: 1 },
    });
    expect(unqualified.code).toBe(1);
    expect(unqualified.stderr).toContain("office/notes/a.txt");
    expect(legacyRange.code).toBe(1);
    expect(legacyRange.stderr).toContain("Unsupported option: --start-line");
  });

  it("never reads a host --file and keeps bash rooted in the browser directory", async () => {
    const hostFile = await runCli(["write", "office/copied.txt", "--file", "/etc/hosts"]);
    const bash = await runCli(["bash", "--command", "grep -R needle .", "--timeout", "2"]);

    expect(hostFile.code).toBe(1);
    expect(hostFile.stderr).toContain("Unsupported option: --file");
    expect(bash).toMatchObject({ code: 0, stdout: "shell ok\n" });
    expect(operations).toEqual([
      {
        operation: "shell_exec",
        input: { cwd: "/", script: "grep -R needle .", timeoutMs: 2000 },
      },
    ]);
  });

  it("uses the protected Unix socket inside the session sandbox", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "piwork-user-space-ipc-"));
    const socketPath = join(root, "user-space.sock");
    const ipc = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.headers.authorization !== `Bearer ${token}`) {
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
        response.end(JSON.stringify({ content: "ipc ok" }));
        return;
      }
      response.writeHead(404).end(JSON.stringify({ error: "not found" }));
    });
    const listenError = await new Promise<NodeJS.ErrnoException | null>((resolveListen) => {
      const onError = (error: NodeJS.ErrnoException) => resolveListen(error);
      ipc.once("error", onError);
      ipc.listen(socketPath, () => {
        ipc.off("error", onError);
        resolveListen(null);
      });
    });
    // Some containerized test runners deny AF_UNIX listeners at the outer
    // sandbox boundary. Production/CI Linux still exercises this branch and
    // the separate SRT smoke; only that host-level denial is non-actionable.
    if (listenError?.code === "EPERM") {
      rmSync(root, { recursive: true, force: true });
      return;
    }
    if (listenError) {
      rmSync(root, { recursive: true, force: true });
      throw listenError;
    }
    try {
      const result = await runCli(["read", "office/notes/ipc.txt"], undefined, {
        SANDBOX_RUNTIME: "1",
        PIWORK_USER_SPACE_API_BASE:
          "http://localhost/internal/user-space-transfer/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        PIWORK_USER_SPACE_API_UNIX: socketPath,
      });
      expect(result).toMatchObject({ code: 0, stdout: "ipc ok\n", stderr: "" });
    } finally {
      await new Promise<void>((resolveClose, reject) =>
        ipc.close((error) => (error ? reject(error) : resolveClose())),
      );
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects an unprotected TCP endpoint inside the session sandbox", async () => {
    const result = await runCli(["read", "office/notes/rejected.txt"], undefined, {
      SANDBOX_RUNTIME: "1",
      PIWORK_USER_SPACE_API_UNIX: "",
      PIWORK_USER_SPACE_API_BASE: apiBase,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("A protected User Space transport is required");
    expect(operations).toEqual([]);
  });
});

async function runCli(
  argv: string[],
  stdin?: string,
  envOverrides: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = spawn("bun", ["bin/user-space.ts", ...argv], {
    cwd: webRoot,
    env: {
      ...process.env,
      SANDBOX_RUNTIME: "",
      PIWORK_USER_SPACE_API_BASE: apiBase,
      PIWORK_USER_SPACE_API_TOKEN: token,
      ...envOverrides,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(stdin);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolveExit(status ?? 1));
  });
  return {
    code,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}
