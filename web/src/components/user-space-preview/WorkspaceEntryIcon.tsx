import { FileTypeIcon } from "../FileTypeIcon.js";
import { isAudioFile, isImageFile, isVideoFile } from "../file-type-utils.js";
import type { WorkspaceEntry } from "../user-space-explorer/model.js";
import {
  OFFICE_EXTENSIONS,
  PRESENTATION_EXTENSIONS,
  SPREADSHEET_EXTENSIONS,
  WORD_EXTENSIONS,
  isHtmlPath,
  isKnownTextPath,
  isMarkdownPath,
} from "../user-space-explorer/preview-builder.js";
import { getExtension } from "../user-space-explorer/workspace-paths.js";

export function iconForWorkspaceEntry(entry: WorkspaceEntry) {
  const ext = getExtension(entry.path);
  if (entry.previewKind === "image") return fileIconForEntry(entry.path, "image", "text-info");
  if (entry.previewKind === "audio") return fileIconForEntry(entry.path, "audio", "text-success");
  if (entry.previewKind === "video") return fileIconForEntry(entry.path, "video", "text-primary");
  if (entry.previewKind === "office") return officeIconForPath(entry.path, ext);
  if (isHtmlPath(entry.path)) return fileIconForEntry(entry.path, "html", "text-warning");
  if (isMarkdownPath(entry.path)) return fileIconForEntry(entry.path, "markdown", "text-info");
  if (entry.previewKind === "text") return textIconForPath(entry.path);
  if (isImageFile(entry.path)) return fileIconForEntry(entry.path, "image", "text-info");
  if (isAudioFile(entry.path)) return fileIconForEntry(entry.path, "audio", "text-success");
  if (isVideoFile(entry.path)) return fileIconForEntry(entry.path, "video", "text-primary");
  if (ext === "pdf") return fileIconForEntry(entry.path, "pdf", "text-danger");
  if (OFFICE_EXTENSIONS.has(ext)) return officeIconForPath(entry.path, ext);
  if (isKnownTextPath(entry.path)) return textIconForPath(entry.path);
  if (["zip", "tar", "gz", "tgz", "rar", "7z"].includes(ext))
    return fileIconForEntry(entry.path, "archive", "text-warning");
  return fileIconForEntry(entry.path, "file", "text-muted-foreground");
}

type WorkspaceEntryIconProps = {
  className?: string;
  "aria-hidden"?: boolean;
  "data-folder-state"?: string;
};

function officeIconForPath(path: string, ext: string) {
  if (WORD_EXTENSIONS.has(ext)) return officeIconForEntry(path, "word", "text-primary");
  if (SPREADSHEET_EXTENSIONS.has(ext))
    return officeIconForEntry(path, "spreadsheet", "text-success");
  if (PRESENTATION_EXTENSIONS.has(ext))
    return officeIconForEntry(path, "presentation", "text-warning");
  return fileIconForEntry(path, "text", "text-foreground/75");
}

function textIconForPath(path: string) {
  return fileIconForEntry(path, "text", "text-foreground/75");
}

function iconClassName(props: WorkspaceEntryIconProps, toneClassName: string) {
  return props.className ? `${props.className} ${toneClassName}` : toneClassName;
}

function fileIconForEntry(path: string, fileIcon: string, toneClassName: string) {
  return function WorkspaceFileIcon(props: WorkspaceEntryIconProps) {
    return (
      <FileTypeIcon
        path={path}
        className={iconClassName(props, toneClassName)}
        aria-hidden={props["aria-hidden"]}
        fileIcon={fileIcon}
        data-folder-state={props["data-folder-state"]}
        data-file-icon={fileIcon}
      />
    );
  };
}

function officeIconForEntry(path: string, officeIcon: string, toneClassName: string) {
  return function WorkspaceOfficeIcon(props: WorkspaceEntryIconProps) {
    return (
      <FileTypeIcon
        path={path}
        className={iconClassName(props, toneClassName)}
        aria-hidden={props["aria-hidden"]}
        officeIcon={officeIcon}
        data-folder-state={props["data-folder-state"]}
        data-office-icon={officeIcon}
      />
    );
  };
}
