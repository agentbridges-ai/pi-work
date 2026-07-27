import { FileTypeIcon } from "./FileTypeIcon.js";
import { isAudioFile, isImageFile, isVideoFile } from "./file-type-utils.js";
import {
  USER_SPACE_PRESENTATION_EXTENSIONS,
  USER_SPACE_SPREADSHEET_EXTENSIONS,
  USER_SPACE_TEXT_EXTENSIONS,
  USER_SPACE_WORD_EXTENSIONS,
} from "../user-space-file-types.js";

type FileReferenceIconMeta = {
  toneClassName: string;
  fileIcon: string;
};

export function FileReferenceIcon({
  path,
  className = "h-4 w-4 shrink-0 object-contain",
  "aria-hidden": ariaHidden = true,
}: {
  path: string;
  className?: string;
  "aria-hidden"?: boolean;
}) {
  const { toneClassName, fileIcon } = getFileReferenceIconMeta(path);
  return (
    <FileTypeIcon
      path={path}
      className={`${className} ${toneClassName}`}
      aria-hidden={ariaHidden}
      fileIcon={fileIcon}
      data-file-icon={fileIcon}
    />
  );
}

function getFileReferenceIconMeta(path: string): FileReferenceIconMeta {
  const ext = getExtension(path);
  if (isImageFile(path)) return { toneClassName: "text-info", fileIcon: "image" };
  if (isAudioFile(path)) return { toneClassName: "text-success", fileIcon: "audio" };
  if (isVideoFile(path)) return { toneClassName: "text-primary", fileIcon: "video" };
  if (ext === "pdf") return { toneClassName: "text-danger", fileIcon: "pdf" };
  if (isWordExtension(ext)) return { toneClassName: "text-primary", fileIcon: "word" };
  if (isSpreadsheetExtension(ext))
    return { toneClassName: "text-success", fileIcon: "spreadsheet" };
  if (isPresentationExtension(ext))
    return { toneClassName: "text-warning", fileIcon: "presentation" };
  if (isHtmlPath(path)) return { toneClassName: "text-warning", fileIcon: "html" };
  if (isMarkdownPath(path)) return { toneClassName: "text-info", fileIcon: "markdown" };
  if (isArchiveExtension(ext)) return { toneClassName: "text-warning", fileIcon: "archive" };
  if (isKnownTextPath(path)) return { toneClassName: "text-muted-foreground", fileIcon: "text" };
  return { toneClassName: "text-muted-foreground", fileIcon: "file" };
}

function isKnownTextPath(path: string): boolean {
  return USER_SPACE_TEXT_EXTENSIONS.has(getExtension(path));
}

function isHtmlPath(path: string): boolean {
  return ["html", "htm"].includes(getExtension(path));
}

function isMarkdownPath(path: string): boolean {
  return ["md", "markdown"].includes(getExtension(path));
}

function isWordExtension(ext: string): boolean {
  return USER_SPACE_WORD_EXTENSIONS.has(ext);
}

function isSpreadsheetExtension(ext: string): boolean {
  return USER_SPACE_SPREADSHEET_EXTENSIONS.has(ext);
}

function isPresentationExtension(ext: string): boolean {
  return USER_SPACE_PRESENTATION_EXTENSIONS.has(ext);
}

function isArchiveExtension(ext: string): boolean {
  return ["zip", "tar", "gz", "tgz", "rar", "7z"].includes(ext);
}

function getExtension(path: string): string {
  const name = (path.split("/").pop() || path).toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : name;
}
