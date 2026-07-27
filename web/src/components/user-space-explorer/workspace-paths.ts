import { uiCopy } from "../../ui-copy.js";

export function dirnameWorkspacePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

export function normalizeWorkspacePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return "";
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function joinWorkspacePath(base: string, name: string): string {
  return base ? `${base}/${name}` : name;
}

export function validateWorkspaceEntryName(name: string): string {
  const trimmed = name.trim();
  const validationCopy = uiCopy.userSpace.validation;
  if (!trimmed) return validationCopy.emptyName;
  if (trimmed === "." || trimmed === "..") return validationCopy.invalidDots;
  if (/[\\/]/.test(trimmed)) return validationCopy.pathSeparator;
  if (trimmed.includes("\0")) return validationCopy.invalidCharacters;
  if (trimmed.length > 255) return validationCopy.tooLong;
  return "";
}

export function splitWorkspaceFileNameForRename(name: string): { stem: string; extension: string } {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === name.length - 1) return { stem: name, extension: "" };
  return {
    stem: name.slice(0, dotIndex),
    extension: name.slice(dotIndex),
  };
}

export function getExtension(path: string): string {
  const name = (path.split("/").pop() || "").toLowerCase();
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : name;
}

export function parentDirectoryPaths(path: string): string[] {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  const parents: string[] = [];
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    parents.push(current);
  }
  return parents;
}
