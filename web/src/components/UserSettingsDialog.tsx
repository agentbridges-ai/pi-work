import { useEffect, useState, useSyncExternalStore } from "react";
import { Button, Dialog, SegmentedControl, Switch } from "./ui/index.js";
import type { CurrentUser, FilePreviewPreference, UserPreferences } from "../api.js";
import { AGENTS, getAgentDisplayName, type Agent, type AgentId } from "../agents.js";
import type { UiLanguage } from "../store/ui-slice.js";
import type { PiSessionInfo } from "../types.js";
import { uiCopy } from "../ui-copy.js";
import {
  checkAndRepairOfficeResources,
  downloadOfficeFontFamily,
  ensureOfficeResources,
  getOfficeResourceSnapshot,
  installOfficeFontPreset,
  loadAllOfficeResources,
  pauseOfficeResources,
  resumeOfficeResources,
  subscribeOfficeResources,
  uninstallOfficeFontFamily,
} from "../office-runtime-resources.js";

export interface UserSettingsDialogProps {
  user: CurrentUser;
  archivedSessions: PiSessionInfo[];
  selectedArchivedSessionIds: Set<string>;
  archivedLoading: boolean;
  archivedError: string;
  archivedActionId: string | null;
  preferences: UserPreferences;
  preferencesError: string;
  uiLanguage: UiLanguage;
  agentSessionIds: Record<AgentId, string>;
  agentSessionHistoryIds: Record<AgentId, string[]>;
  getSessionTitle: (session: PiSessionInfo) => string;
  onUserSpacePreferenceChange: (
    key: keyof UserPreferences["userSpace"],
    value: boolean,
  ) => void | Promise<void>;
  onOfficeFileDefaultChange: (value: FilePreviewPreference) => void | Promise<void>;
  onToggleArchivedSessionSelection: (sessionId: string) => void;
  onSetAllArchivedSessionSelection: (checked: boolean) => void;
  onRestoreArchivedSession: (sessionId: string) => void | Promise<void>;
  onHardDeleteArchivedSession: (sessionId: string) => void | Promise<void>;
  onRestoreSelectedArchivedSessions: () => void | Promise<void>;
  onHardDeleteSelectedArchivedSessions: () => void | Promise<void>;
  onClose: () => void;
}

export function UserSettingsDialog({
  user,
  archivedSessions,
  selectedArchivedSessionIds,
  archivedLoading,
  archivedError,
  archivedActionId,
  preferences,
  preferencesError,
  uiLanguage,
  agentSessionIds,
  agentSessionHistoryIds,
  getSessionTitle,
  onUserSpacePreferenceChange,
  onOfficeFileDefaultChange,
  onToggleArchivedSessionSelection,
  onSetAllArchivedSessionSelection,
  onRestoreArchivedSession,
  onHardDeleteArchivedSession,
  onRestoreSelectedArchivedSessions,
  onHardDeleteSelectedArchivedSessions,
  onClose,
}: UserSettingsDialogProps) {
  const agentBySessionId = new Map<string, Agent>();
  for (const agent of AGENTS) {
    const ids = new Set(
      [agentSessionIds[agent.id], ...(agentSessionHistoryIds[agent.id] || [])].filter(Boolean),
    );
    for (const sessionId of ids) agentBySessionId.set(sessionId, agent);
  }

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={uiCopy.chat.preferencesPanel.title}
      closeLabel={uiCopy.chat.preferencesPanel.closeLabel}
      className="max-w-[44rem]"
      headerClassName="items-center text-left"
      headerTextClassName="text-left"
      size="lg"
    >
      <section>
        <h2 className="text-sm font-semibold text-foreground">
          {uiCopy.chat.preferencesPanel.accountInfo}
        </h2>
        <div className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
          <InfoField
            label={uiCopy.chat.preferencesPanel.labels.displayName}
            value={user.displayName}
          />
          <InfoField label={uiCopy.chat.preferencesPanel.labels.org} value={user.orgName} />
          <InfoField label={uiCopy.chat.preferencesPanel.labels.email} value={user.email || "-"} />
          <InfoField
            label={uiCopy.chat.preferencesPanel.labels.roles}
            value={user.roles.length ? user.roles.join(", ") : "-"}
          />
        </div>
      </section>

      <FilePanelPreferencesSection
        preferences={preferences}
        onOfficeFileDefaultChange={onOfficeFileDefaultChange}
      />

      <OfficeResourcesSection />

      <UserSpacePreferencesSection
        preferences={preferences}
        error={preferencesError}
        onChange={onUserSpacePreferenceChange}
      />

      <ArchivedSessionsSection
        sessions={archivedSessions}
        locale={uiLanguage}
        selectedSessionIds={selectedArchivedSessionIds}
        loading={archivedLoading}
        error={archivedError}
        actionId={archivedActionId}
        agentBySessionId={agentBySessionId}
        getSessionTitle={getSessionTitle}
        onToggleSelection={onToggleArchivedSessionSelection}
        onSetAllSelection={onSetAllArchivedSessionSelection}
        onRestore={onRestoreArchivedSession}
        onHardDelete={onHardDeleteArchivedSession}
        onRestoreSelected={onRestoreSelectedArchivedSessions}
        onHardDeleteSelected={onHardDeleteSelectedArchivedSessions}
      />
    </Dialog>
  );
}

function formatOfficeResourceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function OfficeResourcesSection() {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const state = useSyncExternalStore(
    subscribeOfficeResources,
    getOfficeResourceSnapshot,
    getOfficeResourceSnapshot,
  );
  useEffect(() => {
    void ensureOfficeResources().catch(() => undefined);
  }, []);

  const resources = state.resources;
  const packs = Array.isArray(resources?.packs) ? resources.packs : [];
  const fonts = Array.isArray(resources?.fonts) ? resources.fonts : [];
  const hasResourceInventory =
    Boolean(resources) && Array.isArray(resources?.packs) && Array.isArray(resources?.fonts);
  const busy = Boolean(resources?.operation);
  const copy = uiCopy.chat.preferencesPanel.officeResources;
  const categoryLabels = copy.categories;
  const readinessLabel =
    state.status === "checking"
      ? copy.checking
      : resources?.readiness === "ready"
        ? copy.ready
        : resources?.readiness === "update-available"
          ? copy.updateAvailable
          : resources?.readiness === "paused"
            ? copy.paused
            : resources?.readiness === "repair-needed"
              ? copy.repairNeeded
              : copy.incomplete;
  const phase = resources?.phase ?? "idle";
  const showingVerification = phase === "verifying" || phase === "repairing";
  const completedBytes = showingVerification
    ? (resources?.verifiedBytes ?? 0)
    : (resources?.downloadedBytes ?? 0);
  const totalBytes = showingVerification
    ? (resources?.verifyBytes ?? 0)
    : (resources?.downloadBytes ?? 0);
  const progressPercent =
    totalBytes > 0 ? Math.min(100, Math.round((completedBytes / totalBytes) * 100)) : 0;
  const phaseLabel = copy.phases[phase];
  const progressActive = phase !== "idle";
  const displayedProgressPercent = progressActive
    ? progressPercent
    : resources?.readiness === "ready"
      ? 100
      : 0;
  const progressText = progressActive
    ? showingVerification
      ? copy.verifyProgress(
          formatOfficeResourceBytes(completedBytes),
          formatOfficeResourceBytes(totalBytes),
        )
      : copy.downloadProgress(
          formatOfficeResourceBytes(completedBytes),
          formatOfficeResourceBytes(totalBytes),
        )
    : readinessLabel;
  const resourceErrorCode = state.error?.code;
  const error =
    resourceErrorCode === "insufficient-storage"
      ? copy.errors.insufficientStorage(
          formatOfficeResourceBytes(state.error?.availableBytes || 0),
          formatOfficeResourceBytes(state.error?.requiredBytes || 0),
        )
      : resourceErrorCode === "initialization-failed"
        ? copy.errors.statusUnavailable
        : resourceErrorCode
          ? copy.errors[resourceErrorCode]
          : "";

  return (
    <section className="mt-6" data-testid="office-resources-section">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">{copy.title}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{copy.description}</p>
        </div>
        <div className="shrink-0 text-right text-xs text-muted-foreground">
          <div className="font-medium text-foreground">{readinessLabel}</div>
          {resources && (
            <div className="mt-0.5">
              {copy.version(resources.availablePackageVersion ?? resources.packageVersion)}
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 overflow-hidden rounded-[var(--piwork-control-radius)] border border-border bg-card">
        {resources && (
          <div className="border-b border-border px-3 py-3">
            <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
              <span className="font-medium text-foreground">{phaseLabel}</span>
              <span className="text-muted-foreground">
                {totalBytes > 0 ? progressText : readinessLabel}
              </span>
            </div>
            <progress
              aria-label={copy.progressLabel}
              className="block h-1.5 w-full overflow-hidden rounded-full accent-primary"
              max={100}
              value={displayedProgressPercent}
            />
          </div>
        )}
        {hasResourceInventory ? (
          <div className="grid gap-1.5 px-3 py-3">
            {packs.map((pack) => (
              <div
                key={pack.id}
                className="flex min-h-8 items-center justify-between gap-3 rounded-[var(--piwork-control-radius)] border border-border bg-background px-2.5 py-1.5 text-xs"
              >
                <span className="font-medium text-foreground">{categoryLabels[pack.id]}</span>
                <span className="text-muted-foreground">
                  {pack.ready ? copy.packReady : copy.packOnDemand}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-3 py-3 text-xs text-muted-foreground">{copy.statusUnavailable}</div>
        )}

        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-3 py-3">
          <Button
            size="sm"
            loading={resources?.operation === "prefetch-recommended"}
            isDisabled={busy || state.status === "checking"}
            onPress={() => void installOfficeFontPreset("basic").catch(() => undefined)}
          >
            {copy.basicPreset}
          </Button>
          {resources?.canPause && (
            <Button size="sm" variant="secondary" onPress={() => void pauseOfficeResources()}>
              {copy.pause}
            </Button>
          )}
          {resources?.canResume && (
            <Button
              size="sm"
              variant="secondary"
              onPress={() => void resumeOfficeResources().catch(() => undefined)}
            >
              {copy.resume}
            </Button>
          )}
          {(resources?.canRetry || resources?.readiness === "repair-needed") && (
            <Button
              size="sm"
              variant="secondary"
              isDisabled={busy}
              onPress={() => void checkAndRepairOfficeResources().catch(() => undefined)}
            >
              {resources?.canRetry ? copy.retry : copy.checkAndRepair}
            </Button>
          )}
        </div>

        {hasResourceInventory && resources && (
          <div className="border-t border-border px-3 py-3">
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-between px-0 text-xs font-semibold"
              aria-expanded={advancedOpen}
              aria-controls="office-advanced-resources"
              onPress={() => setAdvancedOpen((open) => !open)}
            >
              <span>{copy.advanced}</span>
              <span
                aria-hidden="true"
                className={`transition-transform ${advancedOpen ? "rotate-180" : ""}`}
              >
                ⌄
              </span>
            </Button>
            {advancedOpen && (
              <div id="office-advanced-resources">
                <div className="mt-3 text-xs text-muted-foreground">{copy.storageNote}</div>
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={resources.operation === "install-font-preset"}
                    isDisabled={busy}
                    onPress={() =>
                      void installOfficeFontPreset("office-compatibility").catch(() => undefined)
                    }
                  >
                    {copy.compatibilityPreset}
                  </Button>
                </div>
                <div className="mt-3 grid gap-2">
                  <div className="text-xs font-semibold text-foreground">{copy.fontsTitle}</div>
                  {fonts.map((font) => (
                    <div
                      key={font.id}
                      className="flex min-h-9 items-center justify-between gap-3 text-sm"
                      data-testid={`office-font-${font.id}`}
                    >
                      <span className="min-w-0 truncate font-medium text-foreground">
                        {font.name}
                        <span className="ml-1 font-normal text-muted-foreground">
                          · {formatOfficeResourceBytes(font.bytes)}
                        </span>
                      </span>
                      {font.removable ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={
                            resources.operation ===
                            (font.downloaded ? "remove-font" : "download-font")
                          }
                          isDisabled={busy}
                          onPress={() =>
                            void (
                              font.downloaded
                                ? uninstallOfficeFontFamily(font.id)
                                : downloadOfficeFontFamily(font.id)
                            ).catch(() => undefined)
                          }
                        >
                          {font.downloaded ? copy.remove : copy.download}
                        </Button>
                      ) : (
                        <span className="text-xs font-medium text-muted-foreground">
                          {copy.required}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-xs text-muted-foreground">{copy.reopenHint}</div>
                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={resources.operation === "check-health"}
                    isDisabled={busy}
                    onPress={() => void checkAndRepairOfficeResources().catch(() => undefined)}
                  >
                    {copy.checkAndRepair}
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={resources.operation === "load-all"}
                    isDisabled={busy}
                    onPress={() => void loadAllOfficeResources().catch(() => undefined)}
                  >
                    {copy.downloadAll}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      {error && (
        <div className="mt-2 text-xs font-medium text-danger" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

function FilePanelPreferencesSection({
  preferences,
  onOfficeFileDefaultChange,
}: {
  preferences: UserPreferences;
  onOfficeFileDefaultChange: (value: FilePreviewPreference) => void | Promise<void>;
}) {
  const officeKeys = ["word", "excel", "ppt"] as const;
  const officeDefault = officeKeys.every(
    (key) => preferences.filePreviewDefaults[key] === "alternate",
  )
    ? "alternate"
    : "preview";
  return (
    <section className="mt-6" data-testid="file-panel-preferences-section">
      <h2 className="text-sm font-semibold text-foreground">
        {uiCopy.chat.preferencesPanel.filePanel.title}
      </h2>
      <div className="mt-3 grid gap-2">
        <div
          className="flex min-h-12 flex-col justify-center gap-2 overflow-hidden rounded-[var(--piwork-control-radius)] border border-border bg-card px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
          data-testid="office-file-opening-preference"
        >
          <span className="text-sm font-medium text-foreground">
            {uiCopy.chat.preferencesPanel.office.title}
          </span>
          <SegmentedControl
            ariaLabel={uiCopy.chat.preferencesPanel.office.title}
            className="w-full shrink-0 sm:w-auto"
            isEqualWidth
            items={[
              { id: "preview", label: uiCopy.chat.preferencesPanel.office.preview },
              { id: "alternate", label: uiCopy.chat.preferencesPanel.office.edit },
            ]}
            onChange={(value) =>
              void onOfficeFileDefaultChange(value === "alternate" ? "alternate" : "preview")
            }
            size="sm"
            value={officeDefault}
          />
        </div>
      </div>
    </section>
  );
}

function UserSpacePreferencesSection({
  preferences,
  error,
  onChange,
}: {
  preferences: UserPreferences;
  error: string;
  onChange: (key: keyof UserPreferences["userSpace"], value: boolean) => void | Promise<void>;
}) {
  return (
    <section className="mt-6" data-testid="user-space-preferences-section">
      <h2 className="text-sm font-semibold text-foreground">
        {uiCopy.chat.preferencesPanel.userSpace.title}
      </h2>
      <div
        className="mt-3 flex min-h-12 items-center overflow-hidden rounded-[var(--piwork-control-radius)] border border-border bg-card px-3 py-2"
        data-testid="user-space-preference-showHiddenEntries"
      >
        <Switch
          label={uiCopy.chat.preferencesPanel.userSpace.showHiddenEntries}
          isSelected={preferences.userSpace.showHiddenEntries === true}
          onChange={(checked) => void onChange("showHiddenEntries", checked)}
          size="sm"
          className="piwork-switch-contrast w-full"
        />
      </div>
      {error && (
        <div className="mt-2 text-xs font-medium text-danger" role="alert">
          {error}
        </div>
      )}
    </section>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div className="piwork-superellipse rounded-xl border border-border bg-card px-3 py-2">
      <div className="text-xs font-semibold text-foreground">{label}</div>
      <div className="mt-0.5 break-all text-sm font-medium text-foreground">{value}</div>
    </div>
  );
}

const ARCHIVED_RESTORE_BUTTON_CLASS_NAME =
  "rounded-[var(--piwork-control-radius)] bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition-colors hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-50";

function ArchivedSessionsSection({
  sessions,
  locale,
  selectedSessionIds,
  loading,
  error,
  actionId,
  agentBySessionId,
  getSessionTitle,
  onToggleSelection,
  onSetAllSelection,
  onRestore,
  onHardDelete,
  onRestoreSelected,
  onHardDeleteSelected,
}: {
  sessions: PiSessionInfo[];
  locale: UiLanguage;
  selectedSessionIds: Set<string>;
  loading: boolean;
  error: string;
  actionId: string | null;
  agentBySessionId: Map<string, Agent>;
  getSessionTitle: (session: PiSessionInfo) => string;
  onToggleSelection: (sessionId: string) => void;
  onSetAllSelection: (checked: boolean) => void;
  onRestore: (sessionId: string) => void | Promise<void>;
  onHardDelete: (sessionId: string) => void | Promise<void>;
  onRestoreSelected: () => void | Promise<void>;
  onHardDeleteSelected: () => void | Promise<void>;
}) {
  const allSelected =
    sessions.length > 0 && sessions.every((session) => selectedSessionIds.has(session.sessionId));
  const selectedCount = selectedSessionIds.size;
  const busy = !!actionId;
  return (
    <section className="mt-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{uiCopy.chat.archived.title}</h2>
        {loading && <span className="text-xs text-foreground">{uiCopy.common.loading}</span>}
        {error && <span className="truncate text-xs text-danger">{error}</span>}
      </div>
      <div
        className="piwork-superellipse-panel mt-3 overflow-hidden rounded-xl border border-border bg-card"
        data-testid="archived-session-group"
      >
        {sessions.length > 0 && (
          <div
            className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 text-xs text-foreground"
            data-testid="archived-session-controls"
          >
            <label className="inline-flex items-center gap-2 font-semibold">
              <input
                type="checkbox"
                aria-label={uiCopy.chat.archived.selectAll}
                checked={allSelected}
                disabled={busy}
                onChange={(event) => onSetAllSelection(event.currentTarget.checked)}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              <span>
                {selectedCount > 0
                  ? uiCopy.chat.archived.selectedCount(selectedCount)
                  : uiCopy.chat.archived.selectSession}
              </span>
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy || selectedCount === 0}
                onClick={() => void onRestoreSelected()}
                className={ARCHIVED_RESTORE_BUTTON_CLASS_NAME}
              >
                {uiCopy.chat.archived.bulkRestore}
              </button>
              <button
                type="button"
                disabled={busy || selectedCount === 0}
                onClick={() => void onHardDeleteSelected()}
                className="rounded-[var(--piwork-control-radius)] bg-danger/10 px-3 py-1.5 font-semibold text-danger transition-colors hover:bg-danger/15 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {uiCopy.chat.archived.bulkDelete}
              </button>
            </div>
          </div>
        )}
        <div data-testid="archived-session-list">
          {sessions.length === 0 ? (
            <div className="px-3 py-4 text-sm text-foreground">
              {loading ? uiCopy.chat.archived.loading : uiCopy.chat.archived.empty}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {sessions.map((session) => {
                const agent = agentBySessionId.get(session.sessionId);
                const rowBusy = busy && actionId !== session.sessionId;
                const currentBusy = actionId === session.sessionId || rowBusy;
                const selected = selectedSessionIds.has(session.sessionId);
                return (
                  <div
                    key={session.sessionId}
                    className="grid gap-3 px-3 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
                  >
                    <label className="flex min-w-0 items-start gap-3">
                      <input
                        type="checkbox"
                        aria-label={uiCopy.chat.archived.selectSessionLabel(
                          getSessionTitle(session),
                        )}
                        checked={selected}
                        disabled={busy}
                        onChange={() => onToggleSelection(session.sessionId)}
                        className="mt-1 h-4 w-4 shrink-0 rounded border-border accent-primary"
                      />
                      <div className="min-w-0">
                        <div className="truncate font-semibold text-foreground">
                          {getSessionTitle(session)}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-foreground">
                          <span>
                            {agent
                              ? getAgentDisplayName(agent.id)
                              : uiCopy.chat.archived.unknownAgent}
                          </span>
                          <span>
                            {uiCopy.chat.archived.createdAt(
                              formatArchivedSessionDate(session.createdAt, locale),
                            )}
                          </span>
                          <span>
                            {uiCopy.chat.archived.archivedAt(
                              formatArchivedSessionDate(
                                session.archivedAt || session.createdAt,
                                locale,
                              ),
                            )}
                          </span>
                        </div>
                      </div>
                    </label>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        disabled={currentBusy}
                        onClick={() => void onRestore(session.sessionId)}
                        className={ARCHIVED_RESTORE_BUTTON_CLASS_NAME}
                      >
                        {uiCopy.chat.archived.restore}
                      </button>
                      <button
                        type="button"
                        disabled={currentBusy}
                        onClick={() => void onHardDelete(session.sessionId)}
                        className="rounded-[var(--piwork-control-radius)] bg-danger/10 px-3 py-1.5 text-xs font-semibold text-danger transition-colors hover:bg-danger/15 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {uiCopy.chat.archived.delete}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function formatArchivedSessionDate(timestamp: number | undefined, locale: UiLanguage): string {
  if (!timestamp) return "-";
  return new Date(timestamp).toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
