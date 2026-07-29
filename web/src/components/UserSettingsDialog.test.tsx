// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";
import { DEFAULT_USER_PREFERENCES, type CurrentUser } from "../api.js";
import { setUiCopyLanguage, uiCopy } from "../ui-copy.js";
import type { UiLanguage } from "../store/ui-slice.js";
import type { PiSessionInfo } from "../types.js";
import { UserSettingsDialog } from "./UserSettingsDialog.js";

const officeResourcesMock = vi.hoisted(() => ({
  snapshot: {
    status: "ready" as const,
    error: null,
    resources: {
      packageVersion: "0.3.37",
      assetVersion: "assets-v1",
      readiness: "needs-download",
      packs: [
        { id: "fonts", ready: true, completedBytes: 1_000, totalBytes: 1_000 },
        { id: "core", ready: true, completedBytes: 1_000, totalBytes: 1_000 },
        { id: "word", ready: false, completedBytes: 0, totalBytes: 2_000 },
        { id: "cell", ready: false, completedBytes: 0, totalBytes: 2_000 },
        { id: "slide", ready: false, completedBytes: 0, totalBytes: 2_000 },
      ],
      progress: {
        phase: "ready" as const,
        completedFiles: 3,
        totalFiles: 10,
        completedBytes: 3_000,
        totalBytes: 10_000,
        failedFiles: 0,
        categories: [
          {
            category: "fonts" as const,
            completedFiles: 2,
            totalFiles: 3,
            completedBytes: 2_000,
            totalBytes: 3_000,
          },
          {
            category: "core" as const,
            completedFiles: 1,
            totalFiles: 2,
            completedBytes: 1_000,
            totalBytes: 2_000,
          },
          {
            category: "word" as const,
            completedFiles: 0,
            totalFiles: 2,
            completedBytes: 0,
            totalBytes: 2_000,
          },
          {
            category: "cell" as const,
            completedFiles: 0,
            totalFiles: 2,
            completedBytes: 0,
            totalBytes: 2_000,
          },
          {
            category: "slide" as const,
            completedFiles: 0,
            totalFiles: 1,
            completedBytes: 0,
            totalBytes: 1_000,
          },
        ],
      },
      fonts: [
        {
          id: "dengxian",
          name: "DengXian",
          bytes: 1_000,
          paths: ["fonts/dengxian.ttf"],
          downloaded: true,
          removable: false,
        },
        {
          id: "microsoft yahei",
          name: "Microsoft YaHei",
          bytes: 2_000,
          paths: ["fonts/yahei.ttf"],
          downloaded: false,
          removable: true,
        },
      ],
      verifiedFontPaths: ["fonts/dengxian.ttf"],
      operation: null,
      error: null,
    },
  },
}));

vi.mock("../office-runtime-resources.js", () => ({
  ensureOfficeResources: vi.fn(async () => ({})),
  getOfficeResourceSnapshot: () => officeResourcesMock.snapshot,
  subscribeOfficeResources: () => () => undefined,
  loadAllOfficeResources: vi.fn(async () => undefined),
  checkAndRepairOfficeResources: vi.fn(async () => undefined),
  downloadOfficeFontFamily: vi.fn(async () => undefined),
  installOfficeFontPreset: vi.fn(async () => undefined),
  uninstallOfficeFontFamily: vi.fn(async () => undefined),
}));

const user: CurrentUser = {
  userId: "user-a",
  username: "login-handle",
  displayName: "misaka",
  orgId: "org-a",
  orgName: "Org A",
  roles: [],
  email: "misaka@example.com",
};

const archivedAt = Date.UTC(2026, 6, 15, 14, 5);
const archivedSession: PiSessionInfo = {
  sessionId: "archived-a",
  state: "exited",
  backendType: "pi",
  transport: "pi-rpc",
  cwd: "/workspace",
  createdAt: archivedAt - 60_000,
  archivedAt,
  archived: true,
  name: "Archived A",
};

function renderDialog(locale: UiLanguage) {
  setUiCopyLanguage(locale);
  return render(
    <UserSettingsDialog
      user={user}
      archivedSessions={[archivedSession]}
      selectedArchivedSessionIds={new Set()}
      archivedLoading={false}
      archivedError=""
      archivedActionId={null}
      preferences={DEFAULT_USER_PREFERENCES}
      preferencesError=""
      uiLanguage={locale}
      agentSessionIds={{ agent: "", "agent-a": "", "agent-b": "", "agent-c": "" }}
      agentSessionHistoryIds={{ agent: [], "agent-a": [], "agent-b": [], "agent-c": [] }}
      getSessionTitle={(session) => session.name || session.sessionId}
      onUserSpacePreferenceChange={vi.fn()}
      onOfficeFileDefaultChange={vi.fn()}
      onToggleArchivedSessionSelection={vi.fn()}
      onSetAllArchivedSessionSelection={vi.fn()}
      onRestoreArchivedSession={vi.fn()}
      onHardDeleteArchivedSession={vi.fn()}
      onRestoreSelectedArchivedSessions={vi.fn()}
      onHardDeleteSelectedArchivedSessions={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

afterEach(() => {
  cleanup();
  setUiCopyLanguage("zh-CN");
});

describe("UserSettingsDialog", () => {
  it("renders the remaining settings in a centered modal without appearance controls", () => {
    renderDialog("en-US");

    const dialog = screen.getByRole("dialog", { name: uiCopy.chat.preferencesPanel.title });
    expect(dialog).toHaveClass("max-w-[44rem]");
    expect(dialog.querySelector('[data-slot="modal-header"]')).toHaveClass(
      "flex-row",
      "items-center",
      "text-left",
    );
    expect(dialog.querySelector('[data-slot="modal-heading"]')?.parentElement).toHaveClass(
      "text-left",
    );
    expect(
      screen.queryByRole("radiogroup", { name: uiCopy.chat.userMenu.theme }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radiogroup", { name: uiCopy.topBar.language }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(uiCopy.chat.preferencesPanel.appearance)).not.toBeInTheDocument();
  });

  it("exposes the Office file opening preference", () => {
    renderDialog("en-US");

    expect(screen.getByTestId("file-panel-preferences-section")).toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: uiCopy.chat.preferencesPanel.office.title }),
    ).toBeInTheDocument();
  });

  it.each(["zh-CN", "en-US"] as const)(
    "shows simplified Office readiness and presets in %s",
    (locale) => {
      renderDialog(locale);

      const section = screen.getByTestId("office-resources-section");
      expect(
        within(section).getByText(uiCopy.chat.preferencesPanel.officeResources.title),
      ).toBeInTheDocument();
      expect(
        within(section).getByText(uiCopy.chat.preferencesPanel.officeResources.version("0.3.37")),
      ).toBeInTheDocument();
      expect(
        within(section).getByRole("button", {
          name: uiCopy.chat.preferencesPanel.officeResources.basicPreset,
        }),
      ).toBeInTheDocument();
      expect(
        within(section).getByRole("button", {
          name: uiCopy.chat.preferencesPanel.officeResources.compatibilityPreset,
        }),
      ).toBeInTheDocument();
      expect(
        within(section).getByText(uiCopy.chat.preferencesPanel.officeResources.advanced),
      ).toBeInTheDocument();
    },
  );

  it("shows the display name as the single username field", () => {
    renderDialog("en-US");

    expect(screen.getByText("misaka")).toBeInTheDocument();
    expect(screen.queryByText("login-handle")).not.toBeInTheDocument();
    expect(screen.getAllByText("Username")).toHaveLength(1);
    expect(screen.queryByText("Name")).not.toBeInTheDocument();
  });

  it("uses concise archive actions and joins the selector to the session list", () => {
    renderDialog("en-US");

    const group = screen.getByTestId("archived-session-group");
    const controls = within(group).getByTestId("archived-session-controls");
    const list = within(group).getByTestId("archived-session-list");

    expect(group).toHaveClass("overflow-hidden", "rounded-xl", "border", "bg-card");
    expect(controls).toHaveClass("border-b");
    expect(controls).not.toHaveClass("bg-muted");
    expect(list).not.toHaveClass("mt-3", "rounded-xl", "border");
    const bulkRestore = within(controls).getByRole("button", { name: "Restore" });
    const rowRestore = within(list).getByRole("button", { name: "Restore" });
    expect(bulkRestore.className).toBe(rowRestore.className);
    expect(within(controls).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(within(list).getByText("Default Agent")).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "Delete" })).toBeInTheDocument();
  });

  it.each(["zh-CN", "en-US"] as const)(
    "formats archived dates with the active %s locale",
    (locale) => {
      renderDialog(locale);
      const expectedDate = new Date(archivedAt).toLocaleString(locale, {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

      expect(screen.getByText(uiCopy.chat.archived.archivedAt(expectedDate))).toBeInTheDocument();
    },
  );

  it("keeps User Space switches in a stable, interactive row", () => {
    renderDialog("en-US");
    const row = screen.getByTestId("user-space-preference-showHiddenEntries");

    expect(
      within(row).getAllByText(uiCopy.chat.preferencesPanel.userSpace.showHiddenEntries),
    ).toHaveLength(1);
    expect(within(row).getByRole("switch")).toBeEnabled();
    expect(row).toHaveClass("overflow-hidden");
    expect(
      screen.queryByTestId("user-space-preference-searchHiddenEntries"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(uiCopy.common.saving)).not.toBeInTheDocument();
  });
});
