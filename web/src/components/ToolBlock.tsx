import { useState, type ComponentType } from "react";
import { DiffViewer } from "./DiffViewer.js";
import { uiCopy } from "../ui-copy.js";

const TOOL_ICONS: Record<string, string> = {
  bash: "terminal",
  read: "file",
  write: "file-plus",
  edit: "file-edit",
  ask: "message",
  todo_write: "checklist",
  task: "agent",
  propose_plan: "list",
  agent_browser: "globe",
};

const TOOL_COPY_KEYS = {
  bash: "bash",
  read: "read",
  write: "write",
  edit: "edit",
  ask: "ask",
  task: "task",
  todo_write: "todo_write",
  propose_plan: "propose_plan",
} as const;

export function getToolIcon(name: string): string {
  return TOOL_ICONS[name] || "tool";
}

export function getToolLabel(name: string): string {
  const copyKey = TOOL_COPY_KEYS[name as keyof typeof TOOL_COPY_KEYS];
  const label = copyKey ? uiCopy.toolBlock.labels[copyKey] : undefined;
  if (label) return label;
  if (name.startsWith("mcp__")) return name.slice("mcp__".length).replaceAll("__", " / ");
  return name;
}

export function getToolActionLabel(name: string): string {
  const copyKey = TOOL_COPY_KEYS[name as keyof typeof TOOL_COPY_KEYS];
  const label = copyKey ? uiCopy.toolBlock.actionLabels[copyKey] : undefined;
  if (label) return label;
  if (name.startsWith("mcp__")) return uiCopy.toolBlock.actionLabels.mcp_tool_call;
  return uiCopy.toolBlock.working;
}

export function ToolBlock({
  name,
  input,
  toolUseId,
  compact = false,
}: {
  name: string;
  input: Record<string, unknown>;
  toolUseId: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const iconType = getToolIcon(name);
  const label = getToolActionLabel(name);
  const preview = getPreview(name, input);
  const showsDiff = name === "edit" || name === "write";

  return (
    <div
      className={`overflow-hidden border tool-card ${
        compact
          ? "rounded-md border-transparent bg-transparent"
          : "piwork-superellipse-panel rounded-lg border-border/50 bg-card/35"
      }`}
      data-tool-use-id={toolUseId}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={`w-full flex items-center gap-2 text-left transition-colors cursor-pointer ${
          compact ? "px-2 py-1 hover:bg-accent/35" : "px-3 py-2 hover:bg-accent/45"
        }`}
      >
        <svg
          viewBox="0 0 16 16"
          fill="currentColor"
          className={`w-3 h-3 text-muted-foreground/60 transition-transform duration-200 shrink-0 ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        >
          <path d="M6 4l4 4-4 4" />
        </svg>
        <ToolIcon type={iconType} />
        <span className="shrink-0 text-xs font-medium text-foreground/75">{label}</span>
        {preview && (
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground font-mono-code">
            {preview}
          </span>
        )}
        {showsDiff && (
          <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary">
            {uiCopy.toolBlock.diff}
          </span>
        )}
        {!preview && <span className="flex-1" />}
        <span className="text-xs text-muted-foreground/55">
          {open ? uiCopy.toolBlock.hide : uiCopy.toolBlock.details}
        </span>
      </button>

      {open && (
        <div
          className={
            compact
              ? "ml-6 border-l border-border/35 px-3 pb-2"
              : "px-3 pb-3 pt-0 border-t border-border/45"
          }
        >
          <div className="mt-2">
            <ToolDetail name={name} input={input} />
          </div>
        </div>
      )}
    </div>
  );
}

interface ToolDetailProps {
  input: Record<string, unknown>;
}

const TOOL_DETAIL_COMPONENTS: Record<string, ComponentType<ToolDetailProps>> = {
  bash: BashDetail,
  edit: EditToolDetail,
  read: ReadToolDetail,
  task: TaskDetail,
  todo_write: TodoDetail,
  write: WriteToolDetail,
};

/** Route to custom detail renderer per tool type. */
export function ToolDetail({ name, input }: { name: string; input: Record<string, unknown> }) {
  const Detail = TOOL_DETAIL_COMPONENTS[name];
  if (Detail) return <Detail input={input} />;
  return <JsonToolDetail input={input} />;
}

function JsonToolDetail({ input }: ToolDetailProps) {
  return (
    <pre className="text-xs text-muted-foreground font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}

// ─── Per-tool detail components ─────────────────────────────────────────────

function BashDetail({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1.5">
      <pre className="piwork-superellipse-panel rounded-lg bg-muted px-3 py-2 text-foreground text-xs font-mono-code leading-relaxed overflow-x-auto">
        <span className="text-muted-foreground select-none">$ </span>
        {String(input.command || "")}
      </pre>
      {!!input.timeout && (
        <div className="text-xs text-muted-foreground">
          {uiCopy.toolBlock.timeout(String(input.timeout))}
        </div>
      )}
    </div>
  );
}

function EditToolDetail({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.path || "");
  const rawEdits = Array.isArray(input.edits)
    ? (input.edits as Array<{ oldText?: unknown; newText?: unknown }>)
    : [];
  const edits = rawEdits
    .map((edit) => ({
      oldText: typeof edit.oldText === "string" ? edit.oldText : "",
      newText: typeof edit.newText === "string" ? edit.newText : "",
    }))
    .filter((edit) => edit.oldText || edit.newText);

  return (
    <div className="space-y-1.5">
      {edits.length > 0 ? (
        edits.map((edit, index) => (
          <div key={`${filePath}:${index}`} className="space-y-1">
            {edits.length > 1 && (
              <div className="text-xs font-medium text-muted-foreground">
                {uiCopy.toolBlock.editNumber(index + 1, edits.length)}
              </div>
            )}
            <DiffViewer
              oldText={edit.oldText}
              newText={edit.newText}
              fileName={filePath}
              mode="compact"
              showLineNumbers
            />
          </div>
        ))
      ) : (
        <pre className="text-xs text-muted-foreground font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
          {JSON.stringify(input, null, 2)}
        </pre>
      )}
    </div>
  );
}

function WriteToolDetail({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.path || "");
  const content = String(input.content || "");

  return <DiffViewer newText={content} fileName={filePath} mode="compact" showLineNumbers />;
}

function ReadToolDetail({ input }: { input: Record<string, unknown> }) {
  const filePath = String(input.path || "");
  const offset = input.offset as number | undefined;
  const limit = input.limit as number | undefined;

  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground font-mono-code">{filePath}</div>
      {(offset != null || limit != null) && (
        <div className="flex gap-2 text-xs text-muted-foreground">
          {offset != null && <span>offset: {offset}</span>}
          {limit != null && <span>limit: {limit}</span>}
        </div>
      )}
    </div>
  );
}

function TaskDetail({ input }: { input: Record<string, unknown> }) {
  return (
    <div className="space-y-1.5">
      {!!input.name && (
        <div className="text-xs text-foreground font-medium">{String(input.name)}</div>
      )}
      {!!input.description && (
        <div className="text-xs text-foreground font-medium">{String(input.description)}</div>
      )}
      {!!input.execution && (
        <span className="inline-block text-xs font-medium px-1.5 py-0.5 rounded bg-primary/10 text-primary">
          {String(input.execution)}
        </span>
      )}
      {!!input.prompt && (
        <pre className="text-xs text-muted-foreground font-mono-code whitespace-pre-wrap leading-relaxed max-h-40 overflow-y-auto">
          {String(input.prompt)}
        </pre>
      )}
    </div>
  );
}

function TodoDetail({ input }: { input: Record<string, unknown> }) {
  const todos = input.todos as
    Array<{ content?: string; status?: string; activeForm?: string }> | undefined;
  if (!Array.isArray(todos)) {
    return (
      <pre className="text-xs text-muted-foreground font-mono-code whitespace-pre-wrap leading-relaxed max-h-60 overflow-y-auto">
        {JSON.stringify(input, null, 2)}
      </pre>
    );
  }

  return (
    <div className="space-y-0.5">
      {todos.map((todo, i) => {
        const status = todo.status || "pending";
        return (
          <div key={i} className="flex items-start gap-2 py-0.5">
            <span className="shrink-0 mt-0.5">
              {status === "completed" ? (
                <svg viewBox="0 0 16 16" fill="currentColor" className="w-3.5 h-3.5 text-success">
                  <path
                    fillRule="evenodd"
                    d="M8 15A7 7 0 108 1a7 7 0 000 14zm3.354-9.354a.5.5 0 00-.708-.708L7 8.586 5.354 6.94a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l4-4z"
                    clipRule="evenodd"
                  />
                </svg>
              ) : status === "in_progress" ? (
                <svg
                  className="w-3.5 h-3.5 text-primary animate-spin"
                  viewBox="0 0 16 16"
                  fill="none"
                >
                  <circle
                    cx="8"
                    cy="8"
                    r="6"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeDasharray="28"
                    strokeDashoffset="8"
                    strokeLinecap="round"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 16 16" fill="none" className="w-3.5 h-3.5 text-muted-foreground">
                  <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              )}
            </span>
            <span
              className={`text-xs leading-snug ${status === "completed" ? "text-muted-foreground line-through" : "text-foreground"}`}
            >
              {todo.content || uiCopy.toolBlock.task}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// ─── Preview ────────────────────────────────────────────────────────────────

export function getPreview(name: string, input: Record<string, unknown>): string {
  if (name === "bash" && typeof input.command === "string") {
    return input.command.length > 60 ? input.command.slice(0, 60) + "..." : input.command;
  }
  if ((name === "read" || name === "write" || name === "edit") && input.path) {
    const path = String(input.path);
    return path.split("/").slice(-2).join("/");
  }
  if (name === "task" && input.description) return String(input.description);
  if (name === "todo_write" && Array.isArray(input.todos)) {
    return uiCopy.toolBlock.taskCount(input.todos.length);
  }
  if (name === "propose_plan") {
    const plan = typeof input.plan === "string" ? input.plan.trim() : "";
    if (!plan) return uiCopy.toolBlock.previewNeedsApproval;
    const firstLine =
      plan
        .split("\n")
        .find((line) => line.trim())
        ?.replace(/^#+\s*/, "")
        .trim() || "plan";
    return firstLine.length > 60 ? firstLine.slice(0, 60) + "..." : firstLine;
  }
  return "";
}

// ─── Icons ──────────────────────────────────────────────────────────────────

export function ToolIcon({ type }: { type: string }) {
  const cls = "w-3.5 h-3.5 text-primary shrink-0";

  if (type === "terminal") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <polyline points="3 11 6 8 3 5" />
        <line x1="8" y1="11" x2="13" y2="11" />
      </svg>
    );
  }
  if (type === "file" || type === "file-plus" || type === "file-edit") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M9 1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V5L9 1z" />
        <polyline points="9 1 9 5 13 5" />
      </svg>
    );
  }
  if (type === "search") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <circle cx="7" cy="7" r="4" />
        <path d="M13 13l-3-3" />
      </svg>
    );
  }
  if (type === "globe") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <circle cx="8" cy="8" r="6" />
        <path d="M2 8h12M8 2c2 2 3 4 3 6s-1 4-3 6c-2-2-3-4-3-6s1-4 3-6z" />
      </svg>
    );
  }
  if (type === "message") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M14 10a1 1 0 01-1 1H5l-3 3V3a1 1 0 011-1h10a1 1 0 011 1v7z" />
      </svg>
    );
  }
  if (type === "list") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path d="M3 4h10M3 8h10M3 12h6" />
      </svg>
    );
  }
  if (type === "agent") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <circle cx="8" cy="5" r="3" />
        <path d="M3 14c0-2.8 2.2-5 5-5s5 2.2 5 5" strokeLinecap="round" />
      </svg>
    );
  }
  if (type === "checklist") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <path
          d="M3 4l1.5 1.5L7 3M3 8l1.5 1.5L7 7M3 12l1.5 1.5L7 11"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M9 4h4M9 8h4M9 12h4" />
      </svg>
    );
  }
  if (type === "notebook") {
    return (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
        <rect x="3" y="1" width="10" height="14" rx="1" />
        <path d="M6 1v14M3 5h3M3 9h3M3 13h3" />
      </svg>
    );
  }
  // Default tool icon
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className={cls}>
      <path d="M10.5 2.5l3 3-8 8H2.5v-3l8-8z" />
    </svg>
  );
}
