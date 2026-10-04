# 04 · delegation-guard-restart: delegated returns rejected after restart (bug 7)

| Field | Value |
| --- | --- |
| id | `delegation-guard-restart` |
| title | Hydrate the first and latest user message into the command read model so the delegated-return fence holds after a restart |
| wave | 1 (parallel, isolated worktree) |
| verdict | **partially-confirmed**. The mechanism is real and reproducible with the real engine. User-visible impact today is narrow, because two live-runtime checks block most post-restart returns first. It becomes the main failure path once `delegation-returns` (Wave 2) relaxes those checks |
| size | S |
| touched files | `apps/server/src/persistence/userMessageAnchors.ts` (new) · `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` · `apps/server/src/persistence/Layers/AgentControlCompletionReturns.ts` (one function, same SQL semantics) · `apps/server/src/orchestration/projector.ts` (one line plus one helper) · tests: `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`, `apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts`, `apps/server/src/orchestration/projector.test.ts` |
| migrations | none (no number used) |
| contract changes | none. `OrchestrationThread.messages` keeps its schema. The command read model now holds up to 2 user messages per thread instead of 1. The same model is the payload of the owner-only legacy `GET /api/orchestration/snapshot` (`http.ts:42-53`) and of the offline CLI (`cli.ts:1152-1155`); neither reads `messages` |
| overlaps | `delegation-returns` (W2): semantic dependency, plus `AgentControlCompletionReturns.ts` `latestUserMessageId`. `delegation-lineage` (W2): `AgentControlCompletionReturns.ts`. `rollback-correctness` (W2): projector revert on the hydrated model. `settlement-signals` (W1): semantic, needs a correct `latestUserMessageAt`. `queue-hold-drain` (W1): constraint on role=`user` rows, possible `getCommandReadModel` tuple edit. `acp-message-ids` (W1): `projector.ts` `thread.message-sent` case. `claude-steering` (W2): semantic, steer rows. `turn-finalization` (W1) / `restart-continuation` (W3): possible `getCommandReadModel` hydration edits |

---

## 1. Problem (verified against the code at `9e545b3ae`)

1. **The engine builds its command model once.** `OrchestrationEngine.ts:539-540` runs `projectionPipeline.bootstrap`
   and then `commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel()`. After that the model only
   advances in memory:
   - on commit, at `:445`
   - by replaying persisted events after a failed dispatch, at `:197`

   It is never rebuilt from SQL while the process runs.
2. **The lightweight snapshot holds only the first user message.** `ProjectionSnapshotQuery.ts:726-760` defines
   `listFirstUserMessageRows`, a `NOT EXISTS` anti-join that picks the earliest user message per thread
   (`created_at ASC, message_id ASC`). Then:
   - `:2283-2297` maps it into `firstUserMessageByThread`
   - `:2411-2413` sets `messages` to `[first]` or `[]`
3. **The fence compares that against the true latest.** For `thread.turn.start` with a `delegationReturnGuard`,
   `decider.ts:1008-1033` computes `targetThread.messages.findLast(role === "user")` and requires
   `(latestUserMessage?.id ?? null) === guard.latestUserMessageId`.
4. **The guard's latest id comes from SQL.** `CompletionReturnDelivery.ts:338` (capture) and `:410` (re-read just before
   dispatch) fill `guard.latestUserMessageId` from `AgentControlCompletionReturns.ts:133-139`:
   `role = 'user' ORDER BY created_at DESC, rowid DESC LIMIT 1`, the true latest user message.
5. **Result.** After a restart, take a parent whose latest user message predates the restart and that has 2 or more
   user messages. In memory, `findLast(user)` returns the *first* message, while the guard holds the *latest*. The decider
   rejects the return with "Delegated result origin changed…".

   Without a restart the projector appends every message (`projector.ts:672-696`), so `findLast` is correct. A user
   message sent after the restart is appended too, which heals the thread. So the bug applies only while the parent's
   latest user message predates the restart.

### Why "partially" confirmed (impact today)

- **Mask 1: the delivery-side live-session check.** Before any dispatch, `CompletionReturnDelivery.ts:232-243` requires
  `providers.getSession(parent)` to be live with the same `runtimeSessionId` and provider instance.
  - After a restart, `ProviderService.getSession` (`ProviderService.ts:859-869`) returns `None` until the adapter holds a
    session again.
  - The first scan runs as soon as `awaitCommandReady` resolves (`CompletionReturnDelivery.ts:460-470`), and it marks
    such records `blocked`.
  - `blocked` is terminal: `listDue` (`AgentControlCompletionReturns.ts:78-80`) only selects `waiting/ready/dispatching`.
- **Mask 2: the event-side live-session check.** `ProviderCommandReactor.ts:1204-1228` checks `providerService.getSession`
  again against `guard.runtimeSessionId` and `guard.providerInstanceId`. On a mismatch it appends "Delegated return was
  not submitted" and returns. So even a return that the decider accepts after a restart is dropped unless the runtime
  was recovered under the same id.
- **The decider path is reachable today, but only narrowly.**
  - Ready sessions survive a restart, because startup reconciliation only touches `starting`/`running`/`activeTurnId`
    sessions (`serverRuntimeStartup.ts:616-623`).
  - The runtime can come back under the same `runtimeSessionId` (`ProviderService.ts:714-716`) through the
    `allowRecovery: true` paths `interruptTurn` (`:1327`) and `rollbackConversation` (`:1622`), without a new user
    message being appended.
- **The planned Wave 2 change exposes the bug fully.** `delegation-returns` plans to relax the exact-turn and
  same-session checks to "queue on the parent thread" (comparison doc §2 row 3). The decider fence then becomes the
  authoritative post-restart check, and this bug would block *every* return to a parent with 2 or more pre-restart user
  messages. **This package is a prerequisite for `delegation-returns`.**
- **The fence is weaker after a restart than before it, but this is not exploitable.**
  - Before a restart, a guard pinned to the *first* user message (`latestUserMessageId = turnMessageId = first`) is
    rejected. After a restart it is accepted, because `findLast` = first.
  - `CompletionReturnDelivery` cannot produce such a guard: `:402-411` always re-reads the latest id from SQL just before
    dispatch.
  - A user start that lands after the restart is appended in memory, so a concurrent start still rejects.
  - `ClientThreadTurnStartCommand` accepts a client-supplied guard (`packages/contracts/src/orchestration.ts:1437`). But a
    guard only *adds* rejection conditions. Its only other effect is to skip session-error marking on a failed start
    (`ProviderCommandReactor.ts:1162-1167`). It grants no capability, so this is not an Agent Control escalation.
  - Test B2 pins the fence strength as a regression test.
- **Settlement reads the stale value today, and this is the live exposure.** `threadSettlementInput.ts:38-46` derives
  `latestUserMessageAt` from the in-memory `messages`. That value feeds `decider.ts:588` (snooze), `decider.ts:654`
  (settle) and `sidebarUndo.ts:145`.
  - After a restart it reports the *first* message's `createdAt`.
  - So the `queued-turn` blocker (`packages/shared/src/threadSettlement.ts:71-90`) can be missed for up to 2 minutes
    after a pre-restart user message whose turn was never requested.
  - It would also undermine `settlement-signals`' planned "the user kept working after the PR merged" comparison.

### Audit: every reader of the command model's `thread.messages`

| Reader | Location | Needs | Before the fix | After the fix |
| --- | --- | --- | --- | --- |
| Delegated-return fence | `decider.ts:1008-1033` | `findLast(user).id` equal to the SQL latest | after a restart: rejects valid returns and accepts a first-pinned guard | **fixed** |
| `isStartedThread` → context handoff | `decider.ts:1036` | `some(user)` | OK after a restart (first anchor). Broken by the message cap (row below) | OK |
| `requireThreadHasUserMessage` (archive) | `decider.ts:541` → `commandInvariants.ts:313-330` | `some(user)` | OK after a restart. Broken by the message cap | OK |
| Settle / snooze / undo eligibility | `threadSettlementInput.ts:38-46` → `decider.ts:588`, `:654`, `sidebarUndo.ts:145` | max user `createdAt` | under-reported after a restart | **fixed** |
| Message cap | `projector.ts:696` (`slice(-2000)`) | — | evicts both anchors in any thread with more than 2,000 messages since its latest user message, **even without a restart**. Then `findLast` is `undefined` (the fence fails closed), `isStartedThread` is false (a model switch skips the atomic context handoff), and archive is rejected with "cannot be archived before a message has been sent", until the next restart | **fixed** (Step 4) |
| Existing-message merge | `projector.ts:672` | — | a `message-sent` for an id that was not hydrated appends a new entry | unchanged (see Edge cases) |
| Revert fallback | `projector.ts:100-140`, `:890-937` | checkpoints | after a restart `checkpoints: []`, so `latestTurn` becomes null; user anchors are retained by count | unchanged. New side effect: see Edge cases → `rollback-correctness` |
| SQL readers | `ProviderCommandReactor.ts:380-411` (message lookup, user count), `ContextHandoffCoordinator.ts:275`, `CheckpointReactor.ts:209`, `ProviderRuntimeIngestion.ts:3130` (all via `getThreadDetailById` or targeted queries) | — | unaffected | unaffected |

No other `getCommandReadModel` consumer (`serverRuntimeStartup.ts:570`, `:741`, `http.ts:45`, `cli.ts:1154`) reads
`messages`.

## 2. Approach

**Hydrate two user-message anchors per thread, first and latest, in `getCommandReadModel`.** "Latest user message" gets a
single SQL definition, shared by the anchor query and `CompletionReturnDelivery`'s repository. The in-memory message cap
also keeps both anchors, so the invariant holds for the whole process lifetime and not only at bootstrap:

> **Invariant.** For every thread in the engine's command model, `messages` contains the thread's first user message
> (if any) and its latest user message. `messages.findLast(role === "user")` is the row `latestUserMessageIdQuery`
> returns, at bootstrap and for as long as appended user messages arrive in `createdAt` order.

This package does **not** change the decider, `CompletionReturnDelivery`, contracts or migrations. The fence semantics
belong to `delegation-returns` (Wave 2).

Why keep the first anchor when the latest alone satisfies `some(user)`?
- It keeps the existing documented hydration exactly. The first-anchor ordering is unchanged.
- After a restart, the common "revert to 1 turn" then falls back to the first message, which is correct, rather than to
  a reverted latest message.

### Rejected alternatives

- **(a) A `latest_user_message_id` column on `projection_threads`.** Its upkeep could piggyback on the existing
  `latest_user_message_at` column: set at `ProjectionPipeline.ts:1026`, recomputed at `:719-738`, already selected by
  `listThreadRows` (`ProjectionSnapshotQuery.ts:625`) and dropped by `getCommandReadModel`. Rejected because:
  - it needs a migration, and this package has no pre-assigned number
  - it needs a backfill
  - the decider would still need a new `OrchestrationThread` field (a contract change) or a side channel
- **(b) A dedicated `latestUserMessageId` thread field read by the fence.** Rejected because:
  - it is a contract change in schema-only `packages/contracts`
  - it adds new projector upkeep
  - it edits the decider fence, which `delegation-returns` owns in Wave 2
- **(c) A window-function query** (`ROW_NUMBER() OVER (PARTITION BY thread_id …)`). Rejected in favour of correlated
  per-thread `LIMIT 1` subqueries. The window form scans every user row and sorts twice in temp B-trees.

  Measured in scratch sqlite3 3.54 with the real schema and indexes
  (`idx_projection_thread_messages_thread_created(thread_id, created_at)` and `…_created_id(thread_id, created_at, message_id)`):

  | Dataset | current `NOT EXISTS` | window | correlated (chosen) |
  | --- | --- | --- | --- |
  | 600k messages, 3k threads, 300k user rows, interleaved | 0.28 s | 0.46 s | **0.014 s** |
  | worst case: 600k messages, 3k threads, one user message per thread followed by 199 assistant messages | 0.18 s | 0.18 s | 0.18 s |

  In the worst case, each `latest_user` probe walks back over the assistant rows that follow the latest user message.
  The total work is bounded by the message count, so the chosen query is never slower than today's.

  Plan: `SCAN threads` → `SEARCH messages USING INDEX sqlite_autoindex_projection_thread_messages_1 (message_id=?)`
  → 2 × correlated `SEARCH … (thread_id=?)`. The implicit `rowid` suffix of `idx_projection_thread_messages_thread_created`
  satisfies `created_at DESC, rowid DESC` without a sort.
  (A role-partial index would make every probe O(1), but it needs a migration; that is a follow-up.)
- **(d) Hydrate full history.** Rejected because of startup cost and memory; the lightweight model exists to avoid it.

## 3. Step-by-step changes

### Step 1: new `apps/server/src/persistence/userMessageAnchors.ts`

The module is a sibling of `persistence/messageText.ts`, the precedent for code-owned SQL fragments built with
`sql.literal`. It is server-only, so it does not go in `packages/shared`. In effect `4.0.0-beta.107`, a `Statement<A>` is both a
`Fragment`, so it can be interpolated into another `sql` template, and an `Effect`, so it can be executed directly. One builder serves
both consumers.

```ts
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as Statement from "effect/unstable/sql/Statement";

/** A bound thread id, or a code-owned column reference such as sql.literal("threads.thread_id"). */
type ThreadRef = string | Statement.Fragment;

/** First user message: oldest created_at, ties by message_id. Proves the thread has started. */
export const firstUserMessageIdQuery = (sql: SqlClient.SqlClient, thread: ThreadRef) =>
  sql<{ readonly messageId: string }>`
    SELECT first_user.message_id AS "messageId"
    FROM projection_thread_messages first_user
    WHERE first_user.thread_id = ${thread} AND first_user.role = 'user'
    ORDER BY first_user.created_at ASC, first_user.message_id ASC
    LIMIT 1
  `;

/**
 * The ONE definition of a thread's latest user message: newest created_at, ties broken by
 * insertion order (rowid). The delegated-return fence compares the engine's hydrated anchor
 * (ProjectionSnapshotQuery.getCommandReadModel) with CompletionReturnDelivery's read
 * (CompletionReturnRepository.latestUserMessageId). Any divergence rejects valid returns or
 * weakens the fence. Never inline this ordering elsewhere.
 */
export const latestUserMessageIdQuery = (sql: SqlClient.SqlClient, thread: ThreadRef) =>
  sql<{ readonly messageId: string }>`
    SELECT latest_user.message_id AS "messageId"
    FROM projection_thread_messages latest_user
    WHERE latest_user.thread_id = ${thread} AND latest_user.role = 'user'
    ORDER BY latest_user.created_at DESC, latest_user.rowid DESC
    LIMIT 1
  `;
```

The JS timestamp-only derivations (`threadSettlementInput.ts:38-46` and `ProjectionPipeline.ts:719-724`) compute the
maximum `created_at`, which does not depend on tie-breaking. They stay as they are.

### Step 2: `AgentControlCompletionReturns.ts`, `latestUserMessageId` (`:133-139`) only

Replace the inline SQL with the shared builder. The SQL semantics are identical (same filter, same ordering, same
row), and the signature is unchanged:

```ts
const latestUserMessageId = (threadId: ThreadId) =>
  safe(
    latestUserMessageIdQuery(sql, threadId).pipe(
      Effect.map((rows) => (rows[0] ? MessageId.make(rows[0].messageId) : null)),
    ),
  );
```

`threadId` stays a bound parameter. Do not touch any other function in this file, because `delegation-lineage` and
`delegation-returns` edit it in Wave 2.

### Step 3: `ProjectionSnapshotQuery.ts`

1. Replace `listFirstUserMessageRows` (`:726-760`, comment included) with `listUserMessageAnchorRows`:

   ```ts
   // The command read model does not load full message history. It keeps two
   // user-message anchors per thread:
   // - first: the thread has accepted a user turn, so a provider/model change after
   //   a restart still takes the atomic context-handoff path;
   // - latest: the delegated-return fence (decider thread.turn.start) and settlement
   //   read messages.findLast(user). It MUST be the row CompletionReturnDelivery
   //   reads, hence the shared latestUserMessageIdQuery.
   // Rows are ordered so a thread's latest anchor is always its last row.
   // Do NOT add `messages.thread_id = threads.thread_id`: it flips the plan to a
   // full SCAN of projection_thread_messages (guarded by a test).
   const listUserMessageAnchorRows = SqlSchema.findAll({
     Request: Schema.Void,
     Result: ProjectionThreadMessageDbRowSchema,
     execute: () =>
       sql`
         SELECT
           messages.message_id AS "messageId",
           messages.thread_id AS "threadId",
           messages.turn_id AS "turnId",
           messages.role,
           ${messageTextColumns(sql, "messages")},
           messages.attachments_json AS "attachments",
           messages.dispatch_mode AS "dispatchMode",
           messages.is_streaming AS "isStreaming",
           messages.created_at AS "createdAt",
           messages.updated_at AS "updatedAt"
         FROM projection_threads threads
         JOIN projection_thread_messages messages
           ON messages.message_id IN (
             (${firstUserMessageIdQuery(sql, sql.literal("threads.thread_id"))}),
             (${latestUserMessageIdQuery(sql, sql.literal("threads.thread_id"))})
           )
         ORDER BY messages.thread_id ASC, messages.created_at ASC, messages.rowid ASC
       `,
   });
   ```

   **Why the ordering is correct.** The latest anchor has the maximum `created_at`, and among ties the maximum `rowid`:
   - If its `created_at` differs from the first anchor's, it sorts last by `created_at`.
   - If the two are equal, the first anchor is in the same tie set, so its `rowid` is ≤ the latest's, and the latest
     sorts last by `rowid`.

   A message that is both first and latest appears once, because `IN` deduplicates. A thread with no user message produces no row
   (`IN (NULL, NULL)`). The thread scope is implicit: `message_id` is the global PK, and both subqueries filter by
   `thread_id`. Only threads present in `projection_threads` are hydrated, which matches the consumer loop.

   I verified this in scratch sqlite3, including the real `messageTextColumns` chunk subquery:
   - many → `[m1, m3]`
   - single → `[s1]`
   - no user message → no row
   - tie → `[tie-a, tie-b]`, where `tie-b` equals the repository query's result
   - tie with the same row → `[tie2-a]`

   The plan is as stated in §2(c). Adding the redundant `thread_id` predicate produces
   `SCAN messages USING INDEX idx_projection_thread_messages_thread_created`.
   Import `firstUserMessageIdQuery` and `latestUserMessageIdQuery` from `../../persistence/userMessageAnchors.ts`.

2. In `getCommandReadModel` (`:2148-2437`):
   - Tuple slot `:2176-2183`: call `listUserMessageAnchorRows(undefined)` and rename the error labels to
     `ProjectionSnapshotQuery.getCommandReadModel:listUserMessageAnchors:query` / `…:decodeRows`.
   - Destructuring `:2232`: rename `firstUserMessageRows` to `userMessageAnchorRows`.
   - `:2244`: replace `firstUserMessageByThread: Map<string, OrchestrationMessage>` with
     `userMessageAnchorsByThread: Map<string, OrchestrationMessage[]>`.
   - Loop `:2283-2297`:
     - keep `updatedAt = maxIso(updatedAt, row.updatedAt)`
     - build each message with the existing `mapMessageRow(row)` (`:367-385`) instead of the inline object. That removes
       the duplicate mapping and carries `dispatchMode`, as the projector does.
     - push the message onto the thread's array in SQL order
   - `:2411-2413`: `messages: userMessageAnchorsByThread.get(row.threadId) ?? []`.
   - Side effect: `readModel.updatedAt` may advance to the latest anchor's `updatedAt`. That is more accurate, and no
     decision reads it.

### Step 4: `projector.ts`, keep both anchors when capping (`thread.message-sent` only)

Add a top-level helper next to `retainThreadMessagesAfterRevert`. In the `thread.message-sent` case, change only line `:696` to
`const cappedMessages = capThreadMessagesPreservingUserAnchors(messages);`.

```ts
/**
 * Caps in-memory history without evicting the thread's first or latest user message.
 * The command model depends on both: some(user) (thread started → context handoff,
 * archive) and findLast(user) (delegated-return fence, settlement). Identical to
 * slice(-MAX_THREAD_MESSAGES) whenever both anchors lie within the newest window.
 */
function capThreadMessagesPreservingUserAnchors(
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<OrchestrationMessage> {
  let excess = messages.length - MAX_THREAD_MESSAGES;
  if (excess <= 0) return messages;
  const firstUserId = messages.find((message) => message.role === "user")?.id;
  const latestUserId = messages.findLast((message) => message.role === "user")?.id;
  return messages.filter((message) => {
    if (excess === 0 || message.id === firstUserId || message.id === latestUserId) return true;
    excess -= 1;
    return false;
  });
}
```

The helper keeps relative order, and the result length is exactly `MAX_THREAD_MESSAGES`. Its cost is O(n), the same as
the current `slice`.

Leave the revert path's `.slice(-MAX_THREAD_MESSAGES)` (`:907`) alone. Revert retention belongs to
`rollback-correctness` (Wave 2), and that slice is a no-op in practice. The existing cap test
(`projector.test.ts:954-1053`, assistant-only messages) is unaffected.

## 4. Contract / migration changes

None. There is no schema change, no new event or command, and no migration number is used.

The only observable payload difference is in the command read model, and therefore in the owner-only
`GET /api/orchestration/snapshot` and the offline CLI's `getOfflineSnapshot`. Both now carry up to 2 user messages per
thread instead of 1.

## 5. Tests (failing-first)

Each test lists its pre-fix result.

### A. `ProjectionSnapshotQuery.test.ts`: new `it.effect("hydrates first and latest user message anchors for the command read model")`

Add it inside `projectionSnapshotLayer("ProjectionSnapshotQuery", …)`. The file shares one in-memory DB, so start with the
same `DELETE FROM …` block as the `:1619` test.

Seed `projection_threads` rows with the column list used at `:116-124`, and `projection_thread_messages` rows, with direct SQL.
Insert order matters, because it sets `rowid`:

| Thread | Messages, in insert order | Expected `messages` ids |
| --- | --- | --- |
| `t-many` | user `m1`@t1, assistant `a1`@t2, user `m2`@t3, user `m3`@t5, assistant `a3`@t6 | `[m1, m3]` |
| `t-single` | user `s1`@t1, assistant `sa`@t2 | `[s1]` |
| `t-none` | assistant `na`@t2 only | `[]` |
| `t-tie` | user `tie-c`, `tie-a`, `tie-b`, all at the same `created_at` | `[tie-a, tie-b]` (first by `message_id`, latest by `rowid`) |
| `t-tie-same` | user `tie2-b`, `tie2-c`, `tie2-a`, all at the same `created_at` | `[tie2-a]` (first and latest are the same row) |

Assertions:
- **A1.** `getCommandReadModel()` returns exactly the ids above.
  *Pre-fix: fails* (`t-many` → `[m1]`, `t-tie` → `[tie-a]`).
- **A2 (lockstep oracle).** `const repo = yield* makeCompletionReturnRepository`, from
  `persistence/Layers/AgentControlCompletionReturns.ts`. It needs only `SqlClient`, which the layer provides. For **every**
  thread, assert `(thread.messages.findLast((m) => m.role === "user")?.id ?? null) === (yield* repo.latestUserMessageId(thread.id))`.
  *Pre-fix: fails* for `t-many` and `t-tie`. After the fix, this is the drift guard between the two consumers of the shared builder.
- **A3 (plan guard).** Capture the anchor statement with `SqlStatement.CurrentTransformer`, the same pattern as `:131-142`,
  matching on `compiled[0].includes("latest_user")`. Provide the transformer only around `getCommandReadModel()`. Run
  `EXPLAIN QUERY PLAN ${statement}` with the captured params and assert:
  - no detail matches `/SCAN (messages|first_user|latest_user)\b/`
  - a detail matches `/SEARCH messages .*\(message_id=\?\)/`
  - a detail matches `/SEARCH first_user .*\(thread_id=\?\)/`
  - a detail matches `/SEARCH latest_user .*\(thread_id=\?\)/`

  The chunk subquery's `SCAN parts` and `SCAN CONSTANT ROW` do not match.
  *Pre-fix: fails* (no such statement is captured).

Also update the existing assertion at `ProjectionSnapshotQuery.test.ts:1853-1856` from `[message-user-first]` to
`[message-user-first, message-user-second]`, with a one-line comment that this behaviour change is intended. The capture test at
`:111-172` filters on `JOIN projection_turns turns` and is unaffected.

### B. `OrchestrationEngine.test.ts`: restart regression with the real engine, pipeline and file-backed SQLite

These are promise-style `vite-plus/test` tests, like the rest of the file.

**Harness.** `createOrchestrationSystem` (`:79-112`) gets one test-only addition:
`commandReadModel: () => runtime.runPromise(snapshotQuery.getCommandReadModel())`. Right after a restart, with no commands
dispatched yet, this is exactly what `OrchestrationEngine.ts:540` loaded.

Get the repository with
`system.run(makeCompletionReturnRepository.pipe(Effect.provideService(SqlClient.SqlClient, system.sql)))`.
`run` is typed with `R = never`, so the service must be provided explicitly.

**Seed helper `seedDelegationParent(databasePath?)`.** Like `seedSidebarUndoSystem` (`:1870`), it uses only engine
commands and no reactors. Use `at(s) = new Date(Date.parse("2026-01-01T00:00:00.000Z") + s * 1000).toISOString()`.
- `projectId = "delegation-project"`, `threadId = "delegation-parent"`
- `modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "fixture" }`

Steps:
1. `project.create` (`workspaceRoot: "/tmp/ryco-delegation-fixture"`, `defaultModelSelection: modelSelection`, `createdAt: at(0)`).
2. `thread.create` (`modelSelection`, `interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE`, `runtimeMode: "full-access"`,
   `branch: null`, `worktreePath: null`, `createdAt: at(0)`).
3. For each turn *n* ∈ {1, 2}, with `t = n === 1 ? 1 : 10`:
   - `thread.turn.start`:
     `{ commandId: "start-n", threadId, message: { messageId: "msg-n", role: "user", text: "Fixture n", attachments: [] }, runtimeMode: "full-access", interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE, createdAt: at(t) }`
   - `thread.session.set` running:
     `{ commandId: "running-n", threadId, session: { threadId, status: "running", providerName: "codex", providerInstanceId: ProviderInstanceId.make("codex"), runtimeSessionId: RuntimeSessionId.make("runtime-1"), runtimeMode: "full-access", activeTurnId: TurnId.make("turn-n"), lastError: null, updatedAt: at(t + 1) }, createdAt: at(t + 1) }`
   - `thread.message.assistant.complete`:
     `{ commandId: "answer-n", threadId, messageId: "answer-n", turnId: "turn-n", text: "Fixture answer", createdAt: at(t + 2) }`
   - `thread.session.set` ready: the same session payload with `status: "ready"`, `activeTurnId: null`,
     `updatedAt: at(t + 3)`, and `createdAt: at(t + 3)`.
   - `thread.turn.diff.complete`:
     `{ commandId: "diff-n", threadId, turnId: "turn-n", completedAt: at(t + 3), checkpointRef: CheckpointRef.make("fixture-checkpoint-n"), status: "ready", files: [], assistantMessageId: "answer-n", checkpointTurnCount: n, createdAt: at(t + 3) }`

   This mirrors `ProviderCommandReactor.test.ts:566-645`. The `running` session-set links `msg-n` to `turn-n` in
   `projection_turns.pending_message_id` (`ProjectionPipeline.ts:1717-1788`).

**`buildReturn(system, overrides?)`** mirrors `CompletionReturnDelivery.ts:336-370` and `:392-412`:
- Read `shell` (the parent thread) from `system.readShell()`.
- Derive the guard's SQL fields from the **repository functions**:
  - `turnId = shell.latestTurn!.turnId`
  - `turnMessageId = repo.turnMessageId(threadId, turnId)`; assert it is not null, as a fixture check
  - `latestUserMessageId = repo.latestUserMessageId(threadId)`
- Take the rest of the guard from `shell`: `projectId`, `runtimeSessionId: shell.session!.runtimeSessionId!`,
  `providerInstanceId: shell.session!.providerInstanceId!`, `runtimeMode`, `worktreePath`.
- Take the command fields `modelSelection`, `runtimeMode`, `interactionMode` and `tokenMode` (only when defined) from `shell` as
  well. Taking `modelSelection` from the shell matches production and keeps the key order that the decider compares with
  `JSON.stringify`.
- Spread `overrides` last into the guard.
- Message: `{ messageId: "delegation-result:child-1", role: "user", text: "Fixture delegated result", attachments: [] }`,
  `commandId: "delegation-return:child-1"`, `createdAt: at(30)`.
- Add a comment: *"Mirrors CompletionReturnDelivery's guard construction. If delegation-returns extracts a shared guard
  builder, call it here instead."*

**Cases** (temp-dir DB via `fs.mkdtemp`, cleaned up in `finally`, like the `:2076` restart test):
- **B0 (control, no restart).** Seed, `buildReturn`, dispatch → resolves. Then
  `repo.latestUserMessageId(parent)` is `delegation-result:child-1`.
  *Pre-fix: passes.* It proves the fixture is valid: session payload, key order, turn binding.
- **B1 (restart).** Seed into a file DB, `dispose()`, then `createOrchestrationSystem(sameDb)`.
  - Oracle: the parent in `commandReadModel()` has `messages` ids `[msg-1, msg-2]`.
  - Oracle: `findLast(user).id === repo.latestUserMessageId(parent)`, which is `msg-2`.
  - Oracle: `findLast(user).createdAt === threadSettlementInput(model, parent, at(30)).latestUserMessageAt`, which equals
    `SELECT latest_user_message_at FROM projection_threads WHERE thread_id = 'delegation-parent'`, which equals `at(10)`.
    That column is pipeline-maintained (`ProjectionPipeline.ts:1026`), so this ties the anchor to the shell-side
    settlement field. The oracle lives here rather than in A, because A's hand-inserted fixture would make it tautological.
  - Then `buildReturn` and dispatch → **resolves**.

  *Pre-fix: fails.* The dispatch is rejected with "Delegated result origin changed", and the oracles fail.
- **B2 (fence strength after restart).** Same restart, but call `buildReturn` with overrides
  `{ latestUserMessageId: "msg-1", turnMessageId: "msg-1" }`; `turnId` stays `turn-2`. Dispatch →
  `rejects.toThrow("Delegated result origin changed")`.
  *Pre-fix: resolves*, so the test fails. Comment: *"After a restart the fence was weaker than before it. This is not
  reachable through CompletionReturnDelivery, which re-reads the latest id from SQL, and a guard only adds rejections."*

New imports: `makeCompletionReturnRepository` (`../../persistence/Layers/AgentControlCompletionReturns.ts`) and
`threadSettlementInput` (`../threadSettlementInput.ts`).

### C. `projector.test.ts`

**C1. `"keeps the first and latest user messages when the message cap evicts history"`**

Reuse the `makeEvent` and reduce pattern of the `:954` test:
1. `thread.created`.
2. User `thread.message-sent` `u-first`, then user `u-latest`, each with `turnId: null` and `streaming: false`.
3. 2,100 assistant `thread.message-sent` events, `msg-0` … `msg-2099`.

Expect:
- length is `2_000`
- `[0].id === "u-first"` and `[1].id === "u-latest"`
- `[2].id === "msg-102"` and `.at(-1).id === "msg-2099"`
- `findLast(user).id === "u-latest"`

*Pre-fix: fails* (both user messages are evicted).

**C2. `"caps exactly like slice when the only user message is in the newest window"`**

2,100 assistant messages, then user `u-only`. Expect the ids to equal
`[msg-101 … msg-2099, u-only]`, which is `slice(-2000)` of the full sequence. *Pre-fix: passes* (equivalence guard).

### Focused validation (no full suite)

```sh
bun run --cwd apps/server test src/orchestration/Layers/ProjectionSnapshotQuery.test.ts
bun run --cwd apps/server test src/orchestration/Layers/OrchestrationEngine.test.ts
bun run --cwd apps/server test src/orchestration/projector.test.ts
bun run --cwd apps/server test src/persistence/Layers/AgentControlCompletionReturns.test.ts
bun run --cwd apps/server test src/agentControl/Layers/CompletionReturnDelivery.test.ts
bun run --cwd apps/server test src/orchestration/decider.contextHandoff.test.ts src/orchestration/lightweightSnapshot.test.ts
bun run --cwd apps/server typecheck
```

Baseline: `ProjectionSnapshotQuery.test.ts` passes 14/14 today, re-run while finalizing this spec.

## 6. Edge cases

- **Non-monotonic `createdAt`.** SQL "latest" uses `created_at DESC, rowid DESC`, while the in-memory `findLast` uses
  append (event) order. They can disagree when a user row is appended with a `createdAt` older than the current latest:
  - clock skew
  - a steer resolved after a later start: `decider.ts:2034-2052` stamps the request time
  - provider history restore (`providerHistoryRecovery.ts`)

  The fence then fails *closed*. This divergence already exists without a restart and is unchanged here.
  `delegation-returns` may adopt a rowid-only definition, which is now a one-line change in `userMessageAnchors.ts`.
- **Steer messages.** Steer rows are `role = 'user'` with `turnId` set to the steered turn (`decider.ts:2045-2050`). The
  hydrated latest anchor carries `turn_id`, so the fence's `latestUserMessage.turnId === guard.turnId` branch keeps
  working after a restart.
- **Revert after a restart (handoff to `rollback-correctness`).** The command model has `checkpoints: []`, so
  `thread.reverted` sets `latestTurn = null` (`projector.ts:913-923`). `retainThreadMessagesAfterRevert`
  (`projector.ts:100-140`) keeps the `turnId === null` user anchors, oldest first, up to `turnCount`. With
  `turnCount >= 2`, *both* anchors are kept even if the latest was reverted. Consequences:
  - The fence then mismatches SQL and fails closed.
  - With `latestTurnRequestedAt = null`, `hasQueuedTurnStart` returns true, so settle and snooze report a phantom
    `queued-turn` blocker until 2 minutes after the reverted message's `createdAt`. This fails safe and heals itself.

  Before this fix only the first anchor survived, so neither happened. `rollback-correctness` must prune user anchors by
  retained turn count or by SQL-retained ids when it fixes revert on the hydrated model.
- **Existing-message merge of a non-hydrated id** (`projector.ts:672`). A `message-sent` for an old message id appends a
  new entry. For a user row with an old `createdAt`, this is the non-monotonic case above (fails closed). It is unchanged.
- **`VACUUM` and `rowid`.** `projection_thread_messages` has an implicit `rowid` (TEXT primary key), which `VACUUM` may
  renumber (see the `068_ProjectionMessageSearch.ts` comment). Both readers share the builder, so they stay in lockstep;
  only the tie-break among equal `created_at` values could change across a `VACUUM`.
- **Deleted (tombstoned) threads.** Anchors are hydrated if rows remain, the same as before.
- **Imported threads.** Imported user messages (`decider.ts:427`, `:1779`) are ordinary rows and hydrate normally.
- **Memory.** At most one extra user message (full text) per thread in the long-lived engine model. Delegation-result
  texts can be about 8 KB. Memory is bounded by the thread count, and the decider never reads anchor text. Possible follow-up:
  hydrate anchors with `messageTextColumns(sql, "messages", limit)`.
- **Startup and request cost.** `getCommandReadModel` runs 3 times at every startup:
  - `OrchestrationEngine.ts:540`
  - `serverRuntimeStartup.ts:570` (pending-request and orphaned-session reconciliation)
  - `serverRuntimeStartup.ts:741` (`workspace.validate`)

  It also runs per `GET /api/orchestration/snapshot` (`http.ts:45`) and per offline CLI command (`cli.ts:1154`). The
  correlated form is about 20× faster than today's anti-join in the typical case and at parity in the worst case (§2c).
  A3 guards against a regression to a full scan.

## 7. Out of scope

- The decider fence semantics and `CompletionReturnDelivery`'s live-session, exact-turn and same-runtime checks
  (`delegation-returns`, W2). This includes the second gate at `ProviderCommandReactor.ts:1204-1228`.
- Revert correctness on the hydrated model, including pruning reverted anchors (`rollback-correctness`, W2).
- In-memory merge of a `message-sent` for a message id that was not hydrated.
- Truncating anchor text; a rowid-only "latest" definition; a role-partial index (needs a migration).

## 8. Overlaps (explicit)

- **`delegation-returns` (W2).**
  - Semantic dependency: once the live-session checks are relaxed, this fix is what keeps post-restart returns
    working.
  - Relaxing only `CompletionReturnDelivery.ts:232-243` is not enough. `ProviderCommandReactor.ts:1204-1228` also
    re-checks the live runtime and drops the start with "Delegated return was not submitted".
  - Textual: `AgentControlCompletionReturns.ts` `latestUserMessageId` (Step 2, one function). It must keep using
    `latestUserMessageIdQuery`.
  - If it extracts a shared guard builder, test B's `buildReturn` must call it.
- **`delegation-lineage` (W2).** Edits `AgentControlCompletionReturns.ts`. At worst a trivial rebase conflict on Step 2's
  single function.
- **`rollback-correctness` (W2).** Owns the `projector.ts` revert path (`:890-937`, `retainThreadMessagesAfterRevert`, the
  `:907` slice). This package does not touch it; see the Edge-cases handoff.
- **`claude-steering` (W2).** Semantic: steer messages must remain `role = 'user'` rows with `turnId` set, otherwise the
  fence's `turnId` branch breaks.
- **`settlement-signals` (W1).** No textual overlap: this package does not edit `threadSettlementInput.ts` or
  `threadSettlement.ts`. Any comparison in the decider of a PR date against `latestUserMessageAt` depends on this fix to be correct
  after a restart.
- **`queue-hold-drain` (W1).**
  - Constraint: queued or held entries must **never** be stored as `role = 'user'` rows in `projection_thread_messages`.
    Otherwise both `latestUserMessageIdQuery` consumers (and settlement) would treat an undispatched entry as the parent's
    latest user message. If that is ever needed, exclude such rows inside `userMessageAnchors.ts` so both consumers stay in
    lockstep.
  - Possible textual overlap: the `getCommandReadModel` `Effect.all` tuple and destructuring (`:2150-2240`), if it adds
    hydration there.
- **`acp-message-ids` (W1).** Possible textual overlap in `projector.ts` `thread.message-sent` (`:642-705`) if it changes
  how existing messages are merged. This package changes only line `:696` and adds a top-level helper.
- **`turn-finalization` (W1) / `restart-continuation` (W3).** May add startup hydration to `getCommandReadModel` or read
  it in `serverRuntimeStartup.ts`. They must keep the anchor invariant and must not replace the `messages` hydration.
- No overlap with `claude-meter-wake`, `reactor-errors-switch`, `provider-compat`, `usage-limits`,
  `reactor-concurrency` or `provider-effect-outbox`.

## 9. Review resolution

I re-verified every disputed point against the code. I agree with the "partially-confirmed" verdict. The "fail-open"
sub-claim is not reachable in practice and is reworded (item 3).

| # | Severity | Issue | Resolution |
| --- | --- | --- | --- |
| 1 | major | Window query can be slower; startup callers undercounted | **Accepted.** Uses correlated per-thread `LIMIT 1` subqueries. I re-measured: typical 0.014 s vs 0.28 s today vs 0.46 s window; worst case at parity at 0.18 s. The plan was verified, all 5 call sites are listed, and the A3 `EXPLAIN QUERY PLAN` guard is added. The redundant `thread_id` predicate is shown to flip the plan to a full scan and is forbidden in a code comment. |
| 2 | major | "Latest user message" ordering duplicated across two SQL sites | **Accepted.** New `persistence/userMessageAnchors.ts` is used by the anchor query and by `CompletionReturnRepository.latestUserMessageId` (one function, same SQL). The builder returns a typed `Statement`, which is both a fragment and an `Effect`, so no wrapper or fallback is needed. A2 still cross-checks the real repository. The comment-only approach was dropped. |
| 3 | minor | "Fail-open" overstated | **Accepted.** Reworded: the fence is weaker after a restart, it is not reachable through `CompletionReturnDelivery`, and a client guard only adds rejections, so there is no escalation. B2 is kept as a fence-strength regression test with that comment. |
| 4 | minor | Second live-runtime gate (`ProviderCommandReactor.ts:1204-1228`) missed | **Accepted.** Added as Mask 2 in §1, to Out of scope, and to the `delegation-returns` overlap note. |
| 5 | minor | Existing `latest_user_message_at` column ignored; no oracle | **Accepted.** Rationale (a) now rejects on "unassigned migration + backfill + contract or side channel". The B1 oracle ties the anchor `createdAt` to `threadSettlementInput(...).latestUserMessageAt` and to the pipeline-maintained column. |
| 6 | minor | Message cap evicts anchors without a restart; archive invariant missing | **Accepted (folded in).** Step 4 `capThreadMessagesPreservingUserAnchors`, tests C1 and C2, the archive invariant added to the audit table, and the `acp-message-ids` overlap named. |
| 7 | minor | Revert after a restart yields a phantom `queued-turn` | **Accepted.** Documented as fail-safe and self-healing within 2 minutes, with an explicit pruning handoff to `rollback-correctness`. |
| 8 | minor | `queue-hold-drain` overlap missing | **Accepted.** Added the role=`user` constraint, exclusion inside the shared builder if ever needed, and the possible tuple conflict. |
| 9 | minor | Test B fixture under-specified; guard partly hand-built | **Accepted.** Full `OrchestrationSession` payloads. `thread.turn.diff.complete` now has every required field, including `checkpointRef`, which the earlier draft omitted (`contracts/orchestration.ts:1763-1775`). `thread.message.assistant.complete` added per turn. Guard SQL fields come from the repository functions and the rest from `readShell()`. Shared-builder comment added; B0 kept as the no-restart control. |
| 10 | minor | Conflicts with the already-reviewed spec at this path | **Accepted.** Reconciled into this file, which supersedes it. The correlated query, shared builder, Step 4 cap helper, B1 oracles and earlier resolutions are retained. Corrected on re-verification: the missing `checkpointRef`; inconsistent performance figures (replaced with one measured set); an unnecessary Step 2 fallback; the C2 wording (equivalence only when both anchors are in the window); added steer and history-restore edge cases and the `claude-steering` semantic overlap. |
