import type { AuthenticatedUser } from "./auth-types.js";
import { getUserProfilePath } from "./local-paths.js";
import { AtomicJsonStore } from "./atomic-json-store.js";

export interface LocalUserProfileRecord extends AuthenticatedUser {
  uuid: string;
  lastSeenAt: string;
}

export class LocalUserProfileStore {
  writeSeenProfile(user: AuthenticatedUser & { uuid: string }): LocalUserProfileRecord {
    const record: LocalUserProfileRecord = {
      ...user,
      lastSeenAt: new Date().toISOString(),
    };
    new AtomicJsonStore<LocalUserProfileRecord>(getUserProfilePath(record.uuid), {
      schemaVersion: 1,
    }).write(record);
    return record;
  }
}
