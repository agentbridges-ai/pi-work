export const USER_SPACE_TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "txt",
  "log",
  "tsv",
  "md",
  "markdown",
  "rst",
  "json",
  "xml",
  "html",
  "htm",
]);

export const USER_SPACE_WORD_EXTENSIONS: ReadonlySet<string> = new Set([
  "doc",
  "docx",
  "odt",
  "rtf",
]);

export const USER_SPACE_SPREADSHEET_EXTENSIONS: ReadonlySet<string> = new Set([
  "xls",
  "xlsx",
  "ods",
  "csv",
]);

export const USER_SPACE_PRESENTATION_EXTENSIONS: ReadonlySet<string> = new Set([
  "ppt",
  "pptx",
  "odp",
]);

export const USER_SPACE_OFFICE_EXTENSIONS: ReadonlySet<string> = new Set([
  ...USER_SPACE_WORD_EXTENSIONS,
  ...USER_SPACE_SPREADSHEET_EXTENSIONS,
  ...USER_SPACE_PRESENTATION_EXTENSIONS,
]);

export const USER_SPACE_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "ico",
  "bmp",
  "tiff",
  "tif",
]);

export const USER_SPACE_AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp3",
  "wav",
  "ogg",
  "oga",
  "m4a",
  "aac",
  "flac",
  "opus",
  "weba",
]);

export const USER_SPACE_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  "mp4",
  "webm",
  "mov",
  "m4v",
  "ogv",
  "avi",
  "mkv",
]);
