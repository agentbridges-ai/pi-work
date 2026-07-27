// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  agentPreviewTabId,
  previewTabId,
} from "../user-space-preview/preview-workspace-contract.js";
import type { PreviewTab } from "./model.js";
import {
  previewSessionStorageKey,
  readPreviewSessionState,
  writePreviewSessionState,
} from "./preview-session-state.js";

function readyTextTab(overrides: Partial<PreviewTab>): PreviewTab {
  return {
    id: "mount-a:notes.txt",
    mountId: "mount-a",
    path: "notes.txt",
    title: "notes.txt",
    viewMode: "text",
    state: {
      status: "ready",
      path: "notes.txt",
      name: "notes.txt",
      kind: "text",
      size: 5,
      objectUrl: "",
      textContent: "hello",
    },
    ...overrides,
  };
}

afterEach(() => {
  window.sessionStorage.clear();
});

describe("preview session state", () => {
  it("persists pinned tabs", () => {
    const ownerKey = "user-a:session-a";
    const id = previewTabId("mount-a", "notes.txt");

    writePreviewSessionState(ownerKey, [readyTextTab({ id, pinned: true })], id);

    expect(readPreviewSessionState(ownerKey)).toEqual({
      activeTabId: id,
      tabs: [
        expect.objectContaining({
          id,
          pinned: true,
        }),
      ],
    });
  });

  it("persists a relocated User Space tab under its new canonical id", () => {
    const ownerKey = "user-a:session-a";
    const runtimeId = previewTabId("mount-a", "notes.txt");
    const relocatedPath = "archive/notes.txt";
    const tab = readyTextTab({
      id: runtimeId,
      path: relocatedPath,
      state: {
        status: "ready",
        path: relocatedPath,
        name: "notes.txt",
        kind: "text",
        size: 5,
        objectUrl: "",
        textContent: "hello",
      },
    });

    writePreviewSessionState(ownerKey, [tab], runtimeId);

    const canonicalId = previewTabId("mount-a", relocatedPath);
    expect(tab.id).toBe(runtimeId);
    expect(readPreviewSessionState(ownerKey)).toEqual({
      activeTabId: canonicalId,
      tabs: [
        {
          space: "user",
          id: canonicalId,
          mountId: "mount-a",
          path: relocatedPath,
          viewMode: "text",
          previewKind: "text",
          size: 5,
        },
      ],
    });
  });

  it("maps a relocated Agent Space active tab to its new canonical id", () => {
    const ownerKey = "user-a:session-a";
    const runtimeId = agentPreviewTabId("draft.md");
    const relocatedPath = "archive/draft.md";
    const tab = readyTextTab({
      id: runtimeId,
      mountId: "agent",
      path: relocatedPath,
      title: "draft.md",
      viewMode: "preview",
      state: {
        status: "ready",
        path: relocatedPath,
        name: "draft.md",
        kind: "markdown",
        size: 7,
        objectUrl: "",
        textContent: "# Draft",
      },
    });

    writePreviewSessionState(ownerKey, [tab], runtimeId);

    const canonicalId = agentPreviewTabId(relocatedPath);
    expect(tab.id).toBe(runtimeId);
    expect(readPreviewSessionState(ownerKey)).toEqual({
      activeTabId: canonicalId,
      tabs: [
        {
          space: "agent",
          id: canonicalId,
          mountId: "agent",
          path: relocatedPath,
          viewMode: "preview",
          previewKind: "text",
          size: 7,
        },
      ],
    });
    expect(window.sessionStorage.getItem(previewSessionStorageKey(ownerKey))).toContain(
      canonicalId,
    );
  });

  it("preserves file size for a restored unsupported preview", () => {
    const ownerKey = "user-a:session-a";
    const id = previewTabId("mount-a", "archive.zip");
    const tab: PreviewTab = {
      id,
      mountId: "mount-a",
      path: "archive.zip",
      title: "archive.zip",
      viewMode: "preview",
      state: {
        status: "error",
        path: "archive.zip",
        messageKey: "unsupportedPreview",
        size: 128,
      },
    };

    writePreviewSessionState(ownerKey, [tab], id);

    expect(readPreviewSessionState(ownerKey)?.tabs[0]?.size).toBe(128);
  });
});
