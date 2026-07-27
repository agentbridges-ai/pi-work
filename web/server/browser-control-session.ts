import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { AtomicJsonStore } from "./atomic-json-store.js";

export const BROWSER_CONTROL_SUMMARY_MAX_CHARS = 2_000;

export type BrowserControlPhase =
  "agent" | "takeover_pending" | "human" | "resuming" | "stopping" | "stopped" | "uncertain";

export interface BrowserControlState {
  schemaVersion: 1;
  sessionId: string;
  phase: BrowserControlPhase;
  epoch: number;
  updatedAt: number;
  reason: string;
  pendingActionRisk: boolean;
  lastHandoff?: {
    summary: string;
    resumedAt: number;
  };
}

interface BrowserControlCoordinatorOptions {
  statePathFor(sessionId: string): string;
  interrupt(sessionId: string): boolean | Promise<boolean>;
  /** Return success only after both the handoff and a fresh semantic browser readback complete. */
  resume(
    sessionId: string,
    summary: string,
  ): BrowserControlResumeVerification | Promise<BrowserControlResumeVerification>;
  stop(sessionId: string): void | Promise<void>;
  now?: () => number;
}

export interface BrowserControlResumeVerification {
  handoffDelivered: boolean;
  semanticReadbackVerified: boolean;
}

export function browserControlStatePath(sessionRoot: string): string {
  return join(sessionRoot, ".browser-control.json");
}

function normalizeState(sessionId: string, value: unknown, now: number): BrowserControlState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return initialBrowserControlState(sessionId, now);
  }
  const candidate = value as Partial<BrowserControlState>;
  const validPhases = new Set<BrowserControlPhase>([
    "agent",
    "takeover_pending",
    "human",
    "resuming",
    "stopping",
    "stopped",
    "uncertain",
  ]);
  const phase = validPhases.has(candidate.phase as BrowserControlPhase)
    ? (candidate.phase as BrowserControlPhase)
    : "uncertain";
  const epoch =
    Number.isInteger(candidate.epoch) && Number(candidate.epoch) > 0 ? Number(candidate.epoch) : 1;
  const updatedAt =
    typeof candidate.updatedAt === "number" && Number.isFinite(candidate.updatedAt)
      ? candidate.updatedAt
      : now;
  const lastHandoff = candidate.lastHandoff;
  return {
    schemaVersion: 1,
    sessionId,
    phase,
    epoch,
    updatedAt,
    reason: typeof candidate.reason === "string" ? candidate.reason : "state_recovered",
    pendingActionRisk: Boolean(candidate.pendingActionRisk),
    ...(lastHandoff &&
    typeof lastHandoff.summary === "string" &&
    typeof lastHandoff.resumedAt === "number"
      ? {
          lastHandoff: {
            summary: lastHandoff.summary.slice(0, BROWSER_CONTROL_SUMMARY_MAX_CHARS),
            resumedAt: lastHandoff.resumedAt,
          },
        }
      : {}),
  };
}

export function initialBrowserControlState(
  sessionId: string,
  now = Date.now(),
): BrowserControlState {
  return {
    schemaVersion: 1,
    sessionId,
    phase: "agent",
    epoch: 1,
    updatedAt: now,
    reason: "session_ready",
    pendingActionRisk: false,
  };
}

export function ensureBrowserControlState(path: string, sessionId: string): BrowserControlState {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const store = new AtomicJsonStore<BrowserControlState>(path, {
    schemaVersion: 1,
    pretty: false,
    normalize: (value) => normalizeState(sessionId, value, Date.now()),
    defaultValue: () => initialBrowserControlState(sessionId),
  });
  const existing = store.readValue();
  if (existsSync(path) && existing) return existing;
  return store.write(existing || initialBrowserControlState(sessionId)).data;
}

export class BrowserControlCoordinator {
  private readonly now: () => number;

  constructor(private readonly options: BrowserControlCoordinatorOptions) {
    this.now = options.now || Date.now;
  }

  get(sessionId: string): BrowserControlState {
    const path = this.options.statePathFor(sessionId);
    const existing = this.store(sessionId).readValue();
    if (existsSync(path) && existing) return existing;
    return this.write(existing || initialBrowserControlState(sessionId, this.now()));
  }

  canDispatch(sessionId: string, epoch: number): boolean {
    const state = this.get(sessionId);
    return state.phase === "agent" && state.epoch === epoch;
  }

  async takeOver(
    sessionId: string,
    upstreamPendingActionRisk = false,
  ): Promise<BrowserControlState> {
    const current = this.get(sessionId);
    if (current.phase === "stopped" || current.phase === "stopping") {
      throw new Error("Browser control is stopped");
    }
    const epoch = current.epoch + 1;
    this.write({
      ...current,
      phase: "takeover_pending",
      epoch,
      updatedAt: this.now(),
      reason: "user_takeover_requested",
      pendingActionRisk: true,
    });
    const interrupted = await this.options.interrupt(sessionId);
    return this.write({
      ...this.get(sessionId),
      phase: "human",
      epoch,
      updatedAt: this.now(),
      reason: !interrupted
        ? "agent_interrupt_unconfirmed"
        : upstreamPendingActionRisk
          ? "action_completion_unconfirmed"
          : "agent_interrupted",
      pendingActionRisk: !interrupted || upstreamPendingActionRisk,
    });
  }

  async resume(sessionId: string, summary: string): Promise<BrowserControlState> {
    const cleanSummary = summary.trim();
    if (!cleanSummary) throw new Error("A handoff summary is required");
    if (cleanSummary.length > BROWSER_CONTROL_SUMMARY_MAX_CHARS) {
      throw new Error(`Handoff summary exceeds ${BROWSER_CONTROL_SUMMARY_MAX_CHARS} characters`);
    }
    const current = this.get(sessionId);
    if (current.phase !== "human" && current.phase !== "uncertain") {
      throw new Error("Browser control is not held by the user");
    }
    const epoch = current.epoch + 1;
    this.write({
      ...current,
      phase: "resuming",
      epoch,
      updatedAt: this.now(),
      reason: "user_resume_requested",
      pendingActionRisk: false,
    });
    let verification: BrowserControlResumeVerification;
    try {
      verification = await this.options.resume(sessionId, cleanSummary);
    } catch {
      verification = { handoffDelivered: false, semanticReadbackVerified: false };
    }
    if (!verification.handoffDelivered || !verification.semanticReadbackVerified) {
      return this.write({
        ...this.get(sessionId),
        phase: "uncertain",
        epoch,
        updatedAt: this.now(),
        reason: verification.semanticReadbackVerified
          ? "handoff_delivery_unconfirmed"
          : "semantic_readback_unconfirmed",
        pendingActionRisk: true,
      });
    }
    const resumedAt = this.now();
    return this.write({
      ...this.get(sessionId),
      phase: "agent",
      epoch,
      updatedAt: resumedAt,
      reason: "handoff_verified",
      pendingActionRisk: false,
      lastHandoff: { summary: cleanSummary, resumedAt },
    });
  }

  async stop(sessionId: string): Promise<BrowserControlState> {
    const current = this.get(sessionId);
    if (current.phase === "stopped") return current;
    const epoch = current.epoch + 1;
    this.write({
      ...current,
      phase: "stopping",
      epoch,
      updatedAt: this.now(),
      reason: "browser_stop_requested",
      pendingActionRisk: true,
    });
    const interrupted = await this.options.interrupt(sessionId);
    try {
      await this.options.stop(sessionId);
    } catch (error) {
      this.write({
        ...this.get(sessionId),
        phase: "uncertain",
        epoch,
        updatedAt: this.now(),
        reason: "browser_stop_unconfirmed",
        pendingActionRisk: true,
      });
      throw error;
    }
    return this.write({
      ...this.get(sessionId),
      phase: "stopped",
      epoch,
      updatedAt: this.now(),
      reason: interrupted ? "browser_stopped" : "browser_stopped_interrupt_unconfirmed",
      pendingActionRisk: !interrupted,
    });
  }

  forget(sessionId: string): void {
    rmSync(this.options.statePathFor(sessionId), { force: true });
  }

  private store(sessionId: string): AtomicJsonStore<BrowserControlState> {
    const path = this.options.statePathFor(sessionId);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    return new AtomicJsonStore<BrowserControlState>(path, {
      schemaVersion: 1,
      pretty: false,
      normalize: (value) => normalizeState(sessionId, value, this.now()),
      defaultValue: () => initialBrowserControlState(sessionId, this.now()),
    });
  }

  private write(state: BrowserControlState): BrowserControlState {
    return this.store(state.sessionId).write(state).data;
  }
}
