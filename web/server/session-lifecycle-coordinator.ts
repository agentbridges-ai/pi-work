export type SessionLifecycleTimer = ReturnType<typeof setTimeout>;

/**
 * Owns the cancellation clock shared by session lifecycle operations.
 *
 * Epochs invalidate older work for one session, while the abort signal and
 * tracked timers invalidate all delayed work when the orchestrator shuts down.
 */
export class SessionLifecycleCoordinator {
  private readonly epochs = new Map<string, number>();
  private readonly timers = new Set<SessionLifecycleTimer>();
  private readonly sessionTimers = new Map<string, SessionLifecycleTimer>();
  private abortController = new AbortController();

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  resume(): void {
    if (this.abortController.signal.aborted) {
      this.abortController = new AbortController();
    }
  }

  currentEpoch(sessionId: string): number {
    return this.epochs.get(sessionId) ?? 0;
  }

  bumpEpoch(sessionId: string): number {
    const next = this.currentEpoch(sessionId) + 1;
    this.epochs.set(sessionId, next);
    return next;
  }

  isCurrent(sessionId: string, epoch: number, signal: AbortSignal = this.signal): boolean {
    return !signal.aborted && this.currentEpoch(sessionId) === epoch;
  }

  setTimeout(callback: () => void | Promise<void>, delayMs: number): SessionLifecycleTimer {
    const signal = this.signal;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (signal.aborted) return;
      void callback();
    }, delayMs);
    this.timers.add(timer);
    return timer;
  }

  delay(delayMs: number): Promise<boolean> {
    const signal = this.signal;
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.timers.delete(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(completed);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(true), delayMs);
      this.timers.add(timer);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  setSessionTimeout(
    sessionId: string,
    callback: () => void | Promise<void>,
    delayMs: number,
  ): SessionLifecycleTimer {
    this.cancelSessionTimeout(sessionId);
    const signal = this.signal;
    const timer = setTimeout(() => {
      if (this.sessionTimers.get(sessionId) !== timer) return;
      this.sessionTimers.delete(sessionId);
      if (signal.aborted) return;
      void callback();
    }, delayMs);
    this.sessionTimers.set(sessionId, timer);
    return timer;
  }

  cancelSessionTimeout(sessionId: string): void {
    const timer = this.sessionTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.sessionTimers.delete(sessionId);
  }

  shutdown(): void {
    this.abortController.abort();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const timer of this.sessionTimers.values()) clearTimeout(timer);
    this.sessionTimers.clear();
    this.epochs.clear();
  }
}
