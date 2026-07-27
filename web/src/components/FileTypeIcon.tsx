import { Icon, addIcon } from "@iconify/react/offline";
import { MATERIAL_FILE_ICONS } from "./iconify-material-file-icons.js";

const PAPERWORK_ICONS = new Set([
  "audio",
  "changelog",
  "document",
  "html",
  "image",
  "license",
  "lock",
  "log",
  "markdown",
  "pdf",
  "powerpoint",
  "readme",
  "svg",
  "table",
  "video",
  "word",
  "xml",
  "zip",
]);

for (const name of PAPERWORK_ICONS) {
  const icon = MATERIAL_FILE_ICONS[name];
  if (icon) addIcon(`material-icon-theme:${name}`, icon);
}

type FileTypeIconProps = {
  path?: string;
  fileIcon?: string;
  officeIcon?: string;
  className?: string;
  "aria-hidden"?: boolean;
  "data-file-icon"?: string;
  "data-folder-state"?: string;
  "data-office-icon"?: string;
};

const KIND_ICONS: Record<string, string> = {
  archive: "zip",
  audio: "audio",
  file: "document",
  html: "html",
  image: "image",
  markdown: "markdown",
  pdf: "pdf",
  presentation: "powerpoint",
  spreadsheet: "table",
  text: "document",
  video: "video",
  word: "word",
};

const FILE_NAME_ICONS: Record<string, string> = {
  changelog: "changelog",
  "changelog.md": "changelog",
  license: "license",
  "license.md": "license",
  readme: "readme",
  "readme.md": "readme",
};

const EXTENSION_ICONS: Record<string, string> = {
  "7z": "zip",
  aac: "audio",
  avi: "video",
  avif: "image",
  bmp: "image",
  bz2: "zip",
  csv: "table",
  doc: "word",
  docx: "word",
  epub: "document",
  flac: "audio",
  gif: "image",
  gz: "zip",
  htm: "html",
  html: "html",
  ico: "image",
  jpeg: "image",
  jpg: "image",
  log: "log",
  m4a: "audio",
  m4v: "video",
  markdown: "markdown",
  md: "markdown",
  mkv: "video",
  mov: "video",
  mp3: "audio",
  mp4: "video",
  oga: "audio",
  ogg: "audio",
  ogv: "video",
  odp: "powerpoint",
  ods: "table",
  odt: "word",
  opus: "audio",
  pdf: "pdf",
  png: "image",
  ppt: "powerpoint",
  pptx: "powerpoint",
  rar: "zip",
  rst: "document",
  rtf: "word",
  svg: "svg",
  tar: "zip",
  tgz: "zip",
  tif: "image",
  tiff: "image",
  tsv: "table",
  txt: "document",
  wav: "audio",
  weba: "audio",
  webm: "video",
  webp: "image",
  xls: "table",
  xlsx: "table",
  xml: "xml",
  zip: "zip",
};

export function FileTypeIcon({
  path,
  fileIcon,
  officeIcon,
  className = "h-5 w-5 shrink-0",
  "aria-hidden": ariaHidden = true,
  "data-file-icon": dataFileIcon,
  "data-folder-state": dataFolderState,
  "data-office-icon": dataOfficeIcon,
}: FileTypeIconProps) {
  const iconifyName = iconifyNameForPath(path || "", officeIcon || fileIcon);
  return (
    <Icon
      icon={iconifyName}
      className={className}
      aria-hidden={ariaHidden}
      data-iconify-icon={iconifyName}
      data-file-icon={fileIcon || dataFileIcon || iconifyName}
      data-folder-state={dataFolderState}
      data-office-icon={officeIcon || dataOfficeIcon}
    />
  );
}

function iconifyNameForPath(path: string, kind?: string): string {
  const name = getFileName(path);
  const extensionIcon = EXTENSION_ICONS[getExtension(name)];
  const iconName = FILE_NAME_ICONS[name] || extensionIcon || (kind ? KIND_ICONS[kind] : undefined);
  return materialIcon(iconName || "document");
}

function materialIcon(iconName: string): string {
  const existingIcon = PAPERWORK_ICONS.has(iconName) ? iconName : "document";
  return `material-icon-theme:${existingIcon}`;
}

function getFileName(path: string): string {
  return (path.split("/").pop() || path).toLowerCase();
}

function getExtension(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot >= 0 ? path.slice(dot + 1) : path;
}
