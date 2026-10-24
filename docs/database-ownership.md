# Database ownership

One Ryco server uses a data directory's database at a time, and only the process that owns the
database migrates it. Code: `apps/server/src/persistence/databaseOwnerLock.ts` (the lock) and
`apps/server/src/persistence/migrationOwnershipPolicy.ts` (the migration rule).

## The owner lock

Next to the database sits `state.sqlite.owner` (`~/.ryco/userdata/state.sqlite.owner` by default,
`<RYCO_HOME>/dev/state.sqlite.owner` for dev servers). It exists while a process owns the database
and names that process: pid, kind (`server` or `maintenance`), what launched it (`desktop`,
`service`, `serve`, `cli`), its version and schema, when it took ownership, and the boot and
process start time that tell a live owner from a stale record.

- **Servers** own the database for their whole lifetime: the desktop app's backend, `ryco serve`
  (also `ryco start`, bare `ryco`, and the setup wizard's foreground server), the `ryco service`
  background service, and dev servers. A server takes ownership before it binds its port and
  opens the database, and gives it back after both are closed.
- **Maintenance** owns the database exclusively for one operation: a CLI command that has to
  migrate it (below), `ryco doctor --apply` (see
  [storage-management.md](storage-management.md#database-ryco-doctor)), and later
  `ryco db restore`. Maintenance never starts while a server owns the database.

### A second server

A server that finds the database owned waits, then gives up:

| Owner                               | `ryco serve`, desktop app, dev server | `ryco service`                    |
| ----------------------------------- | ------------------------------------- | --------------------------------- |
| Another server                      | 10 s, then exits                      | waits until it stops, then starts |
| Maintenance (a migration, a repair) | up to 10 min, then exits              | waits until it finishes           |

The 10 s covers the desktop app replacing its own backend and service restarts. A server that gives
up exits with code 78 (`EX_CONFIG`) and the reason `database-in-use`, which says who owns the
database and how to stop it, for example:

> Another Ryco server is using this data directory: the Ryco desktop app (pid 4242, version 0.1.36,
> running since 15:01). Only one Ryco server can use ~/.ryco/userdata at a time. Quit the other
> one, or start this one with a different --base-dir.

The desktop app shows this in its "could not start" dialog with Retry. A `ryco service` waits
instead of exiting, because launchd and systemd restart every exit: it starts serving within
seconds after the desktop app quits.

A lock file that is still half-written after the wait (its writer was killed while writing it)
is the exception: the server exits with code 1, so its supervisor simply starts it again, and the
file counts as stale once it is a minute old.

This ends the desktop app and a `ryco serve`/`ryco service` running side by side on one data
directory (both default to `~/.ryco`). To run both, give one its own `--base-dir` or `RYCO_HOME`.
Two dev servers on one `~/.ryco/dev` also refuse each other now; give each worktree its own
`RYCO_HOME`.

## Migrations: only the owner migrates

Every `ryco auth`, `hub`, `e2ee`, `project` and `setup` command opens the database, also while a
server runs. Opening it, reading it and the commands' own writes stay allowed. Migrating it does
not: a newer `ryco` CLI next to an older running desktop app must not upgrade the schema under it.

A process that does not own the database first reads what it would change: pending numbered
migrations, and compatibility repairs this database has never recorded. Every migration pass
records the repairs it ran in `ryco_compatibility_repairs` (see
[database-backups.md](database-backups.md)), so this is a read of the ledger and those records;
no migration or repair runs. A database without any record (see
[Servers from before the lock](#servers-from-before-the-lock)) is also read for each repair's
effect. Then:

- **Nothing to change**: it skips the migrations and repairs and carries on.
- **Changes, nobody owns the database**: it takes maintenance ownership for the migration (waiting
  up to 30 s for another CLI that is migrating), so a server started meanwhile waits for it.
- **Changes, a live owner with the same schema code** (the same migrations and repairs, whatever
  the version number): the owner is upgrading right now. It waits up to 30 s for that.
- **Changes, any other owner**: it refuses, without having changed anything:

> This ryco (0.1.37) needs to upgrade the database from schema 93 to 95, but the Ryco desktop app
> (pid 4242, version 0.1.36, running since 15:01) is using it, and Ryco never upgrades a database
> under a running server. Update and restart that server first (reopen the desktop app), or quit it
> and run this command again.

The server owning the database migrates at startup as before, and re-runs every repair.

Only the process that migrates takes the pre-upgrade backup
([database-backups.md](database-backups.md)): the server that owns the database, or a CLI that
migrates a database nobody owns. A CLI that refuses, or that waits for its owner to finish
upgrading, writes no backup. A CLI leaves the backup's verification and compression to the next
server start.

## Stale locks

There is no heartbeat: a suspended laptop must not look like a dead owner. A lock is stale, and the
next process takes it over, when its owner

- crashed or was killed: the pid is gone;
- ran before a reboot: the kernel's boot id differs (on systems without one, the boot time differs
  by more than 10 minutes);
- is gone and its pid was reused: the process with that pid started at another time (Linux: exact
  start ticks; macOS: more than 2 s after the time the owner recorded for itself);
- was copied along with its data directory: the record names another file's inode.

On Windows only the pid is checked. If Ryco reports a database in use by a pid that is not Ryco,
delete `state.sqlite.owner` while no Ryco server runs.

## When the lock cannot be used

The lock fails closed. A lock file that cannot be read (often written by a Ryco server running as
another user), that is not a lock file (a directory, a link), or that cannot be created (a read-only
or full disk) stops the server with an exact message, and a CLI never migrates under it. These
conditions make the database itself unsafe or unusable, and nothing else would notice two servers.

`RYCO_DB_OWNER_LOCK=off` skips the lock and the migration rule, with a warning in the server log.
Use it only where the lock cannot work, and make sure only one Ryco server uses the directory.
Network filesystems are such a case: exclusive file creation is unreliable on NFSv3, and SQLite in
WAL mode is unsafe on network filesystems anyway.

`RYCO_DB_OWNER_WAIT_MS` changes the 10 s a server waits for another server (tests use it).

## Servers from before the lock

Ryco versions released before this lock write no lock file. While there is none, a server that
records a live pid in `server-runtime.json` and still listens on the recorded port counts as an
owner: a new server refuses to start next to it, and a new CLI does not migrate under it. A `ryco
project` command whose live request failed removes that file only by the same rule (its pid is gone,
or nothing listens on its port), so a busy server keeps it. This is best effort for the transition
(an older server whose runtime file was removed is not seen), and it will be removed two releases
after the lock shipped.

Those servers also record no compatibility repairs, although they run every one at each start. On
a database without any repair record and without a pending migration, Ryco reads each repair's
effect instead (columns, tables, indexes and triggers in the SQLite catalog, and the completion
markers of the repairs that backfill data): a repair whose effect is there is not pending, so a new
CLI next to an older running server opens that database normally, and the first start of a server
of this version records the repairs without taking a backup. A repair whose effect is missing is
pending as before: the CLI refuses ("needs to repair the database schema (…)") and the server backs
up before it runs the repair. Once a database has any record, the records alone decide.

## For code

- `probeDatabaseOwner(dbPath)`: `free`, or `owned` by `{ pid, kind, startedAt, launcher, ... }`.
  Fails with `DatabaseOwnerLockError` when the lock cannot be judged; treat that as owned.
  `probeDatabaseOwnerSettled(dbPath)`, which the migration rule uses, first reads a lock that is
  still being written again for up to 1 s, as taking ownership does.
- `acquireDatabaseServer(dbPath, { launcher })` and `acquireDatabaseMaintenance(dbPath, purpose,
  { waitMs })`: scoped; released when the scope closes, also on failure and interruption. They fail
  with `DatabaseOwnedError` (`reason` and the `owner`).
- `DatabaseOwnerLeaseLive` holds the server's ownership in `makeServerLayer`;
  `migrateUnderOwnershipPolicy` applies the migration rule in the persistence layer's setup, around
  the backup and the migration pass.
- `inspectMigrationLedger()` and `isUpgradePending(ledger)` (`Migrations.ts`): whether a migration
  pass would change the database (pending migrations, `repairsPending`), read-only. The rule and
  the pre-upgrade backup both decide with it. On a database without repair records, the repair
  checks in `compatibilityRepairChecks.ts` (loaded only then) move the repairs whose effect is
  present to `repairsRecognised`. `migrationSchemaDigest` (migrations and repair keys) tells an
  owner running the same schema code apart.
