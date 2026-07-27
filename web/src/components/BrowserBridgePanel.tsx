import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  AppWindowMac,
  CircleAlert,
  Copy,
  RefreshCw,
  Wifi,
  WifiOff,
  Hand,
  ShieldAlert,
} from "lucide-react";
import { api } from "../api.js";
import type {
  AgentBrowserBridgePhase,
  AgentBrowserBridgeStatus,
  BrowserControlPhase,
  BrowserControlState,
} from "../types.js";
import { uiCopy } from "../ui-copy.js";
import { Button, Dialog, IconButton, TextArea } from "./ui/index.js";

const STATUS_REFRESH_INTERVAL_MS = 10_000;

function phaseCopy(phase: AgentBrowserBridgePhase): string {
  const copy = uiCopy.browserBridge;
  switch (phase) {
    case "connected":
      return copy.connected;
    case "waiting_for_extension":
      return copy.waiting;
    case "starting":
      return copy.starting;
    case "unavailable":
      return copy.unavailable;
    case "error":
      return copy.failed;
    default:
      return copy.stopped;
  }
}

function phaseDescription(phase: AgentBrowserBridgePhase): string {
  const copy = uiCopy.browserBridge;
  switch (phase) {
    case "connected":
      return copy.connectedDescription;
    case "waiting_for_extension":
      return copy.waitingDescription;
    case "unavailable":
      return copy.unavailableDescription;
    case "error":
      return copy.errorDescription;
    default:
      return copy.stoppedDescription;
  }
}

function phaseColor(phase: AgentBrowserBridgePhase): string {
  if (phase === "connected") return "bg-success";
  if (phase === "waiting_for_extension" || phase === "starting") return "bg-warning";
  if (phase === "error") return "bg-danger";
  return "bg-muted-foreground/60";
}

function StatusIcon({ phase }: { phase: AgentBrowserBridgePhase }) {
  if (phase === "connected") return <Wifi className="h-5 w-5 text-success" aria-hidden="true" />;
  if (phase === "error" || phase === "unavailable") {
    return <CircleAlert className="h-5 w-5 text-danger" aria-hidden="true" />;
  }
  return <WifiOff className="h-5 w-5 text-muted-foreground" aria-hidden="true" />;
}

function controlPhaseCopy(phase: BrowserControlPhase): string {
  const copy = uiCopy.browserBridge;
  switch (phase) {
    case "agent":
      return copy.agentControl;
    case "takeover_pending":
      return copy.takeoverPending;
    case "human":
      return copy.humanControl;
    case "resuming":
      return copy.resumingControl;
    case "stopping":
      return copy.stoppingControl;
    case "stopped":
      return copy.stoppedControl;
    default:
      return copy.uncertainControl;
  }
}

export function BrowserBridgePanel({ sessionId }: { sessionId?: string | null }) {
  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState<AgentBrowserBridgeStatus | null>(null);
  const [control, setControl] = useState<BrowserControlState | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState("");
  const [verifiedMs, setVerifiedMs] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [controlAction, setControlAction] = useState<"takeover" | "resume" | "stop" | null>(null);
  const [handoffSummary, setHandoffSummary] = useState("");

  const refresh = useCallback(
    async (quiet = false) => {
      if (!quiet) setIsRefreshing(true);
      try {
        const next = await api.getBrowserBridgeStatus();
        setStatus(next);
        if (sessionId) setControl(await api.getBrowserControl(sessionId));
        else setControl(null);
        setError("");
      } catch (cause) {
        if (!quiet) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!quiet) setIsRefreshing(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    if (!isOpen) return;
    const pollWhileVisible = () => {
      if (document.visibilityState === "visible") void refresh(true);
    };
    pollWhileVisible();
    const timer = window.setInterval(pollWhileVisible, STATUS_REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", pollWhileVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", pollWhileVisible);
    };
  }, [isOpen, refresh]);

  const start = useCallback(async () => {
    setIsStarting(true);
    setVerifiedMs(null);
    try {
      setStatus(await api.startBrowserBridge());
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh(true);
    } finally {
      setIsStarting(false);
    }
  }, [refresh]);

  const verify = useCallback(async () => {
    setIsVerifying(true);
    setVerifiedMs(null);
    try {
      const result = await api.verifyBrowserBridge();
      setStatus(result.status);
      setVerifiedMs(result.durationMs);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh(true);
    } finally {
      setIsVerifying(false);
    }
  }, [refresh]);

  const copyExtensionPath = useCallback(async () => {
    if (!status?.extension.path) return;
    try {
      await navigator.clipboard.writeText(status.extension.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [status?.extension.path]);

  const takeOver = useCallback(async () => {
    if (!sessionId) return;
    setControlAction("takeover");
    try {
      setControl(await api.takeOverBrowserControl(sessionId));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh(true);
    } finally {
      setControlAction(null);
    }
  }, [refresh, sessionId]);

  const resumeControl = useCallback(async () => {
    if (!sessionId || !handoffSummary.trim()) return;
    setControlAction("resume");
    try {
      setControl(await api.resumeBrowserControl(sessionId, handoffSummary));
      setHandoffSummary("");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh(true);
    } finally {
      setControlAction(null);
    }
  }, [handoffSummary, refresh, sessionId]);

  const stopControl = useCallback(async () => {
    if (!sessionId) return;
    setControlAction("stop");
    try {
      setControl(await api.stopBrowserControl(sessionId));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refresh(true);
    } finally {
      setControlAction(null);
    }
  }, [refresh, sessionId]);

  const phase: AgentBrowserBridgePhase = status?.phase || "stopped";
  const profileCount = status?.extension.profiles.length || 0;
  const tabCount = useMemo(
    () => status?.extension.profiles.reduce((sum, profile) => sum + profile.tabCount, 0) || 0,
    [status?.extension.profiles],
  );
  const copy = uiCopy.browserBridge;

  return (
    <>
      <IconButton
        label={copy.trigger}
        data-testid="browser-bridge-trigger"
        onClick={() => {
          setIsOpen(true);
          void refresh();
        }}
        className="relative text-muted-foreground hover:bg-accent hover:text-foreground"
        size="sm"
        variant="ghost"
      >
        <AppWindowMac className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
        <span
          className={`absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full ring-2 ring-background ${phaseColor(phase)}`}
        />
      </IconButton>

      <Dialog
        bodyClassName="space-y-5"
        closeLabel={copy.close}
        description={copy.description}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onPress={() => void refresh()}
              loading={isRefreshing}
            >
              {!isRefreshing ? <RefreshCw className="h-4 w-4" aria-hidden="true" /> : null}
              {copy.refresh}
            </Button>
            {phase === "stopped" || phase === "error" ? (
              <Button
                size="sm"
                onPress={() => void start()}
                loading={isStarting}
                isDisabled={!status?.runtime.ready}
              >
                {isStarting ? copy.startingAction : copy.start}
              </Button>
            ) : (
              <Button
                size="sm"
                onPress={() => void verify()}
                loading={isVerifying}
                isDisabled={phase !== "connected"}
              >
                {isVerifying ? copy.verifying : copy.verify}
              </Button>
            )}
          </>
        }
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        className="max-w-[42rem]"
        headerClassName="items-center text-left"
        headerTextClassName="text-left"
        size="lg"
        title={copy.title}
      >
        <section
          aria-labelledby="browser-bridge-status-heading"
          data-testid="browser-bridge-status-section"
        >
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] border border-border bg-card">
              <StatusIcon phase={phase} />
            </div>
            <div className="min-w-0 flex-1">
              <h2
                id="browser-bridge-status-heading"
                className="text-sm font-semibold leading-5 text-foreground"
              >
                {phaseCopy(phase)}
              </h2>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                {phaseDescription(phase)}
              </p>
              {error && (
                <p role="alert" className="mt-2 text-sm leading-5 text-danger">
                  {error}
                </p>
              )}
              {verifiedMs !== null && (
                <div className="mt-2 flex items-center gap-1.5 text-sm font-medium text-success">
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  {copy.verifySuccess(verifiedMs)}
                </div>
              )}
            </div>
          </div>

          <dl
            className="mt-4 grid gap-px overflow-hidden rounded-[var(--piwork-control-radius)] bg-border sm:grid-cols-3"
            data-testid="browser-bridge-status-summary"
          >
            <StatusCell
              label={copy.runtime}
              value={status?.runtime.ready ? copy.ready : copy.unavailable}
              detail={
                status?.runtime.version ? `${copy.version} ${status.runtime.version}` : undefined
              }
            />
            <StatusCell
              label={copy.daemon}
              value={status?.daemon.state === "online" ? copy.online : copy.offline}
              detail={
                status
                  ? `${copy.port} ${status.daemon.port} · ${copy.sessions(status.daemon.sessionCount)}`
                  : undefined
              }
            />
            <StatusCell
              label={copy.extension}
              value={copy.connectedProfiles(profileCount)}
              detail={copy.tabs(tabCount)}
            />
          </dl>

          {status?.runtime.sourceCommit && (
            <p className="mt-3 text-xs leading-5 text-muted-foreground">
              {copy.source}:{" "}
              <span className="font-mono text-foreground">
                {status.runtime.sourceCommit.slice(0, 12)}
              </span>
            </p>
          )}

          {status && status.runtime.missing.length > 0 && (
            <div
              role="alert"
              className="mt-3 rounded-[var(--piwork-control-radius)] bg-danger/10 px-3 py-2 text-sm leading-5 text-danger"
            >
              {copy.missingArtifacts(status.runtime.missing.join(uiCopy.common.listSeparator))}
            </div>
          )}
        </section>

        <section
          aria-labelledby="browser-control-heading"
          className="border-t border-border pt-5"
          data-testid="browser-control-section"
        >
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] border border-border bg-card">
                <Hand className="h-4 w-4 text-primary" aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <h2
                  id="browser-control-heading"
                  className="text-sm font-semibold leading-5 text-foreground"
                >
                  {copy.controlTitle}
                </h2>
                {control ? (
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {controlPhaseCopy(control.phase)}
                    </span>
                    <span>{copy.controlEpoch(control.epoch)}</span>
                  </div>
                ) : (
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">
                    {copy.selectSession}
                  </p>
                )}
              </div>
            </div>

            {control?.pendingActionRisk && (
              <div
                role="alert"
                className="flex gap-2 rounded-[var(--piwork-control-radius)] bg-warning/10 px-3 py-2 text-sm leading-5 text-foreground"
              >
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
                <span>{copy.pendingActionRisk}</span>
              </div>
            )}

            {control && (control.phase === "human" || control.phase === "uncertain") && (
              <TextArea
                label={copy.handoffLabel}
                description={copy.handoffDescription}
                textAreaProps={{
                  value: handoffSummary,
                  maxLength: 2_000,
                  placeholder: copy.handoffPlaceholder,
                  onChange: (event) => setHandoffSummary(event.currentTarget.value),
                }}
              />
            )}

            {control && (
              <div className="flex flex-wrap justify-end gap-2">
                {control.phase === "agent" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => void takeOver()}
                    isDisabled={controlAction !== null}
                  >
                    {controlAction === "takeover" ? copy.takingOver : copy.takeOver}
                  </Button>
                )}
                {(control.phase === "human" || control.phase === "uncertain") && (
                  <Button
                    size="sm"
                    onPress={() => void resumeControl()}
                    isDisabled={controlAction !== null || !handoffSummary.trim()}
                  >
                    {controlAction === "resume" ? copy.resumingControlAction : copy.resumeControl}
                  </Button>
                )}
                {control.phase !== "stopped" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-danger hover:bg-danger/10 hover:text-danger"
                    onPress={() => void stopControl()}
                    isDisabled={controlAction !== null}
                  >
                    {controlAction === "stop" ? copy.stoppingControlAction : copy.stopControl}
                  </Button>
                )}
              </div>
            )}

            <p className="text-xs leading-5 text-muted-foreground">{copy.privacyNotice}</p>
          </div>
        </section>

        {status?.runtime.ready && !status.extension.connected && (
          <section
            aria-labelledby="browser-bridge-setup-heading"
            className="border-t border-border pt-5"
            data-testid="browser-bridge-setup-section"
          >
            <div className="space-y-4">
              <h2
                id="browser-bridge-setup-heading"
                className="text-sm font-semibold leading-5 text-foreground"
              >
                {copy.setupTitle}
              </h2>
              <ol className="list-decimal space-y-2 pl-5 text-sm leading-5 text-muted-foreground">
                <li>{copy.stepOne}</li>
                <li>{copy.stepTwo}</li>
                <li>{copy.stepThree}</li>
              </ol>
              <div>
                <div className="mb-1.5 text-xs font-medium text-muted-foreground">
                  {copy.extensionPath}
                </div>
                <div className="flex items-center gap-2 rounded-[var(--piwork-control-radius)] border border-border bg-card px-3 py-2">
                  <code className="min-w-0 flex-1 select-all break-all text-xs text-foreground">
                    {status.extension.path}
                  </code>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={copy.copyPath}
                    onPress={() => void copyExtensionPath()}
                    className="shrink-0"
                  >
                    {copied ? (
                      <CheckCircle2 className="h-4 w-4" aria-label={copy.pathCopied} />
                    ) : (
                      <Copy className="h-4 w-4" aria-hidden="true" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </section>
        )}
      </Dialog>
    </>
  );
}

function StatusCell({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 bg-card px-3 py-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-sm font-semibold text-foreground">{value}</dd>
      {detail && <dd className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</dd>}
    </div>
  );
}
