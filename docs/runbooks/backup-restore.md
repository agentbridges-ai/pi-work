# Backup and restore

Run `make backup` to create a backup and
`make backup-verify BACKUP=/path/to/backup` to verify checksums and path
safety. Rehearse restores in a temporary data root and Postgres instance.
Confirm Better Auth tables, the Pi runtime marker, profiles, and session files
before removing the temporary resources. Record the measured restore point and
recovery time before a production restore.
