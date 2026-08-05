import { useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  FileText,
  ListChecks,
  LoaderCircle,
  RotateCw,
} from "lucide-react";
import type {
  AgentActivityProjection,
  TrustedExtensionEvent,
} from "../agent-activity-projector.js";
import { useStore } from "../store.js";
import type { ToolActivityEntry } from "../store/tasks-slice.js";
import type { ProcessItem } from "../types.js";
import { uiCopy } from "../ui-copy.js";
import { getToolActionLabel } from "./ToolBlock.js";

interface ArtifactItem {
  path: string;
  kind: "write" | "edit";
}

interface StatusPresentation {
  label: string;
  tone: "default" | "warning" | "danger" | "success";
  icon: "busy" | "retry" | "attention" | "done";
}

const emptyProcesses: ProcessItem[] = [];

function activityStatus(activity: AgentActivityProjection): StatusPresentation | null {
  if (activity.attention === "blocked") {
    return { label: uiCopy.activity.status.blocked, tone: "danger", icon: "attention" };
  }
  if (activity.attention === "needs_input") {
    return { label: uiCopy.activity.status.needsInput, tone: "warning", icon: "attention" };
  }
  if (activity.connection === "disconnected") {
    return { label: uiCopy.activity.status.disconnected, tone: "danger", icon: "attention" };
  }
  if (activity.connection === "reconnecting") {
    return { label: uiCopy.activity.status.reconnecting, tone: "warning", icon: "retry" };
  }
  if (activity.connection === "connecting") {
    return { label: uiCopy.activity.status.connecting, tone: "default", icon: "busy" };
  }
  if (activity.operation === "retrying") {
    return { label: uiCopy.activity.status.retrying, tone: "warning", icon: "retry" };
  }
  if (activity.operation === "compacting") {
    return { label: uiCopy.activity.status.compacting, tone: "default", icon: "busy" };
  }
  if (activity.run === "starting") {
    return { label: uiCopy.activity.status.starting, tone: "default", icon: "busy" };
  }
  if (activity.run === "running") {
    return { label: uiCopy.activity.status.working, tone: "default", icon: "busy" };
  }
  if (activity.run === "settling") {
    return { label: uiCopy.activity.status.settling, tone: "default", icon: "busy" };
  }
  if (activity.attention === "review_ready") {
    return { label: uiCopy.activity.status.reviewReady, tone: "success", icon: "done" };
  }
  return null;
}

function statusIcon(presentation: StatusPresentation) {
  const className = "h-3.5 w-3.5 shrink-0";
  if (presentation.icon === "retry") {
    return <RotateCw className={`${className} motion-safe:animate-spin`} aria-hidden="true" />;
  }
  if (presentation.icon === "attention") {
    return <AlertCircle className={className} aria-hidden="true" />;
  }
  if (presentation.icon === "done") {
    return <CheckCircle2 className={className} aria-hidden="true" />;
  }
  return <LoaderCircle className={`${className} motion-safe:animate-spin`} aria-hidden="true" />;
}

function statusTone(tone: StatusPresentation["tone"]): string {
  if (tone === "danger") return "text-danger";
  if (tone === "warning") return "text-warning";
  if (tone === "success") return "text-success";
  return "text-primary";
}

function artifactsFromActivity(
  activity: readonly ToolActivityEntry[],
  runStartedAt: number | null,
): ArtifactItem[] {
  if (runStartedAt === null) return [];
  const byPath = new Map<string, ArtifactItem>();
  for (const entry of [...activity].reverse()) {
    if (
      entry.startedAt < runStartedAt ||
      (entry.toolName !== "write" && entry.toolName !== "edit") ||
      entry.status !== "completed" ||
      typeof entry.input?.path !== "string" ||
      entry.input.path.length === 0
    ) {
      continue;
    }
    if (!byPath.has(entry.input.path)) {
      byPath.set(entry.input.path, { path: entry.input.path, kind: entry.toolName });
    }
  }
  return [...byPath.values()];
}

function extensionSummary(event: TrustedExtensionEvent | null): string | null {
  if (!event) return null;
  if (event.event === "notify" && typeof event.payload.message === "string") {
    return event.payload.message;
  }
  if (event.event === "widget" && Array.isArray(event.payload.widgetLines)) {
    const lines = event.payload.widgetLines.filter(
      (line): line is string => typeof line === "string" && line.trim().length > 0,
    );
    return lines.slice(0, 3).join(" · ") || null;
  }
  if (event.event === "title" && typeof event.payload.title === "string") {
    return uiCopy.activity.extensionTitle(event.payload.title);
  }
  if (event.event === "editor_text") return uiCopy.activity.extensionEditorUpdated;
  if (event.event === "error") {
    return typeof event.payload.error === "string" && event.payload.error.length > 0
      ? event.payload.error
      : uiCopy.activity.extensionFailed;
  }
  return event.event === "status" ? null : uiCopy.activity.extensionUpdate(event.event);
}

function ProcessSummary({ process }: { process: ProcessItem }) {
  const detail = process.progress || process.summary || process.description;
  return (
    <li className="flex min-w-0 items-start justify-between gap-3 py-1.5">
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold text-foreground">{process.name}</span>
        {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {process.status === "running"
          ? uiCopy.activity.processRunning
          : uiCopy.activity.processFinished}
      </span>
    </li>
  );
}

export function AgentActivityBar({ sessionId }: { sessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  // Subscribe so the uiCopy proxy is re-read when the live catalog changes.
  useStore((state) => state.uiLanguage);
  const activity = useStore((state) => state.agentActivity.get(sessionId));
  const toolActivity = useStore((state) => state.toolActivity.get(sessionId));
  const processes = useStore((state) => state.sessionProcesses.get(sessionId) || emptyProcesses);
  const todos = useStore((state) => state.sessionTasks.get(sessionId));
  const artifacts = useMemo(
    () => artifactsFromActivity(toolActivity || [], activity?.runStartedAt ?? null),
    [activity?.runStartedAt, toolActivity],
  );

  if (!activity) return null;

  const status = activityStatus(activity);
  const runningProcesses = processes.filter((process) => process.status === "running");
  const activeTool = [...(toolActivity || [])]
    .reverse()
    .find((entry) => entry.status === "started" || entry.status === "running");
  const incompleteTodos = (todos || []).filter((todo) => todo.status !== "completed").length;
  const queueCount = activity.queue.steering.length + activity.queue.followUp.length;
  const extension = extensionSummary(activity.extensionEvent);
  const hasDetails = Boolean(
    activeTool ||
    processes.length ||
    incompleteTodos ||
    queueCount ||
    artifacts.length ||
    extension ||
    activity.latestError,
  );
  const hasExpandableDetails = Boolean(
    activeTool ||
    processes.length ||
    incompleteTodos ||
    queueCount ||
    artifacts.length ||
    activity.latestError,
  );
  if (!status && !hasDetails) return null;

  const detailId = `agent-activity-details-${sessionId}`;
  const summary =
    activeTool?.preview ||
    (runningProcesses.length > 0
      ? uiCopy.activity.runningProcesses(runningProcesses.length)
      : artifacts.length > 0
        ? uiCopy.activity.artifactsReady(artifacts.length)
        : queueCount > 0
          ? uiCopy.activity.queuedWork(queueCount)
          : extension);

  return (
    <div className="px-3 pt-3 sm:px-6" data-testid="agent-activity-bar">
      <section
        className="piwork-superellipse-panel mx-auto w-full max-w-[var(--piwork-composer-width)] overflow-hidden rounded-[var(--piwork-panel-radius)] border border-border/70 bg-card/90"
        aria-label={uiCopy.activity.label}
      >
        <div className="flex min-h-10 items-center gap-2.5 px-3 py-2">
          {status && (
            <div
              className={`flex shrink-0 items-center gap-1.5 text-xs font-semibold ${statusTone(status.tone)}`}
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {statusIcon(status)}
              <span>{status.label}</span>
            </div>
          )}
          {status && summary && <span className="h-3 w-px shrink-0 bg-border" aria-hidden="true" />}
          {summary && (
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summary}</span>
          )}
          {artifacts.slice(0, 2).map((artifact) => (
            <span
              key={artifact.path}
              className="hidden max-w-40 items-center gap-1 truncate rounded-[var(--piwork-control-radius)] bg-muted px-2 py-1 text-xs text-foreground sm:inline-flex"
              title={artifact.path}
            >
              <FileText className="h-3 w-3 shrink-0 text-primary" aria-hidden="true" />
              <span className="truncate">{artifact.path.split("/").at(-1)}</span>
            </span>
          ))}
          {hasExpandableDetails && (
            <button
              type="button"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--piwork-control-radius)] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={expanded ? uiCopy.activity.collapse : uiCopy.activity.expand}
              aria-expanded={expanded}
              aria-controls={detailId}
              onClick={() => setExpanded((current) => !current)}
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`}
                aria-hidden="true"
              />
            </button>
          )}
        </div>

        {expanded && hasExpandableDetails && (
          <div
            id={detailId}
            className="grid gap-3 border-t border-border/60 px-3 py-3 sm:grid-cols-2"
          >
            <div className="min-w-0 space-y-2">
              {activeTool && (
                <div>
                  <h3 className="text-xs font-semibold text-foreground">
                    {uiCopy.activity.currentWork}
                  </h3>
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {getToolActionLabel(activeTool.toolName)}
                    {activeTool.preview ? ` · ${activeTool.preview}` : ""}
                  </p>
                </div>
              )}
              {processes.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-foreground">
                    {uiCopy.activity.delegatedWork}
                  </h3>
                  <ul className="mt-0.5 divide-y divide-border/50">
                    {processes.slice(-3).map((process) => (
                      <ProcessSummary key={process.taskId} process={process} />
                    ))}
                  </ul>
                </div>
              )}
              {incompleteTodos > 0 && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ListChecks className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
                  {uiCopy.activity.todosRemaining(incompleteTodos, todos?.length || 0)}
                </p>
              )}
              {extension && <p className="text-xs text-muted-foreground">{extension}</p>}
              {activity.latestError && (
                <p className="rounded-[var(--piwork-control-radius)] bg-danger/10 px-2 py-1.5 text-xs text-danger">
                  {activity.latestError}
                </p>
              )}
            </div>

            <div className="min-w-0 space-y-3">
              {queueCount > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-foreground">{uiCopy.activity.queue}</h3>
                  {activity.queue.steering.length > 0 && (
                    <div className="mt-1">
                      <p className="text-xs font-medium text-muted-foreground">
                        {uiCopy.activity.steeringQueue(activity.queue.steering.length)}
                      </p>
                      <ul className="mt-0.5 space-y-0.5">
                        {activity.queue.steering.slice(0, 2).map((item, index) => (
                          <li key={`${index}:${item}`} className="truncate text-xs text-foreground">
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {activity.queue.followUp.length > 0 && (
                    <div className="mt-1.5">
                      <p className="text-xs font-medium text-muted-foreground">
                        {uiCopy.activity.followUpQueue(activity.queue.followUp.length)}
                      </p>
                      <ul className="mt-0.5 space-y-0.5">
                        {activity.queue.followUp.slice(0, 2).map((item, index) => (
                          <li key={`${index}:${item}`} className="truncate text-xs text-foreground">
                            {item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
              {artifacts.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold text-foreground">
                    {uiCopy.activity.artifacts}
                  </h3>
                  <ul className="mt-1 space-y-1">
                    {artifacts.slice(0, 5).map((artifact) => (
                      <li
                        key={artifact.path}
                        className="flex min-w-0 items-center gap-2 text-xs text-foreground"
                      >
                        <FileText
                          className="h-3.5 w-3.5 shrink-0 text-primary"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1 truncate" title={artifact.path}>
                          {artifact.path}
                        </span>
                        <span className="shrink-0 text-muted-foreground">
                          {artifact.kind === "write"
                            ? uiCopy.activity.created
                            : uiCopy.activity.updated}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
