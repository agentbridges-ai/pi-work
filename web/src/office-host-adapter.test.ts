// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CreateOfficeEditorOptions,
  OfficeEditorInstance,
  OfficeEditorMount,
  OfficeEditorState,
  OfficeHostIdentity,
} from "@agentbridges-ai/onlyoffice-browser";
import {
  OfficeContextSwitchBlockedError,
  OfficeHostCompatibilityError,
  OfficePreviewRuntimeManager,
  resolveOfficeActivationBudget,
} from "./office-host-adapter.js";
import { runtimeContextCoordinator } from "./runtime-context.js";

const EXPECTED_IDENTITY: OfficeHostIdentity = {
  packageVersion: "0.3.28",
  hostBuildId: "office-host-test",
  assetManifestDigest: "a".repeat(64),
};

function makeState(overrides: Partial<OfficeEditorState> = {}): OfficeEditorState {
  return {
    id: "office-test",
    fileName: "report.docx",
    fileType: "docx",
    mode: "edit",
    readonly: false,
    dirty: false,
    sourceKind: "local-file",
    status: "ready",
    destroyed: false,
    ...overrides,
  };
}

function makeInstance(
  options: {
    identity?: OfficeHostIdentity;
    dirty?: boolean;
    saveError?: Error;
  } = {},
): OfficeEditorInstance & { save: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> } {
  let state = makeState({ dirty: options.dirty ?? false });
  const save = vi.fn(async () => {
    if (options.saveError) throw options.saveError;
    state = { ...state, dirty: false };
    return new File(["saved"], state.fileName);
  });
  const destroy = vi.fn(async () => {
    state = { ...state, status: "destroyed", destroyed: true };
  });
  return {
    id: state.id,
    save,
    invokePlugin: vi.fn(async () => undefined),
    destroy,
    confirmSaveToNewFormat: vi.fn(async () => true),
    setInterfaceTheme: vi.fn(),
    setReadonly: vi.fn(),
    getState: () => ({ ...state }),
    getHostIdentity: () => ({ ...(options.identity ?? EXPECTED_IDENTITY) }),
  };
}

function mismatchError(): Error {
  const error = new Error("host identity mismatch");
  error.name = "OfficeHostIdentityMismatchError";
  return error;
}

const adapters: OfficePreviewRuntimeManager[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function mountAdapterFromFactory(
  createEditor: (
    container: HTMLElement,
    options: CreateOfficeEditorOptions,
  ) => Promise<OfficeEditorInstance>,
): (container: HTMLElement, options: CreateOfficeEditorOptions) => OfficeEditorMount {
  let sequence = 0;
  return (container, options) => {
    const id = `mount-${++sequence}`;
    const iframe = container.ownerDocument.createElement("iframe");
    iframe.dataset.officeMountId = id;
    container.replaceChildren(iframe);
    let instance: OfficeEditorInstance | null = null;
    let activation: Promise<OfficeEditorInstance> | null = null;
    return {
      id,
      activate: () => {
        activation ??= createEditor(container, options).then((result) => {
          instance = result;
          return result;
        });
        return activation;
      },
      destroy: async () => {
        await instance?.destroy();
        iframe.remove();
      },
      getState: () => ({
        id,
        origin: `https://${id}.office-host.test`,
        phase: instance ? "ready" : iframe.isConnected ? "waiting-for-activation" : "destroyed",
      }),
    };
  };
}

beforeEach(async () => {
  await runtimeContextCoordinator.dispose();
});

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.dispose()));
  await runtimeContextCoordinator.dispose();
});

describe("OfficePreviewRuntimeManager", () => {
  it("uses one activation slot on every device profile", () => {
    expect(resolveOfficeActivationBudget(null, 8)).toBe(1);
    expect(resolveOfficeActivationBudget(8, null)).toBe(1);
    expect(resolveOfficeActivationBudget(4, 12)).toBe(1);
    expect(resolveOfficeActivationBudget(16, 4)).toBe(1);
    expect(resolveOfficeActivationBudget(8, 8)).toBe(1);
  });

  it("mounts 100 independent iframe shells immediately and never exceeds its activation budget", async () => {
    const activations: Array<ReturnType<typeof deferred<OfficeEditorInstance>>> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const createEditor = vi.fn(async () => {
      const activation = deferred<OfficeEditorInstance>();
      activations.push(activation);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return await activation.promise;
      } finally {
        inFlight -= 1;
      }
    });
    const manager = new OfficePreviewRuntimeManager({
      mountEditor: mountAdapterFromFactory(createEditor),
      expectedIdentity: EXPECTED_IDENTITY,
      activationBudget: 2,
    });
    adapters.push(manager);
    const containers = Array.from({ length: 100 }, () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      return container;
    });
    const leases = containers.map((container, index) =>
      manager.mount(container, {
        resourceKey: `tab-${index}`,
        hostUrl: "http://host.localhost/office-host.html",
        file: new File([String(index)], `file-${index}.docx`),
      }),
    );

    expect(containers.every((container) => container.querySelector("iframe"))).toBe(true);
    expect(new Set(leases.map((lease) => lease.id)).size).toBe(100);
    await vi.waitFor(() => expect(createEditor).toHaveBeenCalledTimes(1));

    for (let index = 0; index < 100; index += 1) {
      activations[index]!.resolve(makeInstance());
      if (index < 99) {
        await vi.waitFor(() => expect(createEditor.mock.calls.length).toBeGreaterThan(index + 1));
      }
    }
    await expect(Promise.all(leases.map((lease) => lease.ready))).resolves.toHaveLength(100);
    expect(maxInFlight).toBe(1);
  });

  it("gives the foreground preview the next slot and preserves FIFO for the rest", async () => {
    const startOrder: string[] = [];
    const createEditor = vi.fn(
      async (_container: HTMLElement, options: CreateOfficeEditorOptions) => {
        startOrder.push(options.fileName || "");
        return makeInstance();
      },
    );
    const manager = new OfficePreviewRuntimeManager({
      mountEditor: mountAdapterFromFactory(createEditor),
      expectedIdentity: EXPECTED_IDENTITY,
      activationBudget: 1,
    });
    adapters.push(manager);

    const first = manager.mount(document.createElement("div"), {
      resourceKey: "first",
      hostUrl: "http://host.localhost/office-host.html",
      fileName: "first.docx",
      file: new File(["first"], "first.docx"),
    });
    const foreground = manager.mount(document.createElement("div"), {
      resourceKey: "foreground",
      foreground: true,
      hostUrl: "http://host.localhost/office-host.html",
      fileName: "foreground.docx",
      file: new File(["foreground"], "foreground.docx"),
    });
    const last = manager.mount(document.createElement("div"), {
      resourceKey: "last",
      hostUrl: "http://host.localhost/office-host.html",
      fileName: "last.docx",
      file: new File(["last"], "last.docx"),
    });

    await Promise.all([first.ready, foreground.ready, last.ready]);
    expect(startOrder).toEqual(["foreground.docx", "first.docx", "last.docx"]);
  });

  it("requeues a fresh-origin retry at the FIFO tail without blocking other previews", async () => {
    const startOrder: string[] = [];
    const createEditor = vi.fn(
      async (_container: HTMLElement, options: CreateOfficeEditorOptions) => {
        const name = options.fileName || "";
        startOrder.push(name);
        if (name === "first.docx" && startOrder.filter((entry) => entry === name).length === 1) {
          throw new Error("first startup failed");
        }
        return makeInstance();
      },
    );
    const manager = new OfficePreviewRuntimeManager({
      mountEditor: mountAdapterFromFactory(createEditor),
      expectedIdentity: EXPECTED_IDENTITY,
      activationBudget: 1,
    });
    adapters.push(manager);
    const mount = (name: string) =>
      manager.mount(document.createElement("div"), {
        resourceKey: name,
        hostUrl: "http://host.localhost/office-host.html",
        fileName: `${name}.docx`,
        file: new File([name], `${name}.docx`),
      });

    const first = mount("first");
    const second = mount("second");
    const third = mount("third");
    await Promise.all([first.ready, second.ready, third.ready]);

    expect(startOrder).toEqual(["first.docx", "second.docx", "third.docx", "first.docx"]);
    expect(first.id).not.toBe("mount-1");
  });

  it("rebuilds an incompatible host once and accepts the verified replacement", async () => {
    const replacement = makeInstance();
    const onError = vi.fn();
    const hostUrls: string[] = [];
    const createEditor = vi.fn(
      async (_container: HTMLElement, options: CreateOfficeEditorOptions) => {
        const hostUrl =
          typeof options.hostUrl === "function"
            ? options.hostUrl({
                sessionId: "s",
                fileName: "a.docx",
                fileType: "docx",
                mode: "edit",
              })
            : options.hostUrl;
        hostUrls.push(String(hostUrl));
        if (hostUrls.length === 1) {
          const error = mismatchError();
          options.onError?.(error);
          throw error;
        }
        return replacement;
      },
    );
    const adapter = new OfficePreviewRuntimeManager({
      mountEditor: mountAdapterFromFactory(createEditor),
      expectedIdentity: EXPECTED_IDENTITY,
    });
    adapters.push(adapter);

    await expect(
      adapter.mount(document.createElement("div"), {
        resourceKey: "tab-1",
        hostUrl: "http://host.localhost/office-host.html",
        file: new File(["a"], "a.docx"),
        onError,
      }).ready,
    ).resolves.toBe(replacement);

    expect(createEditor).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
    expect(hostUrls[1]).toContain("piworkOfficeHostBuild=office-host-test");
    expect(hostUrls[1]).toContain("piworkOfficeHostRetry=1");
  });

  it("refuses editing when the rebuilt host is still incompatible", async () => {
    const createEditor = vi.fn(async () => {
      throw mismatchError();
    });
    const adapter = new OfficePreviewRuntimeManager({
      mountEditor: mountAdapterFromFactory(createEditor),
      expectedIdentity: EXPECTED_IDENTITY,
    });
    adapters.push(adapter);

    await expect(
      adapter.mount(document.createElement("div"), {
        resourceKey: "tab-1",
        hostUrl: "http://host.localhost/office-host.html",
        file: new File(["a"], "a.docx"),
      }).ready,
    ).rejects.toBeInstanceOf(OfficeHostCompatibilityError);
    expect(createEditor).toHaveBeenCalledTimes(2);
  });

  it("saves dirty editors before allowing a same-user session switch", async () => {
    runtimeContextCoordinator.activate({
      userId: "user-a",
      agentId: "agent-a",
      sessionId: "session-a",
    });
    const instance = makeInstance({ dirty: true });
    const adapter = new OfficePreviewRuntimeManager({
      expectedIdentity: EXPECTED_IDENTITY,
      mountEditor: mountAdapterFromFactory(vi.fn(async () => instance)),
    });
    adapters.push(adapter);
    await adapter.mount(document.createElement("div"), {
      resourceKey: "tab-1",
      hostUrl: "http://host.localhost/office-host.html",
      file: new File(["a"], "a.docx"),
    }).ready;

    await expect(
      adapter.gateContextSwitch({
        userId: "user-a",
        agentId: "agent-a",
        sessionId: "session-b",
      }),
    ).resolves.toBeUndefined();
    expect(instance.save).toHaveBeenCalledTimes(1);
  });

  it("blocks a same-user session switch when saving fails", async () => {
    runtimeContextCoordinator.activate({
      userId: "user-a",
      agentId: "agent-a",
      sessionId: "session-a",
    });
    const instance = makeInstance({ dirty: true, saveError: new Error("disk permission denied") });
    const adapter = new OfficePreviewRuntimeManager({
      expectedIdentity: EXPECTED_IDENTITY,
      mountEditor: mountAdapterFromFactory(vi.fn(async () => instance)),
    });
    adapters.push(adapter);
    await adapter.mount(document.createElement("div"), {
      resourceKey: "tab-1",
      hostUrl: "http://host.localhost/office-host.html",
      file: new File(["a"], "a.docx"),
    }).ready;

    await expect(
      adapter.gateContextSwitch({
        userId: "user-a",
        agentId: "agent-a",
        sessionId: "session-b",
      }),
    ).rejects.toBeInstanceOf(OfficeContextSwitchBlockedError);
    expect(instance.save).toHaveBeenCalledTimes(1);
  });

  it("does not delay an account switch and releases the editor with the user scope", async () => {
    runtimeContextCoordinator.activate({
      userId: "user-a",
      agentId: "agent-a",
      sessionId: "session-a",
    });
    const instance = makeInstance({ dirty: true });
    const adapter = new OfficePreviewRuntimeManager({
      expectedIdentity: EXPECTED_IDENTITY,
      mountEditor: mountAdapterFromFactory(vi.fn(async () => instance)),
    });
    adapters.push(adapter);
    await adapter.mount(document.createElement("div"), {
      resourceKey: "tab-1",
      hostUrl: "http://host.localhost/office-host.html",
      file: new File(["a"], "a.docx"),
    }).ready;

    await adapter.gateContextSwitch({
      userId: "user-b",
      agentId: "agent-b",
      sessionId: "session-b",
    });
    expect(instance.save).not.toHaveBeenCalled();
    await runtimeContextCoordinator.dispose();
    expect(instance.destroy).toHaveBeenCalledTimes(1);
  });

  it("does not save an old tenant editor during a same-account tenant switch", async () => {
    runtimeContextCoordinator.activate({
      userId: "user-a",
      userScopeKey: '["user-a","tenant-a"]',
      agentId: "agent-a",
      sessionId: "session-a",
    });
    const instance = makeInstance({ dirty: true });
    const adapter = new OfficePreviewRuntimeManager({
      expectedIdentity: EXPECTED_IDENTITY,
      mountEditor: mountAdapterFromFactory(vi.fn(async () => instance)),
    });
    adapters.push(adapter);
    await adapter.mount(document.createElement("div"), {
      resourceKey: "tab-1",
      hostUrl: "http://host.localhost/office-host.html",
      file: new File(["a"], "a.docx"),
    }).ready;

    await adapter.gateContextSwitch({
      userId: "user-a",
      userScopeKey: '["user-a","tenant-b"]',
      agentId: "agent-a",
      sessionId: "session-a",
    });

    expect(instance.save).not.toHaveBeenCalled();
  });
});
