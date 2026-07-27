import type { UserSpaceAccess, UserSpaceMount } from "./types.js";
import { uiCopy } from "./ui-copy.js";
import type { IndexedWorkspaceEntry } from "./user-space-index.js";

const PERSISTENCE_DB_NAME = "user-spaces";
const PERSISTENCE_DB_VERSION = 2;
const PERSISTENCE_STORE_NAME = "mounts";
const PERSISTENCE_OWNER_INDEX_NAME = "owner";

export interface UserSpacePersistenceScope {
  userId: string;
  tenantId?: string;
}

export interface PersistedUserSpaceRecord<TRoot> {
  ownerUserId: string;
  ownerTenantId: string;
  mountId: string;
  name: string;
  rootName: string;
  access: UserSpaceAccess;
  includeHidden: true;
  fileCount?: number;
  lastIndexedAt?: number;
  /** @deprecated Large metadata snapshots are no longer persisted. */
  metadataVersion?: number;
  /** @deprecated Large metadata snapshots are no longer persisted. */
  metadataEntries?: IndexedWorkspaceEntry[];
  updatedAt: number;
  root: TRoot;
}

export interface UserSpacePersistenceAdapter<TRoot> {
  put(record: PersistedUserSpaceRecord<TRoot>): Promise<void>;
  get(
    scope: UserSpacePersistenceScope,
    mountId: string,
  ): Promise<PersistedUserSpaceRecord<TRoot> | null>;
  getAll(scope: UserSpacePersistenceScope): Promise<PersistedUserSpaceRecord<TRoot>[]>;
  delete(scope: UserSpacePersistenceScope, mountId: string): Promise<void>;
}

export class UserSpacePersistence<TRoot> {
  private adapterOverride: UserSpacePersistenceAdapter<TRoot> | null | undefined;
  private indexedDbAdapter: UserSpacePersistenceAdapter<TRoot> | null | undefined;
  private readonly writeChains = new Map<string, Promise<void>>();
  private writeGeneration = 0;

  constructor(private readonly isSameRoot: (left: TRoot, right: TRoot) => Promise<boolean>) {}

  configureAdapterForTests(adapter: UserSpacePersistenceAdapter<TRoot> | null | undefined): void {
    this.adapterOverride = adapter;
  }

  clearPendingWrites(): void {
    this.writeGeneration += 1;
  }

  getAdapter(): UserSpacePersistenceAdapter<TRoot> | null {
    if (this.adapterOverride !== undefined) return this.adapterOverride;
    if (this.indexedDbAdapter !== undefined) return this.indexedDbAdapter;
    if (typeof indexedDB === "undefined") {
      this.indexedDbAdapter = null;
      return this.indexedDbAdapter;
    }
    this.indexedDbAdapter = createIndexedDbPersistenceAdapter<TRoot>();
    return this.indexedDbAdapter;
  }

  async forget(scope: UserSpacePersistenceScope, mountId: string): Promise<void> {
    await this.getAdapter()?.delete(scope, mountId);
  }

  queueMount(scope: UserSpacePersistenceScope, mount: UserSpaceMount, root: TRoot): Promise<void> {
    const scopeSnapshot = normalizePersistenceScope(scope);
    const snapshot = { ...mount };
    const writeKey = persistenceRecordKey(scopeSnapshot, snapshot.mountId);
    const generation = this.writeGeneration;
    const previous = this.writeChains.get(writeKey) || Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => {
        if (generation !== this.writeGeneration) return;
        return this.persistMount(scopeSnapshot, snapshot, root, generation);
      });
    this.writeChains.set(writeKey, next);
    next
      .finally(() => {
        if (this.writeChains.get(writeKey) === next) this.writeChains.delete(writeKey);
      })
      .catch(() => undefined);
    return next;
  }

  private async persistMount(
    scope: UserSpacePersistenceScope,
    mount: UserSpaceMount,
    root: TRoot,
    generation: number,
  ): Promise<void> {
    const adapter = this.getAdapter();
    if (!adapter || generation !== this.writeGeneration) return;
    await requestPersistentOriginStorage();
    if (generation !== this.writeGeneration) return;
    await adapter.put({
      ownerUserId: scope.userId,
      ownerTenantId: persistenceTenantId(scope),
      mountId: mount.mountId,
      name: mount.name,
      rootName: mount.rootName,
      access: mount.access,
      includeHidden: true,
      fileCount: mount.fileCount,
      lastIndexedAt: mount.lastIndexedAt,
      updatedAt: Date.now(),
      root,
    });
    if (generation !== this.writeGeneration) return;
    await this.pruneDuplicateRecords(adapter, scope, mount, root);
  }

  private async pruneDuplicateRecords(
    adapter: UserSpacePersistenceAdapter<TRoot>,
    scope: UserSpacePersistenceScope,
    mount: UserSpaceMount,
    root: TRoot,
  ): Promise<void> {
    const records = await adapter.getAll(scope).catch(() => []);
    await Promise.all(
      records.map(async (record) => {
        if (!isPersistedRecordInScope(record, scope)) return;
        if (record.mountId === mount.mountId) return;
        if (
          record.name !== mount.name ||
          record.rootName !== mount.rootName ||
          record.includeHidden !== true
        )
          return;
        if (!(await this.isSameRoot(root, record.root))) return;
        await adapter.delete(scope, record.mountId);
      }),
    );
  }
}

export function mountFromPersistedRecord<TRoot>(
  record: PersistedUserSpaceRecord<TRoot>,
  expected?: UserSpaceMount,
): UserSpaceMount {
  return {
    mountId: expected?.mountId || record.mountId,
    name: expected?.name || record.name,
    rootName: expected?.rootName || record.rootName,
    status: "mounted",
    access: expected?.access || record.access || "readwrite",
    canRead: expected?.canRead,
    canWrite: expected?.canWrite,
    permissionState: expected?.permissionState,
    lastPermissionCheckedAt: expected?.lastPermissionCheckedAt,
    includeHidden: true,
    fileCount: expected?.fileCount ?? record.fileCount,
    lastIndexedAt: expected?.lastIndexedAt ?? record.lastIndexedAt,
  };
}

export function findPersistedRecordByWorkspaceName<TRoot>(
  records: PersistedUserSpaceRecord<TRoot>[],
  expected: UserSpaceMount,
  scope: UserSpacePersistenceScope,
): PersistedUserSpaceRecord<TRoot> | null {
  const candidates = records
    .filter(
      (record) =>
        isPersistedRecordInScope(record, scope) &&
        record.rootName === expected.rootName &&
        record.name === expected.name &&
        record.includeHidden === true,
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);
  return candidates[0] || null;
}

export function isPersistedRecordInScope<TRoot>(
  record: PersistedUserSpaceRecord<TRoot>,
  scope: UserSpacePersistenceScope,
): boolean {
  return (
    scope.userId.length > 0 &&
    typeof record.ownerUserId === "string" &&
    record.ownerUserId === scope.userId &&
    typeof record.ownerTenantId === "string" &&
    record.ownerTenantId === persistenceTenantId(scope)
  );
}

function createIndexedDbPersistenceAdapter<TRoot>(): UserSpacePersistenceAdapter<TRoot> {
  return {
    async put(record) {
      const db = await openPersistenceDb();
      try {
        const tx = db.transaction(PERSISTENCE_STORE_NAME, "readwrite");
        tx.objectStore(PERSISTENCE_STORE_NAME).put(record);
        await transactionDone(tx);
      } finally {
        db.close();
      }
    },
    async get(scope, mountId) {
      const db = await openPersistenceDb();
      try {
        const tx = db.transaction(PERSISTENCE_STORE_NAME, "readonly");
        const record = await requestDone<PersistedUserSpaceRecord<TRoot> | undefined>(
          tx.objectStore(PERSISTENCE_STORE_NAME).get(persistenceKey(scope, mountId)),
        );
        await transactionDone(tx);
        return record && isPersistedRecordInScope(record, scope) ? record : null;
      } finally {
        db.close();
      }
    },
    async getAll(scope) {
      const db = await openPersistenceDb();
      try {
        const tx = db.transaction(PERSISTENCE_STORE_NAME, "readonly");
        const records = await requestDone<PersistedUserSpaceRecord<TRoot>[]>(
          tx
            .objectStore(PERSISTENCE_STORE_NAME)
            .index(PERSISTENCE_OWNER_INDEX_NAME)
            .getAll(IDBKeyRange.only(persistenceOwnerKey(scope))),
        );
        await transactionDone(tx);
        return records.filter((record) => isPersistedRecordInScope(record, scope));
      } finally {
        db.close();
      }
    },
    async delete(scope, mountId) {
      const db = await openPersistenceDb();
      try {
        const tx = db.transaction(PERSISTENCE_STORE_NAME, "readwrite");
        tx.objectStore(PERSISTENCE_STORE_NAME).delete(persistenceKey(scope, mountId));
        await transactionDone(tx);
      } finally {
        db.close();
      }
    },
  };
}

function openPersistenceDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PERSISTENCE_DB_NAME, PERSISTENCE_DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      // Version 1 keyed records by mountId and had no user/tenant owner. Those
      // directory handles cannot be assigned safely after an account switch,
      // so discard them and require the browser user to authorize again.
      if (event.oldVersion < 2 && db.objectStoreNames.contains(PERSISTENCE_STORE_NAME)) {
        db.deleteObjectStore(PERSISTENCE_STORE_NAME);
      }
      if (db.objectStoreNames.contains(PERSISTENCE_STORE_NAME)) return;
      const store = db.createObjectStore(PERSISTENCE_STORE_NAME, {
        keyPath: ["ownerUserId", "ownerTenantId", "mountId"],
      });
      store.createIndex(PERSISTENCE_OWNER_INDEX_NAME, ["ownerUserId", "ownerTenantId"]);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error || new Error(uiCopy.userSpace.runtimeErrors.idbOpenFailed));
    request.onblocked = () => reject(new Error(uiCopy.userSpace.runtimeErrors.idbBlocked));
  });
}

function normalizePersistenceScope(scope: UserSpacePersistenceScope): UserSpacePersistenceScope {
  if (!scope.userId) throw new Error("User-space persistence requires an authenticated user.");
  return { userId: scope.userId, tenantId: persistenceTenantId(scope) || undefined };
}

function persistenceTenantId(scope: UserSpacePersistenceScope): string {
  return scope.tenantId || "";
}

function persistenceOwnerKey(scope: UserSpacePersistenceScope): [string, string] {
  const normalized = normalizePersistenceScope(scope);
  return [normalized.userId, persistenceTenantId(normalized)];
}

function persistenceKey(
  scope: UserSpacePersistenceScope,
  mountId: string,
): [string, string, string] {
  const [userId, tenantId] = persistenceOwnerKey(scope);
  return [userId, tenantId, mountId];
}

function persistenceRecordKey(scope: UserSpacePersistenceScope, mountId: string): string {
  const [userId, tenantId] = persistenceOwnerKey(scope);
  return JSON.stringify([userId, tenantId, mountId]);
}

function requestDone<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
  });
}

async function requestPersistentOriginStorage(): Promise<void> {
  if (typeof navigator === "undefined") return;
  try {
    await navigator.storage?.persist?.();
  } catch {
    // Best effort only: persisted IndexedDB handles still work without this.
  }
}
