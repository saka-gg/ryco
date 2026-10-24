# Node storage and worktree cleanup

Storage management belongs to the owning node. Desktop/web General settings and native mobile Settings provide an on-demand inventory, explicit manual review and retention policy controls. The frozen web phone tier is unchanged. Remote mutations use existing node-owner authorization and synchronized connection readiness; a preview cannot cross connections or survive a readiness change.

Existing installs keep everything by default. Migration 66 creates an empty ownership ledger; it never adopts pre-existing worktrees. Node retention is off with both periods set to forever. Projects may supply a whole cleanup policy or inherit the node policy. Enabling automatic deletion requires explicit confirmation in the product UI. The worker sleeps an hour before its first pass and does no scanning when all policies are disabled.

## Inventory and accounting

Scans use a shared 30,000-entry/three-second measurement budget, bounded inventory rows, deduplicated canonical-path checks with concurrency four, and cursor pages of 256 owned records. Individual git checks have bounded output and timeouts. A slow filesystem can delay an individual asynchronous operation; entry/time bounds prevent additional traversal. Incomplete lifecycle inventory refuses cleanup. No repository globbing or startup filesystem sweep is performed.

Sizes are apparent file bytes, not allocated blocks. Symlinks, mounts, special/shared files, unreadable entries and scan limits prevent a complete safety result. Unknown size is displayed as unavailable, never a false zero. Repository measurements exclude separately inventoried checkouts and declared provider sources. Protected/adopted worktrees remain visible. Usage samples persist separately from ownership and are never removed by cleanup. Samples are throttled per project to five minutes; omitted pages/inventory count as an incomplete sample, so page totals remain labelled lower bounds. Provider archives and credentials outside the inventory are not traversed.

## Removal and failure behavior

Manual cleanup selects at most 20 eligible records, previews exact paths/sizes, and requires a separate destructive confirmation. A node-owner connection receives a five-minute preview bound to its connection, policies and provider source declarations. The server inspects selected IDs directly, including later inventory pages. It revalidates each entry before claiming it and again at the removal boundary. The existing Git service accepts an internal verified-cleanup request; it never invokes Git’s recursive checkout removal for retention. Git registration, branch refs, git history, provider bindings, conversations, attachments and historical usage remain. Missing Git registrations may be pruned explicitly later.

Eligibility requires durable creation provenance, the same canonical repository and checkout identities, current git registration, a complete scan, merged history, and no dirty/untracked/ignored files, submodules, shared/adopted workspace, running/starting/background session, terminal/subprocess, pending approval/input/plan, pending goal synchronization or accepted-but-not-started turn. Descendant and overlapping active paths count as use, including the provider runtime’s actual persisted cwd after thread metadata moves. Unknown active runtime paths protect cleanup. Declared provider homes/history/exports/databases and node database/settings/secrets/attachments/log locations are protected even when a provider instance is disabled.

A short shared admission lock coordinates orchestration projection, editor target resolution, terminal startup, settings publication and cleanup claims. Path-specific creation/recovery/provider-start leases protect long callbacks without holding that node-wide lock. Persistent removing/removed tombstones refuse nested editor, terminal, metadata, turn and goal admissions. Removing checkouts and recorded quarantine paths also refuse overlapping ancestor admissions; removed children do not permanently disable their parents. Existing ancestor terminals protect descendant checkouts. Explicit new creation can replace a removed tombstone; it cannot replace an in-flight removal. Ownership capture canonicalizes a trusted configured repository alias, pins the result, and keeps strict candidate symlink checks. Capture failure records an unverified/protected creation when possible and logs persistence failure without losing the successful creation outcome.

Each batch persists results after every entry. Same-process retries serialize behind the live batch. After restart, recorded results are replayed and unresolved entries are reported as interrupted; unknown deletion is never replayed. Git/IO failure leaves a protected removing record with its error. There is no automatic retry of a partially removed path: inspect and recover it manually before resuming use. A short path-specific settings lease refuses relevant raw provider/retention changes before any secret-store effects during bounded removal. Relevant settings writers register admission before asynchronous secret writes, blocking fresh cleanup claims until persistence and materialization fully settle, including cancellation. Admitted secret writes and destructive cleanup callbacks fully settle before cancellation releases admission. No long secret/file write holds the node-wide lifecycle lock. External settings watcher changes invalidate removal admission. The final authoritative settings snapshot re-resolves provider paths after filesystem inspection. External processes cannot participate in node admission; fresh filesystem checks refuse detectable external changes.

Temporary retention covers only allocations from `StorageService.createTemporaryDirectory(projectId)` under the dedicated node staging directory. The producer must call `completeTemporaryDirectory(id)` before eligibility. Completion pins a bounded metadata manifest; added, replaced or modified files protect the allocation afterward. Both temporary and worktree cleanup persist a unique sibling quarantine location before atomic rename, validate the moved tree, then consider only manifest entries. Each file is moved to a unique verified slot and rechecked; directories use non-recursive rmdir. New unknown entries are never recursively traversed or deleted. Interrupted/changed data stays at the recorded recovery path, with a persistent refusal and truthful partial result; unknown deletion is never retried. Existing caches, directories under user-owned homes, provider usage scanner artifacts and archives are never adopted. New abandoned worktrees and unreferenced staging allocations have a 24-hour safety grace period.

## Runtime interfaces

- Project settings: `@ryco/shared/storageRetention` exports `resolveStorageRetentionPolicy(settings, projectId)`. It resolves the node/project cleanup policy (`storageRetention`, `projectStorageRetention`) independently of thread creation preferences.
- Provider source protection: `apps/server/src/storage/providerProtection.ts` exports the required `ProviderProtectedPaths` service/port. Its `resolve(settings)` returns trusted declared paths or `null` when unavailable, with no archive/credential content reads. Provider usage discovery owns the single source parser. The production port calls `resolveUsageProtectedPaths(settings, baseEnvironment?, home?)` from `apps/server/src/usage/usageProtectedPaths.ts` with current full server settings at every safety stage. It includes legacy/default history roots and disabled configured instances. Missing or invalid protection refuses cleanup. Storage canonicalizes paths including missing leaves, protects ancestor/descendant overlaps and pins both declarations and effective paths in each preview. Regression tests use synthetic provider declarations and the same resolver as production.
- Submodule creation: `GitVcsDriverCore.createWorktree` captures cleanup ownership after successful checkout setup. The path-specific creation lease spans checkout creation, submodule initialization and dependency hydration; retained incomplete checkouts keep their setup journal and remain protected. Worktrees with `.gitmodules` remain protected, including clean or skipped submodule hydration.
- Multi-model launch: starts must use the authoritative engine/provider admission paths. Multiple historical threads or worktree registrations sharing a checkout protect it. The internal Git cleanup argument is server-only and is not part of RPC/schema contracts. It requires an opaque process-local `StorageCleanupClaim`, minted after the durable ledger claims removal and records its exact quarantine. Drivers revalidate the ledger, target, repository, identity and quarantine, and require the active authentic settings lease. Caller objects, cloned claims, released admission and absent/manual ownership cannot authorize verified cleanup. Verified cleanup also holds the canonical destination lock and durable setup ownership guard, and refuses incomplete setup journals. Path-use leases may span startup/recovery callbacks, never a complete provider turn or scan.
- Shared clients: schema-only storage RPC/settings contracts live in contracts; the transport/controller live in client-runtime without DOM/RN imports. Each presentation uses the existing owner/readiness gate. Older nodes without the storage capability remain disabled.

Focused regressions use synthetic repositories and SQLite fixtures only. They cover dirty/ignored/unmerged data, aliases and identity changes, nested target refusal, pending turn projection with a paused reactor, delayed goal recovery, creation/activation races, source-path protection, partial/retried execution, opt-in retention, pagination and bounded accounting.

## Database: event history compaction

The event log (`orchestration_events` in `state.sqlite`) keeps every orchestration event. Some
activities are not history but the latest state of something running: a task's progress, a tool
heartbeat, a streaming subagent message, a reasoning block. Providers rewrite them many times
under one activity id, and everything that reads them replaces the activity by id, so only the
newest event per thread and activity id matters. The server removes the older versions in the
background (`apps/server/src/persistence/Layers/EventLogCompaction.ts`); the groups are defined
once in `@ryco/shared/latestStateActivities`, which also drives write pacing at ingestion and
live frame coalescing.

- Removed: superseded `thread.activity-appended` events of `task.progress`, `tool.progress`,
  subagent `agent.message` and `reasoning` activities, only when a later event of the same thread
  and activity id stays, and only once the event is at least 24 hours old. Also command receipts
  older than 7 days whose command id embeds a UUID minted for one emission (`provider:<uuid>:…`,
  `history:<uuid>`).
- Never removed: any other event type or activity kind, the newest version of every activity,
  `context-window.updated` samples (statistics read every one), fork copies and imported
  activities, events of the last 24 hours, and every other command receipt (many command ids are
  deterministic and rely on their receipt for at-most-once behaviour).
- Equivalence: server projections rebuilt or caught up from any cursor, and clients resumed from
  any cursor, reach the same state with or without the removed events (property tests in
  `EventLogCompaction.replay.test.ts` and `store.compactionReplay.test.ts`). A resume cursor that
  falls into a removed event is still anchored, because the log's range anchors it.
- Cadence: the first pass runs 10 minutes after startup (later if the last pass finished less than
  6 hours ago), then every 2 minutes while settled history or old receipts are still waiting,
  then every 6 hours.
  A pass scans at most 250,000 sequences or 2 minutes, selects on the read worker, and deletes in
  small adaptive transactions on the main connection. Each pass logs one summary line.
- Kill switch: `RYCO_EVENT_COMPACTION=off` disables it; `RYCO_EVENT_COMPACTION=dry-run` selects
  and counts without deleting, under its own progress state. CLI commands never compact.
- Removed events free pages inside the database file (see below for when the file shrinks).
  Online passes keep at most one stale version per activity whose versions straddle two passes.
- Measure on a copy with `node apps/server/scripts/measure-event-compaction.ts --db <state.sqlite>`
  (fixture homes from `generate-fixture-home.ts --progress-ticks-per-turn N
  --reasoning-flushes-per-turn N --subagent-flushes-per-turn N`).

## Database: free space and automatic shrinking

Deleting rows (compaction, thread purges, finished message chunks) leaves free pages inside
`state.sqlite`. SQLite reuses them for new data before it grows the file, so free space is not
lost, but the file only gets smaller when pages are returned to the file system.

- New databases are created with `auto_vacuum = INCREMENTAL` (`apps/server/src/persistence/Layers/Sqlite.ts`).
  SQLite accepts the mode only while the file has no tables, and before it switches to WAL; the
  setup sets it first, and on Bun the client's own WAL switch is skipped for a file that does not
  exist yet or is empty. Incremental mode adds a pointer map: one page per 819 pages at 4 KiB
  (about 0.12% of the file).
- Existing databases keep their mode (`NONE`). Changing it needs a full rebuild (`VACUUM`), which
  never runs while the server is up; `ryco doctor --apply` (below) does it offline. Until then
  their free space is reused inside the file.
- On incremental databases the server returns free pages online
  (`apps/server/src/persistence/Layers/DatabaseMaintenance.ts`): once a minute, when more than
  256 pages (1 MiB at the default 4 KiB page size) are free, it frees up to 1,024 pages (4 MiB)
  down to that floor, in transactions of 128 single-page `PRAGMA incremental_vacuum(1)` steps,
  pausing after each one at least 2 ms and three times as long as it took. The floor stays free
  for new writes. The file shrinks when the write-ahead log is next checkpointed. A chunk slower
  than 50 ms logs a warning; failures log and retry the next minute. This runs whatever
  `RYCO_EVENT_COMPACTION` says, and never on `NONE` databases.
- Storage settings show the database after a scan (every inventory page carries it): file and
  write-ahead log size, free space inside the file, whether automatic shrinking is on, history
  compaction progress (events and bytes removed so far, the share of history examined, up to date
  or catching up, the last pass), and an estimate of reclaimable space: free pages plus the bytes
  compaction is still expected to remove, extrapolated from what it removed per examined
  sequence so far (unknown before the first pass; the unexamined part includes the last day,
  which is not eligible yet). The report reads header pragmas, two key lookups and two `stat`
  calls; a part it cannot read shows as 0 or unknown. Older nodes send no report and the section
  stays hidden; older clients ignore it.
- When automatic shrinking is off (`auto_vacuum = NONE`) and at least 1 GiB could be returned,
  Storage settings suggest the doctor with the command to run, and the server logs the same
  suggestion once per boot (15 minutes after start, after the first compaction pass).

## Database: `ryco doctor`

`ryco doctor` checks the database of a data directory and shows how much it could shrink.
`ryco doctor --apply` removes all superseded history and shrinks the file while no server uses
it. It is the only way to shrink a database created before automatic shrinking, and the fastest
way to shrink any database after a lot was removed.

```sh
ryco doctor                      # read-only report and plan; safe while Ryco runs
ryco doctor --estimate           # also count the superseded history exactly (reads the whole log)
ryco doctor --apply              # asks first in a terminal; --yes to skip the question
ryco doctor --apply --base-dir ~/other-home
```

The desktop app's data directory takes the CLI of the app's own version:
`npx ryco-cli@<app version> doctor --apply` (Node.js 22.16 or newer), after quitting the app.
Storage settings show the exact command.

What `--apply` does (`apps/server/src/doctor/DatabaseDoctor.ts`):

1. Ownership. If this data directory's running background service (`ryco service`) has the
   database, the doctor stops it and starts it again at the end (`--no-restart-service` leaves it
   stopped). Any other Ryco server (the desktop app, a `ryco serve`) is a refusal that names it
   and says what to do; the CLI never stops the desktop app. Then it takes maintenance ownership
   of the database (see [database-ownership.md](database-ownership.md)): servers that start
   meanwhile wait for it.
2. SQLite's exclusive lock on its own connection. It is refused while any other connection has the
   database open (an older Ryco that does not know the owner lock, a SQLite tool).
3. Checks: `PRAGMA quick_check` (`--thorough`: `integrity_check`); the schema must be exactly the
   one this ryco knows, because the doctor never migrates (the app that owns the data might not open
   an upgraded file): every migration applied and every compatibility repair recorded in
   `ryco_compatibility_repairs`. A database last run by a Ryco from before those records has none;
   there the doctor reads each repair's effect in the schema instead, and accepts the database when
   every one is present (the next start only writes the records). A repair still to run, recorded
   nowhere and without its effect, is a refusal: start Ryco once first. Every projection must be
   caught up with the event log. A damaged database is never repaired: restore a backup.
4. Free disk: the compacted copy needs its size, 1.1x, plus 256 MiB on the database's volume
   (estimated from the compaction state before anything changes, exact after compaction).
5. Compaction over the whole log from the beginning, with no age limit and no carry bound, so it
   also removes the one stale version per activity that online passes can leave; old random-id
   receipts go too. The WAL is truncated every 50,000 deletions.
6. `VACUUM INTO` a sibling file (`state.sqlite.doctor-<pid>-<ms>.tmp`) with
   `auto_vacuum = INCREMENTAL`, then `integrity_check`, row counts of every table, the
   AUTOINCREMENT high-water marks and the newest event compared with the database. It needs about
   1x the compacted size; an in-place `VACUUM` would need about twice the file plus temporary space
   that may be a small tmpfs.
7. The swap. Before writing the copy, and again before the rename, the doctor asks the system
   whether any other process has `state.sqlite`, `-wal` or `-shm` open (`lsof` on macOS, `/proc`
   on Linux; only this user's processes are visible). A process that opened the old file keeps it
   open across the rename but opens `-wal` and `-shm` by name, which then belong to the new file:
   two databases sharing one log corrupt each other, and SQLite's lock does not prevent it. So
   when another process has the file open, or the system cannot say (other platforms), the file
   is not swapped: history stays removed, and no copy is written (or the one written is deleted).
   Otherwise the copy gets the database's owner, group and permissions (a run through `sudo`
   cannot leave a root-owned database behind), the connection closes (removing the WAL), the copy
   is renamed over the database, the directory is synced, and the database is reopened in WAL
   mode for a last `quick_check`. What remains is the few milliseconds between the last check and
   the rename, and only for a process that ignores the owner lock and opens the file exactly
   then.

Exit codes: 0 done (also "history removed, not shrunk" with the reason, and a declined
confirmation), 1 a failure midway, 2 refused before anything changed. `--json` prints the report
and the result as one document.

Interruptions and failures: every step runs in one scope. Ctrl-C (it takes effect after a running
`VACUUM INTO`), a failure or a lost terminal closes the connections, removes the copy, releases
ownership and starts a paused service; compaction batches are transactions, so the database stays
consistent and the next run continues. Until the rename the original file is untouched by the
copy. A `kill -9` leaves the owner lock (reclaimed by liveness), the copy (removed by the next
run) and `doctor-service-paused.json` in the state directory: the next run starts the service it
names.

Afterwards the server returns free pages online like on any new database, and the compaction
state starts from the head of the log (its receipt cursor from the beginning, since the copy
renumbers rowids). An interrupted run leaves the compaction cursor where online passes or the
doctor got furthest, so neither its work nor theirs is repeated.
