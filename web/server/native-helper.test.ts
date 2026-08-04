import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_FILE_ACTIONS,
  NATIVE_HELPER_PROTOCOL_VERSION,
  NativeHelperService,
  nativeHelperVersionIsNewer,
  validateNativeHelperAnchor,
} from "./native-helper.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "piwork-helper-service-test-"));
  roots.push(root);
  const socketPath = join(root, "helper.sock");
  const stagingRoot = join(root, "staging");
  await mkdir(stagingRoot);
  const server = createServer((socket) => {
    let buffered = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffered += chunk;
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffered.slice(0, newline)) as {
        id: string;
        type: string;
        action?: string;
        filePath?: string;
      };
      if (request.type === "hello") {
        socket.end(
          `${JSON.stringify({
            type: "hello",
            version: NATIVE_HELPER_PROTOCOL_VERSION,
            id: request.id,
            helperVersion: "0.1.0",
            protocolVersion: 1,
            platformVersion: "macOS test",
            capabilities: [
              "file.quickLook",
              "file.open",
              "file.openWith",
              "file.print",
              "file.saveAs",
              "file.revealExport",
              "file.share",
              "file.nativeEdit",
            ],
            pid: 123,
          })}\n`,
        );
        return;
      }
      if (request.type === "action") {
        socket.end(
          `${JSON.stringify({
            type: "progress",
            version: 1,
            id: request.id,
            operationId: request.id,
            stage: "presenting",
          })}\n${JSON.stringify({
            type: "result",
            version: 1,
            id: request.id,
            ok: true,
            state: request.action === "file.nativeEdit" ? "editing" : "shown",
          })}\n`,
        );
        return;
      }
      socket.end(
        `${JSON.stringify({
          type: "result",
          version: 1,
          id: request.id,
          ok: true,
          state: "cancelled",
        })}\n`,
      );
    });
  });
  await new Promise<void>((resolvePromise) => server.listen(socketPath, resolvePromise));
  return {
    root,
    socketPath,
    stagingRoot,
    server,
    service: new NativeHelperService({
      platform: "darwin",
      socketPath,
      stagingRoot,
      appPath: join(root, "Piwork Helper"),
      plistPath: join(root, "helper.plist"),
      fetchLatestVersion: async () => "0.2.0",
    }),
  };
}

describe("NativeHelperService", () => {
  it("reports handshake, compatibility and update metadata", async () => {
    const value = await fixture();
    await writeFile(join(value.root, "Piwork Helper"), "");
    await writeFile(join(value.root, "helper.plist"), "");

    await expect(value.service.status()).resolves.toMatchObject({
      supported: true,
      installed: true,
      connected: true,
      compatible: true,
      helperVersion: "0.1.0",
      latestVersion: "0.2.0",
      updateAvailable: true,
    });
    value.server.close();
  });

  it("stages arbitrary file types and reclaims managed native edits", async () => {
    const value = await fixture();
    const source = new TextEncoder().encode("# notes");
    const operation = await value.service.createFileAction({
      ownerKey: "user-a",
      sessionId: "session-a",
      action: "file.nativeEdit",
      bytes: source,
      filename: "AGENTS.md",
      source: { space: "agent", path: "AGENTS.md" },
    });

    expect(operation).toMatchObject({
      action: "file.nativeEdit",
      filename: "AGENTS.md",
      state: "editing",
    });
    const journal = JSON.parse(
      await readFile(join(value.stagingRoot, operation.id, "operation.json"), "utf8"),
    ) as { filePath: string };
    await writeFile(journal.filePath, "# changed");
    const reclaimed = await value.service.reclaimFileAction("user-a", "session-a", operation.id);
    expect(new TextDecoder().decode(reclaimed.bytes)).toBe("# changed");
    expect(reclaimed.changed).toBe(true);

    await value.service.cancelFileAction(operation.id, "session-a", "user-a");
    value.server.close();
  });

  it("rejects cross-session reclaim and unsupported platforms", async () => {
    const value = await fixture();
    const operation = await value.service.createFileAction({
      ownerKey: "user-a",
      sessionId: "session-a",
      action: "file.nativeEdit",
      bytes: new Uint8Array([1]),
      filename: "x.bin",
      source: { space: "agent", path: "x.bin" },
    });
    await expect(
      value.service.reclaimFileAction("user-a", "session-b", operation.id),
    ).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      value.service.reclaimFileAction("user-b", "session-a", operation.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      new NativeHelperService({ platform: "linux" }).createFileAction({
        ownerKey: "user-a",
        sessionId: "session-a",
        action: "file.open",
        bytes: new Uint8Array(),
        filename: "x",
        source: { space: "agent", path: "x" },
      }),
    ).rejects.toMatchObject({ status: 501 });
    value.server.close();
  });

  it("validates native presentation anchors and exposes only owner-scoped edits", async () => {
    expect(validateNativeHelperAnchor(undefined)).toBeUndefined();
    expect(validateNativeHelperAnchor({ x: 10, y: 20, width: 300, height: 200 })).toEqual({
      x: 10,
      y: 20,
      width: 300,
      height: 200,
    });
    expect(() => validateNativeHelperAnchor({ x: 0, y: 0, width: 0, height: 1 })).toThrow(/anchor/);
    expect(() => validateNativeHelperAnchor({ x: Infinity, y: 0, width: 1, height: 1 })).toThrow(
      /anchor/,
    );

    const value = await fixture();
    const operation = await value.service.createFileAction({
      ownerKey: "user-a",
      sessionId: "session-a",
      action: "file.nativeEdit",
      bytes: new Uint8Array([1, 2, 3]),
      filename: "nested/unsafe:name.bin",
      source: { space: "agent", path: "nested/unsafe:name.bin" },
      anchor: { x: 1, y: 2, width: 3, height: 4 },
    });
    await expect(value.service.listFileActions("user-a", "session-a")).resolves.toEqual([
      operation,
    ]);
    await expect(value.service.listFileActions("other-user", "session-a")).resolves.toEqual([]);
    await value.service.cancelFileAction(operation.id, "session-a", "user-a");
    await expect(value.service.listFileActions("user-a", "session-a")).resolves.toEqual([]);
    await value.service.dispose();
    value.server.close();
  });

  it("supports every declared macOS action and reports unavailable helpers", async () => {
    const value = await fixture();
    for (const action of NATIVE_FILE_ACTIONS) {
      await expect(
        value.service.createFileAction({
          ownerKey: "user-a",
          sessionId: "session-a",
          action,
          bytes: new Uint8Array([1]),
          filename: `${action}.txt`,
          source: { space: "agent", path: `${action}.txt` },
        }),
      ).resolves.toMatchObject({ action });
    }
    value.server.close();

    const unavailable = new NativeHelperService({
      platform: "darwin",
      socketPath: join(tmpdir(), "piwork-missing-helper.sock"),
      stagingRoot: join(tmpdir(), "piwork-missing-helper-staging"),
      fetchLatestVersion: async () => {
        throw new Error("release unavailable");
      },
    });
    await expect(unavailable.status({ refreshLatest: true })).resolves.toMatchObject({
      supported: true,
      connected: false,
      lastError: expect.stringMatching(/unavailable|release unavailable/),
    });
    await expect(
      unavailable.createFileAction({
        ownerKey: "user-a",
        sessionId: "session-a",
        action: "invalid" as never,
        bytes: new Uint8Array(),
        filename: "x",
        source: { space: "agent", path: "x" },
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("nativeHelperVersionIsNewer", () => {
  it("compares stable semantic versions", () => {
    expect(nativeHelperVersionIsNewer("0.2.0", "0.1.9")).toBe(true);
    expect(nativeHelperVersionIsNewer("0.1.0", "0.1.0")).toBe(false);
    expect(nativeHelperVersionIsNewer("bad", "0.1.0")).toBe(false);
  });

  it("parses the default GitHub release manifest and tolerates a missing release", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tag_name: "v0.2.0",
            assets: [
              {
                name: "piwork-helper-0.2.0-manifest.json",
                browser_download_url: "https://example.test/manifest.json",
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "v0.2.0", protocol: { minimum: 1, maximum: 1 } }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetcher);
    const service = new NativeHelperService({
      platform: "darwin",
      socketPath: join(tmpdir(), "piwork-default-helper.sock"),
      stagingRoot: join(tmpdir(), "piwork-default-helper-staging"),
      fetchLatestVersion: undefined,
    });
    await expect(service.status({ refreshLatest: true })).resolves.toMatchObject({
      latestVersion: "0.2.0",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    const missing = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", missing);
    const missingService = new NativeHelperService({
      platform: "darwin",
      socketPath: join(tmpdir(), "piwork-missing-helper.sock"),
      stagingRoot: join(tmpdir(), "piwork-missing-helper-staging"),
      fetchLatestVersion: undefined,
    });
    await expect(missingService.status({ refreshLatest: true })).resolves.toMatchObject({
      latestVersion: null,
    });
  });
});
