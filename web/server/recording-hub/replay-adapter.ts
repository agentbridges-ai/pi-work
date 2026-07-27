/**
 * Replays the browser side of a redacted Pi recording without creating a
 * second backend transport. WsBridge remains the sole sequencer and publisher.
 */

import type { BrowserIncomingMessage } from "../../shared/pi-browser-protocol.js";
import type { Recording } from "../replay.js";
import { filterEntries } from "../replay.js";

type State = "idle" | "playing" | "paused" | "finished";

export class ReplayAdapter {
  private state: State = "idle";
  private speed: number;
  private browserMessage?: (message: BrowserIncomingMessage) => void;
  private finishedHandler?: () => void;
  private readonly entries: { ts: number; raw: string }[];
  private currentIndex = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private timerScheduledAt = 0;
  private timerDelayMs = 0;
  private pausedRemainingMs = 0;
  private emittedStopped = false;

  constructor(
    recording: Recording,
    speed = 1,
    private readonly generation = 1,
  ) {
    this.speed = speed;
    this.entries = filterEntries(recording.entries, "out", "browser").map((entry) => ({
      ts: entry.ts,
      raw: entry.raw,
    }));
  }

  onBrowserMessage(callback: (message: BrowserIncomingMessage) => void): void {
    this.browserMessage = callback;
  }

  onFinished(callback: () => void): void {
    this.finishedHandler = callback;
  }

  isActive(): boolean {
    return this.state === "playing" || this.state === "paused";
  }

  stop(): void {
    if (this.state === "finished") return;
    this.clearTimer();
    this.finish();
  }

  play(): void {
    if (this.state === "playing" || this.state === "finished") return;
    this.state = "playing";
    this.scheduleNext();
  }

  pause(): void {
    if (this.state !== "playing") return;
    this.pausedRemainingMs = Math.max(0, this.timerDelayMs - (Date.now() - this.timerScheduledAt));
    this.clearTimer();
    this.state = "paused";
  }

  setSpeed(multiplier: number): void {
    if (!(multiplier > 0)) return;
    const previous = this.speed;
    this.speed = multiplier;
    if (this.state === "playing") {
      this.clearTimer();
      this.scheduleNext();
    } else if (this.state === "paused" && this.pausedRemainingMs > 0) {
      this.pausedRemainingMs *= previous / multiplier;
    }
  }

  getProgress(): {
    current: number;
    total: number;
    percentComplete: number;
    state: State;
  } {
    const total = this.entries.length;
    return {
      current: this.currentIndex,
      total,
      percentComplete: total > 0 ? Math.round((this.currentIndex / total) * 100) : 100,
      state: this.state,
    };
  }

  private scheduleNext(): void {
    if (this.state !== "playing") return;
    if (this.currentIndex >= this.entries.length) {
      this.finish();
      return;
    }
    const entry = this.entries[this.currentIndex]!;
    let delayMs = this.pausedRemainingMs;
    this.pausedRemainingMs = 0;
    if (delayMs === 0 && this.currentIndex > 0) {
      delayMs = (entry.ts - this.entries[this.currentIndex - 1]!.ts) / this.speed;
    }
    if (!Number.isFinite(this.speed)) delayMs = 0;
    delayMs = Math.max(0, Math.min(delayMs, 5_000 / this.speed));
    this.timerDelayMs = delayMs;
    this.timerScheduledAt = Date.now();
    this.pendingTimer = setTimeout(() => this.emitEntry(), delayMs);
  }

  private emitEntry(): void {
    if (this.state !== "playing") return;
    const entry = this.entries[this.currentIndex];
    if (!entry) {
      this.finish();
      return;
    }
    this.currentIndex += 1;
    try {
      const value: unknown = JSON.parse(entry.raw);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        if (
          (value as { type?: unknown }).type === "run_state" &&
          (value as { state?: unknown }).state === "stopped"
        ) {
          this.emittedStopped = true;
        }
        this.browserMessage?.(value as BrowserIncomingMessage);
      }
    } catch {
      // A truncated replay frame is skipped; the original recording is kept.
    }
    this.scheduleNext();
  }

  private finish(): void {
    this.state = "finished";
    if (!this.emittedStopped) {
      this.browserMessage?.({
        type: "run_state",
        state: "stopped",
        generation: this.generation,
        timestamp: Date.now(),
      });
    }
    this.finishedHandler?.();
  }

  private clearTimer(): void {
    if (this.pendingTimer === null) return;
    clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
  }
}
