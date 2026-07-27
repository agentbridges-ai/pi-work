import type { TreeNode } from "../../api.js";

export type WorkspaceEntry = {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
  lastModified?: number;
  previewKind?: "image" | "audio" | "video" | "pdf" | "office" | "text" | "binary";
  supportsLineEdit?: boolean;
};

export type PreviewErrorMessageKey = "fileMovedOrMissing" | "previewFailed" | "unsupportedPreview";

export type PreviewState =
  | { status: "empty" }
  | { status: "loading"; path: string }
  | {
      status: "error";
      path: string;
      message?: string;
      messageKey?: PreviewErrorMessageKey;
      size?: number;
    }
  | {
      status: "ready";
      path: string;
      name: string;
      kind:
        | "markdown"
        | "html"
        | "text"
        | "image"
        | "audio"
        | "video"
        | "pdf"
        | "office"
        | "wterm"
        | "binary";
      size: number;
      objectUrl: string;
      sourceObjectUrl?: string;
      officeFile?: File;
      textContent?: string;
      truncated?: boolean;
    };

export type ReadyPreviewState = Extract<PreviewState, { status: "ready" }>;
export type MarkdownPreviewState = ReadyPreviewState & { kind: "markdown" };
export type OfficePreviewState = ReadyPreviewState & { kind: "office" };
export type PreviewViewMode = "preview" | "text";
export type WorkspaceSpaceView = "user" | "agent";

export type PreviewTab = {
  id: string;
  mountId: string;
  path: string;
  title: string;
  viewMode: PreviewViewMode;
  state: PreviewState;
  pinned?: boolean;
  hasUnsavedChanges?: boolean;
  isEditing?: boolean;
};

export type WorkspaceClipboardEntry = {
  path: string;
  name: string;
  kind: "file" | "directory";
};

export type WorkspaceClipboard = {
  mountId: string;
  entries: WorkspaceClipboardEntry[];
  operation?: "copy" | "move";
};

export type WorkspaceMove = {
  sourcePath: string;
  path: string;
  kind: "file" | "directory";
};

export type WorkspaceMoveResult = {
  moves: WorkspaceMove[];
  changedDirs?: string[];
};

export type WorkspaceEntrySelection = {
  mountId: string;
  entry: WorkspaceEntry;
};

export type AgentEntrySelection = {
  node: TreeNode;
};

export type WorkspaceDetailsTypeCount = {
  label: string;
  count: number;
};

export type WorkspaceDetailsSummary = {
  fileCount: number;
  totalSize: number;
  typeCounts: WorkspaceDetailsTypeCount[];
};

export type WorkspaceDetailsDialog =
  | { kind: "file"; entry: WorkspaceEntry; directoryPath: string }
  | { kind: "summary"; summary: WorkspaceDetailsSummary };

export type WorkspaceNameActionDialog = {
  kind: "create-folder";
  mountId: string;
  parentPath: string;
  initialName: string;
};

export type WorkspaceDeleteActionDialog = {
  kind: "delete";
  space: WorkspaceSpaceView;
  mountId: string;
  entry: WorkspaceEntry;
  entries?: WorkspaceEntrySelection[];
};

export type WorkspaceActionDialog = WorkspaceNameActionDialog | WorkspaceDeleteActionDialog;

export type WorkspaceSearchPathResult = {
  kind: "path";
  entry: WorkspaceEntry;
};

export type WorkspaceSearchContentResult = {
  kind: "content";
  path: string;
  lineNumber: number;
  line: string;
  contextBefore: string[];
  contextAfter: string[];
  matchCount: number;
};

export type WorkspaceSearchResult = WorkspaceSearchPathResult | WorkspaceSearchContentResult;

export type WorkspaceSearchPreviewDialog = {
  path: string;
  label: string;
  searchQuery: string;
  state: PreviewState;
};
