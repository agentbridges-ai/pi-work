import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Hono } from "hono";
import type {
  ActiveUserSpace,
  BrowserIncomingMessage,
  UserSpaceAccess,
  UserSpaceMount,
  UserSpaceOperation,
} from "./session-types.js";
import { ENV, environment } from "./environment.js";
import { isPathInside, writeScopedFileNoFollow } from "./path-policy.js";
import { publicUserSpaceFromMount } from "./user-space-session-state.js";
import type { DiskReservation, UserDiskQuota } from "./user-disk-quota.js";
import { releaseReaderLockBestEffort } from "./web-stream-compat.js";
import {
  USER_SPACE_WRITE_OPERATIONS,
  userSpaceOperationRequiresMutationCommit,
} from "../shared/user-space-mutation-policy.js";

const REQUEST_TIMEOUT_MS = environment.number(ENV.PIWORK_USER_SPACE_TIMEOUT_MS, 30_000);
const TRANSFER_TIMEOUT_MS = environment.number(ENV.PIWORK_USER_SPACE_TRANSFER_TIMEOUT_MS, 120_000);
const RUNTIME_DRAIN_TIMEOUT_MS = Math.max(1, Math.min(10_000, TRANSFER_TIMEOUT_MS));
const MAX_TRANSFER_BYTES = Math.max(
  1,
  Math.floor(environment.number(ENV.PIWORK_USER_SPACE_MAX_TRANSFER_BYTES, 256 * 1024 * 1024)),
);
const CLI_OPERATIONS = new Set<UserSpaceOperation>([
  "read_file",
  "shell_exec",
  "write_file",
  "replace_text",
]);
interface PendingRequest {
  operation: UserSpaceOperation;
  mountId: string;
  runtimeEpoch: string;
  requiresCommit: boolean;
  commitLease?: string;
  authorizedSocket?: object;
  terminal: boolean;
  settled: Promise<void>;
  markSettled: () => void;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  createdAt: number;
}

interface MutationCommitAuthorization {
  commitLease: string;
  runtimeEpoch: string;
}

interface WorkspaceSessionState {
  token: string;
  runtimeEpoch: string;
  mounts: Map<string, UserSpaceMount>;
  pending: Map<string, PendingRequest>;
}

export interface UserSpaceInternalCapabilityLease {
  readonly sessionId: string;
  readonly token: string;
  readonly runtimeEpoch: string;
}

interface PendingCheckoutUpload {
  size: number;
  hash: string;
  writtenAt: number;
}

interface PendingTransferBase {
  id: string;
  token: string;
  sessionId: string;
  mountId: string;
  path: string;
  timer?: ReturnType<typeof setTimeout>;
  createdAt: number;
  sandboxGeneration: number;
  runtimeEpoch: string;
  terminal: boolean;
  cleanupError?: Error;
  settled: Promise<void>;
  markSettled: () => void;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingCheckoutTransfer extends PendingTransferBase {
  kind: "checkout";
  localPath: string;
  upload?: PendingCheckoutUpload;
}

interface PendingCheckinTransfer extends PendingTransferBase {
  kind: "checkin";
  tempPath: string;
  size: number;
  hash: string;
  baseHash: string;
  baseMtime?: number;
  create?: boolean;
  downloadedAt?: number;
  commitLease?: string;
}

type PendingTransfer = PendingCheckoutTransfer | PendingCheckinTransfer;

function isAuthorizedCheckinTransfer(
  transfer: PendingTransfer,
): transfer is PendingCheckinTransfer & { commitLease: string } {
  return transfer.kind === "checkin" && Boolean(transfer.commitLease);
}

interface RuntimeDrainEntry {
  settled: Promise<void>;
  cleanupError: () => Error | undefined;
}

function isAuthorizedMutationRequest(
  pending: PendingRequest,
): pending is PendingRequest & { commitLease: string; authorizedSocket: object } {
  return Boolean(pending.requiresCommit && pending.commitLease && pending.authorizedSocket);
}

function capabilityEquals(expected: string, actual: string | undefined): boolean {
  if (!actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function cloneMount(mount: UserSpaceMount): UserSpaceMount {
  return { ...mount };
}

function normalizeAccess(value: unknown): UserSpaceAccess {
  return value === "readonly" ? "readonly" : "readwrite";
}

function deriveCanRead(mount: Pick<UserSpaceMount, "status"> & Partial<UserSpaceMount>): boolean {
  return mount.canRead ?? (mount.permissionState === "granted" || mount.status === "mounted");
}

function deriveCanWrite(
  mount: Pick<UserSpaceMount, "status" | "access"> & Partial<UserSpaceMount>,
): boolean {
  if (mount.access !== "readwrite") return false;
  if (mount.canWrite !== undefined) return mount.canWrite;
  return mount.permissionState === "granted" || mount.status === "mounted";
}

function normalizeExpectedMount(
  mount: Omit<UserSpaceMount, "status"> & { status?: UserSpaceMount["status"] },
): UserSpaceMount {
  const access = normalizeAccess(mount.access);
  const status = mount.status || "expected";
  return {
    mountId: mount.mountId,
    name: mount.name || mount.rootName || "user-space",
    rootName: mount.rootName || mount.name || "user-space",
    status,
    access,
    canRead: deriveCanRead({ ...mount, status, access }),
    canWrite: deriveCanWrite({ ...mount, status, access }),
    permissionState: mount.permissionState || (status === "mounted" ? "granted" : "unknown"),
    lastPermissionCheckedAt: mount.lastPermissionCheckedAt,
    includeHidden: true,
    fileCount: mount.fileCount,
    lastIndexedAt: mount.lastIndexedAt,
  };
}

function selectActiveMount(
  mounts: Array<Omit<UserSpaceMount, "status"> & { status?: UserSpaceMount["status"] }>,
  preferredMountId?: string,
): UserSpaceMount | null {
  const normalized = mounts
    .filter((mount) => typeof mount.mountId === "string" && mount.mountId.trim())
    .map((mount) => normalizeExpectedMount(mount));
  if (normalized.length === 0) return null;
  const preferred = preferredMountId
    ? normalized.find((mount) => mount.mountId === preferredMountId)
    : undefined;
  if (preferred) return preferred;
  return (
    [...normalized].sort((left, right) => {
      if (left.status !== right.status) {
        if (left.status === "mounted") return -1;
        if (right.status === "mounted") return 1;
        if (left.status === "expected") return -1;
        if (right.status === "expected") return 1;
      }
      const leftSeen = Math.max(left.lastPermissionCheckedAt || 0, left.lastIndexedAt || 0);
      const rightSeen = Math.max(right.lastPermissionCheckedAt || 0, right.lastIndexedAt || 0);
      return rightSeen - leftSeen;
    })[0] || null
  );
}

function normalizeSessionMounts(
  mounts: Array<Omit<UserSpaceMount, "status"> & { status?: UserSpaceMount["status"] }>,
  preferredMountId?: string,
): UserSpaceMount[] {
  const normalized = mounts
    .filter((mount) => typeof mount.mountId === "string" && mount.mountId.trim())
    .map((mount) => normalizeExpectedMount(mount));
  const active = selectActiveMount(normalized, preferredMountId);
  if (!active) return normalized;
  return [active, ...normalized.filter((mount) => mount.mountId !== active.mountId)];
}

export class UserSpaceBroker {
  private sessions = new Map<string, WorkspaceSessionState>();
  private transfers = new Map<string, PendingTransfer>();
  private sender: ((sessionId: string, message: BrowserIncomingMessage) => void) | null = null;
  private stagedCheckoutGenerations = new Map<string, number>();
  private stagingWork = new Map<string, Set<Promise<void>>>();

  constructor(
    private readonly checkoutRootForSession?: (sessionId: string) => string,
    private readonly privateStagingGeneration: (sessionId: string) => number | undefined = () =>
      undefined,
    private readonly diskQuota?: UserDiskQuota,
  ) {}

  setSender(sender: (sessionId: string, message: BrowserIncomingMessage) => void): void {
    this.sender = sender;
  }

  configureSession(
    sessionId: string,
    mounts?: Array<Omit<UserSpaceMount, "status"> & { status?: UserSpaceMount["status"] }>,
    preferredMountId?: string,
  ): { token: string; mounts: UserSpaceMount[]; user_space: ActiveUserSpace | null } {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        token: randomUUID(),
        runtimeEpoch: randomUUID(),
        mounts: new Map(),
        pending: new Map(),
      };
      this.sessions.set(sessionId, state);
    }
    if (mounts !== undefined) {
      const explicitPreferredMountId = preferredMountId?.trim();
      if (
        explicitPreferredMountId &&
        !mounts.some((mount) => mount.mountId === explicitPreferredMountId)
      ) {
        throw new Error(`Unknown active user-space directory: ${explicitPreferredMountId}`);
      }
      const nextMounts = new Map<string, UserSpaceMount>();
      for (const mount of normalizeSessionMounts(
        mounts,
        explicitPreferredMountId || this.getActiveMount(sessionId)?.mountId,
      )) {
        nextMounts.set(mount.mountId, mount);
      }
      for (const [requestId, pending] of state.pending) {
        // A browser that already received a commit lease may be inside native
        // createWritable/write/close. Preserve that exact critical section so
        // runtime revocation can still drain its authenticated terminal result.
        if (isAuthorizedMutationRequest(pending)) continue;
        if (pending.timer) clearTimeout(pending.timer);
        this.rejectPendingRequest(
          state,
          requestId,
          pending,
          new Error("user-space configuration changed; retry the request."),
        );
      }
      state.mounts = nextMounts;
    }
    return {
      token: state.token,
      mounts: this.getMounts(sessionId),
      user_space: this.getActiveUserSpace(sessionId),
    };
  }

  getToken(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.token;
  }

  /**
   * Rotate the bearer capability used by the session-local CLI bridge. The
   * capability is runtime-only and changes for every Pi launch/relaunch so
   * an orphaned old process cannot keep calling the current session broker.
   */
  issueInternalCapability(sessionId: string): string {
    this.configureSession(sessionId);
    const draining = this.beginRuntimeRevocation(
      sessionId,
      "User Space runtime generation was replaced.",
    );
    if (draining.length > 0) {
      throw new Error("A User Space commit is still draining; retry the launch.");
    }
    const state = this.sessions.get(sessionId)!;
    return state.token;
  }

  validateInternalCapability(sessionId: string, token: string): boolean {
    const expected = this.sessions.get(sessionId)?.token;
    if (!expected || !token) return false;
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(token);
    return (
      expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes)
    );
  }

  captureInternalCapability(
    sessionId: string,
    token: string,
  ): UserSpaceInternalCapabilityLease | null {
    if (!this.validateInternalCapability(sessionId, token)) return null;
    const runtimeEpoch = this.sessions.get(sessionId)?.runtimeEpoch;
    if (!runtimeEpoch) return null;
    return { sessionId, token, runtimeEpoch };
  }

  validateInternalCapabilityLease(lease: UserSpaceInternalCapabilityLease): boolean {
    const state = this.sessions.get(lease.sessionId);
    return (
      state?.runtimeEpoch === lease.runtimeEpoch &&
      this.validateInternalCapability(lease.sessionId, lease.token)
    );
  }

  async requestInternalOperation(
    lease: UserSpaceInternalCapabilityLease,
    operation: UserSpaceOperation,
    input: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (!this.validateInternalCapabilityLease(lease)) {
      throw new Error("Invalid or expired user-space capability.");
    }
    const result = await this.requestOperation(lease.sessionId, operation, input);
    if (!this.validateInternalCapabilityLease(lease)) {
      throw new Error("Invalid or expired user-space capability.");
    }
    return result;
  }

  revokeInternalCapability(sessionId: string): void {
    this.beginRuntimeRevocation(sessionId, "User Space runtime capability was revoked.");
  }

  /**
   * Revoke a Pi runtime generation synchronously, then wait (with a hard
   * bound) for private staging cleanup and any browser commit that crossed its
   * authorization point of no return. The old runtime capability is invalid
   * immediately even while that browser terminal acknowledgement is draining.
   */
  async revokeRuntimeGeneration(sessionId: string, reason: string): Promise<void> {
    const draining = this.beginRuntimeRevocation(sessionId, reason);
    await this.waitForRuntimeDrain(draining);
  }

  removeSession(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (state) {
      if ([...state.pending.values()].some(isAuthorizedMutationRequest)) {
        throw new Error(
          "Cannot remove a User Space session while an authorized browser mutation is still draining.",
        );
      }
      for (const [requestId, pending] of state.pending) {
        this.rejectPendingRequest(
          state,
          requestId,
          pending,
          new Error("user-space session was removed."),
        );
      }
      this.sessions.delete(sessionId);
    }
    for (const transfer of [...this.transfers.values()]) {
      if (transfer.sessionId === sessionId) {
        this.rejectTransfer(transfer, new Error("user-space session was removed."));
      }
    }
    const checkoutRoot = resolve(this.getSessionCheckoutRoot(sessionId));
    for (const localPath of this.stagedCheckoutGenerations.keys()) {
      if (isPathInside(checkoutRoot, resolve(localPath))) {
        this.stagedCheckoutGenerations.delete(localPath);
        void this.trackStagingWork(
          sessionId,
          removeStagedEntryNoFollow(localPath, checkoutRoot).catch(() => undefined),
        );
      }
    }
  }

  getMounts(sessionId: string): UserSpaceMount[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    return Array.from(state.mounts.values()).map(cloneMount);
  }

  getActiveMount(sessionId: string): UserSpaceMount | null {
    return this.getMounts(sessionId)[0] || null;
  }

  getActiveUserSpace(sessionId: string): ActiveUserSpace | null {
    const mount = this.getActiveMount(sessionId);
    return mount ? publicUserSpaceFromMount(mount) : null;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  updateMounts(sessionId: string, mounts: UserSpaceMount[]): UserSpaceMount[] {
    this.configureSession(sessionId);
    const state = this.sessions.get(sessionId)!;
    state.mounts = new Map(
      normalizeSessionMounts(mounts, this.getActiveMount(sessionId)?.mountId).map((mount) => [
        mount.mountId,
        mount,
      ]),
    );
    return this.getMounts(sessionId);
  }

  unmount(sessionId: string, mountId: string): UserSpaceMount[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    const existing = state.mounts.get(mountId);
    if (existing) {
      state.mounts.set(mountId, { ...existing, status: "offline" });
    }
    return this.getMounts(sessionId);
  }

  updateIndex(
    sessionId: string,
    mountId: string | undefined,
    fileCount: number,
    lastIndexedAt: number,
  ): UserSpaceMount[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    const active = this.getActiveMount(sessionId);
    const existing = state.mounts.get(mountId || active?.mountId || "");
    if (existing) {
      state.mounts.set(existing.mountId, {
        ...existing,
        fileCount,
        lastIndexedAt,
        status: existing.status === "expected" ? "mounted" : existing.status,
      });
    }
    return this.getMounts(sessionId);
  }

  markOffline(sessionId: string): UserSpaceMount[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    for (const [mountId, mount] of state.mounts) {
      if (mount.status === "mounted") {
        state.mounts.set(mountId, { ...mount, status: "offline" });
      }
    }
    for (const [requestId, pending] of state.pending) {
      if (isAuthorizedMutationRequest(pending)) continue;
      if (pending.timer) clearTimeout(pending.timer);
      this.rejectPendingRequest(
        state,
        requestId,
        pending,
        new Error("user-space is offline; reconnect the browser and re-authorize the folder."),
      );
    }
    for (const transfer of Array.from(this.transfers.values())) {
      if (transfer.sessionId !== sessionId) continue;
      // Commit authorization is the point of no return for a browser-backed
      // native filesystem write. Keep that critical section alive so a later
      // runtime revocation can drain its terminal acknowledgement truthfully.
      if (isAuthorizedCheckinTransfer(transfer)) continue;
      this.rejectTransfer(
        transfer,
        new Error("user-space is offline; reconnect the browser and re-authorize the folder."),
      );
    }
    return this.getMounts(sessionId);
  }

  authorizeMutationCommit(
    sessionId: string,
    requestId: string,
    browserSocket: object,
  ): MutationCommitAuthorization {
    const state = this.sessions.get(sessionId);
    const pending = state?.pending.get(requestId);
    if (!state || !pending || pending.terminal) {
      throw new Error("Unknown or expired User Space mutation request.");
    }
    if (!pending.requiresCommit) {
      throw new Error("User Space request does not require mutation authorization.");
    }
    if (pending.runtimeEpoch !== state.runtimeEpoch) {
      throw new Error("User Space request belongs to a revoked runtime generation.");
    }
    if (pending.commitLease || pending.authorizedSocket) {
      if (
        pending.commitLease &&
        pending.authorizedSocket === browserSocket &&
        pending.runtimeEpoch === state.runtimeEpoch
      ) {
        // The targeted authorization response can be lost. The same socket may
        // retry and receives the same capability; no second commit is granted.
        return { commitLease: pending.commitLease, runtimeEpoch: pending.runtimeEpoch };
      }
      throw new Error("User Space mutation was authorized to another browser connection.");
    }

    // Re-check mutable mount authority at the point immediately before the
    // browser may enter an uninterruptible native filesystem mutation. Shell
    // requests retain read-only compatibility; the browser FS layer still
    // enforces read/write permission before any shell write.
    this.requireMountedMount(
      sessionId,
      pending.mountId,
      pending.operation === "shell_exec" ? "read" : "write",
    );
    pending.commitLease = randomUUID();
    pending.authorizedSocket = browserSocket;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = undefined;
    return { commitLease: pending.commitLease, runtimeEpoch: pending.runtimeEpoch };
  }

  handleResponse(
    sessionId: string,
    requestId: string,
    ok: boolean,
    result?: unknown,
    error?: string,
    browserSocket?: object,
    commitLease?: string,
    runtimeEpoch?: string,
  ): boolean {
    const state = this.sessions.get(sessionId);
    const pending = state?.pending.get(requestId);
    if (!state || !pending || pending.terminal) return false;
    if (pending.requiresCommit) {
      if (
        !isAuthorizedMutationRequest(pending) ||
        pending.authorizedSocket !== browserSocket ||
        !capabilityEquals(pending.commitLease, commitLease) ||
        !capabilityEquals(pending.runtimeEpoch, runtimeEpoch)
      ) {
        return false;
      }
    }
    this.settlePendingRequest(state, requestId, pending);
    if (ok) {
      pending.resolve(result);
    } else {
      pending.reject(new Error(error || "user-space request failed"));
    }
    return true;
  }

  async requestOperation(
    sessionId: string,
    operation: UserSpaceOperation,
    input: Record<string, unknown> = {},
  ): Promise<unknown> {
    if (operation === "list_mounts") {
      return {
        user_space: this.getActiveUserSpace(sessionId),
        mounts: this.getMounts(sessionId),
      };
    }
    return this.requestBrowser(sessionId, operation, input);
  }

  requestBlobCheckout(
    sessionId: string,
    input: { mountId?: string; path: string; out?: string },
  ): Promise<unknown> {
    const sandboxGeneration = this.requirePrivateStagingGeneration(sessionId);
    const mount = this.requireMountedMount(sessionId, input.mountId, "read");
    const runtimeEpoch = this.requireRuntimeEpoch(sessionId);
    const path = normalizeWorkspacePath(input.path, { requireFile: true });
    const localPath = this.resolveCheckoutPath(
      sessionId,
      mount.mountId,
      path,
      input.out || join(sanitizePathSegment(mount.mountId), randomUUID(), path),
    );
    const transfer = this.createTransfer<PendingCheckoutTransfer>({
      kind: "checkout",
      sessionId,
      mountId: mount.mountId,
      path,
      localPath,
      sandboxGeneration,
      runtimeEpoch,
    });
    this.sender?.(sessionId, {
      type: "user_space_blob_checkout_request",
      transfer_id: transfer.id,
      mountId: mount.mountId,
      path,
      uploadUrl: buildPublicTransferUrl(
        sessionId,
        `/blob/checkout/${transfer.id}/upload`,
        transfer.token,
      ),
      completeUrl: buildPublicTransferUrl(
        sessionId,
        `/blob/${transfer.id}/complete`,
        transfer.token,
      ),
      maxBytes: MAX_TRANSFER_BYTES,
    });
    return new Promise((resolve, reject) => {
      transfer.resolve = (value) =>
        resolve({
          ...(value && typeof value === "object" ? (value as Record<string, unknown>) : {}),
          mountId: mount.mountId,
          path,
          localPath,
          access: mount.access,
        });
      transfer.reject = reject;
    });
  }

  async requestBlobCheckin(
    sessionId: string,
    input: {
      mountId?: string;
      path: string;
      baseHash?: string;
      baseMtime?: number;
      body: Uint8Array;
      create?: boolean;
    },
  ): Promise<unknown> {
    const sandboxGeneration = this.requirePrivateStagingGeneration(sessionId);
    const mount = this.requireMountedMount(sessionId, input.mountId, "write");
    const runtimeEpoch = this.requireRuntimeEpoch(sessionId);
    const path = normalizeWorkspacePath(input.path, { requireFile: true });
    if (!input.create && !input.baseHash) throw new Error("baseHash is required for blob checkin.");
    assertTransferSize(input.body.byteLength);

    const tempPath = join(
      this.getSessionCheckoutRoot(sessionId),
      ".pending-checkins",
      `${randomUUID()}.blob`,
    );
    const checkoutRoot = this.getSessionCheckoutRoot(sessionId);
    await this.trackStagingWork(
      sessionId,
      this.writeReservedStagingFile(tempPath, checkoutRoot, input.body, () => {
        if (sandboxGeneration !== this.privateStagingGeneration(sessionId)) {
          throw new Error("User Space transfer belongs to an expired sandbox generation.");
        }
        if (runtimeEpoch !== this.sessions.get(sessionId)?.runtimeEpoch) {
          throw new Error("User Space transfer belongs to a revoked runtime generation.");
        }
      }),
    );
    const hash = sha256(input.body);
    const transfer = this.createTransfer<PendingCheckinTransfer>({
      kind: "checkin",
      sessionId,
      mountId: mount.mountId,
      path,
      tempPath,
      size: input.body.byteLength,
      hash,
      baseHash: input.baseHash || "",
      baseMtime: input.baseMtime,
      create: input.create === true,
      sandboxGeneration,
      runtimeEpoch,
    });
    this.sender?.(sessionId, {
      type: "user_space_blob_checkin_request",
      transfer_id: transfer.id,
      mountId: mount.mountId,
      path,
      baseHash: input.baseHash,
      baseMtime: input.baseMtime,
      create: input.create === true,
      size: input.body.byteLength,
      hash,
      downloadUrl: buildPublicTransferUrl(
        sessionId,
        `/blob/checkin/${transfer.id}/download`,
        transfer.token,
      ),
      commitUrl: buildPublicTransferUrl(
        sessionId,
        `/blob/checkin/${transfer.id}/commit`,
        transfer.token,
      ),
      completeUrl: buildPublicTransferUrl(
        sessionId,
        `/blob/${transfer.id}/complete`,
        transfer.token,
      ),
    });
    return new Promise((resolve, reject) => {
      transfer.resolve = (value) =>
        resolve({
          ...(value && typeof value === "object" ? (value as Record<string, unknown>) : {}),
          mountId: mount.mountId,
          path,
          size: input.body.byteLength,
          hash,
          access: mount.access,
        });
      transfer.reject = reject;
    });
  }

  async handleCheckoutUpload(
    sessionId: string,
    transferId: string,
    token: string,
    body: Uint8Array,
  ): Promise<unknown> {
    const transfer = this.requireTransfer<PendingCheckoutTransfer>(
      sessionId,
      transferId,
      token,
      "checkout",
    );
    if (transfer.upload) throw new Error("Checkout upload token was already used.");
    assertTransferSize(body.byteLength);
    const checkoutRoot = this.getSessionCheckoutRoot(sessionId);
    try {
      await this.trackStagingWork(
        sessionId,
        this.writeReservedStagingFile(transfer.localPath, checkoutRoot, body, () => {
          if (transfer.sandboxGeneration !== this.privateStagingGeneration(sessionId)) {
            throw new Error("User Space transfer belongs to an expired sandbox generation.");
          }
          if (transfer.runtimeEpoch !== this.sessions.get(sessionId)?.runtimeEpoch) {
            throw new Error("User Space transfer belongs to a revoked runtime generation.");
          }
        }),
      );
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (this.transfers.get(transfer.id) === transfer) this.rejectTransfer(transfer, failure);
      throw failure;
    }
    transfer.upload = { size: body.byteLength, hash: sha256(body), writtenAt: Date.now() };
    return { ok: true, size: transfer.upload.size, hash: transfer.upload.hash };
  }

  /**
   * Consume a browser checkout through one no-follow descriptor, validating
   * the browser-recorded size and hash immediately before use. The staging
   * entry is removed on both success and failure.
   */
  async consumeBlobCheckout(
    sessionId: string,
    input: { localPath: string; expectedSize?: number; expectedHash?: string },
  ): Promise<Uint8Array> {
    const root = this.getSessionCheckoutRoot(sessionId);
    const localPath = resolvePathInsideCheckoutRoot(root, input.localPath);
    const expectedGeneration = this.stagedCheckoutGenerations.get(localPath);
    const currentGeneration = this.requirePrivateStagingGeneration(sessionId);
    if (expectedGeneration === undefined || expectedGeneration !== currentGeneration) {
      this.stagedCheckoutGenerations.delete(localPath);
      await removeStagedEntryNoFollow(localPath, root).catch(() => undefined);
      throw new Error("User Space checkout belongs to an expired sandbox generation.");
    }
    let value: Uint8Array | undefined;
    let operationError: unknown;
    try {
      value = await readStagedFileNoFollow(localPath, root, {
        expectedSize: input.expectedSize,
        expectedHash: input.expectedHash,
      });
    } catch (error) {
      operationError = error;
    }

    let cleanupError: unknown;
    try {
      await removeStagedEntryNoFollow(localPath, root);
    } catch (error) {
      cleanupError = error;
    }
    this.stagedCheckoutGenerations.delete(localPath);
    if (operationError) throw operationError;
    if (cleanupError) throw cleanupError;
    if (!value) throw new Error("Browser checkout did not provide file bytes.");
    return value;
  }

  async handleCheckinDownload(
    sessionId: string,
    transferId: string,
    token: string,
  ): Promise<Response> {
    const transfer = this.requireTransfer<PendingCheckinTransfer>(
      sessionId,
      transferId,
      token,
      "checkin",
    );
    const body = await readStagedFileNoFollow(
      transfer.tempPath,
      this.getSessionCheckoutRoot(sessionId),
      { expectedSize: transfer.size, expectedHash: transfer.hash },
    );
    transfer.downloadedAt = Date.now();
    return new Response(Buffer.from(body), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(transfer.size),
        "X-Piwork-Workspace-Hash": transfer.hash,
      },
    });
  }

  authorizeCheckinCommit(sessionId: string, transferId: string, token: string): unknown {
    const transfer = this.requireTransfer<PendingCheckinTransfer>(
      sessionId,
      transferId,
      token,
      "checkin",
    );
    if (transfer.commitLease) {
      // The first response may be lost after the server crossed the
      // authorization point. Returning the same lease makes a retry
      // idempotent without granting a second commit capability.
      return { ok: true, commitLease: transfer.commitLease };
    }
    if (!transfer.downloadedAt) {
      throw new Error("Checkin bytes must be downloaded before commit authorization.");
    }
    this.revalidateCheckinCommit(transfer);
    transfer.commitLease = randomUUID();
    if (transfer.timer) clearTimeout(transfer.timer);
    // An authorized commit is a cross-process critical section. Expiring the
    // lease while createWritable/write/close is in flight can report failure
    // after the browser has already changed the file. Its lifetime therefore
    // ends only at the authenticated terminal completion endpoint. Runtime
    // revocation applies its own bounded, fail-closed drain timeout.
    transfer.timer = undefined;
    return { ok: true, commitLease: transfer.commitLease };
  }

  handleTransferComplete(
    sessionId: string,
    transferId: string,
    token: string,
    result: Record<string, unknown>,
  ): unknown {
    const transfer = this.requireTransfer(sessionId, transferId, token, undefined, {
      allowAuthorizedCheckinTerminal: true,
    });
    if (
      transfer.kind === "checkin" &&
      transfer.commitLease &&
      result.commitLease !== transfer.commitLease
    ) {
      throw new Error("Invalid or expired User Space commit lease.");
    }
    if (result.ok === false) {
      const message =
        typeof result.error === "string"
          ? result.error
          : "Browser failed the user-space blob transfer.";
      this.rejectTransfer(transfer, new Error(message));
      return { ok: false };
    }

    if (transfer.kind === "checkout") {
      if (!transfer.upload) throw new Error("Checkout upload has not completed.");
      this.resolveTransfer(transfer, {
        ok: true,
        size: transfer.upload.size,
        hash: transfer.upload.hash,
        baseHash: transfer.upload.hash,
        mtime: typeof result.mtime === "number" ? result.mtime : undefined,
        baseMtime: typeof result.mtime === "number" ? result.mtime : undefined,
        mime: typeof result.mime === "string" ? result.mime : undefined,
      });
      return { ok: true };
    }

    if (!transfer.commitLease || result.commitLease !== transfer.commitLease) {
      throw new Error("Checkin was not authorized for commit.");
    }
    if (result.size !== transfer.size || result.hash !== transfer.hash) {
      const error = new Error(
        "Browser checkin completion did not match the authorized size/hash manifest.",
      );
      this.rejectTransfer(transfer, error);
      throw error;
    }
    this.resolveTransfer(transfer, {
      ok: true,
      bytesWritten: transfer.size,
      hash: transfer.hash,
      mtime: typeof result.mtime === "number" ? result.mtime : undefined,
    });
    return { ok: true };
  }

  private requestBrowser(
    sessionId: string,
    operation: UserSpaceOperation,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error("No user-space is configured for this session.");
    if (!this.sender)
      throw new Error("user-space broker is not connected to the WebSocket bridge.");

    const mount = this.requireMountedMount(
      sessionId,
      typeof input.mountId === "string" ? input.mountId : undefined,
      USER_SPACE_WRITE_OPERATIONS.has(operation) ? "write" : "read",
    );
    const privateInput: Record<string, unknown> = { ...input, mountId: mount.mountId };
    if (operation === "shell_exec") privateInput.__sessionId = sessionId;
    if (typeof privateInput.path === "string") {
      privateInput.path = normalizeWorkspacePath(privateInput.path);
    }

    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      let markSettled: () => void = () => undefined;
      const settled = new Promise<void>((settle) => {
        markSettled = settle;
      });
      const requestedShellTimeout =
        operation === "shell_exec" && typeof input.timeoutMs === "number"
          ? input.timeoutMs
          : undefined;
      const responseTimeout =
        operation === "shell_exec"
          ? requestedShellTimeout === undefined
            ? undefined
            : Math.min(2_147_483_647, Math.max(1, requestedShellTimeout + 5_000))
          : REQUEST_TIMEOUT_MS;
      const pending: PendingRequest = {
        operation,
        mountId: mount.mountId,
        runtimeEpoch: state.runtimeEpoch,
        requiresCommit: userSpaceOperationRequiresMutationCommit(operation),
        terminal: false,
        settled,
        markSettled,
        resolve,
        reject,
        createdAt: Date.now(),
      };
      pending.timer =
        responseTimeout === undefined
          ? undefined
          : setTimeout(() => {
              const current = state.pending.get(requestId);
              if (!current || current !== pending || isAuthorizedMutationRequest(current)) return;
              this.rejectPendingRequest(
                state,
                requestId,
                current,
                new Error(`Timed out waiting for browser user-space response (${operation}).`),
              );
            }, responseTimeout);
      state.pending.set(requestId, pending);
      this.sender?.(
        sessionId,
        pending.requiresCommit
          ? {
              type: "user_space_mutation_request",
              request_id: requestId,
              operation,
              input: privateInput,
              requires_commit: true,
            }
          : {
              type: "user_space_request",
              request_id: requestId,
              operation,
              input: privateInput,
            },
      );
    });
  }

  private settlePendingRequest(
    state: WorkspaceSessionState,
    requestId: string,
    pending: PendingRequest,
  ): void {
    if (pending.terminal) return;
    pending.terminal = true;
    if (pending.timer) clearTimeout(pending.timer);
    if (state.pending.get(requestId) === pending) state.pending.delete(requestId);
    pending.markSettled();
  }

  private rejectPendingRequest(
    state: WorkspaceSessionState,
    requestId: string,
    pending: PendingRequest,
    error: Error,
  ): void {
    if (pending.terminal) return;
    this.settlePendingRequest(state, requestId, pending);
    pending.reject(error);
  }

  private requireMountedMount(
    sessionId: string,
    mountId: string | undefined,
    mode: "read" | "write",
  ): UserSpaceMount {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error("No user-space is configured for this session.");
    if (!this.sender)
      throw new Error("user-space broker is not connected to the WebSocket bridge.");
    const mount = mountId ? state.mounts.get(mountId) : this.getActiveMount(sessionId);
    if (!mount)
      throw new Error(
        mountId
          ? `Unknown user-space mount: ${mountId}`
          : "No user-space is configured for this session.",
      );
    if (mount.status !== "mounted" || !mount.canRead) {
      throw new Error(
        `user-space "${mount.name}" is ${mount.status}; re-authorize it in the browser.`,
      );
    }
    if (mode === "write" && !mount.canWrite) {
      throw new Error(
        `user-space "${mount.name}" is mounted read-only; switch it to read/write before modifying files.`,
      );
    }
    return mount;
  }

  /** Re-check mutable browser mount authority immediately before write authorization/ack. */
  private revalidateCheckinCommit(transfer: PendingCheckinTransfer): void {
    try {
      this.requireMountedMount(transfer.sessionId, transfer.mountId, "write");
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.rejectTransfer(transfer, failure);
      throw failure;
    }
  }

  private createTransfer<T extends PendingTransfer>(
    transfer: Omit<
      T,
      | "id"
      | "token"
      | "timer"
      | "createdAt"
      | "terminal"
      | "cleanupError"
      | "settled"
      | "markSettled"
      | "resolve"
      | "reject"
    >,
  ): T {
    const id = randomUUID();
    const token = randomUUID();
    let markSettled: () => void = () => undefined;
    const settled = new Promise<void>((resolve) => {
      markSettled = resolve;
    });
    const pending = {
      ...transfer,
      id,
      token,
      createdAt: Date.now(),
      terminal: false,
      settled,
      markSettled,
      resolve: () => undefined,
      reject: () => undefined,
      timer: setTimeout(() => {
        const current = this.transfers.get(id);
        if (current)
          this.rejectTransfer(
            current,
            new Error("Timed out waiting for browser user-space blob transfer."),
          );
      }, TRANSFER_TIMEOUT_MS),
    } as unknown as T;
    this.transfers.set(id, pending);
    return pending;
  }

  private requireTransfer<T extends PendingTransfer = PendingTransfer>(
    sessionId: string,
    transferId: string,
    token: string,
    kind?: PendingTransfer["kind"],
    options: { allowAuthorizedCheckinTerminal?: boolean } = {},
  ): T {
    const transfer = this.transfers.get(transferId);
    if (!transfer || transfer.sessionId !== sessionId || transfer.token !== token) {
      throw new Error("Invalid or expired user-space transfer token.");
    }
    if (transfer.terminal) {
      throw new Error("Invalid or expired user-space transfer token.");
    }
    if (kind && transfer.kind !== kind) {
      throw new Error("user-space transfer token was used for the wrong transfer type.");
    }
    const allowAuthorizedTerminal =
      options.allowAuthorizedCheckinTerminal === true && isAuthorizedCheckinTransfer(transfer);
    if (
      !allowAuthorizedTerminal &&
      transfer.sandboxGeneration !== this.privateStagingGeneration(sessionId)
    ) {
      const error = new Error("User Space transfer belongs to an expired sandbox generation.");
      this.rejectTransfer(transfer, error);
      throw error;
    }
    if (
      !allowAuthorizedTerminal &&
      transfer.runtimeEpoch !== this.sessions.get(sessionId)?.runtimeEpoch
    ) {
      const error = new Error("User Space transfer belongs to a revoked runtime generation.");
      this.rejectTransfer(transfer, error);
      throw error;
    }
    return transfer as T;
  }

  private requirePrivateStagingGeneration(sessionId: string): number {
    const generation = this.privateStagingGeneration(sessionId);
    if (generation === undefined) {
      throw new Error("Binary User Space staging requires the current session to run inside SRT.");
    }
    return generation;
  }

  private requireRuntimeEpoch(sessionId: string): string {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error("No user-space is configured for this session.");
    return state.runtimeEpoch;
  }

  private resolveTransfer(transfer: PendingTransfer, value: unknown): void {
    if (transfer.terminal) return;
    transfer.terminal = true;
    if (transfer.timer) clearTimeout(transfer.timer);
    if (transfer.kind === "checkout") {
      this.transfers.delete(transfer.id);
      this.stagedCheckoutGenerations.set(transfer.localPath, transfer.sandboxGeneration);
      transfer.resolve(value);
      transfer.markSettled();
      return;
    }
    void removeStagedEntryNoFollow(
      transfer.tempPath,
      this.getSessionCheckoutRoot(transfer.sessionId),
    )
      .then(() => transfer.resolve(value))
      .catch((error) => {
        const cleanupError = error instanceof Error ? error : new Error(String(error));
        transfer.cleanupError = cleanupError;
        transfer.reject(
          new AggregateError(
            [cleanupError],
            `User Space checkin completed, but private staging cleanup failed: ${cleanupError.message}`,
          ),
        );
      })
      .finally(() => {
        if (this.transfers.get(transfer.id) === transfer) this.transfers.delete(transfer.id);
        transfer.markSettled();
      });
  }

  private rejectTransfer(transfer: PendingTransfer, error: Error): void {
    if (transfer.terminal) return;
    transfer.terminal = true;
    if (transfer.timer) clearTimeout(transfer.timer);
    const stagedPath = transfer.kind === "checkin" ? transfer.tempPath : transfer.localPath;
    if (transfer.kind === "checkout") {
      this.stagedCheckoutGenerations.delete(transfer.localPath);
    }
    void removeStagedEntryNoFollow(stagedPath, this.getSessionCheckoutRoot(transfer.sessionId))
      .then(() => transfer.reject(error))
      .catch((cleanupFailure) => {
        const cleanupError =
          cleanupFailure instanceof Error ? cleanupFailure : new Error(String(cleanupFailure));
        transfer.cleanupError = cleanupError;
        transfer.reject(
          new AggregateError(
            [error, cleanupError],
            `${error.message} Private staging cleanup failed: ${cleanupError.message}`,
          ),
        );
      })
      .finally(() => {
        if (this.transfers.get(transfer.id) === transfer) this.transfers.delete(transfer.id);
        transfer.markSettled();
      });
  }

  /** Include pre-transfer and upload writes in runtime revocation drains. */
  private trackStagingWork<T>(sessionId: string, work: Promise<T>): Promise<T> {
    let active = this.stagingWork.get(sessionId);
    if (!active) {
      active = new Set();
      this.stagingWork.set(sessionId, active);
    }
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    active.add(settled);
    void settled.finally(() => {
      const current = this.stagingWork.get(sessionId);
      current?.delete(settled);
      if (current?.size === 0) this.stagingWork.delete(sessionId);
    });
    return work;
  }

  /**
   * Reserve the complete staging-file size before touching disk. A failed write
   * removes any partial leaf before releasing its reservation; when cleanup
   * itself fails, commit the full reservation conservatively so admission never
   * under-counts bytes that may remain on disk.
   */
  private async writeReservedStagingFile(
    path: string,
    root: string,
    body: Uint8Array,
    validateAfterWrite: () => void,
  ): Promise<void> {
    let reservation: DiskReservation | undefined;
    reservation = this.diskQuota?.reserve(body.byteLength);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeScopedFileNoFollow(path, body, [root], { exclusive: true });
      validateAfterWrite();
      reservation?.commit();
    } catch (error) {
      try {
        await removeStagedEntryNoFollow(path, root);
        reservation?.release();
      } catch (cleanupFailure) {
        reservation?.commit();
        const primaryError = error instanceof Error ? error : new Error(String(error));
        const cleanupError =
          cleanupFailure instanceof Error ? cleanupFailure : new Error(String(cleanupFailure));
        throw new AggregateError(
          [primaryError, cleanupError],
          `${primaryError.message} Private staging cleanup failed: ${cleanupError.message}`,
        );
      }
      throw error;
    }
  }

  private beginRuntimeRevocation(sessionId: string, reason: string): RuntimeDrainEntry[] {
    const error = new Error(reason);
    const state = this.sessions.get(sessionId);
    if (state) {
      state.token = randomUUID();
      state.runtimeEpoch = randomUUID();
      for (const [requestId, pending] of state.pending) {
        if (isAuthorizedMutationRequest(pending)) continue;
        this.rejectPendingRequest(state, requestId, pending, error);
      }
    }

    const draining: RuntimeDrainEntry[] = [];
    if (state) {
      for (const pending of state.pending.values()) {
        if (!isAuthorizedMutationRequest(pending)) continue;
        // Commit authorization is the point of no return for native browser
        // filesystem changes. Only the exact authorized socket's terminal
        // response settles this evidence; revocation itself cannot synthesize it.
        draining.push({ settled: pending.settled, cleanupError: () => undefined });
      }
    }
    for (const transfer of [...this.transfers.values()]) {
      if (transfer.sessionId !== sessionId) continue;
      // Once the browser receives a commit lease it may already be inside an
      // uninterruptible native close(). Do not settle revocation from server-side
      // staging cleanup alone; the browser's terminal acknowledgement is the
      // evidence that the filesystem side effect has reached a terminal state.
      if (!isAuthorizedCheckinTransfer(transfer)) this.rejectTransfer(transfer, error);
      draining.push({
        settled: transfer.settled,
        cleanupError: () => transfer.cleanupError,
      });
    }
    for (const settled of this.stagingWork.get(sessionId) || []) {
      draining.push({ settled, cleanupError: () => undefined });
    }

    const checkoutRoot = resolve(this.getSessionCheckoutRoot(sessionId));
    for (const localPath of this.stagedCheckoutGenerations.keys()) {
      if (!isPathInside(checkoutRoot, resolve(localPath))) continue;
      this.stagedCheckoutGenerations.delete(localPath);
      let cleanupError: Error | undefined;
      const settled = this.trackStagingWork(
        sessionId,
        removeStagedEntryNoFollow(localPath, checkoutRoot).catch((failure) => {
          cleanupError = failure instanceof Error ? failure : new Error(String(failure));
        }),
      );
      draining.push({ settled, cleanupError: () => cleanupError });
    }
    return draining;
  }

  private async waitForRuntimeDrain(draining: RuntimeDrainEntry[]): Promise<void> {
    if (draining.length === 0) return;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () =>
          reject(
            new Error(
              "Timed out draining revoked User Space staging or an authorized browser commit.",
            ),
          ),
        RUNTIME_DRAIN_TIMEOUT_MS,
      );
      timeout.unref?.();
    });
    try {
      await Promise.race([Promise.all(draining.map((entry) => entry.settled)), timeoutPromise]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const cleanupErrors = draining
      .map((entry) => entry.cleanupError())
      .filter((error): error is Error => error !== undefined);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "Failed to clean revoked User Space private staging.",
      );
    }
  }

  /** Reject pending browser work and revoke all runtime-only capabilities. */
  dispose(): void {
    const error = new Error("user-space runtime was disposed.");
    for (const state of this.sessions.values()) {
      for (const [requestId, pending] of state.pending) {
        if (isAuthorizedMutationRequest(pending)) {
          // Do not manufacture terminal evidence for a commit that may already
          // be inside native close(). Any concurrent revocation drain must hit
          // its deadline and fail closed.
          if (pending.timer) clearTimeout(pending.timer);
          pending.reject(error);
          continue;
        }
        this.rejectPendingRequest(state, requestId, pending, error);
      }
    }
    for (const transfer of [...this.transfers.values()]) {
      this.rejectTransfer(transfer, error);
    }
    for (const localPath of this.stagedCheckoutGenerations.keys()) {
      for (const sessionId of this.sessions.keys()) {
        const checkoutRoot = resolve(this.getSessionCheckoutRoot(sessionId));
        if (!isPathInside(checkoutRoot, resolve(localPath))) continue;
        void this.trackStagingWork(
          sessionId,
          removeStagedEntryNoFollow(localPath, checkoutRoot).catch(() => undefined),
        );
        break;
      }
    }
    this.sessions.clear();
    this.stagedCheckoutGenerations.clear();
    this.sender = null;
  }

  private getSessionCheckoutRoot(sessionId: string): string {
    return this.checkoutRootForSession?.(sessionId) || getSessionCheckoutRoot(sessionId);
  }

  private resolveCheckoutPath(
    sessionId: string,
    mountId: string,
    path: string,
    requested?: string,
  ): string {
    return resolveCheckoutPath(this.getSessionCheckoutRoot(sessionId), mountId, path, requested);
  }
}

function buildPublicTransferUrl(sessionId: string, suffix: string, token: string): string {
  return `/api/user-space-transfer/${encodeURIComponent(sessionId)}${suffix}?token=${encodeURIComponent(token)}`;
}

function getSessionCheckoutRoot(sessionId: string): string {
  return join(tmpdir(), "piwork-user-space", sessionId, "user-space-checkouts");
}

function resolveCheckoutPath(
  root: string,
  mountId: string,
  path: string,
  requested?: string,
): string {
  const target = requested?.trim()
    ? isAbsolute(requested)
      ? requested
      : join(root, requested)
    : join(root, sanitizePathSegment(mountId), path);
  return resolvePathInsideCheckoutRoot(root, target);
}

function resolvePathInsideCheckoutRoot(root: string, target: string): string {
  const resolvedRoot = resolve(root);
  const resolvedTarget = resolve(target);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(
      "Checkout localPath must stay inside the session user-space-checkouts directory.",
    );
  }
  return resolvedTarget;
}

function sameFileIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function requireStagedParentInside(path: string, root: string): Promise<void> {
  const [canonicalRoot, canonicalParent] = await Promise.all([
    realpath(resolve(root)),
    realpath(dirname(path)),
  ]);
  if (!isPathInside(canonicalRoot, canonicalParent)) {
    throw new Error("User Space staging path escaped its private checkout directory.");
  }
}

async function readStagedFileNoFollow(
  path: string,
  root: string,
  expected: { expectedSize?: number; expectedHash?: string },
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(expected.expectedSize) || (expected.expectedSize ?? -1) < 0) {
    throw new Error("Browser checkout did not provide a valid expected size.");
  }
  if (typeof expected.expectedHash !== "string" || !/^[a-f0-9]{64}$/i.test(expected.expectedHash)) {
    throw new Error("Browser checkout did not provide a valid expected hash.");
  }
  assertTransferSize(expected.expectedSize!);
  const target = resolvePathInsideCheckoutRoot(root, path);
  const before = await lstat(target);
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1) {
    throw new Error("User Space staging entry is not a private regular file.");
  }
  const noFollow = constants.O_NOFOLLOW;
  if (typeof noFollow !== "number") {
    throw new Error("Secure no-follow checkout consumption is unavailable.");
  }
  const handle = await open(target, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    const current = await lstat(target);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      current.isSymbolicLink() ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(current, opened)
    ) {
      throw new Error("User Space staging entry changed before it could be consumed.");
    }
    await requireStagedParentInside(target, root);
    if (opened.size !== expected.expectedSize) {
      throw new Error("User Space staging size changed before it could be consumed.");
    }
    const body = new Uint8Array(await handle.readFile());
    const after = await handle.stat();
    if (
      !sameFileIdentity(opened, after) ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      opened.ctimeMs !== after.ctimeMs ||
      body.byteLength !== expected.expectedSize
    ) {
      throw new Error("User Space staging entry changed while it was being consumed.");
    }
    const actualHash = sha256(body);
    const expectedBytes = Buffer.from(expected.expectedHash, "hex");
    const actualBytes = Buffer.from(actualHash, "hex");
    if (
      expectedBytes.length !== actualBytes.length ||
      !timingSafeEqual(expectedBytes, actualBytes)
    ) {
      throw new Error("User Space staging hash changed before it could be consumed.");
    }
    return body;
  } finally {
    await handle.close();
  }
}

async function removeStagedEntryNoFollow(path: string, root: string): Promise<void> {
  const target = resolvePathInsideCheckoutRoot(root, path);
  try {
    await lstat(target);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") return;
    throw error;
  }
  await requireStagedParentInside(target, root);
  await unlink(target);
}

function normalizeWorkspacePath(path: string, options: { requireFile?: boolean } = {}): string {
  if (typeof path !== "string") throw new Error("path must be a string.");
  const raw = path.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  if (!raw || raw === ".") {
    if (options.requireFile) throw new Error("path must not be empty.");
    return "";
  }
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..")
      throw new Error("Path traversal outside the mounted directory is not allowed.");
    parts.push(part);
  }
  const normalized = parts.join("/");
  if (options.requireFile && !normalized) throw new Error("path must not be empty.");
  return normalized;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "mount";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertTransferSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid user-space transfer size.");
  if (size > MAX_TRANSFER_BYTES) {
    throw new Error(`User-space transfer exceeds the ${MAX_TRANSFER_BYTES}-byte limit.`);
  }
}

async function readBinaryRequestBody(request: Request): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength >= 0) assertTransferSize(declaredLength);
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      assertTransferSize(size);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    releaseReaderLockBestEffort(reader);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

function userSpaceErrorStatus(error: unknown): 400 | 507 {
  return error &&
    typeof error === "object" &&
    "status" in error &&
    (error as { status?: unknown }).status === 507
    ? 507
    : 400;
}

export function registerUserSpaceTransferRoutes(api: Hono, broker: UserSpaceBroker): void {
  api.put("/user-space-transfer/:sessionId/blob/checkout/:transferId/upload", async (c) => {
    try {
      const result = await broker.handleCheckoutUpload(
        c.req.param("sessionId"),
        c.req.param("transferId"),
        c.req.query("token") || "",
        await readBinaryRequestBody(c.req.raw),
      );
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, userSpaceErrorStatus(error));
    }
  });

  api.get("/user-space-transfer/:sessionId/blob/checkin/:transferId/download", async (c) => {
    try {
      return await broker.handleCheckinDownload(
        c.req.param("sessionId"),
        c.req.param("transferId"),
        c.req.query("token") || "",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, userSpaceErrorStatus(error));
    }
  });

  api.post("/user-space-transfer/:sessionId/blob/checkin/:transferId/commit", (c) => {
    try {
      const result = broker.authorizeCheckinCommit(
        c.req.param("sessionId"),
        c.req.param("transferId"),
        c.req.query("token") || "",
      );
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, userSpaceErrorStatus(error));
    }
  });

  api.post("/user-space-transfer/:sessionId/blob/:transferId/complete", async (c) => {
    try {
      const result = broker.handleTransferComplete(
        c.req.param("sessionId"),
        c.req.param("transferId"),
        c.req.query("token") || "",
        await readJsonBody(c.req.raw),
      );
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, userSpaceErrorStatus(error));
    }
  });
}

export function registerUserSpaceInternalTransferRoutes(app: Hono, broker: UserSpaceBroker): void {
  const bearerToken = (request: { header(name: string): string | undefined }): string => {
    const authorization = request.header("authorization") || "";
    return authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() || "";
  };

  app.use("/internal/user-space-transfer/:sessionId/*", async (c, next) => {
    const token = bearerToken(c.req);
    if (!broker.validateInternalCapability(c.req.param("sessionId"), token)) {
      return c.json({ error: "Invalid or expired user-space capability." }, 401);
    }
    await next();
  });

  app.get("/internal/user-space-transfer/:sessionId/mounts", (c) => {
    const sessionId = c.req.param("sessionId");
    const capability = broker.captureInternalCapability(sessionId, bearerToken(c.req));
    if (!capability) {
      return c.json({ error: "Invalid or expired user-space capability." }, 401);
    }
    return c.json({
      user_space: broker.getActiveUserSpace(sessionId),
    });
  });

  app.post("/internal/user-space-transfer/:sessionId/operation", async (c) => {
    try {
      const sessionId = c.req.param("sessionId");
      const capability = broker.captureInternalCapability(sessionId, bearerToken(c.req));
      if (!capability) {
        return c.json({ error: "Invalid or expired user-space capability." }, 401);
      }
      const body = await readJsonBody(c.req.raw);
      if (!broker.validateInternalCapabilityLease(capability)) {
        return c.json({ error: "Invalid or expired user-space capability." }, 401);
      }
      const operation =
        typeof body.operation === "string" ? (body.operation as UserSpaceOperation) : undefined;
      if (!operation) throw new Error("operation is required.");
      if (!CLI_OPERATIONS.has(operation))
        throw new Error(`Operation is not available to the User Space CLI: ${operation}`);
      const input =
        body.input && typeof body.input === "object" && !Array.isArray(body.input)
          ? (body.input as Record<string, unknown>)
          : {};
      if (Object.prototype.hasOwnProperty.call(input, "mountId")) {
        throw new Error(
          "mountId is not available to the User Space CLI; it always uses the active directory.",
        );
      }
      if (Object.keys(input).some((key) => key.startsWith("__"))) {
        throw new Error("Private User Space operation fields are not accepted from the CLI.");
      }
      const result = await broker.requestInternalOperation(capability, operation, input);
      return c.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json(
        { error: message },
        message === "Invalid or expired user-space capability." ? 401 : 400,
      );
    }
  });
}
