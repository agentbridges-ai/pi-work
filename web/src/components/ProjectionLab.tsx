import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Pause, Play, RotateCcw, StepForward } from "lucide-react";
import { basicAgentScenario, type ScenarioFaultKind } from "../../shared/agent-scenario.js";
import { ScenarioPlayback, type ScenarioPlaybackProgress } from "../../shared/scenario-playback.js";
import { useStore } from "../store.js";
import type { BrowserIncomingMessage, SessionState } from "../types.js";
import { uiCopy } from "../ui-copy.js";
import { projectRecordingHubFixture } from "../ws.js";
import { AgentActivityBar } from "./AgentActivityBar.js";
import { MessageFeed } from "./MessageFeed.js";

const LAB_SESSION_ID = "recording-hub-projection-lab";
const SPEEDS = [0.5, 1, 2, 4] as const;
const FAULTS: readonly ScenarioFaultKind[] = [
  "duplicate",
  "gap",
  "stale_generation",
  "disconnect",
  "late",
  "cancel",
  "retry",
  "compaction",
];
const SCENARIO_DURATION = basicAgentScenario.events.at(-1)?.at ?? 0;
const GAP_RECOVERY_EVENT_INDEX = basicAgentScenario.events.findIndex(
  ({ event }) => event.type === "agent_message" && event.message.role === "assistant",
);
const initialProgress: ScenarioPlaybackProgress = {
  state: "idle",
  current: 0,
  total: basicAgentScenario.events.length,
  clock: 0,
  speed: 1,
};

function labSession(): SessionState {
  return {
    sessionId: LAB_SESSION_ID,
    backendType: "pi",
    transport: "pi-rpc",
    piVersion: "0.82.1",
    model: {
      key: "fixture/projection-lab",
      provider: "fixture",
      modelId: "projection-lab",
    },
    thinkingLevel: "off",
    mode: "agent",
    cwd: "/projection-lab",
    tools: [],
    commands: [],
    skills: [],
    mcpServers: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    runState: "ready",
    isCompacting: false,
    generation: basicAgentScenario.generation,
  };
}

function ControlButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-8 items-center gap-1.5 rounded-[var(--piwork-control-radius)] border border-border bg-card px-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      {label}
    </button>
  );
}

export function ProjectionLab() {
  useStore((store) => store.uiLanguage);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [fault, setFault] = useState<ScenarioFaultKind | "">("");
  const [speed, setSpeed] = useState(1);
  const [progress, setProgress] = useState<ScenarioPlaybackProgress>(initialProgress);
  const [lastEvent, setLastEvent] = useState<BrowserIncomingMessage | null>(null);
  const playback = useRef<ScenarioPlayback | null>(null);
  const runState = useStore((store) => store.runStates.get(LAB_SESSION_ID) || "ready");
  const messages = useStore((store) => store.messages.get(LAB_SESSION_ID)?.length || 0);
  const generation = useStore(
    (store) => store.sessions.get(LAB_SESSION_ID)?.generation || basicAgentScenario.generation,
  );
  const activity = useStore((store) => store.agentActivity.get(LAB_SESSION_ID));

  const reset = useCallback(() => {
    const store = useStore.getState();
    store.removeSession(LAB_SESSION_ID);
    projectRecordingHubFixture(LAB_SESSION_ID, {
      type: "session_init",
      session: labSession(),
    });
    setLastEvent(null);
  }, []);

  const createPlayback = useCallback(() => {
    reset();
    const next = new ScenarioPlayback(basicAgentScenario, {
      speed,
      faults: fault
        ? [{ id: fault, kind: fault, at: fault === "gap" ? GAP_RECOVERY_EVENT_INDEX : 2 }]
        : [],
      onReset: reset,
      onEvent: (event) => {
        setLastEvent(event);
        projectRecordingHubFixture(LAB_SESSION_ID, event);
      },
    });
    playback.current = next;
    setProgress(next.getProgress());
    return next;
  }, [fault, reset, speed]);

  useEffect(() => {
    void fetch("/api/hub/projection-lab", { credentials: "same-origin" })
      .then((response) => setEnabled(response.ok))
      .catch(() => setEnabled(false));
  }, []);

  useEffect(
    () => () => {
      useStore.getState().removeSession(LAB_SESSION_ID);
    },
    [],
  );

  useEffect(() => {
    const timer = window.setInterval(() => {
      const current = playback.current;
      if (!current || current.getProgress().state !== "playing") return;
      current.advance(16);
      setProgress(current.getProgress());
    }, 16);
    return () => window.clearInterval(timer);
  }, []);

  if (enabled === false) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6">
        <p
          role="alert"
          className="rounded-[var(--piwork-control-radius)] border border-warning/40 bg-warning-muted px-4 py-2 text-sm text-warning"
        >
          {uiCopy.projectionLab.unavailable}
        </p>
      </div>
    );
  }
  if (enabled === null) {
    return (
      <div className="flex h-full items-center justify-center bg-background">
        <p role="status" className="text-sm text-muted-foreground">
          {uiCopy.common.loading}
        </p>
      </div>
    );
  }

  const current = playback.current;
  const play = () => {
    const next = current || createPlayback();
    next.play();
    setProgress(next.getProgress());
  };
  const pause = () => {
    current?.pause();
    if (current) setProgress(current.getProgress());
  };
  const step = () => {
    const next = current || createPlayback();
    next.step();
    setProgress(next.getProgress());
  };
  const seek = (clock: number) => {
    const next = current || createPlayback();
    next.seek(clock);
    setProgress(next.getProgress());
  };
  const restart = () => {
    playback.current = null;
    reset();
    setProgress({ ...initialProgress, speed });
  };
  const inspectorState = {
    runState,
    messages,
    generation,
    activity,
  };

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      aria-label={uiCopy.projectionLab.title}
    >
      <header className="shrink-0 border-b border-border px-4 py-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-[1440px] items-start justify-between gap-4">
          <div>
            <h1 className="text-base font-semibold">{uiCopy.projectionLab.title}</h1>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {uiCopy.projectionLab.description}
            </p>
          </div>
          <span className="rounded-[var(--piwork-control-radius)] bg-accent px-2 py-1 text-xs font-semibold text-accent-foreground">
            {uiCopy.projectionLab.developmentOnly}
          </span>
        </div>
      </header>

      <div className="shrink-0 border-b border-border/70 bg-muted/30 px-4 py-3 sm:px-6">
        <div className="mx-auto flex w-full max-w-[1440px] flex-wrap items-end gap-2.5">
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            {uiCopy.projectionLab.scenario}
            <select
              aria-label={uiCopy.projectionLab.scenario}
              defaultValue={basicAgentScenario.id}
              className="h-8 rounded-[var(--piwork-control-radius)] border border-input bg-card px-2 text-xs text-foreground outline-none focus:border-ring"
            >
              <option value={basicAgentScenario.id}>{uiCopy.projectionLab.scenarioBasic}</option>
            </select>
          </label>
          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            {uiCopy.projectionLab.fault}
            <select
              aria-label={uiCopy.projectionLab.fault}
              value={fault}
              onChange={(event) => {
                setFault(event.target.value as ScenarioFaultKind | "");
                playback.current = null;
              }}
              className="h-8 rounded-[var(--piwork-control-radius)] border border-input bg-card px-2 text-xs text-foreground outline-none focus:border-ring"
            >
              <option value="">{uiCopy.projectionLab.noFault}</option>
              {FAULTS.map((kind) => (
                <option key={kind} value={kind}>
                  {uiCopy.projectionLab.faults[kind]}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-1.5">
            <ControlButton label={uiCopy.projectionLab.play} onClick={play}>
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
            </ControlButton>
            <ControlButton label={uiCopy.projectionLab.pause} onClick={pause}>
              <Pause className="h-3.5 w-3.5" aria-hidden="true" />
            </ControlButton>
            <ControlButton label={uiCopy.projectionLab.step} onClick={step}>
              <StepForward className="h-3.5 w-3.5" aria-hidden="true" />
            </ControlButton>
            <ControlButton label={uiCopy.projectionLab.reset} onClick={restart}>
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            </ControlButton>
          </div>

          <label className="grid gap-1 text-xs font-medium text-muted-foreground">
            {uiCopy.projectionLab.speed}
            <select
              aria-label={uiCopy.projectionLab.speed}
              value={speed}
              onChange={(event) => {
                const next = Number(event.target.value);
                setSpeed(next);
                playback.current?.setSpeed(next);
                if (playback.current) setProgress(playback.current.getProgress());
              }}
              className="h-8 rounded-[var(--piwork-control-radius)] border border-input bg-card px-2 text-xs text-foreground outline-none focus:border-ring"
            >
              {SPEEDS.map((value) => (
                <option key={value} value={value}>
                  {uiCopy.projectionLab.speedValue(value)}
                </option>
              ))}
            </select>
          </label>

          <label className="grid min-w-48 flex-1 gap-1 text-xs font-medium text-muted-foreground">
            <span className="flex items-center justify-between gap-3">
              <span>{uiCopy.projectionLab.seek}</span>
              <span className="font-mono-code font-normal">
                {uiCopy.projectionLab.clock(progress.clock)}
              </span>
            </span>
            <input
              aria-label={uiCopy.projectionLab.seek}
              type="range"
              min="0"
              max={SCENARIO_DURATION}
              value={Math.min(progress.clock, SCENARIO_DURATION)}
              onChange={(event) => seek(Number(event.target.value))}
              className="h-8 accent-primary"
            />
          </label>
        </div>
      </div>

      <div className="mx-auto grid min-h-0 w-full max-w-[1440px] flex-1 gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="piwork-superellipse-panel relative flex min-h-[360px] min-w-0 flex-col overflow-hidden rounded-[var(--piwork-panel-radius)] border border-border bg-card/35">
          <div className="min-h-0 flex-1">
            <MessageFeed sessionId={LAB_SESSION_ID} suppressScrollToBottom />
          </div>
          <div className="shrink-0 pb-3">
            <AgentActivityBar sessionId={LAB_SESSION_ID} />
          </div>
        </div>

        <aside className="grid min-h-0 gap-3 overflow-auto sm:grid-cols-2 lg:grid-cols-1">
          <section className="piwork-superellipse-panel min-w-0 rounded-[var(--piwork-panel-radius)] border border-border bg-card p-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-xs font-semibold">{uiCopy.projectionLab.eventInspector}</h2>
              <span className="text-xs text-muted-foreground">
                {uiCopy.projectionLab.events(progress.current, progress.total)}
              </span>
            </div>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[var(--piwork-control-radius)] bg-muted p-2 text-xs text-muted-foreground">
              {lastEvent
                ? JSON.stringify(lastEvent, null, 2)
                : uiCopy.projectionLab.noEventSelected}
            </pre>
          </section>
          <section className="piwork-superellipse-panel min-w-0 rounded-[var(--piwork-panel-radius)] border border-border bg-card p-3">
            <h2 className="text-xs font-semibold">{uiCopy.projectionLab.stateInspector}</h2>
            <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-[var(--piwork-control-radius)] bg-muted p-2 text-xs text-muted-foreground">
              {JSON.stringify(inspectorState, null, 2)}
            </pre>
          </section>
        </aside>
      </div>
    </section>
  );
}
