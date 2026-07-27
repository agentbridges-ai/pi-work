import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { isAudioFile, isImageFile, isVideoFile } from "../file-type-utils.js";
import { previewResourceRegistry } from "../preview-resource-registry.js";
import { uiCopy } from "../../ui-copy.js";
import {
  USER_SPACE_OFFICE_EXTENSIONS,
  USER_SPACE_PRESENTATION_EXTENSIONS,
  USER_SPACE_SPREADSHEET_EXTENSIONS,
  USER_SPACE_TEXT_EXTENSIONS,
  USER_SPACE_WORD_EXTENSIONS,
} from "../../user-space-file-types.js";
import type { PreviewState, WorkspaceEntry } from "./model.js";
import { getExtension } from "./workspace-paths.js";

export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;
export const DOCX_PREVIEW_ARCHIVE_LIMITS = Object.freeze({
  compressedBytes: 32 * 1024 * 1024,
  entryCount: 2_048,
  entryUncompressedBytes: 16 * 1024 * 1024,
  totalUncompressedBytes: 64 * 1024 * 1024,
  compressionRatio: 100,
});

const KNOWN_NON_PREVIEW_BINARY_EXTENSIONS = new Set([
  "7z",
  "a",
  "aar",
  "bin",
  "bz2",
  "class",
  "dat",
  "db",
  "dll",
  "dmg",
  "dylib",
  "eot",
  "exe",
  "gz",
  "heic",
  "iso",
  "jar",
  "o",
  "otf",
  "pkl",
  "pyc",
  "rar",
  "so",
  "sqlite",
  "tar",
  "tgz",
  "ttf",
  "wasm",
  "woff",
  "woff2",
  "xz",
  "zip",
  "zst",
]);

export const OFFICE_EXTENSIONS = USER_SPACE_OFFICE_EXTENSIONS;
export const WORD_EXTENSIONS = USER_SPACE_WORD_EXTENSIONS;
export const SPREADSHEET_EXTENSIONS = USER_SPACE_SPREADSHEET_EXTENSIONS;
export const PRESENTATION_EXTENSIONS = USER_SPACE_PRESENTATION_EXTENSIONS;

export function previewErrorMessage(preview: Extract<PreviewState, { status: "error" }>): string {
  if (preview.message) return preview.message;
  if (preview.messageKey === "fileMovedOrMissing") {
    return uiCopy.userSpace.fileMovedOrMissing(previewTitleForPath(preview.path));
  }
  if (preview.messageKey === "previewFailed") return uiCopy.userSpace.previewFailed;
  return uiCopy.userSpace.unsupportedPreview;
}

export function previewLoadErrorState(
  path: string,
  error: unknown,
): Extract<PreviewState, { status: "error" }> {
  if (isFileNotFoundError(error)) {
    return { status: "error", path, messageKey: "fileMovedOrMissing" };
  }
  return {
    status: "error",
    path,
    ...(error instanceof Error
      ? { message: error.message }
      : { messageKey: "previewFailed" as const }),
  };
}

export function unsupportedPreviewState(
  path: string,
  size?: number,
): Extract<PreviewState, { status: "error" }> {
  return {
    status: "error",
    path,
    messageKey: "unsupportedPreview",
    ...(typeof size === "number" ? { size } : {}),
  };
}

function isFileNotFoundError(error: unknown): boolean {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return false;
  const candidate = error as { name?: unknown; message?: unknown };
  if (candidate.name === "NotFoundError") return true;
  return (
    typeof candidate.message === "string" &&
    candidate.message.includes(
      "A requested file or directory could not be found at the time an operation was processed.",
    )
  );
}

export async function buildPreview(
  file: File,
  path: string,
): Promise<Extract<PreviewState, { status: "ready" }>> {
  const ext = getExtension(path);
  const base = {
    status: "ready" as const,
    path,
    name: path.split("/").pop() || file.name || "file",
    size: file.size,
  };
  const fileObjectUrl = () => previewResourceRegistry.create(file);
  if (isImageFile(path)) return { ...base, kind: "image", objectUrl: fileObjectUrl() };
  if (isAudioPreviewFile(file, path))
    return { ...base, kind: "audio", objectUrl: createMediaObjectUrl(file, path) };
  if (isVideoPreviewFile(file, path))
    return { ...base, kind: "video", objectUrl: createMediaObjectUrl(file, path) };
  if (ext === "pdf") return { ...base, kind: "pdf", objectUrl: fileObjectUrl() };
  if (OFFICE_EXTENSIONS.has(ext)) {
    const officeFile = await normalizeOfficePreviewFile(file, path);
    return {
      ...base,
      kind: "office",
      objectUrl: "",
      officeFile,
    };
  }
  if (shouldReadAsText(file, path)) {
    const content = await readBlobText(file.slice(0, MAX_TEXT_PREVIEW_BYTES));
    const truncated = file.size > MAX_TEXT_PREVIEW_BYTES;
    if (isHtmlPath(path)) {
      return {
        ...base,
        kind: "html",
        objectUrl: fileObjectUrl(),
        textContent: content,
        truncated,
      };
    }
    const objectUrl = createPlainTextObjectUrl(content);
    if (isMarkdownPath(path))
      return { ...base, kind: "markdown", objectUrl, textContent: content, truncated };
    return { ...base, kind: "text", objectUrl, textContent: content, truncated };
  }
  const firstBytes = await readBlobBytes(file.slice(0, Math.min(file.size, 4096)));
  if (!looksBinary(firstBytes)) {
    const content = await readBlobText(file.slice(0, MAX_TEXT_PREVIEW_BYTES));
    return {
      ...base,
      kind: "text",
      objectUrl: createPlainTextObjectUrl(content),
      textContent: content,
      truncated: file.size > MAX_TEXT_PREVIEW_BYTES,
    };
  }
  return { ...base, kind: "binary", objectUrl: fileObjectUrl() };
}

export function createPlainTextObjectUrl(content: string): string {
  return previewResourceRegistry.create(new Blob([content], { type: "text/plain;charset=utf-8" }));
}

export function createHtmlObjectUrl(content: string): string {
  return previewResourceRegistry.create(new Blob([content], { type: "text/html;charset=utf-8" }));
}

export function createImageObjectUrl(file: File, path: string): string {
  if (file.type) return previewResourceRegistry.create(file);
  const mimeType = imageMimeTypeForPath(path);
  return previewResourceRegistry.create(mimeType ? file.slice(0, file.size, mimeType) : file);
}

function createMediaObjectUrl(file: File, path: string): string {
  if (file.type) return previewResourceRegistry.create(file);
  const mimeType = mediaMimeTypeForPath(path);
  return previewResourceRegistry.create(mimeType ? file.slice(0, file.size, mimeType) : file);
}

export async function readBlobText(blob: Blob): Promise<string> {
  if (typeof blob.text === "function") return blob.text();
  if (typeof blob.arrayBuffer === "function")
    return new TextDecoder().decode(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () =>
      reject(reader.error || new Error(uiCopy.userSpace.textSaveErrors.textReadFailed));
    reader.readAsText(blob);
  });
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (blob.size === 0) return new Uint8Array();
  if (typeof blob.arrayBuffer === "function") return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (result instanceof ArrayBuffer) {
        resolve(new Uint8Array(result));
        return;
      }
      resolve(new Uint8Array());
    };
    reader.onerror = () =>
      reject(reader.error || new Error(uiCopy.userSpace.textSaveErrors.textReadFailed));
    reader.readAsArrayBuffer(blob);
  });
}

export function isPreviewableFile(
  path: string,
  previewKind?: WorkspaceEntry["previewKind"],
): boolean {
  if (previewKind === "binary") return isPreviewablePath(path);
  if (previewKind) return true;
  return isPreviewablePath(path);
}

export function isPreviewableAgentFile(
  path: string,
  previewKind?: WorkspaceEntry["previewKind"],
): boolean {
  if (previewKind) return isPreviewableFile(path, previewKind);
  if (isPreviewablePath(path)) return true;
  return !KNOWN_NON_PREVIEW_BINARY_EXTENSIONS.has(getExtension(path));
}

export function previewKindForWorkspacePath(
  path: string,
): WorkspaceEntry["previewKind"] | undefined {
  const ext = getExtension(path);
  if (isImageFile(path)) return "image";
  if (isAudioFile(path)) return "audio";
  if (isVideoFile(path)) return "video";
  if (ext === "pdf") return "pdf";
  if (OFFICE_EXTENSIONS.has(ext)) return "office";
  if (isKnownTextPath(path)) return "text";
  return undefined;
}

export function emptyOfficeTypeForWorkspacePath(
  path: string,
): "docx" | "xlsx" | "pptx" | undefined {
  const ext = getExtension(path);
  if (ext === "docx" || ext === "xlsx" || ext === "pptx") return ext;
  return undefined;
}

export function isPreviewablePath(path: string): boolean {
  const ext = getExtension(path);
  return (
    isImageFile(path) ||
    isAudioFile(path) ||
    isVideoFile(path) ||
    ext === "pdf" ||
    OFFICE_EXTENSIONS.has(ext) ||
    isKnownTextPath(path)
  );
}

export function isHiddenWorkspaceEntry(entry: WorkspaceEntry): boolean {
  const name = entry.name || entry.path.split("/").filter(Boolean).at(-1) || "";
  return name.startsWith(".");
}

export function isKnownTextPath(path: string): boolean {
  return USER_SPACE_TEXT_EXTENSIONS.has(getExtension(path));
}

export function isMarkdownPath(path: string): boolean {
  return ["md", "markdown"].includes(getExtension(path));
}

export function isHtmlPath(path: string): boolean {
  return ["html", "htm"].includes(getExtension(path));
}

function shouldReadAsText(file: File, path: string): boolean {
  if (file.type.startsWith("text/")) return true;
  if (file.type === "application/json" || file.type.endsWith("+json") || file.type.endsWith("+xml"))
    return true;
  return isKnownTextPath(path);
}

function isAudioPreviewFile(file: File, path: string): boolean {
  return isAudioFile(path) || file.type.startsWith("audio/");
}

function isVideoPreviewFile(file: File, path: string): boolean {
  return isVideoFile(path) || file.type.startsWith("video/");
}

function imageMimeTypeForPath(path: string): string {
  switch (getExtension(path)) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
    case "avif":
      return "image/avif";
    case "ico":
      return "image/x-icon";
    case "bmp":
      return "image/bmp";
    case "tiff":
    case "tif":
      return "image/tiff";
    default:
      return "";
  }
}

function mediaMimeTypeForPath(path: string): string {
  switch (getExtension(path)) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "ogg":
    case "oga":
      return "audio/ogg";
    case "m4a":
      return "audio/mp4";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "opus":
      return "audio/opus";
    case "weba":
      return "audio/webm";
    case "mp4":
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "ogv":
      return "video/ogg";
    case "avi":
      return "video/x-msvideo";
    case "mkv":
      return "video/x-matroska";
    default:
      return "";
  }
}

function previewTitleForPath(path: string): string {
  return path.split("/").pop() || path || uiCopy.userSpace.defaultFileName;
}

async function normalizeOfficePreviewFile(file: File, path: string): Promise<File> {
  const name = previewTitleForPath(path) || file.name || "document";
  const type = file.type || mimeForOfficeExtension(getExtension(path));
  const normalizedFile =
    file.name === name && file.type === type
      ? file
      : new File([file], name, { type, lastModified: file.lastModified });
  if (getExtension(path) !== "docx") return normalizedFile;
  return normalizeDocxPreviewFonts(normalizedFile, name, type);
}

async function normalizeDocxPreviewFonts(file: File, name: string, type: string): Promise<File> {
  if (file.size > DOCX_PREVIEW_ARCHIVE_LIMITS.compressedBytes) return file;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > DOCX_PREVIEW_ARCHIVE_LIMITS.compressedBytes) return file;
    let entryCount = 0;
    let totalCompressedBytes = 0;
    let totalUncompressedBytes = 0;
    const zipEntries = unzipSync(bytes, {
      // fflate invokes this filter from the central directory before allocating
      // each output buffer, so rejected zip bombs never reach inflateSync.
      filter: ({ size, originalSize }) => {
        entryCount += 1;
        totalCompressedBytes += size;
        totalUncompressedBytes += originalSize;
        if (
          entryCount > DOCX_PREVIEW_ARCHIVE_LIMITS.entryCount ||
          originalSize > DOCX_PREVIEW_ARCHIVE_LIMITS.entryUncompressedBytes ||
          totalUncompressedBytes > DOCX_PREVIEW_ARCHIVE_LIMITS.totalUncompressedBytes ||
          compressionRatio(originalSize, size) > DOCX_PREVIEW_ARCHIVE_LIMITS.compressionRatio ||
          compressionRatio(totalUncompressedBytes, totalCompressedBytes) >
            DOCX_PREVIEW_ARCHIVE_LIMITS.compressionRatio
        ) {
          throw new Error("DOCX preview archive exceeds safe resource limits.");
        }
        return true;
      },
    });
    let changed = false;
    const patchXmlEntry = (entryName: string) => {
      const entry = zipEntries[entryName];
      if (!entry) return;
      const xml = strFromU8(entry);
      const patched = patchDocxCjkFonts(xml);
      if (patched === xml) return;
      zipEntries[entryName] = strToU8(patched);
      changed = true;
    };

    patchXmlEntry("word/document.xml");
    patchXmlEntry("word/styles.xml");
    patchXmlEntry("word/theme/theme1.xml");
    for (const entryName of Object.keys(zipEntries)) {
      if (/^word\/(header|footer|footnotes|endnotes)\d*\.xml$/.test(entryName))
        patchXmlEntry(entryName);
    }

    if (!changed) return file;
    return new File([zipSync(zipEntries)], name, { type, lastModified: file.lastModified });
  } catch {
    return file;
  }
}

function compressionRatio(uncompressedBytes: number, compressedBytes: number): number {
  if (uncompressedBytes === 0) return 0;
  return uncompressedBytes / Math.max(1, compressedBytes);
}

function patchDocxCjkFonts(xml: string): string {
  return xml
    .replace(
      /w:eastAsia="(?:Calibri|Cambria|Arial|Times New Roman|zh-CN|zh-Hans|en-US)"/g,
      'w:eastAsia="宋体"',
    )
    .replace(
      /typeface="(?:Calibri|Cambria|Arial|Times New Roman)"(?=[^>]*script="Hans")/g,
      'typeface="宋体"',
    )
    .replace(
      /script="Hans" typeface="(?:Calibri|Cambria|Arial|Times New Roman|zh-CN|zh-Hans|en-US)"/g,
      'script="Hans" typeface="宋体"',
    );
}

function mimeForOfficeExtension(ext: string): string {
  switch (ext) {
    case "doc":
      return "application/msword";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "odt":
      return "application/vnd.oasis.opendocument.text";
    case "rtf":
      return "application/rtf";
    case "xls":
      return "application/vnd.ms-excel";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "ods":
      return "application/vnd.oasis.opendocument.spreadsheet";
    case "csv":
      return "text/csv";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "odp":
      return "application/vnd.oasis.opendocument.presentation";
    default:
      return "application/octet-stream";
  }
}

function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true;
  let suspicious = 0;
  for (const byte of bytes) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious++;
  }
  return bytes.length > 0 && suspicious / bytes.length > 0.1;
}
