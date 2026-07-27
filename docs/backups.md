# Local maintenance backups

Piwork backups combine a PostgreSQL custom-format dump with a durable archive
of the configured `data/` root. They are local, permission-restricted artifacts;
the backup command does not upload them anywhere.

Stop the local writer, then create and verify a backup:

```bash
make dev-fast-stop
make backup
make backup-verify BACKUP=/absolute/path/to/backups/piwork-YYYYMMDDTHHMMSSZ
```

`make backup` requires `DATABASE_URL`, `pg_dump`, `pg_restore`, Node.js, and
`tar`. It acquires `.runtime/maintenance-backup.lock`, refuses to run while the
local API or the default single-writer lock is active, writes into a `0700` partial
directory, fsyncs the artifacts, and atomically renames the completed backup.
Files and the checksum manifest are created with owner-only permissions.

The durable data archive excludes directory segments named `tmp`, `checkouts`,
`user-space-checkouts`, `.cache`, `cache`, `caches`, and `recordings`.
Recordings are therefore not included by default. The manifest records the
source version/commit, exclusion policy, artifact sizes, and SHA-256 checksums.

`pi-sessions/` is intentionally included because Pi JSONL is the only source of
truth for conversation, model, thinking, compaction, Plan, and Todo.
`session.json` contains only product authority, archive state, the relative Pi
path, offline queue metadata, and client de-duplication. The Pi v1
`.runtime/runtime-layout.json` marker is also included. A restore must preserve
all three together; it must not reconstruct Pi history from recordings.

`make backup-verify` is intentionally read-only: it validates checksums, asks
`pg_restore --list` to parse the dump, and lists the tar archive to reject path
traversal or excluded directories. It never connects to a restore database,
extracts the archive, swaps `data/`, or mutates product state. A restore workflow
must be designed and reviewed separately before it is added.
