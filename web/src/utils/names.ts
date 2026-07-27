import { uiCopy } from "../ui-copy.js";

export const DEFAULT_SESSION_NAME = uiCopy.session.defaultName;

export function getDefaultSessionName(): string {
  return uiCopy.session.defaultName;
}

export function isPlaceholderSessionName(name: string | undefined): boolean {
  const normalized = name?.trim();
  return !normalized;
}
