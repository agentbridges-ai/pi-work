export interface RuntimeContextInput {
  /** Raw Better Auth user.id. Never encode tenant scope into this field. */
  userId: string;
  /** User-lifetime isolation key. Defaults to userId for callers without tenant scope. */
  userScopeKey?: string;
  agentId: string;
  sessionId: string | null;
}

export interface RuntimeContext extends Omit<RuntimeContextInput, "userScopeKey"> {
  userScopeKey: string;
  epoch: number;
  /** Per-context browser capability. Never derive authority from epoch alone. */
  contextId: string;
}

export type ResourceDisposer = () => void | Promise<void>;

/**
 * Owns browser resources for one lifetime. Disposal is synchronous for aborting
 * work and invoking cleanup callbacks; asynchronous cleanup is drained in the
 * returned promise.
 */
export class ResourceScope {
  private readonly controller = new AbortController();
  private readonly disposers = new Set<ResourceDisposer>();
  private disposed = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  add(disposer: ResourceDisposer): () => void {
    if (this.disposed) {
      void runDisposer(disposer);
      return () => {};
    }
    this.disposers.add(disposer);
    return () => this.disposers.delete(disposer);
  }

  child(): ResourceScope {
    const child = new ResourceScope();
    if (this.disposed) {
      void child.dispose();
      return child;
    }
    const detach = this.add(() => child.dispose());
    child.add(detach);
    return child;
  }

  dispose(
    reason: unknown = new DOMException("Resource scope disposed", "AbortError"),
  ): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.disposed = true;
    this.controller.abort(reason);
    const pending = Array.from(this.disposers, (disposer) => runDisposer(disposer));
    this.disposers.clear();
    return Promise.allSettled(pending).then(() => undefined);
  }
}

export interface RuntimeContextLease {
  context: RuntimeContext;
  /** Resources tied to the active Better Auth user + tenant isolation lifetime. */
  userScope: ResourceScope;
  /** Resources tied to the current agent/session context. */
  scope: ResourceScope;
}

export interface RuntimeContextCandidate extends RuntimeContextLease {
  isLatest(): boolean;
  /** Atomically makes this candidate active; stale candidates cannot commit. */
  commit(apply?: () => void): boolean;
  abort(): Promise<void>;
}

function sameContext(left: RuntimeContext, right: RuntimeContextInput): boolean {
  return (
    left.userId === right.userId &&
    left.userScopeKey === scopeKeyForInput(right) &&
    left.agentId === right.agentId &&
    left.sessionId === right.sessionId
  );
}

function scopeKeyForInput(input: RuntimeContextInput): string {
  return input.userScopeKey ?? input.userId;
}

function createContextId(): string {
  const crypto = globalThis.crypto;
  if (!crypto || typeof crypto.getRandomValues !== "function") {
    throw new Error("Secure random generation is unavailable");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createContext(input: RuntimeContextInput, epoch: number): RuntimeContext {
  return Object.freeze({
    userId: input.userId,
    userScopeKey: scopeKeyForInput(input),
    agentId: input.agentId,
    sessionId: input.sessionId,
    epoch,
    contextId: createContextId(),
  });
}

export class RuntimeContextCoordinator {
  private epoch = 0;
  private active: RuntimeContextLease | null = null;
  private pending: RuntimeContextCandidate | null = null;

  activate(input: RuntimeContextInput): RuntimeContextLease {
    const pending = this.pending;
    this.pending = null;
    if (pending) void pending.abort();
    if (this.active && sameContext(this.active.context, input)) return this.active;

    const userChanged =
      !this.active || this.active.context.userScopeKey !== scopeKeyForInput(input);
    let userScope: ResourceScope;
    if (userChanged) {
      if (this.active) void this.active.userScope.dispose();
      userScope = new ResourceScope();
    } else {
      userScope = this.active!.userScope;
      void this.active!.scope.dispose();
    }

    const context = createContext(input, ++this.epoch);
    const scope = userScope.child();
    this.active = { context, userScope, scope };
    return this.active;
  }

  /**
   * Prepare a context switch without releasing the current context. Same-scope
   * agent/session switches reuse userScope; a different userScopeKey gets a
   * fresh one. Only the newest candidate can commit.
   */
  prepare(input: RuntimeContextInput): RuntimeContextCandidate {
    const previousCandidate = this.pending;
    this.pending = null;
    if (previousCandidate) void previousCandidate.abort();

    const previousActive = this.active;
    const userChanged =
      !previousActive || previousActive.context.userScopeKey !== scopeKeyForInput(input);
    const userScope = userChanged ? new ResourceScope() : previousActive.userScope;
    const scope = userScope.child();
    const lease: RuntimeContextLease = {
      context: createContext(input, ++this.epoch),
      userScope,
      scope,
    };
    let settled = false;
    let candidate!: RuntimeContextCandidate;
    candidate = {
      ...lease,
      isLatest: () => !settled && this.pending === candidate && !scope.isDisposed,
      commit: (apply = () => undefined) => {
        if (settled || this.pending !== candidate || scope.isDisposed) return false;
        try {
          apply();
          settled = true;
          this.pending = null;
          const active = this.active;
          this.active = lease;
          if (active) {
            if (active.userScope !== userScope) void active.userScope.dispose();
            else if (active.scope !== scope) void active.scope.dispose();
          }
          return true;
        } catch (error) {
          void candidate.abort();
          throw error;
        }
      },
      abort: async () => {
        if (settled) return;
        settled = true;
        if (this.pending === candidate) this.pending = null;
        if (userChanged) await userScope.dispose();
        else await scope.dispose();
      },
    };
    this.pending = candidate;
    return candidate;
  }

  current(): RuntimeContextLease | null {
    return this.active;
  }

  isCurrent(
    context:
      | (Pick<RuntimeContext, "epoch"> & Partial<Pick<RuntimeContext, "contextId">>)
      | null
      | undefined,
  ): boolean {
    return (
      !!context &&
      this.active?.context.epoch === context.epoch &&
      (context.contextId === undefined || this.active.context.contextId === context.contextId)
    );
  }

  operationScope(
    context: Pick<RuntimeContext, "epoch"> & Partial<Pick<RuntimeContext, "contextId">>,
  ): ResourceScope {
    if (!this.isCurrent(context) || !this.active) {
      const disposed = new ResourceScope();
      void disposed.dispose();
      return disposed;
    }
    return this.active.scope.child();
  }

  async dispose(): Promise<void> {
    const active = this.active;
    const pending = this.pending;
    this.active = null;
    this.pending = null;
    this.epoch++;
    if (pending) await pending.abort();
    if (active) await active.userScope.dispose();
  }
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : !!error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError";
}

async function runDisposer(disposer: ResourceDisposer): Promise<void> {
  try {
    await disposer();
  } catch (error) {
    console.warn("[resource-scope] cleanup failed", error);
  }
}

export const runtimeContextCoordinator = new RuntimeContextCoordinator();
