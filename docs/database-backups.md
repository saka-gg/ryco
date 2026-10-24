# Database backups

Ryco keeps its history in one SQLite database, `<stateDir>/state.sqlite` (`~/.ryco/userdata` by
default, `~/.ryco/dev` for development servers). Before an upgrade changes that database, Ryco
writes a restorable copy of it next to it, in `<stateDir>/backups`. You can also back it up
yourself at any time with `ryco db backup`, see the backups with `ryco db list`, and restore one
into a new data directory with `ryco db restore` (see [Commands](#commands)).

## When a backup is written

The process that migrates the database checks what the migration pass would change: the server
that owns it (the desktop app's server, `ryco serve`, the background service), or a CLI command
such as `ryco project add` that migrates a database no server is using. A CLI never migrates a
database a running server owns, and so never backs it up either
([database-ownership.md](database-ownership.md)). The migrating process writes a backup first
when:

- a numbered migration is pending, or
- a compatibility repair runs for the first time on this database. Repairs carry schema changes
  that cannot ship as numbered migrations; each one is recorded in `ryco_compatibility_repairs`
  once it has run. Databases written by builds before this one have no such records, so the
  first start of this build takes one backup even without a pending migration.

New, empty databases are not backed up, and neither is a database whose schema is newer than
the running build (that build refuses to open it; see below).

A restart within ten minutes that finds the same pending upgrade, and a database whose content
has not changed since (same ledger, schema, size and event sequence), reuses the backup it
already has. This keeps a crash loop from replacing older backups with copies of the same data.

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
next start. A command-line process that migrated leaves its backup plain; the next server start
verifies and compresses it.

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
state-v093-manual-20261023T151230123Z.sqlite.zst        ryco db backup
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

## Commands

None of these commands migrates or writes the database in use, so they are safe while Ryco runs.
`ryco db backup` reads it through a read-only connection (under Bun, when no other process has the
database open, through a normal connection that only reads, because Bun's SQLite cannot open a
WAL database read-only then); the other two never open it. Each takes `--base-dir <dir>` (like
`RYCO_HOME`) and `--dev-url <url>` to pick the data directory, and `--json` to print one compact
JSON document instead of text. A command that cannot go ahead prints one line starting with
`Error:` and exits with status 1.

### `ryco db backup`

Writes `state-v<schema>-manual-<time>.sqlite.zst` to `<stateDir>/backups`:

1. `VACUUM INTO` a new file, from a read-only connection. That is one read transaction: it never
   takes the write lock, so a running server keeps writing, and the copy is a consistent snapshot
   of the moment it started. The copy is also compacted (free pages are dropped).
2. `PRAGMA quick_check` on the copy, its migration ledger (the schema in its name), and a size
   check (page count times page size). A copy that fails means the database itself is damaged;
   no backup is written.
3. zstd level 1 with a frame checksum (gzip level 1 where the runtime has no zstd), flushed to
   disk, then given its final name. The plain copy is removed. Older manual backups beyond the
   newest three are removed; pre-upgrade backups are left alone. The backup is complete once it
   has its final name: if a clean-up step after that fails, the command still succeeds and
   prints a warning.

It needs free space of twice the database size (database plus WAL) in `<stateDir>/backups`, and
fails, naming both numbers, when there is less. Progress goes to stderr; the result (path,
schema, sizes, timings) to stdout.

What it costs is measured [below](#what-ryco-db-backup-costs).

### `ryco db list`

Lists the backups in `<stateDir>/backups`, newest first: when each was taken (local time), its
kind (`before upgrade 92 → 93`, `before repairs`, or `manual`), size, state (compressed, not
compressed yet, or failed its integrity check) and full path. A backup whose schema is newer
than this build supports is marked `needs a newer Ryco build`. It only reads the directory.

### `ryco db restore <file> --into <dir>`

Restores a backup into a new data directory and checks it first. It never writes the data
directory in use.

- `<file>` can be a `.sqlite.zst`, `.sqlite.gz` or plain `.sqlite` backup. The format is read from
  the file's first bytes, so a renamed file still works. The database in use (by any path,
  including a hard link) and a file with a write-ahead log next to it (a database in use) are
  refused; back that one up with `ryco db backup` first.
- `<dir>` must be new or empty, and must not be, contain or lie inside the data directory in use
  (paths are compared after resolving symlinks). There must be free space for the restored
  database: a plain backup's size, or the size a compressed backup's SQLite header states, read
  from its first decompressed bytes. Nothing is created before these checks pass.
- The backup is decompressed (the zstd and gzip checksums are verified while it streams) into a
  temporary file in `<dir>/userdata`, checked with `PRAGMA quick_check` (`--full-check` runs
  `PRAGMA integrity_check`, much slower on large databases), and must have a migration ledger.
  Only then does it become `<dir>/userdata/state.sqlite`. Any failure removes the temporary file
  and the directories the command created.
- It warns, and restores anyway, when the backup's schema is newer than this build supports, or
  when its ledger names migrations differently from this build (another branch wrote it). Open it
  with a build that supports it.

Then start Ryco on it: `ryco serve --base-dir <dir>` (or `RYCO_HOME=<dir>`). The restored
directory has no settings, secrets or Hub identity, so pair your devices with it again.

A backup holds the database only. It does not include settings, secrets, the Hub identity,
attachments, task files or logs, nor anything written after the backup was taken. To make the
restored database your main one, quit Ryco (the desktop app, `ryco service stop`, or any
`ryco serve`), move `<stateDir>/state.sqlite`, `state.sqlite-wal` and `state.sqlite-shm` aside (do
not delete them), and copy `<dir>/userdata/state.sqlite` in as `state.sqlite`. Ryco does not do
this swap for you yet.

### What `ryco db backup` costs

Measured on an Apple M5 Max (APFS, internal NVMe, a machine shared with other work) with a
synthetic 4.5 GB database:

| Step                                          | Time                                                      |
| --------------------------------------------- | --------------------------------------------------------- |
| `VACUUM INTO` the copy (4.34 GB)              | 6.7-7.4 s from a warm cache; 44 s for the first, cold run |
| `quick_check` of the copy                     | 2.0-2.5 s                                                 |
| zstd compression, 4.34 GB → 640 MB (7.0x)     | 5.4-7.7 s                                                 |
| Whole command                                 | 14-17 s warm (15-30 s beside a running server), 54 s cold |
| `ryco db restore` (decompress, `quick_check`) | 12.6-14.2 s; 43.7 s with `--full-check`                   |

With `ryco serve` running on the same database, a second process kept inserting a row every
50 ms: its p99 insert time was 3.2-5.5 ms during the backup against 2.0-3.1 ms before it (worst
single insert 19 ms), and the server's request p99 stayed at 4.2-8.4 ms (4.5-7.5 ms before),
with no failed requests. A test runs the backup beside a writer with no busy timeout at all and
checks that the writer never once finds the database locked.

## Restoring a backup by hand

Without the `ryco` command (an older CLI, say), decompress a backup into a new data directory
yourself:

```sh
mkdir -p ~/ryco-restore/userdata
zstd -d ~/.ryco/userdata/backups/state-v093-before-v095-20261023T151230123Z.sqlite.zst \
  -o ~/ryco-restore/userdata/state.sqlite
```

`zstd` comes with `brew install zstd` on macOS. A `.sqlite.gz` backup decompresses with
`gunzip -c <file> > ~/ryco-restore/userdata/state.sqlite`, and a plain `.sqlite` backup is copied
as it is. Then start a Ryco build that supports that schema on it, as above.

## Schema newer than this build

A build that finds a database written by a newer build refuses to open it, before any migration
or repair runs, and says where the backups are. Use a build that supports that schema, or find a
backup taken before the upgrade with `ryco db list` (with the server's `--base-dir` or
`--dev-url`, if it uses one) and restore it into a separate data directory with
`ryco db restore <file> --into <new directory>`.
