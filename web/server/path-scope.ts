import { relative } from "node:path";

export function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.includes(":"));
}
