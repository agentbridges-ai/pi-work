import type { UserSpaceOperation } from "../server/session-types.js";

/** Operations that can cross the browser File System Access API write boundary. */
export const USER_SPACE_WRITE_OPERATIONS: ReadonlySet<UserSpaceOperation> = new Set([
  "create_entry",
  "rename_entry",
  "copy_entry",
  "copy_entries",
  "duplicate_entry",
  "move_entries",
  "write_file",
  "replace_text",
  "delete_entry",
]);

export function userSpaceOperationRequiresMutationCommit(operation: UserSpaceOperation): boolean {
  // A shell command that looks read-only can still write through redirection,
  // pipelines, or a nested shell. The browser shell parser is authoritative for
  // execution, so the protocol conservatively commits every shell operation.
  return USER_SPACE_WRITE_OPERATIONS.has(operation) || operation === "shell_exec";
}
