// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const userSpaceMocks = vi.hoisted(() => ({
  executeUserSpaceOperation: vi.fn(),
  handleUserSpaceBlobCheckinRequest: vi.fn(),
  handleUserSpaceBlobCheckoutRequest: vi.fn(),
  resendSessionUserSpaces: vi.fn(),
  setUserSpaceTransport: vi.fn(),
  syncSessionUserSpaces: vi.fn(),
}));

vi.mock("./user-space.js", () => userSpaceMocks);

let wsModule: typeof import("./ws.js");
let sockets: MockWebSocket[];

class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static CONNECTING = 0;
  static CLOSING = 2;
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly CLOSING = 2;
  readyState = MockWebSocket.OPEN;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();

  constructor(readonly url: string) {
    sockets.push(this);
  }
}

function messages(socket: MockWebSocket): Array<Record<string, unknown>> {
  return socket.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>);
}

function fire(socket: MockWebSocket, data: Record<string, unknown>): void {
  socket.onmessage?.({ data: JSON.stringify(data) });
}

beforeEach(async () => {
  vi.resetModules();
  sockets = [];
  userSpaceMocks.executeUserSpaceOperation.mockReset();
  userSpaceMocks.executeUserSpaceOperation.mockResolvedValue({ bytesWritten: 5 });
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "localhost:3456" });
  const { useStore } = await import("./store.js");
  useStore.getState().reset();
  wsModule = await import("./ws.js");
});

afterEach(() => {
  wsModule.disconnectAll();
  vi.unstubAllGlobals();
});

describe("browser User Space mutation commit", () => {
  it("does not execute a write until the exact WebSocket authorization arrives", async () => {
    wsModule.connectSession("session-1");
    const socket = sockets[0]!;
    fire(socket, {
      type: "user_space_mutation_request",
      request_id: "request-1",
      operation: "write_file",
      input: { path: "notes.txt", content: "hello" },
      requires_commit: true,
    });

    expect(userSpaceMocks.executeUserSpaceOperation).not.toHaveBeenCalled();
    expect(messages(socket).at(-1)).toEqual({
      type: "user_space_mutation_authorize",
      request_id: "request-1",
    });

    fire(socket, {
      type: "user_space_mutation_authorization",
      request_id: "request-1",
      ok: true,
      commit_lease: "lease-1",
      runtime_epoch: "epoch-1",
    });
    await vi.waitFor(() =>
      expect(userSpaceMocks.executeUserSpaceOperation).toHaveBeenCalledTimes(1),
    );
    await vi.waitFor(() =>
      expect(messages(socket).at(-1)).toMatchObject({
        type: "user_space_response",
        request_id: "request-1",
        ok: true,
        commit_lease: "lease-1",
        runtime_epoch: "epoch-1",
      }),
    );
  });

  it("executes duplicate grants at most once and reports failures with the same lease", async () => {
    let rejectOperation!: (error: Error) => void;
    userSpaceMocks.executeUserSpaceOperation.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectOperation = reject;
      }),
    );
    wsModule.connectSession("session-1");
    const socket = sockets[0]!;
    fire(socket, {
      type: "user_space_mutation_request",
      request_id: "request-1",
      operation: "shell_exec",
      input: { script: "cat notes.txt > copy.txt" },
      requires_commit: true,
    });
    const grant = {
      type: "user_space_mutation_authorization",
      request_id: "request-1",
      ok: true,
      commit_lease: "lease-1",
      runtime_epoch: "epoch-1",
    };
    fire(socket, grant);
    fire(socket, grant);
    expect(userSpaceMocks.executeUserSpaceOperation).toHaveBeenCalledTimes(1);

    rejectOperation(new Error("native close failed"));
    await vi.waitFor(() =>
      expect(messages(socket).at(-1)).toMatchObject({
        type: "user_space_response",
        request_id: "request-1",
        ok: false,
        error: "native close failed",
        commit_lease: "lease-1",
        runtime_epoch: "epoch-1",
      }),
    );
  });

  it("never moves terminal evidence to a replacement WebSocket", async () => {
    let resolveOperation!: (result: unknown) => void;
    userSpaceMocks.executeUserSpaceOperation.mockReturnValue(
      new Promise((resolve) => {
        resolveOperation = resolve;
      }),
    );
    wsModule.connectSession("session-1");
    const original = sockets[0]!;
    fire(original, {
      type: "user_space_mutation_request",
      request_id: "request-1",
      operation: "replace_text",
      input: { path: "notes.txt", oldText: "old", newText: "new" },
      requires_commit: true,
    });
    fire(original, {
      type: "user_space_mutation_authorization",
      request_id: "request-1",
      ok: true,
      commit_lease: "lease-1",
      runtime_epoch: "epoch-1",
    });
    wsModule.disconnectSession("session-1");
    wsModule.connectSession("session-1");
    const replacement = sockets[1]!;
    original.send.mockClear();
    replacement.send.mockClear();

    resolveOperation({ bytesWritten: 3 });
    await vi.waitFor(() => expect(original.send).toHaveBeenCalledOnce());
    expect(messages(original)[0]).toMatchObject({
      type: "user_space_response",
      commit_lease: "lease-1",
      runtime_epoch: "epoch-1",
    });
    expect(replacement.send).not.toHaveBeenCalled();
  });

  it("drops a denied authorization without executing the mutation", async () => {
    wsModule.connectSession("session-1");
    const socket = sockets[0]!;
    fire(socket, {
      type: "user_space_mutation_request",
      request_id: "request-1",
      operation: "delete_entry",
      input: { path: "notes.txt" },
      requires_commit: true,
    });
    fire(socket, {
      type: "user_space_mutation_authorization",
      request_id: "request-1",
      ok: false,
      error: "authorized to another browser",
    });
    await Promise.resolve();
    expect(userSpaceMocks.executeUserSpaceOperation).not.toHaveBeenCalled();
  });
});
