import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UserSpaceBroker,
  registerUserSpaceInternalTransferRoutes,
  registerUserSpaceTransferRoutes,
} from "./user-space-broker.js";
import type { BrowserIncomingMessage } from "./session-types.js";
import { UserDiskQuota } from "./user-disk-quota.js";

function expectedMount() {
  return {
    mountId: "uw-test",
    name: "Notes",
    rootName: "Notes",
    access: "readwrite" as const,
    includeHidden: true as const,
  };
}

function internalAuthorization(broker: UserSpaceBroker, sessionId: string): Record<string, string> {
  return { Authorization: `Bearer ${broker.getToken(sessionId)}` };
}

describe("UserSpaceBroker CLI bridge", () => {
  it("rejects pending work and revokes session capabilities on dispose", async () => {
    const broker = new UserSpaceBroker();
    broker.configureSession("s1", [{ ...expectedMount(), status: "mounted" }]);
    broker.setSender(() => undefined);

    const pending = broker.requestOperation("s1", "list_dir", {
      mountId: "uw-test",
      path: "",
    });
    broker.dispose();

    await expect(pending).rejects.toThrow("runtime was disposed");
    expect(broker.getToken("s1")).toBeUndefined();
    expect(broker.hasSession("s1")).toBe(false);
  });

  it("returns only the active directory capability without leaking mount ids", async () => {
    const broker = new UserSpaceBroker();
    broker.configureSession("s1", [
      {
        ...expectedMount(),
        status: "mounted",
        access: "readonly" as const,
        canRead: true,
        canWrite: false,
        permissionState: "granted" as const,
      },
    ]);
    const app = new Hono();
    registerUserSpaceInternalTransferRoutes(app, broker);

    const res = await app.request("/internal/user-space-transfer/s1/mounts", {
      headers: internalAuthorization(broker, "s1"),
    });
    const json = (await res.json()) as {
      user_space: { access: string; canRead: boolean; canWrite: boolean; mountId?: string };
      mounts?: unknown;
    };

    expect(json.user_space).toEqual(
      expect.objectContaining({
        access: "readonly",
        canRead: true,
        canWrite: false,
      }),
    );
    expect(json.user_space).not.toHaveProperty("mountId");
    expect(json).not.toHaveProperty("mounts");
  });

  it("switches the active CLI mount when the preferred mount changes", () => {
    const broker = new UserSpaceBroker();
    const first = {
      ...expectedMount(),
      mountId: "uw-first",
      name: "first",
      rootName: "first",
      status: "mounted" as const,
    };
    const second = {
      ...expectedMount(),
      mountId: "uw-second",
      name: "office",
      rootName: "office",
      status: "mounted" as const,
    };

    broker.configureSession("s1", [first, second]);
    expect(broker.getActiveMount("s1")?.mountId).toBe("uw-first");

    const configured = broker.configureSession("s1", [first, second], "uw-second");
    expect(configured.user_space?.rootName).toBe("office");
    expect(broker.getMounts("s1").map((mount) => mount.mountId)).toEqual(["uw-second", "uw-first"]);
    expect(() => broker.configureSession("s1", [first, second], "uw-missing")).toThrow(
      "Unknown active",
    );
  });

  it("forwards CLI operations to the browser and correlates the response", async () => {
    const broker = new UserSpaceBroker();
    broker.configureSession("s1", [{ ...expectedMount(), status: "mounted" }]);
    const app = new Hono();
    registerUserSpaceInternalTransferRoutes(app, broker);
    broker.setSender((sessionId, message) => {
      expect(sessionId).toBe("s1");
      expect(message.type).toBe("user_space_request");
      if (message.type !== "user_space_request") throw new Error("Expected user-space request");
      expect(message.operation).toBe("read_file");
      expect(message.input.mountId).toBe("uw-test");
      broker.handleResponse("s1", message.request_id, true, {
        content: "hello",
      });
    });

    const res = await app.request("/internal/user-space-transfer/s1/operation", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...internalAuthorization(broker, "s1") },
      body: JSON.stringify({
        operation: "read_file",
        input: { path: "README.md" },
      }),
    });
    const json = (await res.json()) as { content: string };

    expect(res.status).toBe(200);
    expect(json.content).toBe("hello");
  });

  it("restricts the CLI capability to four tools and the active directory", async () => {
    const broker = new UserSpaceBroker();
    broker.configureSession("s1", [{ ...expectedMount(), status: "mounted" }]);
    broker.setSender(() => undefined);
    const app = new Hono();
    registerUserSpaceInternalTransferRoutes(app, broker);
    const headers = { "Content-Type": "application/json", ...internalAuthorization(broker, "s1") };

    const hiddenMutation = await app.request("/internal/user-space-transfer/s1/operation", {
      method: "POST",
      headers,
      body: JSON.stringify({ operation: "create_entry", input: { name: "blocked.txt" } }),
    });
    const mountSelection = await app.request("/internal/user-space-transfer/s1/operation", {
      method: "POST",
      headers,
      body: JSON.stringify({
        operation: "read_file",
        input: { path: "README.md", mountId: "uw-test" },
      }),
    });

    expect(hiddenMutation.status).toBe(400);
    expect(await hiddenMutation.json()).toEqual(
      expect.objectContaining({ error: expect.stringContaining("not available") }),
    );
    expect(mountSelection.status).toBe(400);
    expect(await mountSelection.json()).toEqual(
      expect.objectContaining({ error: expect.stringContaining("active directory") }),
    );
    expect(
      (
        await app.request("/internal/user-space-transfer/s1/blob/checkout", {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request("/internal/user-space-transfer/s1/blob/checkin", {
          method: "POST",
          headers,
        })
      ).status,
    ).toBe(404);
  });

  it("rejects missing and stale internal capabilities", async () => {
    const broker = new UserSpaceBroker();
    broker.configureSession("s1", [{ ...expectedMount(), status: "mounted" }]);
    const stale = broker.getToken("s1")!;
    const current = broker.issueInternalCapability("s1");
    const app = new Hono();
    registerUserSpaceInternalTransferRoutes(app, broker);

    expect((await app.request("/internal/user-space-transfer/s1/mounts")).status).toBe(401);
    expect(
      (
        await app.request("/internal/user-space-transfer/s1/mounts", {
          headers: { Authorization: `Bearer ${stale}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request("/internal/user-space-transfer/s1/mounts", {
          headers: { Authorization: `Bearer ${current}` },
        })
      ).status,
    ).toBe(200);
  });

  it("rejects a capability rotated while an operation body is still streaming", async () => {
    const broker = new UserSpaceBroker();
    broker.configureSession("s1", [{ ...expectedMount(), status: "mounted" }]);
    let dispatched = false;
    broker.setSender(() => {
      dispatched = true;
    });
    const stale = broker.getToken("s1")!;
    const app = new Hono();
    registerUserSpaceInternalTransferRoutes(app, broker);

    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    let markBodyRead!: () => void;
    const bodyRead = new Promise<void>((resolve) => {
      markBodyRead = resolve;
    });
    let unblockBody!: () => void;
    const bodyBlocked = new Promise<void>((resolve) => {
      unblockBody = resolve;
    });
    const encoder = new TextEncoder();
    let firstChunk = true;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        bodyController = controller;
        if (firstChunk) {
          firstChunk = false;
          controller.enqueue(encoder.encode('{"operation":"read_file","input":'));
          return;
        }
        markBodyRead();
        return bodyBlocked;
      },
    });
    const request = new Request("http://localhost/internal/user-space-transfer/s1/operation", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stale}`,
        "Content-Type": "application/json",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const responsePromise = app.fetch(request);

    await bodyRead;
    broker.issueInternalCapability("s1");
    bodyController.enqueue(encoder.encode('{"path":"README.md"}}'));
    bodyController.close();
    unblockBody();

    const response = await responsePromise;
    expect(response.status).toBe(401);
    expect(dispatched).toBe(false);
  });

  it("revokes the internal capability and pending work when a session is removed", async () => {
    const broker = new UserSpaceBroker();
    broker.configureSession("s1", [{ ...expectedMount(), status: "mounted" }]);
    broker.setSender(() => undefined);
    const pending = broker.requestOperation("s1", "list_dir", {
      mountId: "uw-test",
      path: "",
    });
    const token = broker.getToken("s1")!;

    broker.removeSession("s1");

    await expect(pending).rejects.toThrow("session was removed");
    expect(broker.hasSession("s1")).toBe(false);
    expect(broker.validateInternalCapability("s1", token)).toBe(false);
  });

  it("rejects readonly write operations before contacting the browser", async () => {
    const broker = new UserSpaceBroker();
    broker.configureSession("s1", [
      {
        ...expectedMount(),
        status: "mounted",
        access: "readonly" as const,
        canRead: true,
        canWrite: false,
      },
    ]);
    let sent = false;
    broker.setSender(() => {
      sent = true;
    });

    await expect(
      broker.requestOperation("s1", "write_file", {
        mountId: "uw-test",
        path: "README.md",
        content: "blocked",
      }),
    ).rejects.toThrow("read-only");
    await expect(
      broker.requestOperation("s1", "create_entry", {
        mountId: "uw-test",
        parentPath: "",
        name: "blocked.txt",
        kind: "file",
      }),
    ).rejects.toThrow("read-only");
    expect(sent).toBe(false);
  });

  it("rejects pending browser requests when a session goes offline", async () => {
    const broker = new UserSpaceBroker();
    broker.configureSession("s1", [{ ...expectedMount(), status: "mounted" }]);
    broker.setSender(() => {});

    const pending = broker.requestOperation("s1", "read_file", {
      mountId: "uw-test",
      path: "README.md",
    });
    const mounts = broker.markOffline("s1");

    await expect(pending).rejects.toThrow("offline");
    expect(mounts[0].status).toBe("offline");
  });

  it("requires two-phase commit authorization for every browser mutation and shell request", async () => {
    const broker = new UserSpaceBroker();
    broker.configureSession("s1", [
      { ...expectedMount(), status: "mounted", canRead: true, canWrite: true },
    ]);
    let latestMessage: BrowserIncomingMessage | undefined;
    broker.setSender((_sessionId, message) => {
      latestMessage = message;
    });

    for (const operation of [
      "create_entry",
      "rename_entry",
      "copy_entry",
      "copy_entries",
      "duplicate_entry",
      "move_entries",
      "write_file",
      "replace_text",
      "delete_entry",
      "shell_exec",
    ] as const) {
      latestMessage = undefined;
      const pending = broker.requestOperation("s1", operation, {
        mountId: "uw-test",
        path: "notes.txt",
        script: "cat notes.txt",
      });
      expect(latestMessage).toMatchObject({
        type: "user_space_mutation_request",
        operation,
        requires_commit: true,
      });
      await broker.revokeRuntimeGeneration("s1", "test generation rotated");
      await expect(pending).rejects.toThrow("test generation rotated");
    }

    latestMessage = undefined;
    const read = broker.requestOperation("s1", "read_file", {
      mountId: "uw-test",
      path: "notes.txt",
    });
    expect(latestMessage).toMatchObject({
      type: "user_space_request",
      operation: "read_file",
    });
    expect(latestMessage).not.toHaveProperty("requires_commit", true);
    await broker.revokeRuntimeGeneration("s1", "finish read request");
    await expect(read).rejects.toThrow("finish read request");
  });

  it("grants a mutation lease to only one browser socket and drains its exact terminal response", async () => {
    const broker = new UserSpaceBroker();
    broker.configureSession("s1", [
      { ...expectedMount(), status: "mounted", canRead: true, canWrite: true },
    ]);
    let request:
      Extract<BrowserIncomingMessage, { type: "user_space_mutation_request" }> | undefined;
    broker.setSender((_sessionId, message) => {
      if (message.type === "user_space_mutation_request") request = message;
    });
    const result = broker.requestOperation("s1", "write_file", {
      mountId: "uw-test",
      path: "notes.txt",
      content: "committed",
    });
    if (!request) throw new Error("Expected a browser mutation request");
    const firstSocket = {};
    const secondSocket = {};
    const authorization = broker.authorizeMutationCommit("s1", request.request_id, firstSocket);

    expect(broker.authorizeMutationCommit("s1", request.request_id, firstSocket)).toEqual(
      authorization,
    );
    expect(() => broker.authorizeMutationCommit("s1", request!.request_id, secondSocket)).toThrow(
      /another browser connection/,
    );
    expect(
      broker.handleResponse(
        "s1",
        request.request_id,
        true,
        { bytesWritten: 9 },
        undefined,
        secondSocket,
        authorization.commitLease,
        authorization.runtimeEpoch,
      ),
    ).toBe(false);

    let drainSettled = false;
    const draining = broker.revokeRuntimeGeneration("s1", "runtime generation changed");
    void draining.then(() => {
      drainSettled = true;
    });
    await Promise.resolve();
    expect(drainSettled).toBe(false);
    expect(
      broker.handleResponse(
        "s1",
        request.request_id,
        true,
        { bytesWritten: 9 },
        undefined,
        firstSocket,
        "wrong-lease",
        authorization.runtimeEpoch,
      ),
    ).toBe(false);
    expect(drainSettled).toBe(false);

    expect(
      broker.handleResponse(
        "s1",
        request.request_id,
        true,
        { bytesWritten: 9 },
        undefined,
        firstSocket,
        authorization.commitLease,
        authorization.runtimeEpoch,
      ),
    ).toBe(true);
    await draining;
    await expect(result).resolves.toEqual({ bytesWritten: 9 });
  });

  it("fails a mutation revocation closed at 10 seconds without inventing terminal evidence", async () => {
    vi.useFakeTimers();
    const broker = new UserSpaceBroker();
    broker.configureSession("s1", [
      { ...expectedMount(), status: "mounted", canRead: true, canWrite: true },
    ]);
    let request:
      Extract<BrowserIncomingMessage, { type: "user_space_mutation_request" }> | undefined;
    broker.setSender((_sessionId, message) => {
      if (message.type === "user_space_mutation_request") request = message;
    });

    try {
      const result = broker.requestOperation("s1", "replace_text", {
        mountId: "uw-test",
        path: "notes.txt",
        oldText: "old",
        newText: "new",
      });
      let resultSettled = false;
      void result.then(
        () => {
          resultSettled = true;
        },
        () => {
          resultSettled = true;
        },
      );
      if (!request) throw new Error("Expected a browser mutation request");
      const socket = {};
      const authorization = broker.authorizeMutationCommit("s1", request.request_id, socket);
      const draining = broker.revokeRuntimeGeneration("s1", "runtime generation changed");
      const drainError = draining.then(
        () => null,
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(10_000);
      expect(await drainError).toMatchObject({
        message: expect.stringMatching(/timed out draining/i),
      });
      expect(resultSettled).toBe(false);

      expect(
        broker.handleResponse(
          "s1",
          request.request_id,
          false,
          undefined,
          "browser write failed",
          socket,
          authorization.commitLease,
          authorization.runtimeEpoch,
        ),
      ).toBe(true);
      await expect(result).rejects.toThrow("browser write failed");
      await expect(
        broker.revokeRuntimeGeneration("s1", "retry after terminal evidence"),
      ).resolves.toBeUndefined();
    } finally {
      broker.dispose();
      vi.useRealTimers();
    }
  });

  it("replaces old mounts when a session is configured again", () => {
    const broker = new UserSpaceBroker();
    const first = broker.configureSession("s1", [{ ...expectedMount(), status: "mounted" }]);
    const second = broker.configureSession("s1", [
      {
        ...expectedMount(),
        mountId: "uw-next",
        name: "Next",
        rootName: "Next",
        status: "mounted",
      },
    ]);

    expect(second.token).toBe(first.token);
    expect(second.mounts).toEqual([
      expect.objectContaining({
        mountId: "uw-next",
        status: "mounted",
      }),
    ]);
  });

  it("keeps all mounts while deriving one active user-space from multi-mount session data", () => {
    const broker = new UserSpaceBroker();
    const configured = broker.configureSession("s1", [
      {
        ...expectedMount(),
        mountId: "uw-old",
        name: "Old",
        rootName: "Old",
        status: "expected",
        lastIndexedAt: 100,
      },
      {
        ...expectedMount(),
        mountId: "uw-active",
        name: "Active",
        rootName: "Active",
        status: "mounted",
        lastPermissionCheckedAt: 200,
      },
    ]);

    expect(configured.mounts).toEqual([
      expect.objectContaining({
        mountId: "uw-active",
        rootName: "Active",
      }),
      expect.objectContaining({
        mountId: "uw-old",
        rootName: "Old",
      }),
    ]);
    expect(configured.user_space).toEqual(
      expect.objectContaining({
        rootName: "Active",
        status: "mounted",
      }),
    );
    expect(configured.user_space).not.toHaveProperty("mountId");
  });

  it("keeps all browser-reported mounts on status updates", () => {
    const broker = new UserSpaceBroker();
    broker.configureSession("s1", [
      {
        ...expectedMount(),
        mountId: "uw-old",
        name: "Old",
        rootName: "Old",
        status: "mounted",
      },
    ]);

    const mounts = broker.updateMounts("s1", [
      {
        ...expectedMount(),
        mountId: "uw-old",
        name: "Old",
        rootName: "Old",
        status: "mounted",
      },
      {
        ...expectedMount(),
        mountId: "uw-next",
        name: "Next",
        rootName: "Next",
        status: "mounted",
      },
    ]);

    expect(mounts.map((mount) => mount.mountId)).toEqual(["uw-old", "uw-next"]);
  });

  it("coordinates binary checkout and checkin transfers through single-use routes", async () => {
    const broker = new UserSpaceBroker(undefined, () => 1);
    broker.configureSession("s1", [
      {
        ...expectedMount(),
        status: "mounted",
        canRead: true,
        canWrite: true,
      },
    ]);
    let latestMessage: BrowserIncomingMessage | null = null;
    const getLatestMessage = () => latestMessage as BrowserIncomingMessage | null;
    broker.setSender((_sessionId, message) => {
      latestMessage = message;
    });

    const app = new Hono();
    const api = new Hono();
    registerUserSpaceTransferRoutes(api, broker);
    app.route("/api", api);

    const checkoutResponse = broker.requestBlobCheckout("s1", {
      mountId: "uw-test",
      path: "asset.bin",
    });
    const checkoutMessage = getLatestMessage();
    expect(checkoutMessage?.type).toBe("user_space_blob_checkout_request");
    if (checkoutMessage?.type !== "user_space_blob_checkout_request") {
      throw new Error("Expected checkout request");
    }
    expect(checkoutMessage.maxBytes).toBe(256 * 1024 * 1024);

    const checkoutBytes = new Uint8Array([1, 2, 3]);
    const upload = await app.request(checkoutMessage.uploadUrl, {
      method: "PUT",
      body: checkoutBytes,
    });
    expect(upload.status).toBe(200);
    const complete = await app.request(checkoutMessage.completeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, mtime: 123 }),
    });
    expect(complete.status).toBe(200);
    const checkoutJson = (await checkoutResponse) as {
      localPath: string;
      hash: string;
      baseHash: string;
    };
    expect(new Uint8Array(await readFile(checkoutJson.localPath))).toEqual(checkoutBytes);

    latestMessage = null;
    const checkinBytes = new Uint8Array([4, 5, 6]);
    const checkinResponse = broker.requestBlobCheckin("s1", {
      mountId: "uw-test",
      path: "asset.bin",
      baseHash: checkoutJson.baseHash,
      baseMtime: 123,
      body: checkinBytes,
    });
    for (let attempt = 0; attempt < 20 && !getLatestMessage(); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const checkinMessage = getLatestMessage();
    if (!checkinMessage) throw new Error("Expected checkin request");
    expect(checkinMessage.type).toBe("user_space_blob_checkin_request");
    if (checkinMessage.type !== "user_space_blob_checkin_request") {
      throw new Error("Expected checkin request");
    }
    const prematureAuthorization = await app.request(checkinMessage.commitUrl, { method: "POST" });
    expect(prematureAuthorization.status).toBe(400);
    const download = await app.request(checkinMessage.downloadUrl);
    expect(download.status, download.status === 200 ? "" : await download.clone().text()).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(checkinBytes);
    const authorization = await app.request(checkinMessage.commitUrl, { method: "POST" });
    expect(authorization.status).toBe(200);
    const { commitLease } = (await authorization.json()) as { commitLease: string };
    const authorizationRetry = await app.request(checkinMessage.commitUrl, { method: "POST" });
    expect(authorizationRetry.status).toBe(200);
    await expect(authorizationRetry.json()).resolves.toEqual({ ok: true, commitLease });
    await app.request(checkinMessage.completeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: true,
        size: checkinBytes.byteLength,
        hash: await crypto.subtle
          .digest("SHA-256", checkinBytes)
          .then((digest) => Buffer.from(digest).toString("hex")),
        mtime: 456,
        commitLease,
      }),
    });
    const checkinJson = (await checkinResponse) as { bytesWritten: number; mtime: number };

    expect(checkinJson.bytesWritten).toBe(checkinBytes.byteLength);
    expect(checkinJson.mtime).toBe(456);
  });

  it("returns 507 and writes no checkout staging file when the user quota is exhausted", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "piwork-checkout-quota-"));
    const checkoutRoot = join(tempRoot, "checkouts");
    const quota = new UserDiskQuota({ maxBytes: 4, reservedHeadroomBytes: 1 });
    quota.addRoot(tempRoot);
    await quota.reconcile();
    const broker = new UserSpaceBroker(
      () => checkoutRoot,
      () => 1,
      quota,
    );
    broker.configureSession("s1", [
      { ...expectedMount(), status: "mounted", canRead: true, canWrite: true },
    ]);
    let request: Extract<
      BrowserIncomingMessage,
      { type: "user_space_blob_checkout_request" }
    > | null = null;
    broker.setSender((_sessionId, message) => {
      if (message.type === "user_space_blob_checkout_request") request = message;
    });
    const getCheckoutRequest = () =>
      request as Extract<
        BrowserIncomingMessage,
        { type: "user_space_blob_checkout_request" }
      > | null;
    const app = new Hono();
    const api = new Hono();
    registerUserSpaceTransferRoutes(api, broker);
    app.route("/api", api);

    try {
      const pending = broker.requestBlobCheckout("s1", {
        mountId: "uw-test",
        path: "too-large.bin",
      });
      const pendingError = pending.then(
        () => null,
        (error: unknown) => error,
      );
      const checkoutRequest = getCheckoutRequest();
      if (!checkoutRequest) throw new Error("Expected checkout request");
      const response = await app.request(checkoutRequest.uploadUrl, {
        method: "PUT",
        body: new Uint8Array([1, 2, 3, 4, 5]),
      });

      expect(response.status).toBe(507);
      expect(await pendingError).toMatchObject({ status: 507 });
      expect(existsSync(checkoutRoot)).toBe(false);
      await expect(
        broker.requestBlobCheckin("s1", {
          mountId: "uw-test",
          path: "too-large-checkin.bin",
          baseHash: "baseline",
          body: new Uint8Array([1, 2, 3, 4, 5]),
        }),
      ).rejects.toMatchObject({ status: 507 });
      expect(existsSync(join(checkoutRoot, ".pending-checkins"))).toBe(false);
      expect(quota.snapshot()).toMatchObject({ usedBytes: 0, reservedBytes: 0 });
    } finally {
      broker.dispose();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("settles checkout and checkin reservations on success and generation failure", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "piwork-staging-quota-"));
    const checkoutRoot = join(tempRoot, "checkouts");
    const quota = new UserDiskQuota({ maxBytes: 100, reservedHeadroomBytes: 10 });
    quota.addRoot(tempRoot);
    await quota.reconcile();
    let generation = 1;
    const broker = new UserSpaceBroker(
      () => checkoutRoot,
      () => generation,
      quota,
    );
    broker.configureSession("s1", [
      { ...expectedMount(), status: "mounted", canRead: true, canWrite: true },
    ]);
    let request: BrowserIncomingMessage | null = null;
    broker.setSender((_sessionId, message) => {
      request = message;
    });
    const getRequest = () => request as BrowserIncomingMessage | null;

    try {
      const checkout = broker.requestBlobCheckout("s1", {
        mountId: "uw-test",
        path: "ok.bin",
      });
      const checkoutRequest = getRequest();
      if (!checkoutRequest || checkoutRequest.type !== "user_space_blob_checkout_request") {
        throw new Error("Expected checkout request");
      }
      const checkoutToken = new URL(checkoutRequest.uploadUrl, "http://localhost").searchParams.get(
        "token",
      )!;
      await broker.handleCheckoutUpload(
        "s1",
        checkoutRequest.transfer_id,
        checkoutToken,
        new Uint8Array([1, 2, 3]),
      );
      expect(quota.snapshot()).toMatchObject({ usedBytes: 3, reservedBytes: 0 });
      broker.handleTransferComplete("s1", checkoutRequest.transfer_id, checkoutToken, { ok: true });
      await checkout;

      request = null;
      const failedCheckin = broker.requestBlobCheckin("s1", {
        mountId: "uw-test",
        path: "generation-changed.bin",
        baseHash: "baseline",
        body: new Uint8Array([4, 5, 6, 7]),
      });
      generation = 2;
      await expect(failedCheckin).rejects.toThrow(/expired sandbox generation/);
      expect(quota.snapshot()).toMatchObject({ usedBytes: 3, reservedBytes: 0 });
      expect(existsSync(join(checkoutRoot, ".pending-checkins"))).toBe(true);
      await expect(readdir(join(checkoutRoot, ".pending-checkins"))).resolves.toEqual([]);
    } finally {
      broker.dispose();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("removes unreserved checkin staging when revocation races the initial write", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "piwork-staging-revoke-race-"));
    const checkoutRoot = join(tempRoot, "checkouts");
    let generationRead = 0;
    const broker = new UserSpaceBroker(
      () => checkoutRoot,
      () => (++generationRead === 1 ? 1 : 2),
    );
    broker.configureSession("s1", [
      { ...expectedMount(), status: "mounted", canRead: true, canWrite: true },
    ]);
    broker.setSender(() => undefined);

    try {
      await expect(
        broker.requestBlobCheckin("s1", {
          mountId: "uw-test",
          path: "asset.bin",
          baseHash: "baseline",
          body: new Uint8Array([1, 2, 3]),
        }),
      ).rejects.toThrow(/expired sandbox generation/);
      await expect(readdir(join(checkoutRoot, ".pending-checkins"))).resolves.toEqual([]);
    } finally {
      broker.dispose();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("keeps a revocation drain open until an in-flight staging write is cleaned", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "piwork-staging-drain-race-"));
    const checkoutRoot = join(tempRoot, "checkouts");
    const pendingDir = join(checkoutRoot, ".pending-checkins");
    let broker!: UserSpaceBroker;
    let generationRead = 0;
    let revocation: Promise<void> | undefined;
    let observedOrphanWhenDrainSettled = false;
    broker = new UserSpaceBroker(
      () => checkoutRoot,
      () => {
        generationRead += 1;
        if (generationRead === 2) {
          revocation = broker.revokeRuntimeGeneration("s1", "runtime generation changed");
          void revocation.then(() => {
            observedOrphanWhenDrainSettled = readdirSync(pendingDir).length > 0;
          });
        }
        return 1;
      },
    );
    broker.configureSession("s1", [
      { ...expectedMount(), status: "mounted", canRead: true, canWrite: true },
    ]);
    broker.setSender(() => undefined);

    try {
      await expect(
        broker.requestBlobCheckin("s1", {
          mountId: "uw-test",
          path: "asset.bin",
          baseHash: "baseline",
          body: new Uint8Array([1, 2, 3]),
        }),
      ).rejects.toThrow(/revoked runtime generation/);
      await revocation;
      expect(observedOrphanWhenDrainSettled).toBe(false);
      expect(readdirSync(pendingDir)).toEqual([]);
    } finally {
      broker.dispose();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("does not revive an in-flight write after dispose and same-session reconfiguration", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "piwork-staging-epoch-aba-"));
    const checkoutRoot = join(tempRoot, "checkouts");
    let broker!: UserSpaceBroker;
    let generationRead = 0;
    let leakedTransfer = false;
    const mounts = [
      { ...expectedMount(), status: "mounted" as const, canRead: true, canWrite: true },
    ];
    broker = new UserSpaceBroker(
      () => checkoutRoot,
      () => {
        generationRead += 1;
        if (generationRead === 2) {
          broker.dispose();
          broker.configureSession("s1", mounts);
          broker.setSender((_sessionId, message) => {
            leakedTransfer = true;
            if (message.type !== "user_space_blob_checkin_request") return;
            const token = new URL(message.completeUrl, "http://localhost").searchParams.get(
              "token",
            )!;
            queueMicrotask(() => {
              broker.handleTransferComplete("s1", message.transfer_id, token, {
                ok: false,
                error: "leaked transfer",
              });
            });
          });
        }
        return 1;
      },
    );
    broker.configureSession("s1", mounts);
    broker.setSender(() => undefined);

    try {
      await expect(
        broker.requestBlobCheckin("s1", {
          mountId: "uw-test",
          path: "asset.bin",
          baseHash: "baseline",
          body: new Uint8Array([1, 2, 3]),
        }),
      ).rejects.toThrow(/revoked runtime generation/);
      expect(leakedTransfer).toBe(false);
      await expect(readdir(join(checkoutRoot, ".pending-checkins"))).resolves.toEqual([]);
    } finally {
      broker.dispose();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("rejects commit authorization after a generation switch that follows download", async () => {
    let generation = 1;
    const broker = new UserSpaceBroker(undefined, () => generation);
    broker.configureSession("s1", [
      { ...expectedMount(), status: "mounted", canRead: true, canWrite: true },
    ]);
    let latestMessage: BrowserIncomingMessage | null = null;
    broker.setSender((_sessionId, message) => {
      latestMessage = message;
    });
    const app = new Hono();
    const api = new Hono();
    registerUserSpaceTransferRoutes(api, broker);
    app.route("/api", api);

    const pending = broker.requestBlobCheckin("s1", {
      mountId: "uw-test",
      path: "asset.bin",
      baseHash: "baseline",
      body: new Uint8Array([7, 8, 9]),
    });
    for (let attempt = 0; attempt < 20 && !latestMessage; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const message = latestMessage as BrowserIncomingMessage | null;
    if (!message || message.type !== "user_space_blob_checkin_request") {
      throw new Error("Expected checkin request");
    }

    const download = await app.request(message.downloadUrl);
    expect(download.status).toBe(200);
    generation = 2;
    await broker.revokeRuntimeGeneration("s1", "runtime generation changed");

    const authorization = await app.request(message.commitUrl, { method: "POST" });
    expect(authorization.status).toBe(400);
    await expect(pending).rejects.toThrow("runtime generation changed");
  });

  it("keeps revocation draining until an authorized checkin reports its terminal result", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "piwork-revoked-checkin-"));
    const checkoutRoot = join(tempRoot, "checkouts");
    const broker = new UserSpaceBroker(
      () => checkoutRoot,
      () => 1,
    );
    broker.configureSession("s1", [
      { ...expectedMount(), status: "mounted", canRead: true, canWrite: true },
    ]);
    let latestMessage: BrowserIncomingMessage | null = null;
    broker.setSender((_sessionId, message) => {
      latestMessage = message;
    });
    const getLatestMessage = () => latestMessage as BrowserIncomingMessage | null;
    const oldCapability = broker.issueInternalCapability("s1");
    const browserRequest = broker.requestOperation("s1", "list_dir", {
      mountId: "uw-test",
      path: "",
    });

    const checkin = broker.requestBlobCheckin("s1", {
      mountId: "uw-test",
      path: "asset.bin",
      baseHash: "baseline",
      body: new Uint8Array([1, 2, 3]),
    });
    for (
      let attempt = 0;
      attempt < 20 && getLatestMessage()?.type !== "user_space_blob_checkin_request";
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const message = getLatestMessage();
    if (!message || message.type !== "user_space_blob_checkin_request") {
      throw new Error("Expected checkin request");
    }
    const token = new URL(message.downloadUrl, "http://localhost").searchParams.get("token")!;
    await broker.handleCheckinDownload("s1", message.transfer_id, token);
    const authorization = broker.authorizeCheckinCommit("s1", message.transfer_id, token) as {
      commitLease: string;
    };

    try {
      let drainSettled = false;
      const draining = broker.revokeRuntimeGeneration("s1", "runtime generation changed");
      void draining.then(() => {
        drainSettled = true;
      });
      await expect(browserRequest).rejects.toThrow("runtime generation changed");
      expect(broker.validateInternalCapability("s1", oldCapability)).toBe(false);
      await Promise.resolve();
      expect(drainSettled).toBe(false);

      expect(
        broker.handleTransferComplete("s1", message.transfer_id, token, {
          ok: true,
          size: 3,
          hash: message.hash,
          commitLease: authorization.commitLease,
        }),
      ).toEqual({ ok: true });

      await draining;
      await expect(checkin).resolves.toMatchObject({ bytesWritten: 3, hash: message.hash });
      expect(existsSync(join(checkoutRoot, ".pending-checkins"))).toBe(true);
      await expect(readdir(join(checkoutRoot, ".pending-checkins"))).resolves.toEqual([]);
    } finally {
      broker.dispose();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails revocation closed at its deadline without expiring the authorized commit", async () => {
    vi.useFakeTimers();
    const tempRoot = mkdtempSync(join(tmpdir(), "piwork-checkin-timeout-"));
    const checkoutRoot = join(tempRoot, "checkouts");
    const broker = new UserSpaceBroker(
      () => checkoutRoot,
      () => 1,
    );
    broker.configureSession("s1", [
      { ...expectedMount(), status: "mounted", canRead: true, canWrite: true },
    ]);
    let deliverMessage: ((message: BrowserIncomingMessage) => void) | undefined;
    const messageReady = new Promise<BrowserIncomingMessage>((resolve) => {
      deliverMessage = resolve;
    });
    broker.setSender((_sessionId, message) => deliverMessage?.(message));

    try {
      const checkin = broker.requestBlobCheckin("s1", {
        mountId: "uw-test",
        path: "asset.bin",
        baseHash: "baseline",
        body: new Uint8Array([1, 2, 3]),
      });
      let checkinSettled = false;
      void checkin.then(
        () => {
          checkinSettled = true;
        },
        () => {
          checkinSettled = true;
        },
      );
      const message = await messageReady;
      if (message.type !== "user_space_blob_checkin_request") {
        throw new Error("Expected checkin request");
      }
      const token = new URL(message.downloadUrl, "http://localhost").searchParams.get("token")!;
      await broker.handleCheckinDownload("s1", message.transfer_id, token);
      const authorization = broker.authorizeCheckinCommit("s1", message.transfer_id, token) as {
        commitLease: string;
      };
      const pendingDir = join(checkoutRoot, ".pending-checkins");
      const [stagedName] = await readdir(pendingDir);
      const stagedPath = join(pendingDir, stagedName!);
      expect(existsSync(stagedPath)).toBe(true);

      const oldCapability = broker.getToken("s1")!;
      const draining = broker.revokeRuntimeGeneration("s1", "runtime generation changed");
      const drainError = draining.then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(10_000);

      expect(await drainError).toMatchObject({
        message: expect.stringMatching(/timed out draining/i),
      });
      expect(broker.validateInternalCapability("s1", oldCapability)).toBe(false);
      expect(checkinSettled).toBe(false);
      expect(existsSync(stagedPath)).toBe(true);

      expect(
        broker.handleTransferComplete("s1", message.transfer_id, token, {
          ok: true,
          size: message.size,
          hash: message.hash,
          commitLease: authorization.commitLease,
        }),
      ).toEqual({ ok: true });
      await expect(checkin).resolves.toMatchObject({ bytesWritten: message.size });
      await expect(readdir(pendingDir)).resolves.toEqual([]);
      await expect(
        broker.revokeRuntimeGeneration("s1", "retry after terminal acknowledgement"),
      ).resolves.toBeUndefined();
    } finally {
      broker.dispose();
      rmSync(tempRoot, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("revalidates mount access and the write manifest at final commit", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "piwork-checkin-revalidate-"));
    const checkoutRoot = join(tempRoot, "checkouts");
    const broker = new UserSpaceBroker(
      () => checkoutRoot,
      () => 1,
    );
    broker.configureSession("s1", [
      { ...expectedMount(), status: "mounted", canRead: true, canWrite: true },
    ]);
    let latestMessage: BrowserIncomingMessage | null = null;
    broker.setSender((_sessionId, message) => {
      latestMessage = message;
    });

    try {
      const staleMountCheckin = broker.requestBlobCheckin("s1", {
        mountId: "uw-test",
        path: "asset.bin",
        baseHash: "baseline",
        body: new Uint8Array([1, 2, 3]),
      });
      const staleMountError = staleMountCheckin.then(
        () => null,
        (error: unknown) => error,
      );
      for (let attempt = 0; attempt < 20 && !latestMessage; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const staleMessage = latestMessage as BrowserIncomingMessage | null;
      if (!staleMessage || staleMessage.type !== "user_space_blob_checkin_request") {
        throw new Error("Expected checkin request");
      }
      const staleToken = new URL(staleMessage.downloadUrl, "http://localhost").searchParams.get(
        "token",
      )!;
      await broker.handleCheckinDownload("s1", staleMessage.transfer_id, staleToken);
      broker.configureSession("s1", [
        {
          ...expectedMount(),
          status: "mounted",
          access: "readonly",
          canRead: true,
          canWrite: false,
        },
      ]);
      expect(() =>
        broker.authorizeCheckinCommit("s1", staleMessage.transfer_id, staleToken),
      ).toThrow(/read-only|write/i);
      await broker.revokeRuntimeGeneration("s1", "mount access changed");
      expect(await staleMountError).toMatchObject({
        message: expect.stringMatching(/read-only|write/i),
      });

      broker.configureSession("s1", [
        { ...expectedMount(), status: "mounted", canRead: true, canWrite: true },
      ]);
      latestMessage = null;
      const badManifestCheckin = broker.requestBlobCheckin("s1", {
        mountId: "uw-test",
        path: "asset.bin",
        baseHash: "baseline",
        body: new Uint8Array([4, 5, 6]),
      });
      const badManifestError = badManifestCheckin.then(
        () => null,
        (error: unknown) => error,
      );
      for (let attempt = 0; attempt < 20 && !latestMessage; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      const badManifestMessage = latestMessage as BrowserIncomingMessage | null;
      if (!badManifestMessage || badManifestMessage.type !== "user_space_blob_checkin_request") {
        throw new Error("Expected checkin request");
      }
      const badManifestToken = new URL(
        badManifestMessage.downloadUrl,
        "http://localhost",
      ).searchParams.get("token")!;
      await broker.handleCheckinDownload("s1", badManifestMessage.transfer_id, badManifestToken);
      const authorization = broker.authorizeCheckinCommit(
        "s1",
        badManifestMessage.transfer_id,
        badManifestToken,
      ) as { commitLease: string };
      expect(() =>
        broker.handleTransferComplete("s1", badManifestMessage.transfer_id, badManifestToken, {
          ok: true,
          size: 3,
          hash: "wrong-hash",
          commitLease: authorization.commitLease,
        }),
      ).toThrow(/manifest|hash/i);
      await expect(badManifestError).resolves.toMatchObject({
        message: expect.stringMatching(/manifest|hash/i),
      });
      await expect(readdir(join(checkoutRoot, ".pending-checkins"))).resolves.toEqual([]);
    } finally {
      broker.dispose();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("fails closed for binary staging when the current Pi process is not in SRT", async () => {
    const broker = new UserSpaceBroker();
    broker.configureSession("s1", [
      { ...expectedMount(), status: "mounted", canRead: true, canWrite: true },
    ]);
    broker.setSender(() => undefined);

    expect(() =>
      broker.requestBlobCheckout("s1", { mountId: "uw-test", path: "asset.bin" }),
    ).toThrow(/requires the current session to run inside SRT/);
    await expect(
      broker.requestBlobCheckin("s1", {
        mountId: "uw-test",
        path: "asset.bin",
        baseHash: "sha256:baseline",
        body: new Uint8Array([1]),
      }),
    ).rejects.toThrow(/requires the current session to run inside SRT/);
  });

  it("expires pending and completed blob staging across SRT generations", async () => {
    let generation = 1;
    const broker = new UserSpaceBroker(undefined, () => generation);
    broker.configureSession("s1", [
      { ...expectedMount(), status: "mounted", canRead: true, canWrite: true },
    ]);
    let latestMessage: BrowserIncomingMessage | null = null;
    broker.setSender((_sessionId, message) => {
      latestMessage = message;
    });

    const completed = broker.requestBlobCheckout("s1", {
      mountId: "uw-test",
      path: "completed.bin",
    });
    const completedMessage = latestMessage as BrowserIncomingMessage | null;
    if (!completedMessage || completedMessage.type !== "user_space_blob_checkout_request") {
      throw new Error("Expected checkout request");
    }
    const completedToken = new URL(completedMessage.uploadUrl, "http://localhost").searchParams.get(
      "token",
    )!;
    await broker.handleCheckoutUpload(
      "s1",
      completedMessage.transfer_id,
      completedToken,
      new Uint8Array([1, 2, 3]),
    );
    broker.handleTransferComplete("s1", completedMessage.transfer_id, completedToken, {
      ok: true,
    });
    const completedResult = (await completed) as {
      localPath: string;
      size: number;
      hash: string;
    };

    generation = 2;
    await expect(
      broker.consumeBlobCheckout("s1", {
        localPath: completedResult.localPath,
        expectedSize: completedResult.size,
        expectedHash: completedResult.hash,
      }),
    ).rejects.toThrow(/expired sandbox generation/);

    generation = 3;
    latestMessage = null;
    const pending = broker.requestBlobCheckout("s1", {
      mountId: "uw-test",
      path: "pending.bin",
    });
    const pendingMessage = latestMessage as BrowserIncomingMessage | null;
    if (!pendingMessage || pendingMessage.type !== "user_space_blob_checkout_request") {
      throw new Error("Expected checkout request");
    }
    const pendingToken = new URL(pendingMessage.uploadUrl, "http://localhost").searchParams.get(
      "token",
    )!;
    generation = 4;
    await expect(
      broker.handleCheckoutUpload(
        "s1",
        pendingMessage.transfer_id,
        pendingToken,
        new Uint8Array([4]),
      ),
    ).rejects.toThrow(/expired sandbox generation/);
    await expect(pending).rejects.toThrow(/expired sandbox generation/);
  });

  it("rejects and cleans checkout files replaced or modified before final consumption", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "piwork-checkout-consume-"));
    const checkoutRoot = join(tempRoot, "checkouts");
    const broker = new UserSpaceBroker(
      () => checkoutRoot,
      () => 1,
    );
    broker.configureSession("s1", [
      { ...expectedMount(), status: "mounted", canRead: true, canWrite: true },
    ]);
    let latestMessage: BrowserIncomingMessage | null = null;
    broker.setSender((_sessionId, message) => {
      latestMessage = message;
    });
    const getLatestMessage = () => latestMessage as BrowserIncomingMessage | null;
    const app = new Hono();
    const api = new Hono();
    registerUserSpaceTransferRoutes(api, broker);
    app.route("/api", api);

    const checkout = async (bytes: Uint8Array) => {
      latestMessage = null;
      const response = broker.requestBlobCheckout("s1", {
        mountId: "uw-test",
        path: "asset.bin",
      });
      const message = getLatestMessage();
      if (!message || message.type !== "user_space_blob_checkout_request") {
        throw new Error("Expected checkout request");
      }
      expect(
        (
          await app.request(message.uploadUrl, {
            method: "PUT",
            body: Buffer.from(bytes),
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await app.request(message.completeUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ok: true }),
          })
        ).status,
      ).toBe(200);
      return (await response) as { localPath: string; size: number; hash: string };
    };

    try {
      const replaced = await checkout(new Uint8Array([1, 2, 3]));
      const outside = join(tempRoot, "outside-secret.txt");
      writeFileSync(outside, "outside-secret");
      rmSync(replaced.localPath, { force: true });
      symlinkSync(outside, replaced.localPath);
      await expect(
        broker.consumeBlobCheckout("s1", {
          localPath: replaced.localPath,
          expectedSize: replaced.size,
          expectedHash: replaced.hash,
        }),
      ).rejects.toThrow(/staging entry|symbolic|private regular/i);
      expect(existsSync(replaced.localPath)).toBe(false);
      expect(await readFile(outside, "utf-8")).toBe("outside-secret");

      const modified = await checkout(new Uint8Array([4, 5, 6]));
      writeFileSync(modified.localPath, new Uint8Array([7, 8, 9]));
      await expect(
        broker.consumeBlobCheckout("s1", {
          localPath: modified.localPath,
          expectedSize: modified.size,
          expectedHash: modified.hash,
        }),
      ).rejects.toThrow(/hash changed/i);
      expect(existsSync(modified.localPath)).toBe(false);
    } finally {
      broker.dispose();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
