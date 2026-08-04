import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  encodeRuntimeControlFrame,
  makeRuntimeRequest,
  RuntimeControlAuthenticator,
  RuntimeControlDecoder,
  type RuntimeScope,
} from "./runtime-control-protocol.js";
import { RuntimeControlClient, RuntimeControlServer } from "./runtime-control-server.js";

const scope: RuntimeScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  membershipId: "membership-a",
  orgNodeId: "org-root",
  sessionId: "session-a",
  generation: 1,
};

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Piwork Runtime Unix control channel", () => {
  it("serves authenticated requests, events, and fragmented LF frames", async () => {
    const root = await mkdtemp(join(tmpdir(), "piwork-runtime-control-"));
    roots.push(root);
    const socketPath = join(root, "runtime.sock");
    const authenticator = new RuntimeControlAuthenticator(randomBytes(32));
    let client!: RuntimeControlClient;
    const server = new RuntimeControlServer({
      socketPath,
      authenticator,
      handler: async (request, connection) => {
        await connection.sendEvent("runtime.warning", request.scope, { code: "canary" });
        return { operation: request.operation, generation: request.scope.generation };
      },
    });
    await server.start();
    client = new RuntimeControlClient({ socketPath, authenticator });
    const events: unknown[] = [];
    client.onEvent((event) => events.push(event.payload));

    await expect(client.request(scope, "status")).resolves.toEqual({
      operation: "status",
      generation: 1,
    });
    expect(events).toEqual([{ code: "canary" }]);
    expect((await lstat(socketPath)).mode & 0o777).toBe(0o660);

    await client.close();
    await server.close();
  });

  it("fails closed when a response is authenticated for another generation", async () => {
    const root = await mkdtemp(join(tmpdir(), "piwork-runtime-control-"));
    roots.push(root);
    const socketPath = join(root, "runtime.sock");
    const authenticator = new RuntimeControlAuthenticator(randomBytes(32));
    const rawServer = createServer((socket) => {
      const decoder = new RuntimeControlDecoder();
      socket.on("data", (chunk) => {
        for (const frame of decoder.push(chunk, authenticator)) {
          if (frame.kind !== "request") continue;
          socket.write(
            encodeRuntimeControlFrame(
              {
                version: 1,
                kind: "response",
                id: frame.id,
                ok: true,
                scope: { ...frame.scope, generation: frame.scope.generation + 1 },
                data: { forged: true },
              },
              authenticator,
            ),
          );
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      rawServer.once("error", reject);
      rawServer.listen(socketPath, resolve);
    });
    const client = new RuntimeControlClient({ socketPath, authenticator });
    await expect(client.request(scope, "status")).rejects.toThrow("response scope does not match");
    await client.close();
    await new Promise<void>((resolve) => rawServer.close(() => resolve()));
  });
});
