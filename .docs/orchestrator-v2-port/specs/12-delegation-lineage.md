# 12 · delegation-lineage: server-side parent/child lineage for delegated threads

| Field            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id               | `delegation-lineage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| title            | Record a server-owned `lineage` on threads that Agent Control `createThreads` creates for a provider session. Project it, expose it to clients, fold quiet children under their parent in the inbox, and list a parent's children in the thread view                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| wave             | 2 (parallel, isolated worktree). Merge **before** `delegation-returns`, which rebases on it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| verdict          | **feature**. Verified against HEAD `9e545b3ae`. No lineage exists anywhere. "Managed by" is inferred on the client from proposal history that is capped at 20 terminal proposals                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| size             | L (server + client-runtime + web; every step is mechanical, but the surface is wide)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| touched files    | **contracts:** `packages/contracts/src/orchestration.ts`, `packages/contracts/src/orchestration.test.ts` · **server:** `apps/server/src/persistence/Migrations/071_ProjectionThreadLineage.ts` (new), `apps/server/src/persistence/Migrations/071_ProjectionThreadLineage.test.ts` (new), `apps/server/src/persistence/Migrations.ts`, `apps/server/src/persistence/Services/ProjectionThreads.ts`, `apps/server/src/persistence/Layers/ProjectionThreads.ts`, `apps/server/src/orchestration/threadLineage.ts` (new), `apps/server/src/orchestration/decider.ts`, `apps/server/src/orchestration/projector.ts`, `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`, `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`, `apps/server/src/orchestration/Services/OrchestrationCommandApplication.ts`, `apps/server/src/orchestration/Layers/OrchestrationCommandApplication.ts`, `apps/server/src/agentControl/Layers/AgentControlExecution.ts` · **server tests:** `apps/server/src/orchestration/decider.lineage.test.ts` (new), `projector.test.ts`, `Layers/ProjectionPipeline.test.ts`, `Layers/ProjectionSnapshotQuery.test.ts`, `Layers/OrchestrationEngine.test.ts`, `Layers/OrchestrationCommandApplication.test.ts`, `persistence/Layers/ProjectionThreads.test.ts`, `persistence/Layers/ProjectionRepositories.test.ts` (fixture fields only), `agentControl/Layers/AgentControlExecution.test.ts`, `agentControl/Layers/AgentControlProjectPreferences.test.ts` · **client-runtime:** `packages/client-runtime/src/state/threads/threadLineage.ts` (new) + `threadLineage.test.ts` (new), `state/threads/types.ts`, `state/threads/store.ts` + `store.test.ts`, `state/threads/index.ts`, `state/agentControl/logic.ts` + `logic.test.ts`, `state/workspace/types.ts` · **web:** `apps/web/src/components/inboxSidebar/inboxSidebarModel.ts` + `.test.ts`, `inboxSidebar/InboxSidebar.tsx` + `InboxSidebar.browser.tsx`, `inboxSidebar/InboxDelegatedGroup.tsx` (new), `apps/web/src/components/threads/ThreadLinkList.tsx` (new) + `ThreadLinkList.browser.tsx` (new), `threads/threadLinkActivity.ts` (new), `threads/DelegatedThreadsSection.tsx` (new) + `DelegatedThreadsSection.browser.tsx` (new), `pullRequests/rail/AgentsSection.tsx`, `pullRequests/rail/agentThreads.logic.ts`, `agent-control/AgentControlThreadActivity.tsx` + `.browser.tsx`, `agent-control/AgentControlApprovals.tsx`, `ChatView.tsx` (one mount), `apps/web/src/store.ts` (one re-export), `apps/web/src/workspaceMetadataProjection.ts` + `.test.ts` · **mobile (no UI):** `apps/mobile/src/persistence/environmentSnapshotCodec.ts` + `.test.ts` |
| migrations       | **071** `ProjectionThreadLineage`: three nullable columns on `projection_threads` plus one partial index. Idempotent, and **also run as an unconditional repair hook** because the pre-assigned numbers merge out of order (see §5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| contract changes | New `ThreadLineage` schema with an open `relationship` string. Optional `lineage` on `OrchestrationThread`, `OrchestrationThreadShell` and `ThreadCreatedPayload`. New **internal-only** command `thread.delegated.create` in `InternalOrchestrationCommand`; it is **not** part of `ClientOrchestrationCommand`. Server service `OrchestrationCommandApplicationShape` gains `applyInternal`. Client-runtime types `Thread`, `ThreadShell`, `SidebarThreadSummary` and `WorkspaceThreadMetadata` gain an optional `lineage`. `AgentControlThreadActivity` gains `delegatedFromThreadId`. All additions are optional on the wire: older clients drop the key and older servers omit it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| overlaps         | `delegation-returns` (W2): `AgentControlExecution.ts` createThreads loop (`dispatch` helper and `thread-created` hunk; returns owns the adjacent `returnToOrigin` hunk), `logic.ts` `selectAgentControlThreadActivity`, `AgentControlThreadActivity.tsx`. Merge lineage first. `usage-limits` (W2): `OrchestrationThreadShell` fields, `ProjectionSnapshotQuery` shell builders, `store.ts` `mapThreadShell` / `sidebarThreadSummariesEqual`, `inboxSidebarModel.ts` `sectionKey` semantics, `Migrations.ts` repair-hook lines (074). `delegation-guard-restart` (W1, merged earlier): same object literal in `getCommandReadModel`. This package does **not** edit `AgentControlCompletionReturns.ts`. `settlement-signals` (W1, 075): out-of-order migration hazard, possible shell-field neighbours. `queue-hold-drain` (W1): neighbouring ChatView composer-stack JSX. `rollback-correctness` / `acp-message-ids`: different `projector.ts` / `decider.ts` cases, no shared function                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

---

## 1. Problem (verified against the code)

1. **No lineage exists.**
   - `OrchestrationThread` (`packages/contracts/src/orchestration.ts:834-872`) and `OrchestrationThreadShell` (`:932-962`) have no parent fields.
   - `ThreadCreateCommand` (`:1236`, a non-exported const) and `ThreadCreatedPayload` (`:1984`) have none either.
   - The server side has none: projector (`projector.ts:313-357`), pipeline (`ProjectionPipeline.ts:762-790`), the `ProjectionThread` row (`persistence/Services/ProjectionThreads.ts:29-56`) and its upsert (`persistence/Layers/ProjectionThreads.ts:30-118`).
   - Latest migration: 070.
2. **Agent Control creates children as plain threads.**
   - `AgentControlExecution.ts:890` handles both `createThreads` and `automationRun`.
   - It revalidates at `:1062`, then dispatches a plain `thread.create` (`:1063-1089`) through `commandApplication.apply` (`:487-512`), which is typed `ClientOrchestrationCommand`.
   - The caller thread is known server-side: `proposal.principal.threadId` comes from the session registry record (`AgentControlActionValidator.ts:589-599`, `Mcp/tools.ts:1288`). Agents cannot choose it.
3. **"Managed by" is a client-side guess.**
   - `selectAgentControlThreadActivity` (`packages/client-runtime/src/state/agentControl/logic.ts:252-306`) infers the latest accepted manager. It looks at `createThreads` receipts _and_ at `sendMessage` / `interruptThread` / `updateThread`.
   - History is capped at `AGENT_CONTROL_CLIENT_HISTORY_LIMIT` = 20 terminal proposals (`logic.ts:44`). So the link disappears for older children and is never known after a client restart outside that window.
   - The only consumer is the "Managed by" line in `AgentControlThreadActivity.tsx:63-72`.
4. **Children are ordinary inbox rows.** The inbox (`inboxSidebarModel.ts:397-596`) has no notion of parent and child. A fan-out of N workers produces N unrelated rows that stay there after they finish.
5. **A dead parent column exists but must not be reused.**
   - Migration 041 and the repair `repairProjectionThreadSubagentNestingColumns` (`Migrations.ts:281-329`) created `projection_threads.parent_thread_id`, `parent_subagent_id`, `thread_kind` and `visibility`.
   - These come from the "managed subagent" feature that was added in `c2e3f5f04` and removed a day later in `85274c65e`. Nothing reads them.
   - The current upsert never writes `parent_thread_id`, so rows from that era may still hold stale parent ids. Reusing the column would resurrect them as fake delegations.

t3 reference: `OrchestrationV2AppThreadLineage { parentThreadId, relationshipToParent: "fork"|"subagent", rootThreadId }` (`/tmp/t3code-research/packages/contracts/src/orchestrationV2.ts:102`). t3 also hides subagent children from the sidebar entirely (`apps/web/src/components/Sidebar.logic.ts:533-552`).

## 2. Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                           | Why                                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `ThreadLineage = { parentThreadId, rootThreadId, relationship }`. It is absent on root threads, never `{ parent: null }`                                                                                                                                                                                                                           | Avoids touching every existing thread and fixture. Absent means "no known parent"                                                                                                                       |
| D2  | `relationship` is an **open** bounded string. Known value: `"delegated"`. Clients treat any other value as "no known relationship" and render flat                                                                                                                                                                                                 | A literal union inside the shell schema would make a future third value fail the **whole** shell-snapshot decode on older clients (review #10)                                                          |
| D3  | Only the decider computes lineage, from an internal command `thread.delegated.create { …thread.create fields, parentThreadId }`. The decider rejects an unknown, deleted or cross-project parent, a cycle, and depth > 64                                                                                                                          | Single invariant owner. The command is absent from `ClientOrchestrationCommand`, which is what the WS RPC (`rpc.ts:1800`) and HTTP (`orchestration/http.ts:83`) decode, so clients cannot forge lineage |
| D4  | Lineage is set **only** when `proposal.plan.kind === "createThreads"` **and** `proposal.principal.kind === "provider-session"`                                                                                                                                                                                                                     | `automationRun` reuses the same branch with the automation's stored principal (`AgentControlAutomation.ts:290/315/326/470`). Scheduled runs are not delegated children (review #1)                      |
| D5  | Lineage is **provenance only**. It grants nothing and is never read by Agent Control policy, the validator, the worktree-escalation guard, approvals or return delivery                                                                                                                                                                            | Agent Control is security-sensitive. Lineage must not become an authority channel                                                                                                                       |
| D6  | Thread view, "Delegated from {parent}": server lineage, and for pre-lineage threads the accepted `createThreads` receipt as a fallback. "Managed by {manager}": unchanged inference of the latest accepted manager, **hidden when it is the same thread as "Delegated from"**. Both render on one line: `Delegated from X · Managed by Y`          | "Created by" and "currently directed by" are different facts. Precedence must not silently relabel one as the other (review #7)                                                                         |
| D7  | Inbox: a child folds under its nearest visible ancestor **only if** it is delegated, not pinned, not in Focus, its own section is quiet (`recent`, `snoozed` or `settled`), and it is not more urgent than the host. Working, error, connecting, delivery-unknown and needs-input children always stay top-level, in their own sections and counts | The inbox is the attention surface. Hiding live work under a collapsed parent is the main failure mode (review #2). Finished children folding away is the actual decluttering value                     |
| D8  | The thread view lists **direct** children. The inbox flattens every nested descendant under the **topmost** visible host. Both are documented and pinned by tests                                                                                                                                                                                  | Avoids two silently different trees (review #9)                                                                                                                                                         |
| D9  | The nesting planner is a generic pure function in client-runtime (`planDelegatedNesting`). Web's inbox is a thin adapter, and mobile can reuse the planner later                                                                                                                                                                                   | Mobile already builds on client-runtime `buildThreadInbox` (`apps/mobile/src/features/inbox/inboxModel.ts:199`) (review #5)                                                                             |
| D10 | Web phone tier: nesting off (`nestDelegated: false`). There is no "Delegated threads" section there, and Agent Control is already non-phone                                                                                                                                                                                                        | AGENTS.md freezes the web phone tier                                                                                                                                                                    |
| D11 | Extract a shared `ThreadLinkList` row list and use it in both `AgentsSection` (behaviour identical) and `DelegatedThreadsSection`                                                                                                                                                                                                                  | Avoids duplicating the glyph + title + time + navigate row (review #4)                                                                                                                                  |
| D12 | New columns `lineage_parent_thread_id`, `lineage_root_thread_id`, `lineage_relationship`. Leave the dead 041 columns untouched                                                                                                                                                                                                                     | §1.5                                                                                                                                                                                                    |

## 3. Approach (data flow)

```
MCP ryco_create_threads (provider session)
  └─ proposal.principal = { kind: provider-session, threadId: <caller> }   (session registry)
AgentControlExecution createThreads loop
  └─ revalidateExecution (origin must still exist in project)  :1062, unchanged
  └─ commandApplication.applyInternal({ type: "thread.delegated.create", …, parentThreadId: principal.threadId })
decider: thread.delegated.create
  └─ parent checks + resolveDelegatedChildLineage → thread.created { …, lineage }
projector (in-memory)  → OrchestrationThread.lineage
ProjectionPipeline     → projection_threads.lineage_* columns
ProjectionSnapshotQuery (6 builders) → OrchestrationThread / OrchestrationThreadShell .lineage (key only when present)
client-runtime mapThread / mapThreadShell / toThreadShell → Thread / ThreadShell / SidebarThreadSummary .lineage
web: inbox folding (planDelegatedNesting) · DelegatedThreadsSection (parent) · "Delegated from" (child)
```

## 4. Step-by-step changes

### 4.1 `packages/contracts/src/orchestration.ts` (schema only)

1. Before `OrchestrationThread` (~`:834`):
   ```ts
   /**
    * Server-owned provenance of a thread created on behalf of another thread.
    * Absent on root threads. Immutable for a thread incarnation. Never authority.
    * `relationship` is deliberately an open string: a newer server may add kinds
    * without failing older clients' shell decode. Clients must treat values they
    * do not know as "no known relationship". Known values: "delegated".
    */
   export const ThreadLineage = Schema.Struct({
     parentThreadId: ThreadId,
     rootThreadId: ThreadId,
     relationship: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
   });
   export type ThreadLineage = typeof ThreadLineage.Type;
   ```
2. Add `lineage: Schema.optional(Schema.NullOr(ThreadLineage))` to `OrchestrationThread` (next to `goal`) and to `OrchestrationThreadShell` (next to `backgroundLiveness`).
   - No decoding default. This mirrors `backgroundLiveness` so existing fixtures and `toEqual` expectations stay valid.
3. Add `lineage: Schema.optional(ThreadLineage)` to `ThreadCreatedPayload`.
4. Add the internal command next to `ThreadCreateCommand`:
   ```ts
   /** Server-originated only (Agent Control). Never part of ClientOrchestrationCommand. */
   const ThreadDelegatedCreateCommand = Schema.Struct({
     ...ThreadCreateCommand.fields,
     type: Schema.Literal("thread.delegated.create"),
     parentThreadId: ThreadId,
   });
   export type ThreadDelegatedCreateCommand = typeof ThreadDelegatedCreateCommand.Type;
   ```
   - Add it to `InternalOrchestrationCommand` (`:1853`).
   - Do **not** add it to `DispatchableClientOrchestrationCommand` or `ClientOrchestrationCommand`.

### 4.2 Migration 071 and the repair hook (see §5 for why)

1. New `apps/server/src/persistence/Migrations/071_ProjectionThreadLineage.ts`. It exports `ensureProjectionThreadLineageColumns` (an `Effect.gen`) and uses it as the default export:
   - Return early if the `projection_threads` table does not exist. Copy the guard from `repairProjectionThreadSubagentNestingColumns`.
   - Run `PRAGMA table_info(projection_threads)`. Then `ALTER TABLE projection_threads ADD COLUMN lineage_parent_thread_id TEXT`, `… lineage_root_thread_id TEXT` and `… lineage_relationship TEXT`, each only when missing.
   - `CREATE INDEX IF NOT EXISTS projection_threads_lineage_parent ON projection_threads(lineage_parent_thread_id) WHERE lineage_parent_thread_id IS NOT NULL`. This is a partial index, nearly free on mostly-null data, for the follow-up MCP/returns child queries.
   - No backfill. Pre-lineage children keep the client fallback (D6). A projection-only backfill from proposals would diverge from the event log on the next projection rebuild.
2. `Migrations.ts`:
   - Import the migration, append `[71, "ProjectionThreadLineage", Migration0071]` after `:167`.
   - In `runMigrations`, after the `>= 44` block (`:461-463`), add:
     ```ts
     if (toMigrationInclusive === undefined || toMigrationInclusive >= 71) {
       yield * ensureProjectionThreadLineageColumns; // repair: 071 may be skipped (see spec §5)
     }
     ```

### 4.3 Projection row and repository

1. `persistence/Services/ProjectionThreads.ts`: add **required** fields to `ProjectionThread`:
   - `lineageParentThreadId: Schema.NullOr(ThreadId)`
   - `lineageRootThreadId: Schema.NullOr(ThreadId)`
   - `lineageRelationship: Schema.NullOr(Schema.String)`

   They are required on purpose. Every literal constructor then fails to type-check until it supplies them, and every SELECT that forgets the columns fails to decode in tests. Without that, a SELECT missing the columns would let the next `...existingRow.value` upsert silently wipe lineage. Every non-`thread.created` case in `ProjectionPipeline.applyThreadsProjection` spreads `existingRow.value` (`:798-1060`).

2. `persistence/Layers/ProjectionThreads.ts`:
   - Add the three columns to the `INSERT` column list, `VALUES` and `ON CONFLICT … DO UPDATE SET`. Always overwrite them, so re-creating a soft-deleted id resets them.
   - Add the three `AS "lineage…"` selects to `getProjectionThreadRow` and `listProjectionThreadRows`.
3. New `apps/server/src/orchestration/threadLineage.ts` (pure, no Effect services):
   - `DELEGATED_THREAD_RELATIONSHIP = "delegated" as const`, `MAX_THREAD_LINEAGE_DEPTH = 64`.
   - `projectionThreadLineage(row: Pick<ProjectionThread, "lineageParentThreadId" | "lineageRootThreadId" | "lineageRelationship">): ThreadLineage | null`. Returns null unless all three are non-null and the relationship is non-empty, so partial rows are treated as no lineage.
   - `projectionLineageColumns(lineage: ThreadLineage | null | undefined)` returns the three row fields, or nulls.
   - `withThreadLineage<T extends object>(target: T, lineage: ThreadLineage | null): T & { lineage?: ThreadLineage }`. It adds the key only when non-null. All builders use it, so the "omit when absent" rule lives in one place.
   - `resolveDelegatedChildLineage({ readModel, parent, childThreadId }): { ok: true; lineage } | { ok: false; detail }`:
     - Set `root = parent.lineage?.rootThreadId ?? parent.id`.
     - Walk the ancestors starting at `parent`. At each step, check `cursor.lineage`: if its `parentThreadId` or `rootThreadId` equals `childThreadId`, fail with a cycle. Then follow `findThreadById(readModel, cursor.lineage.parentThreadId)`. The read model includes deleted rows, so deleted ancestors are walked too.
     - Fail with "too deep" once the walk exceeds `MAX_THREAD_LINEAGE_DEPTH`.
     - Stop when a thread has no lineage or cannot be found.
     - Return `{ parentThreadId: parent.id, rootThreadId: root, relationship: "delegated" }`.
     - This covers the re-created soft-deleted id case (`requireThreadAbsent` allows re-creation, `commandInvariants.ts:332-350`) at any depth, not just for the direct parent or root (review #6).

### 4.4 Decider (`apps/server/src/orchestration/decider.ts`)

1. Extract the body of `case "thread.create"` (`:472-506`) into a local helper. The helper takes `{ readModel, command, fields, lineage }`, where `command` is the original command and is used for invariant-error `commandType`. It runs `requireProject` and `requireThreadAbsent`, then returns the single `thread.created` event. The payload gets `lineage` only when non-null.
   - `thread.create` calls the helper with `lineage: null`. Its events stay byte-identical, so existing decider tests are unchanged.
   - `thread.history.import` (`:414-470`) keeps recursing through `thread.create`, so it is unchanged.
2. New `case "thread.delegated.create"`, failing via `OrchestrationCommandInvariantError` with `commandType: "thread.delegated.create"`:
   - Reject `parentThreadId === threadId`.
   - `parent = yield* requireThread(...)`. Reject `parent.deletedAt !== null` ("Parent thread … was deleted."). Archived parents are allowed.
   - Reject `parent.projectId !== command.projectId`. The validator already enforces the same rule at `AgentControlActionValidator.ts:313-317`; the decider re-asserts it.
   - `resolveDelegatedChildLineage`. On failure, reject with its detail.
   - Call the helper with `fields` = the command minus `type` and `parentThreadId`, and the resolved lineage.

### 4.5 Engine, projector and pipeline

1. `OrchestrationEngine.ts:101-141`: add `case "thread.delegated.create":` to the thread-aggregate group. Storage readiness needs nothing new: `"worktreePath" in storageCommand` (`:255`) already matches.
2. `projector.ts` `case "thread.created"` (`:313-357`): build the decoded thread with `withThreadLineage({...}, payload.lineage ?? null)`. On re-creation it replaces the whole thread, so lineage resets.
3. `ProjectionPipeline.ts` `applyThreadsProjection` `case "thread.created"` (`:762-790`): spread `projectionLineageColumns(event.payload.lineage)`. No other case changes; they all spread `existingRow.value`.

### 4.6 `ProjectionSnapshotQuery.ts`

1. Add the three `lineage_*` selects to `listThreadRows` (`:598-630`) and `getActiveThreadRowById` (`:1051-1086`). `ProjectionThreadDbRowSchema` picks the new fields up from `ProjectionThread`.
2. Apply `withThreadLineage(…, projectionThreadLineage(row))` in all six builders:
   - `decodeThreadFromProjectionRows` (`:1781-1829`), which also covers detail and window reads
   - `getSnapshot` threads (`:2094`)
   - `getCommandReadModel` `threads.push` (`:2389-2418`). This is required for the decider's root and cycle walk after a restart.
   - `getShellSnapshot` shell (`:2580-2612`)
   - `getThreadShellById` (`:2850-2881`). The shell stream re-reads this (`orchestrationStreams.ts:281-292`).
   - any remaining `OrchestrationThread` builder found by searching for `tokenMode: row.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE` in this file
3. Rebase note: `delegation-guard-restart` (W1) edits the `messages:` property of the same `getCommandReadModel` literal. Keep both.

### 4.7 Command application (`Services/` + `Layers/OrchestrationCommandApplication.ts`)

1. Add to `OrchestrationCommandApplicationShape`:
   ```ts
   /**
    * Apply a server-originated internal command (no client normalization; same
    * engine dispatcher, archive follow-ups and error mapping as `apply`).
    * Never pass decoded client input here.
    */
   readonly applyInternal: (
     command: InternalOrchestrationCommand,
   ) => Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError>;
   ```
2. Implementation:
   ```ts
   applyOrchestrationNormalizedCommand({
     command,
     dispatch: engineDispatcher,
     projections,
     terminals,
   });
   ```
   Return `{ apply, applyWithDispatcher, applyInternal }`.

### 4.8 `AgentControlExecution.ts`

1. `dispatch` helper (`:487-512`):
   - Widen its parameter to `ClientOrchestrationCommand | ThreadDelegatedCreateCommand`.
   - Call `command.type === "thread.delegated.create" ? commandApplication.applyInternal(command) : commandApplication.apply(command)`.
   - Receipts keep recording `command.type`. `AgentControlDispatchedCommandReceipt.commandType` is an open string (`contracts/agentControl.ts:903-907`) and nothing matches on `"thread.create"`.
2. In the createThreads/automationRun branch (`:890`), once before the loop:
   ```ts
   // Provenance only (spec D4/D5): never authority; automation runs are not children.
   const delegatedParentThreadId =
     proposal.plan.kind === "createThreads" && proposal.principal.kind === "provider-session"
       ? proposal.principal.threadId
       : null;
   ```
3. At `:1063-1089`:
   - Dispatch `{ type: "thread.delegated.create", …same fields…, parentThreadId: delegatedParentThreadId }` when non-null, otherwise the existing `thread.create`.
   - Keep the step name `thread-created:${index}`, `commandIdFor(operation.operationId, "thread-create-${index}")` and the `ownedThreadIds` update unchanged. A crash-resumed operation that already committed the old `thread.create` under that commandId is deduplicated by the receipt, and that child simply has no lineage.
4. Do **not** add a pre-loop parent lookup (review #3):
   - `revalidateExecution` at `:1062` already fails with `caller-stale` when the origin thread is missing or in another project (`AgentControlActionValidator.ts:757-761`).
   - A parent deleted between revalidation and dispatch is rejected by the decider. That fails the step through the existing dispatch-failure and compensation path, the same as caller-stale.
5. No change to `returnToOrigin`, worktree, setup or turn-start code. `delegation-returns` owns `:1108-1146`.

### 4.9 client-runtime

1. New `packages/client-runtime/src/state/threads/threadLineage.ts`, exported from `state/threads/index.ts`:
   - `isThreadLineage = Schema.is(ThreadLineage)`. Used by cache paths.
   - `isDelegatedThreadLineage(lineage): lineage is ThreadLineage`. Narrows `null | undefined` too, and is true only for `relationship === "delegated"`.
   - `threadLineagesEqual(a, b)`: compares all three fields, with null and undefined treated as equal.
   - `selectDelegatedChildThreads<T extends Pick<SidebarThreadSummary, "id" | "environmentId" | "createdAt" | "archivedAt" | "lineage">>(threads, parent: ScopedThreadRef): T[]`. Returns direct, delegated, non-archived children in the same environment, ordered by `createdAt` ascending, then id.
   - `planDelegatedNesting(items, options?)`, the generic planner (D7–D9):
     ```ts
     export type DelegatedNestingUrgency =
       | "needs-input"
       | "active"
       | "recent"
       | "snoozed"
       | "settled";
     export interface DelegatedNestingItem {
       readonly key: string; // scopedThreadKey(scopeThreadRef(environmentId, threadId))
       readonly environmentId: EnvironmentId;
       readonly threadId: ThreadId;
       readonly lineage: ThreadLineage | null | undefined;
       readonly pinned: boolean;
       readonly focused: boolean;
       /** State-derived section, ignoring pin/focus placement. */
       readonly urgency: DelegatedNestingUrgency;
     }
     export interface DelegatedNestingPlan {
       readonly hostByChildKey: ReadonlyMap<string, string>; // host is always top-level
       readonly childKeysByHostKey: ReadonlyMap<string, ReadonlyArray<string>>; // input order
     }
     export function planDelegatedNesting(
       items: ReadonlyArray<DelegatedNestingItem>,
       options?: { readonly lineageByKey?: ReadonlyMap<string, ThreadLineage | null | undefined> },
     ): DelegatedNestingPlan;
     ```
     Rules:
     - Urgency rank: `needs-input` 0 < `active` 1 < `recent` 2 < `snoozed` 3 < `settled` 4.
     - **Can nest:** `isDelegatedThreadLineage(lineage)`, not `pinned`, not `focused`, and `urgency ∈ {recent, snoozed, settled}`.
       - This is the single attention predicate. Anything the adapter classifies as `needs-input` or `active` never nests.
       - Coordination with `usage-limits`: whatever section its new state maps to via web `sectionKey()` decides nesting. A state that must stay visible must map to `active` or `needs-input`.
     - **Nearest visible ancestor:**
       - Walk `parentThreadId` in the same environment, following only delegated links. Use the item index for visible threads and `lineageByKey` for invisible intermediates. Stop after 64 hops or on a revisit.
       - If the walk dead-ends, for example at a deleted middle child that has no shell, fall back to `rootThreadId` when that is visible.
     - **Urgency guard:** nest only if `rank(child) >= rank(host)`, i.e. the child is not more urgent than the host. Otherwise stay top-level. Only the _nearest_ visible ancestor is considered, so the result is predictable.
     - **Flatten:** follow candidate hosts to a top-level item with a visited set. A cycle leaves the involved items top-level. Urgency is transitive, so the flattened host is never less urgent than the child.
2. `state/threads/types.ts`: add `lineage?: ThreadLineage | null | undefined` to `Thread`, `ThreadShell` and `SidebarThreadSummary`.
3. `state/threads/store.ts`:
   - Set `lineage: thread.lineage ?? null` in `mapThread` (`:328`), in `mapThreadShell` for both shell and summary (`:363-438`), and in `toThreadShell` (`:441`). Otherwise a detail update would drop it from the shell.
   - Add `threadLineagesEqual(left.lineage, right.lineage)` to `sidebarThreadSummariesEqual` (`:550`) and `threadShellsEqual` (`:606`). Without it, a cached pre-lineage object compares "equal" to the live one and is never replaced.
   - New selector next to `selectSidebarThreadsForProjectRef` (`:2917`): `selectDelegatedChildThreadsForThreadRef(state, ref)`. It iterates `threadIdsByProjectId[parentShell.projectId]`, because the decider enforces same-project children, and falls back to all summaries when the parent shell is missing. It filters with `selectDelegatedChildThreads`.
   - Cache hydration (`:3155-3164`) and demotion (`:3209-3213`) spread the summary, so they already keep lineage. Covered by a test.
4. `state/agentControl/logic.ts`:
   - `AgentControlThreadActivity` gains `delegatedFromThreadId: ThreadId | null`. External activity returns `null`.
   - `selectAgentControlThreadActivity(state, threadId, lineage?: ThreadLineage | null)`. Keep the existing accepted-management filter and `decidedAt` ordering, then:
     ```ts
     const latestManager = principalThreadId(sorted[0]);
     const inferredCreator = principalThreadId(sorted.find((p) => p.plan.kind === "createThreads"));
     const delegatedFromThreadId = isDelegatedThreadLineage(lineage)
       ? lineage.parentThreadId
       : inferredCreator;
     const managerThreadId = latestManager === delegatedFromThreadId ? null : latestManager;
     ```
     The inference stays because it also covers threads an agent only messaged, interrupted or updated, and pre-lineage children.
5. `state/workspace/types.ts`: add `readonly lineage?: ThreadLineage | null` to `WorkspaceThreadMetadata`. Optional, so no schema-version bump; `isWorkspaceMetadataSnapshot` is unchanged.

### 4.10 Web

1. **Inbox model (`inboxSidebarModel.ts`).**
   - `InboxSidebarRow` gains `readonly lineage: ThreadLineage | null` and `readonly delegatedChildren: ReadonlyArray<InboxSidebarRow>` (empty unless the row is a host).
   - `BuildInboxSidebarInput` gains `readonly nestDelegated?: boolean` (default `true`).
   - After `rows` is built (`:442-555`), when `nestDelegated !== false` and `filters.query.trim() === ""`:
     - Build `lineageByKey` from **all** `input.threads`, so filtered or archived intermediates can be walked.
     - Map rows to `DelegatedNestingItem`, with `urgency = row.snoozedUntil ? "snoozed" : row.settled ? "settled" : sectionKey(row.state)` and `focused = row.focus !== null`.
     - Call `planDelegatedNesting`.
     - Remove children from `rows`, then attach them to their host as `delegatedChildren`, sorted with `compareRecent`.
   - Sections are built from the remaining top-level rows. Section counts are therefore top-level rows. Folded children are by construction quiet (recent, snoozed or settled), so the "Active now" and "Needs input" counts stay exact.
   - Text search disables folding: every match is its own row. A status filter keeps folding, but a host must itself pass the filter, otherwise the child stays top-level.
2. **`InboxDelegatedGroup.tsx` (new).** A compact disclosure under a host row:
   - One 20px line indented to the title column, with a chevron and `{n} delegated`.
   - `text-[11px] text-muted-foreground`, `aria-expanded`, `aria-label="Show {n} delegated threads from {host title}"`.
   - When expanded, the children render as normal `InboxThreadRow`s inside `ml-3 border-l border-sidebar-border/60 pl-1`. That is a guide line, not a card, so it is not container-in-container. `InboxThreadRow` itself is not edited.
3. **`InboxSidebar.tsx`.**
   - `nestDelegated: usePresentationTier() !== "phone"`.
   - `expandedHostKeys` state, default collapsed. A host is also forced open while `activeThreadKey` is one of its children.
   - Render `<Fragment key={row.key}><InboxThreadRow …/>{row.delegatedChildren.length ? <InboxDelegatedGroup …/> : null}</Fragment>` at `:330-345`.
   - Include the keys of expanded children in `orderSignature`, so `useInboxListMotion` animates them.
4. **`components/threads/threadLinkActivity.ts` (new).** `threadLinkActivityAt(thread) = thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt`, moved from `agentThreads.logic.ts:69-108`.
   - `agentThreads.logic.ts` imports it for sorting.
   - Delete `agentThreadActivityAt`; `AgentsSection` was its only user.
5. **`components/threads/ThreadLinkList.tsx` (new).** Props `{ threads: ReadonlyArray<SidebarThreadSummary>; tone: "rail" | "band" }`.
   - Renders a fragment of row buttons, so the caller owns the container. Each button is the exact markup and classes of today's `AgentsSection` rows (`AgentsSection.tsx:89-114`): `resolveInboxThreadStatus` → `InboxStatusGlyph`, the truncated title, `RelativeTime` (from `pullRequests/primitives`) and `router.navigate` with `buildThreadRouteParams`.
   - `AgentsSection` keeps its `<section>`, its `SectionLabel` and the band's `slice(0, 1)`, and delegates the rows. The DOM and visuals stay identical.
6. **`components/threads/DelegatedThreadsSection.tsx` (new).** Props `{ environmentId; parentThreadId: ThreadId | null }`.
   - Reads children with `useStore(useShallow(selectDelegatedChildThreadsForThreadRef))`; re-export the selector from `apps/web/src/store.ts`.
   - Returns `null` when there are none.
   - Otherwise renders a ghost `xs` disclosure, `Delegated threads · {n}` (count only, review #8), collapsed by default, inside `mx-auto mb-2 w-full min-w-0 max-w-208`, matching the Agent Control block.
   - Expanded: `ThreadLinkList tone="rail"` in a `max-h-[min(18rem,35dvh)] overflow-y-auto` column.
   - Per-row status glyphs are the only child progress shown. Aggregate child-result progress stays in `AgentControlThreadActivity` (owned by `delegation-returns`).
7. **`ChatView.tsx` (`:5036-5042`).** Directly before `<AgentControlApprovals>`, inside the same `presentationTier !== "phone"` guard:
   ```tsx
   <DelegatedThreadsSection
     key={`${environmentId}:${activeThreadId ?? ""}`}
     environmentId={environmentId}
     parentThreadId={activeThreadId}
   />
   ```
   Do not use `OverviewRail.tsx` (unmerged) or `PlanSidebar.tsx`.
8. **`AgentControlApprovals.tsx`.** Read `threadShellById[activeThreadId]?.lineage ?? null` from the environment state and pass it as the third argument to `selectAgentControlThreadActivity` (memo deps `[queueState, activeThreadId, activeLineage]`).
9. **`AgentControlThreadActivity.tsx`.**
   - Destructure `delegatedFromThreadId`.
   - The header line renders `Delegated from {link}` and/or `Managed by {link}`, joined with `·`, using the existing link markup and the existing title fallback.
   - The early `return null` also requires `delegatedFromThreadId === null`.
10. **`workspaceMetadataProjection.ts`.**
    - `readWorkspaceMetadataSnapshot` (`:64-89`) adds `...(isThreadLineage(thread.lineage) ? { lineage: thread.lineage } : {})`.
    - `workspaceMetadataToCachedShellSnapshot` (`:159-216`) sets the same `lineage` on the shell and summary. Invalid lineage is dropped, not rejected.

### 4.11 Mobile (no UI)

`apps/mobile/src/persistence/environmentSnapshotCodec.ts` `toWorkspaceMetadataSnapshot` (`:248-264`): add `...(isThreadLineage(shell.lineage) ? { lineage: shell.lineage } : {})` (review #9b).

- Stored shell/summary pairs already carry lineage as-is, because the store spreads them.
- Any future mobile display must validate with `isThreadLineage` and nest with `planDelegatedNesting`.

## 5. Contract and migration notes

- **Wire compatibility:**
  - Every new field is optional. Old clients strip unknown keys: Effect Schema's default `onExcessProperty` is ignore, see `SchemaAST.js:1693`.
  - Old servers never send lineage.
  - Old binaries replaying new `thread.created` events drop the lineage key.
  - The open `relationship` string (D2) means adding values later needs no client-first rollout. Unknown values render flat.
- **Out-of-order migration hazard (blocker found while verifying).**
  - Effect's `Migrator` runs only ids greater than the latest recorded id. See `node_modules/.bun/effect@4.0.0-beta.107/.../unstable/sql/Migrator.js:109-124`.
  - Pre-assigned 075 (`settlement-signals`, Wave 1) and 074 (`usage-limits`, same wave) can land on `main` before 071. Any database that already recorded 074 or 075 would then **never** run 071, and every `projection_threads` SELECT would fail on the missing columns.
  - Fix: 071 is idempotent and also runs as an unconditional repair hook (§4.2), following the existing pattern for exactly this situation (`Migrations.ts:387-404`).
  - The same hazard applies to **every** pre-assigned number lower than one that is already merged, including 072 and 073 relative to 074 and 075. Flag this to the wave coordinator.
- The dead 041 columns stay; dropping them is out of scope.

## 6. Tests

Server tests use `@effect/vitest` `it.effect`. Run each file focused, e.g. `bun run --cwd apps/server test src/orchestration/decider.lineage.test.ts`. Never `bun test`.

### Contracts — `packages/contracts/src/orchestration.test.ts`

1. `OrchestrationThreadShell` decodes with and without `lineage`. A lineage with `relationship: "future-kind"` decodes (lenient).
2. `ClientOrchestrationCommand` rejects `type: "thread.delegated.create"`. Decoding `thread.create` with extra `parentThreadId` or `lineage` keys strips them.
3. `OrchestrationCommand` accepts `thread.delegated.create`. `ThreadCreatedPayload` round-trips with lineage, and encodes without a `lineage` key when absent.

### Decider — `apps/server/src/orchestration/decider.lineage.test.ts` (new)

4. Child of a root parent: `payload.lineage = { parentThreadId: P, rootThreadId: P, relationship: "delegated" }`. All other payload fields equal those of a plain `thread.create` with the same fields.
5. Grandchild: `rootThreadId` is inherited from the parent's lineage.
6. Rejections, each an `OrchestrationCommandInvariantError` with `commandType "thread.delegated.create"`:
   - unknown parent
   - deleted parent
   - archived parent is **accepted**
   - parent in another project
   - `parentThreadId === threadId`
   - cycle via a re-created soft-deleted id, in three forms: X's old incarnation is the parent's parent, is the root, and is a **middle** ancestor
   - an ancestor chain deeper than `MAX_THREAD_LINEAGE_DEPTH`
7. Plain `thread.create` emits no `lineage` key. The existing `decider.import.test.ts` stays green.

### Projections

8. `projector.test.ts`: `thread.created` with lineage sets `thread.lineage`. Re-creating a soft-deleted id without lineage clears it.
9. `ProjectionPipeline.test.ts` + `persistence/Layers/ProjectionThreads.test.ts`:
   - The columns are written on `thread.created`.
   - They are **preserved** across `thread.archived`, `thread.meta-updated` and `thread.message-sent` upserts.
   - They are reset when the id is re-created.
   - Update `ProjectionThread` literal fixtures with the three `null` fields; other fixture files only need the fields.
10. `ProjectionSnapshotQuery.test.ts`: `getShellSnapshot`, `getThreadShellById`, `getThreadDetailById`, `getSnapshot` and `getCommandReadModel` all expose `lineage` for a child. A root thread has **no** `lineage` key (`assert.notProperty`).
11. `071_ProjectionThreadLineage.test.ts` (new; pattern from `066_StorageLifecycle.test.ts`):
    - Run to 70, insert a row, run to 71: columns are null, the index exists, existing data is untouched.
    - A second run is idempotent.
    - **Repair:** run all migrations, then drop the three columns (`ALTER TABLE … DROP COLUMN`) and the index, then `runMigrations()`. They are restored, which proves the hook covers the out-of-order case.

### Engine and command application

12. `OrchestrationEngine.test.ts`: a restart test modelled on **`:416`** ("restores durable approval claims after closing and reopening the database"), not `:636` (review #12).
    - Create P, then C via `thread.delegated.create` (parent P).
    - Close and reopen the SQLite file.
    - Dispatch G (parent C). Its `thread.created` payload has `rootThreadId === P`. This exercises the SQL `getCommandReadModel` hydration.
13. `OrchestrationCommandApplication.test.ts`: `applyInternal` dispatches an internal command unnormalized through the engine, and maps engine failures to `OrchestrationDispatchCommandError`.

### Agent Control

14. `AgentControlExecution.test.ts`:
    - **Harness:** `makeTestExecution` provides `applyInternal: stub.applyInternal ?? stub.apply`, so the existing stubs keep working.
    - `createThreads` + provider-session principal dispatches `thread.delegated.create` with `parentThreadId === "thread-origin"`, commandId `thread-create-0` and step `thread-created:0`.
    - **`automationRun` with a provider-session principal dispatches a plain `thread.create`** (review #1).
    - `createThreads` with an `external-integration` principal dispatches a plain `thread.create`.
    - Update "preserves an explicit created thread title…" (`:1083`, `:1091`) and the worktree-prefix test (`:1159`) to find `thread.delegated.create`.
    - The returnToOrigin test at `:1442` now issues `thread.delegated.create` too. It asserts only on `thread.turn.start`, and the harness fallback keeps it green (review correction 2).
15. `AgentControlProjectPreferences.test.ts`: add `applyInternal` to the stub (`:149`). Its assertion at `:226` looks for `thread.delegated.create`.

### client-runtime

16. `threadLineage.test.ts` (new), `planDelegatedNesting`:
    - A quiet child nests under its parent.
    - A working child does not.
    - A recent child under a settled host stays top-level, while a settled child under a recent host nests.
    - A pinned or focused child stays top-level.
    - A grandchild flattens to the top host.
    - An invisible intermediate is walked via `lineageByKey`.
    - Root fallback when an intermediate is missing.
    - Same id in another environment does not nest.
    - An unknown relationship does not nest.
    - A two-node cycle terminates with both top-level.
    - Children keep input order.
17. `threadLineage.test.ts`, the other helpers:
    - `selectDelegatedChildThreads` returns direct children only (no grandchild), excludes archived and unknown relationships, and orders by `createdAt`.
    - `threadLineagesEqual` holds for null against undefined.
18. `store.test.ts`:
    - A shell event with lineage populates shell and summary.
    - A second shell event that differs **only** in lineage replaces a cached pre-lineage summary (equality).
    - Detail `mapThread` → `toThreadShell` keeps lineage.
    - Cache hydration keeps lineage.
    - `selectDelegatedChildThreadsForThreadRef` works.
19. `logic.test.ts`, update and extend:
    - `:408` "uses creation receipts…" now expects `delegatedFromThreadId: caller, managerThreadId: null`, and with a newer sendMessage manager `managerThreadId: newer`.
    - `:469` keeps `managerThreadId: newManager` and adds `delegatedFromThreadId: <creator>`.
    - New: server lineage wins over a different inferred creator. A manager equal to the lineage parent is suppressed. A lineage with an unknown relationship falls back to inference.

### Web

20. `inboxSidebarModel.test.ts`:
    - An idle child under an idle parent is folded and absent from Recent, and the parent's `delegatedChildren` holds it.
    - **A working child under a Recent parent stays in Active now and is counted.**
    - A needs-input child under a working parent stays in Needs input.
    - An idle child under a working parent folds into the host in Active now.
    - A settled child under a Recent parent folds; a Recent child under a Settled parent stays.
    - Pinned and focused children stay in Pinned and Focus.
    - Grandchild flattening.
    - A non-empty query gives flat rows.
    - `nestDelegated: false` gives flat rows.
    - A host filtered out by a status filter leaves the child top-level.
21. `InboxSidebar.browser.tsx`:
    - The disclosure shows `1 delegated`, collapsed. A click reveals the child row.
    - A host whose child is `activeThreadKey` renders expanded.
22. `ThreadLinkList.browser.tsx` (new): the rail tone renders every row with glyph label and title; band shows the first row only through `AgentsSection`; a click navigates to the thread route.
23. `DelegatedThreadsSection.browser.tsx` (new):
    - No children renders nothing.
    - `Delegated threads · 2`, collapsed.
    - Expanding lists **direct** children in creation order. A grandchild is absent, which pins D8.
24. `AgentControlThreadActivity.browser.tsx`:
    - `Delegated from Coordinator` renders with only lineage.
    - `Delegated from A · Managed by B` renders when the selection has both.
    - The existing "Managed by" test (`:99`) is unchanged.
25. `workspaceMetadataProjection.test.ts`: lineage round-trips through capture and rehydrate. A malformed lineage is dropped and the snapshot is still accepted.

### Mobile

26. `environmentSnapshotCodec.test.ts`: `toWorkspaceMetadataSnapshot` keeps a valid lineage and drops a malformed one.

Validation for this package: run the focused files above, then `bun typecheck`. The change crosses contracts, server, client-runtime and web, which makes it a cross-package change in AGENTS.md terms. Finish with `bun run test` on the affected packages (`apps/server`, `packages/client-runtime`, `apps/web`, `packages/contracts`) and `bun lint` / `bun run fmt:check`.

## 7. Edge cases

- **The parent is deleted before execution.** Unreachable as a silent unlink: `revalidateExecution` (`:1062`) fails with caller-stale. If the delete races between revalidation and dispatch, the decider rejects it and the operation fails through the existing compensation.
- **The parent is archived.** The child is still linked. In the inbox the parent is excluded, so its children render top-level. The archived parent's thread view still lists them.
- **The child is deleted.** Nothing to do. The thread view and inbox read only live shells.
- **The parent is deleted after the children exist.** Children keep lineage pointing at a missing shell. The inbox renders them top-level, or under the root if the root is visible.
  - "Delegated from" falls back to the existing id-prefix label. This matches today's "Managed by" behaviour for unknown titles.
- **Re-created soft-deleted id.** Lineage is reset by the projector and the pipeline. Cycles are rejected at any depth by the decider walk (§4.3).
- **Crash between `thread.create` (old binary) and resume (new binary).** Receipt dedup by commandId returns the old result. That child has no lineage. It shows through the "Delegated from" fallback while it is in proposal history, and in the inbox it stays flat.
- **Children with `returnToOrigin`.** Both lineage and the completion return are recorded. They are independent, and the return logic does not read lineage.
- **External-integration or automation-owner principals, and automation runs.** No lineage (D4).
- **Many children.** The inbox disclosure is collapsed by default. The thread-view list is height-capped and scrolls.
- **Agent Control later disabled.** Lineage still shows ("Delegated from", Delegated threads, inbox folding), because it is projection data, not an Agent Control feature. Nothing becomes actionable.
- **Hosted cold start from the metadata cache.** Lineage is in the cache (§4.10.10), so folding does not flicker when the live shell arrives.

## 8. Security

- No new authority.
  - Lineage is never consulted by `AgentControlPolicy`, `AgentControlActionValidator`, the worktree-escalation guard, approvals, `CompletionReturnDelivery` or MCP tools.
  - Agents cannot approve anything through it.
  - Child output keeps its untrusted labelling, unchanged.
- No forgery.
  - The parent id comes from the server-side session-registry principal. `thread.delegated.create` exists only in `InternalOrchestrationCommand`.
  - Every external decode path uses `ClientOrchestrationCommand`: WS RPC `rpc.ts:1800` and HTTP `orchestration/http.ts:83`.
  - `SessionImport` decodes `OrchestrationCommand` only from its own table and only accepts `thread.history.import`.
- `applyInternal` is documented as never-for-client-input. It adds no capability that server modules lack today, since they can already obtain `OrchestrationEngineService`.

## 9. Coordination and sequencing

- **`delegation-returns` (W2, parallel).**
  - Must **not** depend on `lineage` in Wave 2. It keeps using `AgentControlCompletionReturn.parentThreadId`.
  - Merge order: **lineage first, returns rebases**. Shared file: `AgentControlExecution.ts`. Lineage edits the `dispatch` helper (`:487-512`) and the `thread-created` hunk (`:1063-1089`); returns edits the `returnToOrigin` block (`:1108-1146`).
  - Also shared: `logic.ts` `selectAgentControlThreadActivity`, where lineage adds `delegatedFromThreadId`, and `AgentControlThreadActivity.tsx`, where lineage edits only the header line and the null guard. Child-progress text stays with returns.
  - Exposing lineage in MCP (`ryco_list_threads` / `ryco_read_thread`, task status) is a **follow-up after both merge**.
- **`usage-limits` (W2).**
  - Adjacent field additions to `OrchestrationThreadShell`, the `ProjectionSnapshotQuery` shell builders, `mapThreadShell` and `sidebarThreadSummariesEqual`.
  - Semantic contract: any new inbox state must map through `sectionKey()`. Map it to `active` or `needs-input` if it must never fold.
  - Its migration 074 needs the same repair-hook treatment.
- **`delegation-guard-restart` (W1).** Same `getCommandReadModel` object literal, different property. Spec 04 lists an overlap on `AgentControlCompletionReturns.ts`; this package does **not** touch that file.
- **`settlement-signals` (W1, 075).** Triggers the §5 hazard; possible neighbouring shell fields.
- **`queue-hold-drain` (W1).** Neighbouring JSX in the ChatView composer stack.

## 10. Out of scope

- MCP/agent-facing lineage (follow-up after `delegation-returns`).
- Backfilling lineage for pre-lineage children.
- Lineage for automation runs, external integrations or forks. `relationship` is open for them.
- Folding in the classic project-tree sidebar (`Sidebar.logic.ts`), command palette or split-pane chrome.
- The web phone tier (frozen) and any mobile UI.
- A "from {parent}" hint on top-level live children.
- Archive or delete cascades from parent to children.
- Dropping the dead 041 columns.
- Moving `RelativeTime` out of `pullRequests/primitives`.
- Any change to the Overview rail or `PlanSidebar.tsx`.

## 11. Review resolution

| #   | Sev.       | Issue                                                                | Resolution                                                                                                                                                                                                           |
| --- | ---------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | correction | "Parent deleted before execution → unlinked child" is unreachable    | **Accepted.** Verified: `revalidateExecution` at `:1062` fails caller-stale (`AgentControlActionValidator.ts:757-761`). Edge cases rewritten (§7)                                                                    |
| C2  | correction | The `:1442` test would switch to the delegated command               | **Accepted.** Verified: it uses the provider-session `approvedProposal`. The harness falls back `applyInternal` → `apply`, and the test is listed in §6.14                                                           |
| C3  | correction | Agent-created automations run with provider-session principals       | **Accepted.** Verified at `AgentControlAutomation.ts:290/315/326/470`. Becomes D4                                                                                                                                    |
| 1   | major      | Scheduled-run threads mislabelled as children                        | **Accepted.** Gate on `plan.kind === "createThreads"` plus provider-session, with a test that automationRun stays a plain create (§4.8, §6.14)                                                                       |
| 2   | major      | Nesting hides live work from "Active now"                            | **Accepted, stricter than suggested.** Only quiet children (`recent`/`snoozed`/`settled`) fold, and only under a host that is at least as urgent. Live and attention children stay top-level and counted (D7, §6.20) |
| 3   | major      | Redundant pre-loop parent lookup; contradictory "unlinked" behaviour | **Accepted.** No lookup. Always dispatch `thread.delegated.create` for D4 cases; the decider is the single authority. Test 6c replaced by decider rejection tests (§6.6)                                             |
| 4   | major      | DelegatedThreadsSection duplicates AgentsSection                     | **Accepted.** Shared `ThreadLinkList`, `AgentsSection` refactored with identical DOM, and a new browser test, because AgentsSection has no direct test today (§4.10.5, §6.22)                                        |
| 5   | minor      | The nesting policy is web-only                                       | **Accepted.** Generic `planDelegatedNesting` in client-runtime; urgency is the single attention predicate; the usage-limits contract is named (§4.9, §9)                                                             |
| 6   | minor      | Lineage cycle via re-created id                                      | **Accepted, broadened.** The decider walks the full ancestor chain, not just parent and root, with a depth cap (§4.3)                                                                                                |
| 7   | minor      | Lineage silently changes "Managed by"                                | **Accepted.** Two labels, two facts; the manager is hidden only when it equals the lineage parent (D6)                                                                                                               |
| 8   | minor      | "Delegated threads · 2 delegated · 1 working" repeats facts          | **Accepted.** Count only in the thread view; aggregate child progress stays in the Agent Control block (returns). The inbox disclosure says `{n} delegated`                                                          |
| 9   | minor      | Thread view and inbox show different trees                           | **Accepted.** D8 documents "direct children" against "flatten to topmost host", pinned by §6.20 and §6.23                                                                                                            |
| 9b  | minor      | Mobile codec drops lineage                                           | **Accepted.** One-line codec change plus web metadata projection (§4.10.10, §4.11)                                                                                                                                   |
| 10  | minor      | Reserved literal union breaks old clients                            | **Accepted.** `relationship` is an open bounded string (D2)                                                                                                                                                          |
| 11  | minor      | Wrong engine test harness                                            | **Accepted.** Modelled on the `:416` close/reopen test (§6.12)                                                                                                                                                       |
| 12  | minor      | Under-specified sequencing with delegation-returns                   | **Accepted.** Lineage merges first; returns does not depend on lineage in W2; MCP exposure is a follow-up (§9)                                                                                                       |
| new | blocker    | Out-of-order pre-assigned migrations                                 | **Added by this spec.** 071 is idempotent and registered as an unconditional repair hook. The wave coordinator should apply the same rule to 072–075 (§5)                                                            |
| new | major      | `parent_thread_id` already exists with stale data                    | **Added by this spec.** Use new `lineage_*` columns; do not reuse it (D12)                                                                                                                                           |

## 12. Risks

- **Wide fixture churn.** The `ProjectionThread` fields are deliberately required. Mitigation: the edits are mechanical, and the alternative risks silent lineage loss.
- **Missed builder.** One of the six snapshot builders could be missed, so a surface silently lacks lineage. Mitigation: the §6.10 test asserts every reader.
- **Inbox visual crowding.** The disclosure line could crowd the inbox, and the highlight could mis-size on nested rows. Mitigation: visual check with the dev pairing setup; the disclosure renders only for hosts.
- **Migration repair runs every startup.** It costs one `PRAGMA table_info`. Negligible, and the same as the existing repairs.
- **Old children stay flat.** Children created during the upgrade window, or before it, stay flat in the inbox. Accepted: there is no backfill, and the fallback "Delegated from" still covers recent ones.
