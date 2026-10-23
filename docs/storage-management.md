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
- Removed events free pages inside the database file; the file itself does not shrink. Online
  passes keep at most one stale version per activity whose versions straddle two passes.
- Measure on a copy with `node apps/server/scripts/measure-event-compaction.ts --db <state.sqlite>`
  (fixture homes from `generate-fixture-home.ts --progress-ticks-per-turn N
  --reasoning-flushes-per-turn N --subagent-flushes-per-turn N`).
