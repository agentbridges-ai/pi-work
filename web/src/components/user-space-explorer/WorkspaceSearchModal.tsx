import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Icon as IconifyIcon,
  addIcon,
  type IconifyIcon as IconifyIconData,
} from "@iconify/react/offline";
import { Folder, Search } from "lucide-react";
import {
  CloseButtonEngine as CloseButton,
  ModalEngine as Modal,
  ProgressCircleEngine as ProgressCircle,
} from "../ui/index.js";
import { FileTypeIcon } from "../FileTypeIcon.js";
import { executeUserSpaceOperation, getUserSpaceFile } from "../../user-space.js";
import { uiCopy } from "../../ui-copy.js";
import { useAutoFocusSearchInput } from "../use-auto-focus-search-input.js";
import type { UserSpaceMount } from "../../types.js";
import type { UiLanguage } from "../../store/ui-slice.js";
import { buildPreview, isPreviewableFile, unsupportedPreviewState } from "./preview-builder.js";
import { revokePreviewStateUrl } from "./preview-resources.js";
import type {
  PreviewState,
  WorkspaceEntry,
  WorkspaceSearchContentResult,
  WorkspaceSearchPreviewDialog,
  WorkspaceSearchResult,
} from "./model.js";

const WORKSPACE_SEARCH_DEBOUNCE_MS = 180;
const WORKSPACE_SEARCH_PREVIEW_ICON = "qlementine-icons:preview-16";
const QLEMENTINE_PREVIEW_ICON: IconifyIconData = {
  body: '<path fill="currentColor" fill-rule="evenodd" d="M12 4.57a.5.5 0 0 0-.024-.235l-.013-.063a1.5 1.5 0 0 0-.18-.434c-.092-.15-.222-.28-.482-.54L8.711.707c-.259-.26-.389-.39-.54-.483a1.5 1.5 0 0 0-.496-.193a.5.5 0 0 0-.235-.024C7.329.004 7.194.004 7.015.004h-2.21c-1.68 0-2.52 0-3.16.327a3.02 3.02 0 0 0-1.31 1.31C.008 2.283.008 3.12.008 4.8v6.4c0 1.68 0 2.52.327 3.16a3.02 3.02 0 0 0 1.31 1.31c.642.327 1.48.327 3.16.327h2.423c.401 0 .602-.523.347-.832a.45.45 0 0 0-.345-.168H4.8c-.857 0-1.44-.001-1.89-.038c-.438-.036-.663-.1-.819-.18a2 2 0 0 1-.874-.874c-.08-.156-.145-.38-.18-.819c-.036-.45-.037-1.03-.037-1.89v-6.4c0-.857 0-1.44.037-1.89c.036-.438.101-.663.18-.819c.192-.376.498-.682.874-.874c.156-.08.381-.145.82-.18C3.36.997 3.94.997 4.8.997H7v3.5a.5.5 0 0 0 .5.5H11v.547c0 .25.207.45.456.473c.285.025.543-.188.543-.474V4.99c0-.178 0-.313-.005-.425zM8 1.41L10.59 4H8z" clip-rule="evenodd"/><path fill="currentColor" fill-rule="evenodd" d="M11 15c.834 0 1.61-.255 2.25-.691l1.47 1.47a.749.749 0 1 0 1.06-1.06l-1.47-1.47c.436-.641.691-1.41.691-2.25c0-2.21-1.79-4-4-4s-4 1.79-4 4s1.79 4 4 4zm0-1c1.66 0 3-1.34 3-3s-1.34-3-3-3s-3 1.34-3 3s1.34 3 3 3" clip-rule="evenodd"/>',
};
addIcon(WORKSPACE_SEARCH_PREVIEW_ICON, QLEMENTINE_PREVIEW_ICON);

const workspaceCopy = uiCopy.userSpace;
const WORKSPACE_CONTROL_RADIUS_CLASS = "rounded-[var(--piwork-control-radius)]";
const WORKSPACE_PANEL_RADIUS_CLASS = "rounded-[var(--piwork-panel-radius)]";

type WorkspaceSearchMode = "path" | "content";

export type WorkspaceSearchPreviewRenderArgs = {
  dialog: WorkspaceSearchPreviewDialog;
  mount: UserSpaceMount;
  uiLanguage: UiLanguage;
};

export function WorkspaceSearchModal({
  mount,
  includeHidden,
  uiLanguage,
  onClose,
  onOpenResult,
  renderPreview,
}: {
  mount: UserSpaceMount;
  includeHidden: boolean;
  uiLanguage: UiLanguage;
  onClose: () => void;
  onOpenResult: (result: WorkspaceSearchResult) => void;
  renderPreview: (args: WorkspaceSearchPreviewRenderArgs) => ReactNode;
}) {
  const [mode, setMode] = useState<WorkspaceSearchMode>("path");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WorkspaceSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [previewDialog, setPreviewDialog] = useState<WorkspaceSearchPreviewDialog | null>(null);
  const inputId = useId();
  const requestSeqRef = useRef(0);
  const previewRequestSeqRef = useRef(0);
  const previewDialogRef = useRef<WorkspaceSearchPreviewDialog | null>(null);
  const trimmedQuery = query.trim();
  const searchInputRef = useAutoFocusSearchInput<HTMLInputElement>(true, mode);

  useEffect(() => {
    previewDialogRef.current = previewDialog;
  }, [previewDialog]);

  const replacePreviewDialog = useCallback((next: WorkspaceSearchPreviewDialog | null) => {
    setPreviewDialog((current) => {
      if (current) revokePreviewStateUrl(current.state);
      return next;
    });
  }, []);

  const closePreviewDialog = useCallback(() => {
    previewRequestSeqRef.current += 1;
    replacePreviewDialog(null);
  }, [replacePreviewDialog]);

  useEffect(() => {
    return () => {
      previewRequestSeqRef.current += 1;
      const current = previewDialogRef.current;
      if (current) revokePreviewStateUrl(current.state);
      previewDialogRef.current = null;
    };
  }, []);

  const openPreviewDialog = useCallback(
    (result: WorkspaceSearchResult) => {
      const target = workspaceSearchPreviewTarget(result);
      if (!target) return;
      const { path, previewKind } = target;
      const label = workspaceSearchDisplayPath(path);
      const searchQuery = trimmedQuery;
      const seq = previewRequestSeqRef.current + 1;
      previewRequestSeqRef.current = seq;
      const loadingState: PreviewState = isPreviewableFile(path, previewKind)
        ? { status: "loading", path }
        : unsupportedPreviewState(path);
      replacePreviewDialog({ path, label, searchQuery, state: loadingState });
      if (loadingState.status !== "loading") return;

      void (async () => {
        try {
          const file = await getUserSpaceFile(mount.mountId, path);
          const nextPreview = await buildPreview(file, path);
          if (seq !== previewRequestSeqRef.current) {
            revokePreviewStateUrl(nextPreview);
            return;
          }
          replacePreviewDialog({ path, label, searchQuery, state: nextPreview });
        } catch (err) {
          if (seq !== previewRequestSeqRef.current) return;
          replacePreviewDialog({
            path,
            label,
            searchQuery,
            state: {
              status: "error",
              path,
              ...(err instanceof Error
                ? { message: err.message }
                : { messageKey: "previewFailed" as const }),
            },
          });
        }
      })();
    },
    [mount.mountId, replacePreviewDialog, trimmedQuery],
  );

  useEffect(() => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setError("");
    if (!trimmedQuery) {
      setLoading(false);
      setResults([]);
      return undefined;
    }

    setLoading(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          if (mode === "path") {
            const result = (await executeUserSpaceOperation("search_paths", {
              mountId: mount.mountId,
              query: trimmedQuery,
              includeHidden,
            })) as { entries?: WorkspaceEntry[] };
            if (requestSeqRef.current !== requestSeq) return;
            setResults((result.entries || []).map((entry) => ({ kind: "path", entry })));
          } else {
            const result = (await executeUserSpaceOperation("search", {
              mountId: mount.mountId,
              query: trimmedQuery,
              includeHidden,
              contextLines: 1,
            })) as { matches?: Array<Omit<WorkspaceSearchContentResult, "kind" | "matchCount">> };
            if (requestSeqRef.current !== requestSeq) return;
            setResults(groupWorkspaceSearchContentResults(result.matches || []));
          }
        } catch (err) {
          if (requestSeqRef.current !== requestSeq) return;
          setResults([]);
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          if (requestSeqRef.current === requestSeq) setLoading(false);
        }
      })();
    }, WORKSPACE_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [includeHidden, mode, mount.mountId, trimmedQuery]);

  const statusText = error
    ? error
    : trimmedQuery && !loading && results.length === 0
      ? workspaceCopy.searchDialog.noResults
      : "";

  return (
    <>
      <Modal
        isOpen
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <Modal.Backdrop variant="opaque" isDismissable>
          <Modal.Container placement="center" size="lg">
            <Modal.Dialog
              aria-label={workspaceCopy.searchDialog.openFor(mount.rootName)}
              className={`piwork-superellipse-panel flex h-[520px] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-[680px] overflow-hidden ${WORKSPACE_PANEL_RADIUS_CLASS} border border-border bg-card !p-0 text-foreground`}
            >
              <div className="flex h-full min-h-0 flex-col gap-3 p-4 sm:p-5">
                <div
                  role="tablist"
                  aria-label={workspaceCopy.searchDialog.modeLabel}
                  onKeyDown={(event) => {
                    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const tabList = event.currentTarget;
                    setMode(event.key === "ArrowLeft" || event.key === "Home" ? "path" : "content");
                    requestAnimationFrame(() =>
                      tabList
                        .querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
                        ?.focus(),
                    );
                  }}
                  className="grid grid-cols-2 gap-1 rounded-[var(--piwork-control-radius)] border border-border bg-surface-weak p-0.5"
                >
                  <WorkspaceSearchModeButton
                    active={mode === "path"}
                    onClick={() => setMode("path")}
                  >
                    {workspaceCopy.searchDialog.pathMode}
                  </WorkspaceSearchModeButton>
                  <WorkspaceSearchModeButton
                    active={mode === "content"}
                    onClick={() => setMode("content")}
                  >
                    {workspaceCopy.searchDialog.contentMode}
                  </WorkspaceSearchModeButton>
                </div>

                <div className="relative">
                  <label className="sr-only" htmlFor={inputId}>
                    {workspaceCopy.searchDialog.inputLabel}
                  </label>
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <input
                    ref={searchInputRef}
                    id={inputId}
                    autoFocus
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    placeholder={
                      mode === "path"
                        ? workspaceCopy.searchDialog.pathPlaceholder
                        : workspaceCopy.searchDialog.contentPlaceholder
                    }
                    className="h-10 w-full rounded-[var(--piwork-control-radius)] border border-input bg-background pl-9 pr-3 text-sm text-foreground outline-none transition-colors placeholder:text-disabled-foreground focus:border-ring"
                    data-testid="user-space-search-input"
                  />
                </div>

                <div
                  className="min-h-0 flex-1 overflow-y-scroll px-1 [scrollbar-gutter:stable]"
                  data-testid="user-space-search-body"
                >
                  {loading ? (
                    <WorkspaceSearchLoading />
                  ) : statusText ? (
                    <div
                      className={
                        error
                          ? "text-xs text-danger"
                          : "flex h-full min-h-[160px] items-center justify-center text-sm text-muted-foreground"
                      }
                      role="status"
                    >
                      {statusText}
                    </div>
                  ) : results.length > 0 ? (
                    <div data-testid="user-space-search-results">
                      {results.map((result) => (
                        <WorkspaceSearchResultRow
                          key={workspaceSearchResultKey(result)}
                          result={result}
                          onOpen={() => onOpenResult(result)}
                          onPreview={() => openPreviewDialog(result)}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
      {previewDialog && (
        <WorkspaceSearchPreviewModal
          dialog={previewDialog}
          mount={mount}
          uiLanguage={uiLanguage}
          onClose={closePreviewDialog}
          renderPreview={renderPreview}
        />
      )}
    </>
  );
}

function WorkspaceSearchLoading() {
  return (
    <div
      className="flex h-full min-h-[160px] items-center justify-center"
      data-testid="user-space-search-loading"
    >
      <ProgressCircle isIndeterminate aria-label={uiCopy.common.loading}>
        <ProgressCircle.Track>
          <ProgressCircle.TrackCircle />
          <ProgressCircle.FillCircle />
        </ProgressCircle.Track>
      </ProgressCircle>
    </div>
  );
}

function WorkspaceSearchPreviewModal({
  dialog,
  mount,
  uiLanguage,
  onClose,
  renderPreview,
}: WorkspaceSearchPreviewRenderArgs & {
  onClose: () => void;
  renderPreview: (args: WorkspaceSearchPreviewRenderArgs) => ReactNode;
}) {
  const readonlyMount = useMemo<UserSpaceMount>(() => ({ ...mount, canWrite: false }), [mount]);
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Backdrop variant="opaque" isDismissable>
        <Modal.Container placement="center" size="lg">
          <Modal.Dialog
            aria-label={workspaceCopy.previewEntry(dialog.label)}
            className={`piwork-superellipse-panel flex h-[min(720px,calc(100dvh-2rem))] w-[calc(100vw-2rem)] max-w-[960px] overflow-hidden ${WORKSPACE_PANEL_RADIUS_CLASS} border border-border bg-card !p-0 text-foreground`}
          >
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
                <FileTypeIcon path={dialog.path} className="h-5 w-5 shrink-0" aria-hidden={true} />
                <span
                  className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"
                  title={dialog.label}
                >
                  {dialog.label}
                </span>
                <CloseButton
                  onClick={onClose}
                  aria-label={uiCopy.common.close}
                  className={`shrink-0 ${WORKSPACE_CONTROL_RADIUS_CLASS} bg-transparent hover:bg-accent`}
                  style={{ color: "var(--foreground)" }}
                />
              </div>
              <div
                className="min-h-0 flex-1 bg-background"
                data-testid={`workspace-search-preview-body-${dialog.path}`}
              >
                {renderPreview({ dialog, mount: readonlyMount, uiLanguage })}
              </div>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

function groupWorkspaceSearchContentResults(
  matches: Array<Omit<WorkspaceSearchContentResult, "kind" | "matchCount">>,
): WorkspaceSearchContentResult[] {
  const byPath = new Map<string, WorkspaceSearchContentResult>();
  for (const match of matches) {
    const existing = byPath.get(match.path);
    if (existing) {
      existing.matchCount += 1;
      continue;
    }
    byPath.set(match.path, { kind: "content", ...match, matchCount: 1 });
  }
  return Array.from(byPath.values());
}

function WorkspaceSearchModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      onClick={onClick}
      className="h-7 rounded-[var(--piwork-control-radius)] bg-transparent px-2 text-xs font-semibold text-muted-foreground outline-none transition-colors hover:bg-card hover:text-foreground aria-selected:bg-card aria-selected:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function WorkspaceSearchResultRow({
  result,
  onOpen,
  onPreview,
}: {
  result: WorkspaceSearchResult;
  onOpen: () => void;
  onPreview: () => void;
}) {
  const isPath = result.kind === "path";
  const path = isPath ? result.entry.path : result.path;
  const label = workspaceSearchDisplayPath(path);
  const openLabelPath = isPath ? path : label;
  const previewable = Boolean(workspaceSearchPreviewTarget(result));
  return (
    <div className="group/search-result relative">
      <button
        type="button"
        onClick={onOpen}
        className="flex h-12 w-full min-w-0 items-center gap-3 rounded-[var(--piwork-control-radius)] px-2 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
        aria-label={workspaceCopy.searchDialog.openResult(openLabelPath)}
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center">
          {isPath && result.entry.kind === "directory" ? (
            <Folder className="h-5 w-5 text-warning" aria-hidden="true" />
          ) : (
            <FileTypeIcon path={path} className="h-5 w-5" aria-hidden={true} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-semibold leading-5 text-foreground overflow-visible">
            {label}
          </span>
          {!isPath && (
            <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
              {workspaceCopy.searchDialog.matchCount(result.matchCount)}
            </span>
          )}
        </span>
      </button>
      {previewable && (
        <button
          type="button"
          aria-label={workspaceCopy.previewEntry(label)}
          title={workspaceCopy.previewEntry(label)}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onPreview();
          }}
          className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center text-muted-foreground opacity-0 transition-colors hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/search-result:opacity-100"
        >
          <IconifyIcon
            icon={WORKSPACE_SEARCH_PREVIEW_ICON}
            className="h-4 w-4"
            aria-hidden="true"
            data-iconify-icon={WORKSPACE_SEARCH_PREVIEW_ICON}
          />
        </button>
      )}
    </div>
  );
}

function workspaceSearchDisplayPath(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  return normalized || "/";
}

function workspaceSearchPreviewTarget(
  result: WorkspaceSearchResult,
): { path: string; previewKind?: WorkspaceEntry["previewKind"] } | null {
  if (result.kind === "content") return { path: result.path };
  if (result.entry.kind !== "file") return null;
  return { path: result.entry.path, previewKind: result.entry.previewKind };
}

function workspaceSearchResultKey(result: WorkspaceSearchResult): string {
  return result.kind === "path" ? `path:${result.entry.path}` : `content:${result.path}`;
}
