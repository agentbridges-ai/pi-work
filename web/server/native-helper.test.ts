import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NATIVE_HELPER_PROTOCOL_VERSION,
  NativeHelperService,
  nativeHelperVersionIsNewer,
  validateNativeHelperAnchor,
} from "./native-helper.js";

const roots: string[] = [];

afterEach(async () => {
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

  it("covers bounded anchors, unsupported status, transient actions, and operation listing", async () => {
    expect(validateNativeHelperAnchor(undefined)).toBeUndefined();
    expect(validateNativeHelperAnchor({ x: 1, y: 2, width: 10, height: 20 })).toEqual({
      x: 1,
      y: 2,
      width: 10,
      height: 20,
    });
    expect(() => validateNativeHelperAnchor({ x: 0, y: 0, width: 0, height: 10 })).toThrow(
      /anchor rectangle/,
    );
    await expect(new NativeHelperService({ platform: "linux" }).status()).resolves.toMatchObject({
      supported: false,
      connected: false,
      compatible: false,
    });

    const value = await fixture();
    const operation = await value.service.createFileAction({
      ownerKey: "user-a",
      sessionId: "session-a",
      action: "file.open",
      bytes: new Uint8Array([1, 2, 3]),
      filename: "nested/path.txt",
      source: { space: "agent", path: "nested/path.txt", baselineSha256: "not-a-digest" },
      anchor: { x: 5, y: 6, width: 7, height: 8 },
      applicationPath: "/Applications/Preview.app",
    });
    expect(operation.state).toBe("shown");
    await expect(value.service.listFileActions("user-a", "session-a")).resolves.toEqual([]);
    await value.service.cancelFileAction(operation.id);
    await value.service.dispose();
    value.server.close();
  });

  it("handles GitHub release metadata and incompatible manifests without leaking errors", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
      await expect(
        new NativeHelperService({
          platform: "darwin",
          socketPath: "/tmp/piwork-helper-missing.sock",
        }).status({ refreshLatest: true }),
      ).resolves.toMatchObject({ latestVersion: null });

      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ tag_name: "v0.3.0", assets: [] }), { status: 200 }),
      );
      await expect(
        new NativeHelperService({
          platform: "darwin",
          socketPath: "/tmp/piwork-helper-missing.sock",
        }).status({ refreshLatest: true }),
      ).resolves.toMatchObject({ latestVersion: "0.3.0" });

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tag_name: "v0.3.1",
            assets: [
              {
                name: "piwork-helper-0.3.1-manifest.json",
                browser_download_url: "https://example.test/manifest",
              },
            ],
          }),
          { status: 200 },
        ),
      );
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "0.3.0", protocol: { minimum: 1, maximum: 1 } }), {
          status: 200,
        }),
      );
      await expect(
        new NativeHelperService({
          platform: "darwin",
          socketPath: "/tmp/piwork-helper-missing.sock",
        }).status({ refreshLatest: true }),
      ).resolves.toMatchObject({
        lastError: expect.stringContaining("unavailable"),
        latestVersion: null,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("nativeHelperVersionIsNewer", () => {
  it("compares stable semantic versions", () => {
    expect(nativeHelperVersionIsNewer("0.2.0", "0.1.9")).toBe(true);
    expect(nativeHelperVersionIsNewer("0.1.0", "0.1.0")).toBe(false);
    expect(nativeHelperVersionIsNewer("bad", "0.1.0")).toBe(false);
    expect(nativeHelperVersionIsNewer("0.1.0", "0.2.0")).toBe(false);
    expect(nativeHelperVersionIsNewer("0.1.0", "0.1.0-beta")).toBe(false);
  });
});
