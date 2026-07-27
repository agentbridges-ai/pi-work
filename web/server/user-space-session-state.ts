import type { ActiveUserSpace, UserSpaceMount } from "./session-types.js";

export function publicUserSpaceFromMount(
  mount: UserSpaceMount | null | undefined,
): ActiveUserSpace | null {
  if (!mount) return null;
  const {
    name,
    rootName,
    status,
    access,
    canRead,
    canWrite,
    permissionState,
    lastPermissionCheckedAt,
    includeHidden,
    fileCount,
    lastIndexedAt,
  } = mount;
  return {
    name,
    rootName,
    status,
    access,
    canRead,
    canWrite,
    permissionState,
    lastPermissionCheckedAt,
    includeHidden,
    fileCount,
    lastIndexedAt,
  };
}

export function normalizeOfflineUserSpace(
  space: ActiveUserSpace | null | undefined,
): ActiveUserSpace | null {
  if (!space) return null;
  return {
    ...space,
    status: space.status === "mounted" ? "offline" : space.status,
  };
}
