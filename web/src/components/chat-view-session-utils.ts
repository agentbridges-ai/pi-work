import type { CurrentUser, UserSpaceCreateMetadata } from "../api.js";
import type {
  ChatMessage,
  InteractionRequest,
  PiRunState,
  PiSessionInfo,
  UserSpaceMount,
} from "../types.js";
import { uiCopy } from "../ui-copy.js";

export type SessionDisplayMeta = {
  isRunning: boolean;
  needsConfirmation: boolean;
  isCompacting: boolean;
};

export function getLifecycleState(session: PiSessionInfo | undefined): "enabled" | "closed" {
  return session?.lifecycleState || (session?.state === "exited" ? "closed" : "enabled");
}

export function getSessionSystemState(
  session: PiSessionInfo | undefined,
  meta: SessionDisplayMeta,
  runtimeConnected = false,
): "active" | "running" | "idle" {
  if (meta.isRunning || meta.needsConfirmation) return "running";
  if (runtimeConnected) return "active";
  return getLifecycleState(session) === "enabled" ? "active" : "idle";
}

export function getUserInitials(user: CurrentUser): string {
  const displayName = user.displayName.trim();
  if (displayName) return Array.from(displayName).slice(0, 2).join("");
  const username = user.username.trim();
  return username ? username.slice(0, 2).toUpperCase() : "U";
}

export function getLastMessageTime(
  messages: ChatMessage[] | undefined,
  session: PiSessionInfo,
): number {
  const lastMessage = messages && messages.length > 0 ? messages[messages.length - 1] : null;
  return lastMessage?.timestamp || session.createdAt || 0;
}

export function formatSessionTime(timestamp: number): string {
  if (!timestamp) return uiCopy.chat.noSessionMessages;
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return uiCopy.chat.now;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 60) return uiCopy.chat.sessionTime.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return uiCopy.chat.sessionTime.hoursAgo(hours);
  const days = Math.floor(hours / 24);
  if (days < 7) return uiCopy.chat.sessionTime.daysAgo(days);
  return new Date(timestamp).toLocaleDateString();
}

export function toUserSpaceMetadata(mounts: UserSpaceMount[]): UserSpaceCreateMetadata | null {
  const mount = mounts[0];
  return mount ? toUserSpaceMetadataItem(mount) : null;
}

export function toUserSpaceMetadataItem(mount: UserSpaceMount): UserSpaceCreateMetadata {
  return {
    mountId: mount.mountId,
    name: mount.name,
    rootName: mount.rootName,
    access: mount.access,
    canRead: mount.canRead,
    canWrite: mount.canWrite,
    permissionState: mount.permissionState,
    lastPermissionCheckedAt: mount.lastPermissionCheckedAt,
    includeHidden: true,
    fileCount: mount.fileCount,
    lastIndexedAt: mount.lastIndexedAt,
  };
}

export function sameUserSpaceMounts(
  left: UserSpaceMount[],
  right: UserSpaceMount[],
  options: { includeStatus?: boolean } = {},
): boolean {
  if (left.length !== right.length) return false;
  const rightById = new Map(right.map((mount) => [mount.mountId, mount]));
  return left.every((mount) => {
    const other = rightById.get(mount.mountId);
    return Boolean(
      other &&
      mount.rootName === other.rootName &&
      mount.name === other.name &&
      mount.access === other.access &&
      mount.canRead === other.canRead &&
      mount.canWrite === other.canWrite &&
      (!options.includeStatus || mount.status === other.status),
    );
  });
}

export function userSpaceSyncKey(mounts: UserSpaceMount[]): string {
  return mounts
    .slice()
    .sort((left, right) => left.mountId.localeCompare(right.mountId))
    .map((mount) => `${mount.mountId}:${mount.status}:${mount.access}`)
    .join("|");
}

export function getSessionDisplayMeta(
  sessionId: string,
  runStateById: Map<string, PiRunState | null>,
  pendingInteractionsById: Map<string, Map<string, InteractionRequest>>,
  runActiveById: Map<string, boolean>,
): SessionDisplayMeta {
  const pendingInteractions = pendingInteractionsById.get(sessionId);
  return {
    isRunning: runActiveById.get(sessionId) === true,
    needsConfirmation: Boolean(pendingInteractions?.size),
    isCompacting: runStateById.get(sessionId) === "compacting",
  };
}

export function getSessionSortPriority(meta: SessionDisplayMeta): number {
  if (meta.isRunning) return 0;
  if (meta.needsConfirmation) return 1;
  return 2;
}
