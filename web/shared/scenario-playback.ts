import type { BrowserIncomingMessage, PiHistoryEntry } from "./pi-browser-protocol.js";
import type { AgentScenario, AgentScenarioEvent, ScenarioFault } from "./agent-scenario.js";

export type ScenarioPlaybackState = "idle" | "playing" | "paused" | "finished";

export interface ScenarioPlaybackProgress {
  state: ScenarioPlaybackState;
  current: number;
  total: number;
  clock: number;
  speed: number;
}

export interface ScenarioPlaybackOptions {
  speed?: number;
  faults?: readonly ScenarioFault[];
  /** Clears the consumer's derived projection before a seek replays it. */
  onReset?: () => void;
  onEvent?: (event: BrowserIncomingMessage) => void;
}

interface ScheduledEvent extends AgentScenarioEvent {
  order: number;
}

const generationEventTypes = [
  "agent_message",
  "message_delta",
  "tool_execution",
  "interaction_request",
  "interaction_response",
  "run_state",
  "history_snapshot",
  "pi_queue",
  "pi_extension_event",
] as const;
type GenerationEventType = (typeof generationEventTypes)[number];
type GenerationAwareBrowserEvent = Extract<BrowserIncomingMessage, { type: GenerationEventType }>;

/**
 * A manually advanced clock for fixture playback. Production projections own
 * de-duplication and generation rejection; this engine only supplies the same
 * protocol frames, including intentionally malformed ordering scenarios.
 */
export class ScenarioPlayback {
  private readonly events: readonly ScheduledEvent[];
  private index = 0;
  private clock = 0;
  private state: ScenarioPlaybackState = "idle";
  private speed: number;
  private readonly onReset?: () => void;
  private readonly onEvent?: (event: BrowserIncomingMessage) => void;

  constructor(scenario: AgentScenario, options: ScenarioPlaybackOptions = {}) {
    this.speed = validSpeed(options.speed) ? options.speed : 1;
    this.onReset = options.onReset;
    this.onEvent = options.onEvent;
    this.events = materializeScenario(scenario, options.faults ?? scenario.faults ?? []);
  }

  play(): void {
    if (this.state === "finished") return;
    this.state = "playing";
  }

  pause(): void {
    if (this.state === "playing") this.state = "paused";
  }

  step(): BrowserIncomingMessage | undefined {
    if (this.state === "finished") return undefined;
    const next = this.events[this.index];
    if (!next) {
      this.state = "finished";
      return undefined;
    }
    this.clock = Math.max(this.clock, next.at);
    this.index += 1;
    this.onEvent?.(next.event);
    if (this.index === this.events.length) this.state = "finished";
    return next.event;
  }

  /** Advances logical milliseconds, scaled by the selected playback speed. */
  advance(elapsedMs: number): number {
    if (this.state !== "playing" || !Number.isFinite(elapsedMs) || elapsedMs < 0) return 0;
    this.clock += elapsedMs * this.speed;
    let emitted = 0;
    while (this.events[this.index] && this.events[this.index]!.at <= this.clock) {
      this.step();
      emitted += 1;
    }
    return emitted;
  }

  /**
   * Rebuilds a consumer projection at the requested logical point. This makes
   * seek safe for the production reducer, whose state is intentionally derived
   * rather than maintained by the lab.
   */
  seek(clock: number): void {
    this.clock = Math.max(0, Number.isFinite(clock) ? clock : 0);
    this.index = 0;
    this.onReset?.();
    while (this.events[this.index] && this.events[this.index]!.at <= this.clock) {
      this.onEvent?.(this.events[this.index]!.event);
      this.index += 1;
    }
    this.state = this.index === this.events.length ? "finished" : "paused";
  }

  setSpeed(speed: number): void {
    if (validSpeed(speed)) this.speed = speed;
  }

  getProgress(): ScenarioPlaybackProgress {
    return {
      state: this.state,
      current: this.index,
      total: this.events.length,
      clock: this.clock,
      speed: this.speed,
    };
  }
}

function validSpeed(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function materializeScenario(
  scenario: AgentScenario,
  faults: readonly ScenarioFault[],
): ScheduledEvent[] {
  const output: ScheduledEvent[] = [];
  const faultMap = new Map<number, ScenarioFault[]>();
  for (const fault of faults) {
    if (Number.isInteger(fault.at) && fault.at >= 0) {
      const list = faultMap.get(fault.at) ?? [];
      list.push(fault);
      faultMap.set(fault.at, list);
    }
  }
  scenario.events.forEach((source, index) => {
    const faultsAtEvent = faultMap.get(index) ?? [];
    const gapFault = faultsAtEvent.find((fault) => fault.kind === "gap");
    if (!gapFault || source.event.type !== "agent_message")
      output.push({ ...source, event: source.event, order: output.length });
    for (const fault of faultsAtEvent) {
      const injected = injectFault(source, fault, scenario.generation);
      if (injected) output.push({ ...injected, order: output.length });
    }
  });
  return output.sort((a, b) => a.at - b.at || a.order - b.order);
}

function injectFault(
  source: AgentScenarioEvent,
  fault: ScenarioFault,
  generation: number,
): AgentScenarioEvent | undefined {
  const at = source.at + (fault.kind === "late" ? 1_000 : 0);
  if (fault.kind === "gap") return gapRecoveryEvent(source, generation);
  if (fault.kind === "duplicate" || fault.kind === "late") {
    return { at, event: structuredClone(source.event) };
  }
  if (fault.kind === "stale_generation") {
    const event = structuredClone(source.event);
    if (!hasGeneration(event)) return undefined;
    return { at, event: { ...event, generation: Math.max(0, generation - 1) } };
  }
  const event = faultEvent(fault.kind, generation, at);
  return event ? { at, event } : undefined;
}

/**
 * A gap is recovered by the same authoritative history snapshot that the
 * browser receives after a missed buffered frame. It deliberately replaces a
 * durable final agent message rather than merely omitting an arbitrary delta.
 */
function gapRecoveryEvent(
  source: AgentScenarioEvent,
  generation: number,
): AgentScenarioEvent | undefined {
  if (source.event.type !== "agent_message") return undefined;
  const entry: PiHistoryEntry = {
    id: `scenario-gap:${source.event.message.id}`,
    timestamp: source.event.message.timestamp,
    event: structuredClone(source.event),
  };
  return {
    at: source.at,
    event: {
      type: "history_snapshot",
      generation,
      entries: [entry],
      total: 1,
      cursor: 1,
      nextCursor: 1,
      hasMore: false,
      reason: "gap",
    },
  };
}

/** Only these browser protocol frames participate in generation rejection. */
function hasGeneration(event: BrowserIncomingMessage): event is GenerationAwareBrowserEvent {
  return (
    (generationEventTypes as readonly string[]).includes(event.type) &&
    "generation" in event &&
    typeof event.generation === "number"
  );
}

function faultEvent(
  kind: ScenarioFault["kind"],
  generation: number,
  timestamp: number,
): BrowserIncomingMessage | undefined {
  const base = { generation, timestamp, reason: `scenario:${kind}` };
  switch (kind) {
    case "disconnect":
      return { type: "run_state", state: "disconnected", ...base };
    case "cancel":
      return { type: "run_state", state: "stopped", ...base };
    case "retry":
      return {
        type: "run_state",
        state: "running",
        ...base,
        detail: {
          kind: "provider_retry",
          phase: "start",
          attempt: 1,
          maxAttempts: 3,
          delayMs: 1_000,
          error: "scenario provider retry",
        },
      };
    case "compaction":
      return {
        type: "run_state",
        state: "compacting",
        ...base,
        detail: { kind: "compaction", phase: "start", reason: "threshold" },
      };
    default:
      return undefined;
  }
}
