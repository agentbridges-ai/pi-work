export type IndexedWorkspaceEntry = {
  name: string;
  path: string;
  parentPath: string;
  kind: "file" | "directory";
  size?: number;
  lastModified?: number;
  ext: string;
  depth: number;
  previewKind: "image" | "audio" | "video" | "pdf" | "office" | "text" | "binary";
  hidden?: boolean;
  contentIndexed?: boolean;
  /** Runtime-only field consumed by the content index; never persisted. */
  content?: string;
};

export type IndexedWorkspaceList = {
  entries: IndexedWorkspaceEntry[];
  total?: number;
  nextCursor?: string;
};

export type IndexedWorkspaceContentMatch = {
  path: string;
  lineNumber: number;
  line: string;
  contextBefore: string[];
  contextAfter: string[];
};

export type IndexedWorkspaceContentSearchResult = {
  matches: IndexedWorkspaceContentMatch[];
  truncated?: boolean;
};
