import {
  mountOfficeEditor,
  type CreateOfficeEditorOptions,
  type OfficeEditorInstance,
  type OfficeEditorMount,
  type OfficeHostIdentity,
  type OfficeHostUrlContext,
  type OfficeHostUrlResolver,
} from "@agentbridges-ai/onlyoffice-browser";
import releaseManifest from "../../release/onlyoffice-release-manifest.json";
import { registerOfficeContextGate } from "./office-context-gate.js";
import {
  runtimeContextCoordinator,
  type RuntimeContext,
  type RuntimeContextInput,
} from "./runtime-context.js";

export type OfficeEditorMountAdapter = (
  container: HTMLElement,
  options: CreateOfficeEditorOptions,
) => OfficeEditorMount;

export interface MountOfficePreviewOptions extends CreateOfficeEditorOptions {
  resourceKey: string;
  foreground?: boolean;
}

export interface OfficePreviewLease {
  readonly id: string;
  readonly ready: Promise<OfficeEditorInstance>;
  dispose(): Promise<void>;
}

export interface OfficePreviewRuntimeManagerOptions {
  mountEditor?: OfficeEditorMountAdapter;
  expectedIdentity?: OfficeHostIdentity;
  activationBudget?: number;
  retryLimit?: number;
}

type EditorTrackingState = {
  dirty: boolean;
  lastSaveError: Error | null;
};

type PreviewRecord = {
  key: string;
  container: HTMLElement;
  options: Omit<MountOfficePreviewOptions, "resourceKey" | "foreground">;
  mount: OfficeEditorMount;
  instance: OfficeEditorInstance | null;
  context: RuntimeContext | null;
  state: EditorTrackingState;
  sequence: number;
  attempts: number;
  foreground: boolean;
  status: "waiting" | "activating" | "ready" | "error" | "disposed";
  settled: boolean;
  resolveReady: (instance: OfficeEditorInstance) => void;
  rejectReady: (error: Error) => void;
  ready: Promise<OfficeEditorInstance>;
  detachScope: () => void;
  disposePromise: Promise<void> | null;
};

export class OfficeHostCompatibilityError extends Error {
  readonly expected: OfficeHostIdentity;
  readonly cause: Error;

  constructor(expected: OfficeHostIdentity, cause: Error) {
    super(`Office editor runtime is incompatible with this Piwork build: ${cause.message}`);
    this.name = "OfficeHostCompatibilityError";
    this.expected = expected;
    this.cause = cause;
  }
}

export class OfficeContextSwitchBlockedError extends Error {
  readonly resourceKey: string;
  readonly cause: Error;

  constructor(resourceKey: string, cause: Error) {
    super("The current Office document could not be saved. Session switch was cancelled.");
    this.name = "OfficeContextSwitchBlockedError";
    this.resourceKey = resourceKey;
    this.cause = cause;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function identitiesEqual(left: OfficeHostIdentity, right: OfficeHostIdentity): boolean {
  return (
    left.packageVersion === right.packageVersion &&
    left.hostBuildId === right.hostBuildId &&
    left.assetManifestDigest === right.assetManifestDigest
  );
}

function expectedReleaseIdentity(): OfficeHostIdentity {
  const identity = releaseManifest.runtimeIdentity;
  if (
    !identity ||
    typeof identity.packageVersion !== "string" ||
    typeof identity.hostBuildId !== "string" ||
    !/^[a-f0-9]{64}$/.test(identity.assetManifestDigest)
  ) {
    throw new Error("OnlyOffice release manifest is missing a valid runtime identity");
  }
  return Object.freeze({ ...identity });
}

function withRetryCacheBust(
  hostUrl: OfficeHostUrlResolver,
  attempt: number,
  expected: OfficeHostIdentity,
): OfficeHostUrlResolver {
  if (attempt === 0) return hostUrl;
  return (context: OfficeHostUrlContext) => {
    const resolved = typeof hostUrl === "function" ? hostUrl(context) : hostUrl;
    const url = new URL(resolved, window.location.href);
    url.searchParams.set("piworkOfficeHostBuild", expected.hostBuildId);
    url.searchParams.set("piworkOfficeHostRetry", String(attempt));
    return url;
  };
}

export function resolveOfficeActivationBudget(
  deviceMemory: number | null | undefined = (navigator as Navigator & { deviceMemory?: number })
    .deviceMemory,
  hardwareConcurrency: number | null | undefined = navigator.hardwareConcurrency,
): 1 {
  void deviceMemory;
  void hardwareConcurrency;
  return 1;
}

function isRetryableStartupError(error: Error): boolean {
  return !["AbortError", "OfficeHostIsolationError", "OfficeContextSwitchBlockedError"].includes(
    error.name,
  );
}

export class OfficePreviewRuntimeManager {
  private readonly mountEditor: OfficeEditorMountAdapter;
  private readonly expectedIdentity: OfficeHostIdentity;
  private readonly activationBudget: number;
  private readonly retryLimit: number;
  private readonly records = new Map<string, PreviewRecord>();
  private foregroundKey: string | null = null;
  private nextSequence = 1;
  private activations = 0;
  private scheduled = false;
  private switchGate: Promise<void> | null = null;

  constructor(options: OfficePreviewRuntimeManagerOptions = {}) {
    this.mountEditor = options.mountEditor ?? mountOfficeEditor;
    this.expectedIdentity = options.expectedIdentity ?? expectedReleaseIdentity();
    this.activationBudget = Math.min(
      1,
      Math.max(1, Math.floor(options.activationBudget ?? resolveOfficeActivationBudget())),
    );
    this.retryLimit = Math.max(0, Math.min(1, Math.floor(options.retryLimit ?? 1)));
  }

  mount(container: HTMLElement, options: MountOfficePreviewOptions): OfficePreviewLease {
    const { resourceKey, foreground = false, ...editorOptions } = options;
    if (!resourceKey.trim()) {
      throw new Error("OfficePreviewRuntimeManager requires a resourceKey");
    }
    if (this.records.has(resourceKey)) {
      throw new Error(`Office preview ${resourceKey} is already mounted`);
    }

    let resolveReady!: (instance: OfficeEditorInstance) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<OfficeEditorInstance>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    const tracking: EditorTrackingState = { dirty: false, lastSaveError: null };
    const record = {
      key: resourceKey,
      container,
      options: editorOptions,
      mount: null as unknown as OfficeEditorMount,
      instance: null,
      context: runtimeContextCoordinator.current()?.context ?? null,
      state: tracking,
      sequence: this.nextSequence++,
      attempts: 0,
      foreground,
      status: "waiting" as const,
      settled: false,
      resolveReady,
      rejectReady,
      ready,
      detachScope: () => {},
      disposePromise: null,
    } satisfies PreviewRecord;

    record.mount = this.createMount(record);
    const contextLease = runtimeContextCoordinator.current();
    if (contextLease) {
      record.detachScope = contextLease.scope.add(() => this.disposeRecord(record));
    }
    this.records.set(resourceKey, record);
    if (foreground) this.foregroundKey = resourceKey;
    this.schedule();

    return {
      get id() {
        return record.mount.id;
      },
      ready,
      dispose: () => this.disposeRecord(record),
    };
  }

  setForeground(resourceKey: string | null): void {
    this.foregroundKey = resourceKey;
    for (const record of this.records.values()) {
      record.foreground = record.key === resourceKey;
    }
    this.schedule();
  }

  gateContextSwitch(next: RuntimeContextInput): Promise<void> {
    const current = runtimeContextCoordinator.current()?.context;
    if (
      !current ||
      current.userId !== next.userId ||
      current.userScopeKey !== (next.userScopeKey ?? next.userId) ||
      (current.agentId === next.agentId && current.sessionId === next.sessionId)
    ) {
      return Promise.resolve();
    }
    if (this.switchGate) return this.switchGate;

    const gate = this.saveDirtyEditorsForContext(current).finally(() => {
      if (this.switchGate === gate) this.switchGate = null;
    });
    this.switchGate = gate;
    return gate;
  }

  async dispose(): Promise<void> {
    const records = [...this.records.values()];
    await Promise.allSettled(records.map((record) => this.disposeRecord(record)));
  }

  private createMount(record: PreviewRecord): OfficeEditorMount {
    const attempt = record.attempts;
    const options = this.wrapOptions(record, attempt);
    return this.mountEditor(record.container, {
      ...options,
      hostUrl: withRetryCacheBust(record.options.hostUrl, attempt, this.expectedIdentity),
      expectedHostIdentity: this.expectedIdentity,
    });
  }

  private wrapOptions(record: PreviewRecord, attempt: number): CreateOfficeEditorOptions {
    const options = record.options;
    return {
      ...options,
      onDirtyChange: async (dirty, instance) => {
        if (record.instance && instance.id !== record.instance.id) return;
        record.state.dirty = dirty;
        if (!dirty) record.state.lastSaveError = null;
        await options.onDirtyChange?.(dirty, instance);
      },
      onStateChange: async (state, instance) => {
        if (record.instance && instance.id !== record.instance.id) return;
        record.state.dirty = state.dirty;
        if (!state.dirty) record.state.lastSaveError = null;
        await options.onStateChange?.(state, instance);
      },
      onSave: options.onSave
        ? async (file, instance) => {
            try {
              const result = await options.onSave!(file, instance);
              record.state.lastSaveError = null;
              return result;
            } catch (error) {
              record.state.lastSaveError = toError(error);
              record.state.dirty = true;
              throw error;
            }
          }
        : undefined,
      onError: (error, instance) => {
        if (record.state.dirty) record.state.lastSaveError = error;
        if (!(attempt < this.retryLimit && isRetryableStartupError(error))) {
          options.onError?.(error, instance);
        }
      },
    };
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    while (this.activations < this.activationBudget) {
      const next = this.nextWaitingRecord();
      if (!next) return;
      next.status = "activating";
      this.activations += 1;
      void this.activateRecord(next).finally(() => {
        this.activations -= 1;
        this.schedule();
      });
    }
  }

  private nextWaitingRecord(): PreviewRecord | undefined {
    const waiting = [...this.records.values()].filter((record) => record.status === "waiting");
    const foreground = waiting.find((record) => record.key === this.foregroundKey);
    return foreground ?? waiting.sort((left, right) => left.sequence - right.sequence)[0];
  }

  private async activateRecord(record: PreviewRecord): Promise<void> {
    try {
      const instance = await record.mount.activate();
      if (record.status === "disposed" || this.records.get(record.key) !== record) {
        await instance.destroy().catch(() => undefined);
        return;
      }
      const actualIdentity = instance.getHostIdentity();
      if (!identitiesEqual(this.expectedIdentity, actualIdentity)) {
        const mismatch = new Error("Office host returned a different runtime identity after ready");
        mismatch.name = "OfficeHostIdentityMismatchError";
        throw mismatch;
      }

      record.instance = instance;
      record.status = "ready";
      record.settled = true;
      record.resolveReady(instance);
    } catch (error) {
      const normalized = toError(error);
      await record.mount.destroy().catch(() => undefined);
      if (record.status === "disposed" || this.records.get(record.key) !== record) return;

      if (record.attempts < this.retryLimit && isRetryableStartupError(normalized)) {
        record.attempts += 1;
        record.sequence = this.nextSequence++;
        try {
          record.mount = this.createMount(record);
          record.status = "waiting";
          return;
        } catch (retryMountError) {
          this.failRecord(record, toError(retryMountError));
          return;
        }
      }

      const finalError =
        normalized.name === "OfficeHostIdentityMismatchError"
          ? new OfficeHostCompatibilityError(this.expectedIdentity, normalized)
          : normalized;
      this.failRecord(record, finalError);
    }
  }

  private failRecord(record: PreviewRecord, error: Error): void {
    record.status = "error";
    if (!record.settled) {
      record.settled = true;
      record.rejectReady(error);
    }
  }

  private disposeRecord(record: PreviewRecord): Promise<void> {
    if (record.disposePromise) return record.disposePromise;
    record.status = "disposed";
    if (this.records.get(record.key) === record) this.records.delete(record.key);
    record.detachScope();
    if (!record.settled) {
      record.settled = true;
      record.rejectReady(abortError("Office preview was disposed before it became ready"));
    }
    record.disposePromise = Promise.resolve(record.mount.destroy()).catch((error) => {
      console.warn("[office-preview-runtime-manager] Failed to destroy editor", toError(error));
    });
    return record.disposePromise;
  }

  private async saveDirtyEditorsForContext(context: RuntimeContext): Promise<void> {
    const records = [...this.records.values()].filter(
      (record) =>
        record.status === "ready" &&
        record.instance &&
        record.context?.userId === context.userId &&
        record.context.sessionId === context.sessionId &&
        record.context.epoch === context.epoch,
    );
    for (const record of records) {
      const instance = record.instance!;
      const state = instance.getState();
      if (!state.dirty && !record.state.dirty) continue;
      try {
        await instance.save();
        if (instance.getState().dirty || record.state.dirty) {
          throw record.state.lastSaveError ?? new Error("Office editor remained dirty after save");
        }
      } catch (error) {
        throw new OfficeContextSwitchBlockedError(record.key, toError(error));
      }
    }
  }
}

export const officePreviewRuntimeManager = new OfficePreviewRuntimeManager();
registerOfficeContextGate((next) => officePreviewRuntimeManager.gateContextSwitch(next));
