export interface ScopedWriteContext {
  scopeKey: string;
  signal: AbortSignal;
}

export interface ScopedLatestWriteCoordinatorOptions<Value, Result> {
  write: (value: Value, context: ScopedWriteContext) => Promise<Result>;
  onSuccess?: (result: Result, value: Value, scopeKey: string) => void;
  onError?: (error: unknown, value: Value, scopeKey: string) => void;
  onSavingChange?: (saving: boolean, scopeKey: string) => void;
  dedupeKey?: (value: Value) => string;
}

interface PendingWrite<Value> {
  generation: number;
  sequence: number;
  scopeKey: string;
  value: Value;
  dedupeKey?: string;
}

/**
 * Serializes writes within one user scope and retains only the newest queued
 * value. A response is observable only when it still belongs to the active
 * scope and no newer value was enqueued while it was in flight.
 */
export class ScopedLatestWriteCoordinator<Value, Result> {
  private readonly options: ScopedLatestWriteCoordinatorOptions<Value, Result>;
  private scopeKey = "";
  private generation = 0;
  private sequence = 0;
  private latestSequence = 0;
  private pending: PendingWrite<Value> | null = null;
  private active: { entry: PendingWrite<Value>; controller: AbortController } | null = null;
  private draining = false;
  private saving = false;
  private savingScopeKey = "";
  private readonly idleWaiters = new Set<() => void>();

  constructor(options: ScopedLatestWriteCoordinatorOptions<Value, Result>) {
    this.options = options;
  }

  setScope(scopeKey: string): void {
    if (scopeKey === this.scopeKey) return;
    const previousScopeKey = this.scopeKey;
    this.scopeKey = scopeKey;
    this.generation += 1;
    this.latestSequence = 0;
    this.pending = null;
    this.active?.controller.abort();
    if (this.saving && this.savingScopeKey === previousScopeKey) {
      this.setSaving(false, previousScopeKey);
    }
    this.resolveIdleWaitersIfIdle();
  }

  enqueue(scopeKey: string, value: Value): number | null {
    if (!scopeKey) return null;
    if (scopeKey !== this.scopeKey) this.setScope(scopeKey);

    const dedupeKey = this.options.dedupeKey?.(value);
    if (
      dedupeKey !== undefined &&
      !this.pending &&
      this.active?.entry.scopeKey === scopeKey &&
      this.active.entry.dedupeKey === dedupeKey
    ) {
      return this.active.entry.sequence;
    }
    if (
      dedupeKey !== undefined &&
      this.pending?.scopeKey === scopeKey &&
      this.pending.dedupeKey === dedupeKey
    ) {
      this.pending = { ...this.pending, value };
      return this.pending.sequence;
    }

    const sequence = ++this.sequence;
    this.latestSequence = sequence;
    this.pending = {
      generation: this.generation,
      sequence,
      scopeKey,
      value,
      dedupeKey,
    };
    this.setSaving(true, scopeKey);
    void this.drain();
    return sequence;
  }

  async whenIdle(): Promise<void> {
    if (!this.draining && !this.active && !this.pending) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  async dispose(): Promise<void> {
    this.setScope("");
    await this.whenIdle();
  }

  private isCurrent(entry: PendingWrite<Value>): boolean {
    return entry.generation === this.generation && entry.scopeKey === this.scopeKey;
  }

  private setSaving(saving: boolean, scopeKey: string): void {
    if (this.saving === saving && (!saving || this.savingScopeKey === scopeKey)) return;
    this.saving = saving;
    this.savingScopeKey = saving ? scopeKey : "";
    this.options.onSavingChange?.(saving, scopeKey);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.pending) {
        const entry = this.pending;
        this.pending = null;
        const controller = new AbortController();
        this.active = { entry, controller };
        try {
          const result = await this.options.write(entry.value, {
            scopeKey: entry.scopeKey,
            signal: controller.signal,
          });
          if (this.isCurrent(entry) && entry.sequence === this.latestSequence && !this.pending) {
            this.options.onSuccess?.(result, entry.value, entry.scopeKey);
          }
        } catch (error) {
          if (
            !controller.signal.aborted &&
            this.isCurrent(entry) &&
            entry.sequence === this.latestSequence &&
            !this.pending
          ) {
            this.options.onError?.(error, entry.value, entry.scopeKey);
          }
        } finally {
          if (this.active?.entry === entry) this.active = null;
        }
      }
    } finally {
      this.draining = false;
      if (!this.pending && !this.active && this.saving && this.savingScopeKey === this.scopeKey) {
        this.setSaving(false, this.scopeKey);
      }
      this.resolveIdleWaitersIfIdle();
      if (this.pending) void this.drain();
    }
  }

  private resolveIdleWaitersIfIdle(): void {
    if (this.draining || this.active || this.pending) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
