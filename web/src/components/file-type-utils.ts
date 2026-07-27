import {
  USER_SPACE_AUDIO_EXTENSIONS,
  USER_SPACE_IMAGE_EXTENSIONS,
  USER_SPACE_VIDEO_EXTENSIONS,
} from "../user-space-file-types.js";

export function isImageFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return USER_SPACE_IMAGE_EXTENSIONS.has(ext);
}

export function isAudioFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return USER_SPACE_AUDIO_EXTENSIONS.has(ext);
}

export function isVideoFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  return USER_SPACE_VIDEO_EXTENSIONS.has(ext);
}
