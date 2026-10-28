# Database backups

Ryco keeps its history in one SQLite database, `<stateDir>/state.sqlite` (`~/.ryco/userdata` by
default, `~/.ryco/dev` for development servers). Before an upgrade changes that database, Ryco
writes a restorable copy of it next to it, in `<stateDir>/backups`.

## When a backup is written

Every process that opens the database (the desktop app's server, `ryco serve`, the background
service, and CLI commands such as `ryco project add`) checks what the next migration pass would
change. It writes a backup first when:

- a numbered migration is pending, or
- a compatibility repair runs for the first time on this database. Repairs carry schema changes
  that cannot ship as numbered migrations; each one is recorded in `ryco_compatibility_repairs`
  once it has run. Databases written by builds before this one have no such records, so the
  first start of this build takes one backup even without a pending migration.

New, empty databases are not backed up, and neither is a database whose schema is newer than
the running build (that build refuses to open it; see below).

A restart within ten minutes that finds the same pending upgrade, and a database whose content
has not changed since (same ledger, repairs, schema, size and event sequence), reuses the backup
it already has. A later restart that finds the same takes a new copy and removes the old one.
Either way, a crash loop keeps one copy and never replaces older backups with copies of the same
data.

## How it works, and what it costs

The backup is taken in two phases.

**Before migrations (on the startup path).** Ryco checkpoints the WAL, takes SQLite's write lock
(`BEGIN IMMEDIATE`), and copies the database file and any remaining WAL while it holds the lock.
Nobody can write or reset the WAL meanwhile, so the copied pair is exactly what a crash at that
moment would leave behind, and opening it is ordinary crash recovery. Ryco then folds the copy into
one plain SQLite file (`journal_mode=delete`), checks that its migration ledger matches the
database and that its size matches its page count, flushes it to disk and gives it its final name.

Where the filesystem supports copy-on-write clones (APFS on macOS; btrfs, xfs and bcachefs on
Linux), the copy is a clone and costs almost nothing regardless of size. Elsewhere it is a full
copy, which Ryco only makes for databases up to 2 GiB.

Measured on an Apple M5 Max (APFS, internal NVMe) with a 4.5 GB database:

| Step                                              | Time                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------- |
| Clone backup, whole phase                         | 0.11-0.15 s for a contiguous file, 0.23-0.55 s for a fragmented one |
| Write lock held during a clone                    | 2-10 ms                                                             |
| Full copy (no clone), whole phase                 | 3.3-4.4 s, write lock held throughout                               |
| Server event loop, longest pause during the phase | under 16 ms                                                         |
| `VACUUM INTO` (not used before migrations)        | 6.8 s                                                               |

Most of a clone's time goes into unsharing the two files: the first write to either file after a
clone makes APFS split their shared extents, which takes longer the more fragmented the file is.
Ryco does that write itself, off the event loop, so that neither the copy's fold nor the
migration that follows stalls the server.

**In the background (30 seconds later).** A low-priority child process runs `PRAGMA quick_check`
on the copy, and a second one compresses it with zstd (level 1, with a frame checksum); without
zstd support, gzip level 1 is used. The compressed file replaces the plain one. Measured for the
same 4.5 GB database: `quick_check` 88-117 s on a cold cache, compression 8 s, 4.5 GB → 708 MB
(6.3x). The server's event loop stayed under 17 ms throughout. Stopping Ryco during this phase is
immediate: the child processes are killed, and the plain backup stays valid and is finished on the
next start. A command-line process that exits within the 30 seconds leaves its backup plain; the
next server compresses it.

A backup that fails `quick_check` means the database was already damaged before the upgrade. Ryco
keeps that copy anyway, renamed with `-unverified`, uncompressed and never removed automatically,
and logs an error with its path: partly readable data can still be the best restore point.

## When no backup is written

Ryco never blocks or fails an upgrade because of a backup. It skips the backup, with a warning in
the server log that names the reason, when:

- free space in `<stateDir>/backups` is below twice the database size (database plus WAL);
- the database is larger than 2 GiB and the filesystem cannot clone it (the warning says so);
- the copy or its check fails.

Windows cannot copy a live SQLite database larger than 1 GiB (SQLite's byte-range locks are
mandatory there), so on Windows such a database is skipped with a copy error.

Set `RYCO_PREMIGRATION_BACKUP` to change the behaviour:

| Value            | Effect                                                                               |
| ---------------- | ------------------------------------------------------------------------------------ |
| `auto` (default) | Clone where possible; full copies up to 2 GiB; skip larger databases without clones. |
| `always`         | Also make full copies above 2 GiB. Startup waits for the copy, roughly 1 s per GB.   |
| `off`            | No backups.                                                                          |

## Names and retention

Backups are named after the schema they hold and the upgrade they precede, in UTC:

```text
state-v093-before-v095-20261023T151230123Z.sqlite.zst   compressed
state-v093-before-v095-20261023T151230123Z.sqlite       plain (not compressed yet)
state-v093-before-v095-20261023T151230123Z-unverified.sqlite
```

`v000` means a database without a migration ledger. A `-2` before `.sqlite` appears when two
backups were written in the same millisecond. Files whose names start with a dot are unfinished
and are removed on the next start.

Ryco keeps the newest three backups of each kind (before an upgrade, or manual) and removes older
ones; for a 10 GB database that is about 4.5 GB. The newest backup taken before a numbered
migration is also kept when newer ones only precede repairs (`v093-before-v093`): a repair that
keeps failing part-way backs up again on every restart that finds the database changed, and must
not push out the copy from before the schema change. Unverified backups and files that do not
follow this naming are never removed. The Storage settings list the folder as "Database backups".

## Restoring a backup by hand

A backup holds the database only. It does not include settings, secrets, the Hub identity,
attachments, task files or logs, nor anything written after the backup was taken, and that
includes revocations: a session, pairing link or Agent Control connection revoked after the backup
is not revoked in it. Restore into a separate data directory and keep the upgraded database as it
is.

1. Quit Ryco (the desktop app, `ryco service stop`, or any `ryco serve`).
2. Pick a backup in `<stateDir>/backups` and decompress it into a new data directory:

   ```sh
   mkdir -p ~/ryco-restore/userdata
   zstd -d ~/.ryco/userdata/backups/state-v093-before-v095-20261023T151230123Z.sqlite.zst \
     -o ~/ryco-restore/userdata/state.sqlite
   ```

   `zstd` comes with `brew install zstd` on macOS. A `.sqlite.gz` backup decompresses with
   `gunzip -c <file> > ~/ryco-restore/userdata/state.sqlite`, and a plain `.sqlite` backup is
   copied as it is.

3. Start a Ryco build that supports that schema on the restored directory:
   `ryco serve --base-dir ~/ryco-restore` (or `RYCO_HOME=~/ryco-restore`). The restored directory
   has no settings, secrets or Hub identity, so pair your devices with it again. Agent Control
   connections of external clients live in the database, so the ones in the backup work there,
   including any you revoked after the backup: revoke them again in Settings → Integrations.

To make the restored database your main one, quit Ryco, move `<stateDir>/state.sqlite`,
`state.sqlite-wal` and `state.sqlite-shm` aside (do not delete them), and copy the restored file in
as `state.sqlite`. The main data directory keeps its secrets, so every session, pairing link and
Agent Control connection in the backup is valid again, including those you revoked after the
backup was taken (a lost device, say). Right after the first start, revoke them again: in
Settings → Connections, choose Revoke others and revoke the pairing links you no longer need, and
revoke the external Agent Control connections in Settings → Integrations.

## Schema newer than this build

A build that finds a database written by a newer build refuses to open it, before any migration
or repair runs, and says where the backups are. Use a build that supports that schema, or restore
a backup taken before the upgrade into a separate data directory as above.
