const FILE_PREVIEW_LAYOUT_STORAGE_PREFIX = "piwork:file-preview-layout:v1:";

export type FilePreviewLayoutMode = "two-fifths" | "four-fifths";

export function filePreviewLayoutStorageKey(ownerKey: string): string {
  return `${FILE_PREVIEW_LAYOUT_STORAGE_PREFIX}${encodeURIComponent(ownerKey)}`;
}

export function readFilePreviewLayoutMode(ownerKey: string): FilePreviewLayoutMode {
  if (typeof window === "undefined" || !ownerKey) return "two-fifths";
  try {
    return window.sessionStorage?.getItem(filePreviewLayoutStorageKey(ownerKey)) === "four-fifths"
      ? "four-fifths"
      : "two-fifths";
  } catch {
    return "two-fifths";
  }
}

export function writeFilePreviewLayoutMode(ownerKey: string, mode: FilePreviewLayoutMode): void {
  if (typeof window === "undefined" || !ownerKey) return;
  try {
    window.sessionStorage?.setItem(filePreviewLayoutStorageKey(ownerKey), mode);
  } catch {
    // Refresh recovery is best-effort when browser storage is unavailable.
  }
}
