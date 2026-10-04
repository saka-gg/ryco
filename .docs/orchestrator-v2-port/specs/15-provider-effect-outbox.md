# 15 · provider-effect-outbox: durable provider side effects

| Field            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id               | `provider-effect-outbox`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| title            | Durable provider-bound intents: record them in the commit transaction, settle them from their outcome events, and resolve leftovers visibly after a restart                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| wave             | 3 (sequential, same branch). Order: `reactor-concurrency` → **`provider-effect-outbox`** → `restart-continuation`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| verdict          | **partially-confirmed**. Turn start, steer and session stop are silently lost if the process dies between commit and provider call. Approval and user-input responses, interrupts, goal sync and runtime/token mode changes are already recovered by existing startup code, so they are not tracked here                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| size             | L                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| touched files    | new: `apps/server/src/persistence/Migrations/072_ProviderEffectIntents.ts`, `apps/server/src/orchestration/providerEffectIntents.ts`, `apps/server/src/persistence/Services/ProviderEffectIntents.ts`, `apps/server/src/persistence/Layers/ProviderEffectIntents.ts` · changed: `apps/server/src/persistence/Migrations.ts`, `apps/server/src/orchestration/Services/OrchestrationEngine.ts`, `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`, `apps/server/src/orchestration/Services/ProviderCommandReactor.ts`, `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`, `apps/server/src/orchestration/Services/OrchestrationReactor.ts`, `apps/server/src/orchestration/Layers/OrchestrationReactor.ts`, `apps/server/src/orchestration/Services/ContextHandoffCoordinator.ts`, `apps/server/src/orchestration/Layers/ContextHandoffCoordinator.ts`, `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, `apps/server/src/persistence/Services/ProjectionTurns.ts`, `apps/server/src/persistence/Layers/ProjectionTurns.ts`, `apps/server/src/serverRuntimeStartup.ts` · tests: `apps/server/src/orchestration/providerEffectIntents.test.ts` (new), `apps/server/src/persistence/Layers/ProviderEffectIntents.test.ts` (new), `apps/server/src/persistence/Migrations/072_ProviderEffectIntents.test.ts` (new), `OrchestrationEngine.test.ts`, `ProviderCommandReactor.test.ts`, `ProjectionPipeline.test.ts`, `ContextHandoffCoordinator.test.ts`, `OrchestrationReactor.test.ts`, `serverRuntimeStartup.test.ts`, `agentControl/Layers/CompletionReturnDelivery.test.ts`, and every `OrchestrationEngineShape` test double (new required `bootSequence` field) |
| migrations       | **072** `ProviderEffectIntents`: `CREATE TABLE provider_effect_intents` plus one index. No backfill                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| contract changes | None in `packages/contracts`. Internal server shapes: `OrchestrationEngineShape.bootSequence` (new, required), `ProviderCommandReactorShape.recoverIntents`, `OrchestrationReactorShape.recoverProviderIntents`, `ContextHandoffCoordinatorShape.abandonUnstartedTurnStart`, `ProjectionTurnRepositoryShape.deletePendingTurnStartByMessage`, new `ProviderEffectIntentRepository` service. Activity payloads gain an informational `deliveryState` key (`payload` is `Schema.Unknown`). Behaviour changes: session-stop failures become visible, and a `provider.turn.start.failed` activity now removes the matching pending `projection_turns` row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| overlaps         | `reactor-concurrency` (W3, lands first: `ProviderCommandReactor.start`, the worker/lane, `processDomainEventSafely`, `processTurnStartRequested`) · `restart-continuation` (W3, lands after: `serverRuntimeStartup` phase list, consumes the recovery summary) · `reactor-errors-switch` (W1: `formatFailureDetail`, `appendProviderFailureActivity`, `processDomainEventSafely`) · `turn-finalization` (W1: `reconcileOrphanedProviderSessions` and the phase list in `serverRuntimeStartup.ts`, `ProjectionPipeline.applyThreadTurnsProjection`) · `delegation-returns` (W2: `processTurnStartRequested` delegation-return-guard branch; semantic overlap with `CompletionReturnDelivery` `pendingTurnExists` / `isReturnContinuation` through the pending-row deletion) · `usage-limits` (W2: `handleTurnStartFailure` / `recoverTurnStartFailure`) · `claude-steering` (W2: `processTurnSteerRequested`) · `delegation-guard-restart` (W1: `makeOrchestrationEngine` around `getCommandReadModel`, `:539-540`, next to the new `bootSequence` capture) · `delegation-lineage`, `restart-continuation`, `usage-limits`, `settlement-signals` (one-line `Migrations.ts` registry appends only) · `rollback-correctness` (W2: no code overlap; it owns neither the lost-revert gap nor this fix, see §8)                                                                                                                                                                                                                                                                                                                                                                                               |

---

## 1. Problem (verified against the code)

### 1.1 Confirmed silent losses

1. **The reactor is live-only.**
   - `ProviderCommandReactor.start` (`ProviderCommandReactor.ts:1811-1852`) forks `Stream.runForEach(orchestrationEngine.streamDomainEvents, …)` (`:1829-1831`).
   - `streamDomainEvents` is a getter that returns `Stream.fromPubSub` (`OrchestrationEngine.ts:600-602`). It subscribes lazily, inside the forked fiber.
   - Startup recovery covers only pending goal sync (`:1832-1851`).
2. **The engine publishes after commit.** It runs the transaction (`:362-430`) and the post-commit effects, then publishes to the PubSub (`:445-466`). Nothing durable links a committed intent event to its provider call.
3. **Turn start.**
   - `thread.turn-start-requested` only writes a pending `projection_turns` row (`ProjectionPipeline.ts:1706-1714`).
   - The provider call is forked: `providerService.sendTurn(...).pipe(..., Effect.forkScoped)` (`ProviderCommandReactor.ts:1332-1336`).
   - `reconcileOrphanedProviderSessions` only touches sessions that are `starting`/`running` or have an `activeTurnId` (`serverRuntimeStartup.ts:616-623`).
   - So if the process dies after commit but before the provider call (or before ingestion commits the running `thread.session-set`), the user message stays saved, no turn runs and no error appears.
   - `LocalTaskService.ts:106-135` also stays `starting`, because no `provider.turn.start.failed` carries the `messageId`.
4. **Steer.**
   - `processTurnSteerRequested` forks `steerTurn` (`:1543-1574`) and resolves only through `thread.turn.steer.resolve`.
   - The `thread.turn-steer-requested` route is projection-free (`ProjectionPipeline.ts:122`; session stop at `:151`), and nothing replays it. A lost steer stays unresolved.
5. **Session stop.**
   - `thread.session-stop-requested` has an empty projection route.
   - `processSessionStopRequested` (`:1693-1721`) is the only executor.
   - After a crash, a `ready` session is not "orphaned" (`serverRuntimeStartup.ts:616-623`), so the user's Stop never takes effect.
6. **Two pre-existing defects on the same path** (the fix depends on them):
   - **`commitAcceptedModelSelection` failure is reported as a start failure.** It runs inside `Effect.tap` after a _successful_ `sendTurn` (`:1321-1336`). If it fails, `recoverTurnStartFailure` runs and emits `provider.turn.start.failed` for a turn that started.
   - **Reactor-level failures are only logged.** `processDomainEventSafely` (`:1790-1801`) logs failures that escape a handler, for example a SQL error in `resolveThread`. The same applies when `recoverTurnStartFailure` (`:1186-1196`) cannot append the failure activity.

### 1.2 Already recovered today (refuted, so not tracked)

- **Approval and user-input responses.**
  - `thread.approval.respond` appends `approval.response.submitted` (`decider.ts:1328-1352`).
  - `derivePendingThreadRequests` (`packages/shared/src/threadActivity.ts:140-165`) still treats that request as pending.
  - `pendingCallbackInvalidation` requires only `status === "pending"` (`approvalResponses.ts:244`).
  - So startup (`serverRuntimeStartup.ts:573-610`) invalidates `submitting` claims with a visible `provider.*.respond.failed`.
- **Interrupt.** Orphan reconciliation stops the binding and dispatches its own `thread.turn.interrupt` and an error `thread.session-set` for every session with an `activeTurnId` (`:625-700`). The reactor skips those interrupts through `isProviderOriginatedCommandId` (`ProviderCommandReactor.ts:1340-1342`).
- **Goal sync.** `start()` re-enqueues pending syncs (`:1832-1851`).
- **Runtime/token mode.** These are persisted on the thread. The next `ensureSessionForThread` uses them.

### 1.3 Corrections to earlier claims

- **The stuck pending row is not permanent.** `replacePendingTurnStart` deletes every pending row of the thread (`ProjectionTurns.ts:95-104`, `:263-277`). The pending row (storage-cleanup hold `StorageService.ts:131/751`, `hasQueuedTurn` in `ThreadPriorityCandidateQuery.ts:54-57`, and "A newer parent start is pending" in `CompletionReturnDelivery.ts:209-219`) therefore lasts until the **next turn start on that thread**. It is permanent only for threads that are abandoned.
- **`CompletionReturnDelivery` "delivered" is receipt-level by design.** Its detail reads "Provider processing is separate from this dispatch receipt" (`CompletionReturnDelivery.ts:118-121`). It is not a bug and is not changed here.
- **The provider runtime does not always die with the process.**
  - OpenCode can run against an external `serverUrl` (`OpenCodeAdapter.ts:2083-2160`).
  - After a restart `stopExactBinding` returns not-found (`ProviderService.ts:628-631`).
  - Codex and Claude resume native history from the cursor (`ProviderService.ts:970-975`).
  - So "dispatched but unconfirmed" must never be reported as "not sent" (see §2.4).

### 1.4 Reference

- t3 `orchestration-v2/EffectOutbox.ts:108-124` splits effects into `PROCESS_BOUND_EFFECT_TYPES` (turn start, interrupt, steer, request respond) and `REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS` (including `provider-session.detach`).
- `reconcileAfterProcessLoss` (`:456-485`) cancels the first group and requeues the second.
- Ryco keeps the same policy split. It does not port t3's lease/worker machinery: Ryco has a single engine writer and no multi-worker claiming.

---

## 2. Approach

### 2.1 Shape: an open-intent ledger, settled by outcome events in the same transaction

Each tracked request event gets one row in `provider_effect_intents`, keyed by its `orchestration_events.sequence`.

- **Insert.** The row is inserted **inside the engine's commit transaction**, right after `eventStore.append`.
- **Delete (settle).** The row is deleted **inside the commit transaction of the event that makes its outcome visible**: a failure activity, the steer resolution, the running/stopped `thread.session-set`, the handoff terminal activity, or `thread.deleted`.
- **No payload copy.** The row stores only the lookup keys. The payload stays in `orchestration_events` and is read back by sequence when needed.

This gives three invariants by construction. They replace the draft's settle-after-call bookkeeping and its outcome probes:

- **I1 – no silent settle.** An open row means no outcome event for that intent was ever committed. A row disappears only atomically with a durable, user-visible outcome. The only exceptions are explicit settles where no outcome can be shown (thread missing, coordinator-owned handoff, poison row; see §2.5).
- **I2 – no lost intent.** The row commits atomically with its request event. A rolled-back command leaves no row.
- **I3 – no double execution.** Recovery never re-sends a process-bound intent (turn start, steer). Only the idempotent session stop is retried. Within one process, replayed rows go through the existing per-event dedup (`hasHandledTurnStartRecently`, `ProviderCommandReactor.ts:260-271`). Session stop is idempotent.

Rejected alternatives:

- **Generalising `AgentControlOperationStore`.**
  - That store is security-sensitive: proposals, approvals, exact-turn binding.
  - Provider intents are orchestration-internal and must never share approval state with agent-facing operations.
  - Only the pattern is reused: a durable row plus recovery at startup.
- **`effect_receipts` plus a cursor over `orchestration_events`.**
  - It needs a low-water mark and a scan of all tracked event types since that mark.
  - An open-row table makes startup O(open intents) and needs no cursor.
  - It is still "derived from the event log": rows are inserted and deleted only as a function of committed events, plus one `dispatched_at` marker.
- **A `ProjectionPipeline` projector.**
  - A new projector replays from sequence 0 at bootstrap, which would resurrect every historical request.
  - The `dispatched_at` write is not event-derived, so a projector rebuild could not reproduce it.
  - An engine-owned write keeps the semantics explicit.

### 2.2 Tracked kinds

| kind           | request event                   | policy after process loss                                | message_id                  | handoff_id                                  |
| -------------- | ------------------------------- | -------------------------------------------------------- | --------------------------- | ------------------------------------------- |
| `turn-start`   | `thread.turn-start-requested`   | process-bound: cancel visibly, never resend              | `payload.messageId`         | `payload.contextHandoff?.handoffId ?? null` |
| `turn-steer`   | `thread.turn-steer-requested`   | process-bound: resolve as rejected visibly, never resend | `payload.message.messageId` | null                                        |
| `session-stop` | `thread.session-stop-requested` | replay-safe: retry once per boot                         | null                        | null                                        |

### 2.3 Settlement table (applied in the engine transaction, only to rows with `sequence < event.sequence`)

| committed event                                                                                                                                                        | rows deleted                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `thread.activity-appended`, kind `provider.turn.start.failed`, payload `messageId` M                                                                                   | `turn-start` rows for (thread, M)                                                                                   |
| `thread.activity-appended`, kind `context-handoff` (`CONTEXT_HANDOFF_ACTIVITY_KIND`), decoded payload `status ∈ {consumed, failed, delivery-uncertain}`, `handoffId` H | `turn-start` rows for (thread, handoff H)                                                                           |
| `thread.activity-appended`, kind `provider.session.stop.failed`                                                                                                        | `session-stop` rows for the thread                                                                                  |
| `thread.turn-steer-accepted` / `thread.turn-steer-rejected`, payload `messageId` M                                                                                     | `turn-steer` rows for (thread, M)                                                                                   |
| `thread.session-set` with `status === "running"` and `activeTurnId !== null`                                                                                           | `turn-start` rows for the thread **with `dispatched_at IS NOT NULL`** (the turn the provider accepted is now bound) |
| `thread.session-set` with `status === "stopped"`                                                                                                                       | `session-stop` rows for the thread                                                                                  |
| `thread.deleted`                                                                                                                                                       | every row of the thread                                                                                             |

Why the "running" rule is safe:

- The reactor dispatches a turn start only when the session is not `running` with an active turn (`:1128-1139`).
- Ingestion refuses `turn.started` for terminal turns (`ProviderRuntimeIngestion.ts:2391-2396`).
- So a running set after a dispatch is the dispatched turn.
- Rows that were never dispatched, and handoff rows (never marked dispatched), are not touched.

### 2.4 `dispatched_at`: distinguishing "not sent" from "delivery not proven"

The reactor sets `dispatched_at` with an autocommitted UPDATE **immediately before** it calls `providerService.sendTurn` or `steerTurn`, inside the forked fiber.

- **`dispatched_at IS NULL`** means the provider was never called for this intent. Recovery says "was not sent; send it again".
- **`dispatched_at` set** means the provider may have received it. Recovery says "may have reached the provider; check before sending again".

This matches Ryco's existing honest-uncertainty precedents: `ContextHandoffCoordinator.markDeliveryUncertain` (`:826-897`), CompletionReturn "uncertain", and approval `responseState: "uncertain"`.

### 2.5 Startup partition and recovery policy

The engine captures `bootSequence = eventStore.latestSequence` during construction, after `projectionPipeline.bootstrap` and before it forks its command worker (`OrchestrationEngine.ts:539-556`). That value is the highest sequence any earlier process committed, and it is exposed as `OrchestrationEngineShape.bootSequence`.

`ProviderCommandReactor.recoverIntents()` runs in a new startup phase `provider-intents.recover`:

- after `reactors.start` (so the live subscription exists)
- after `provider-sessions.reconcile` (orphan reconciliation owns session/turn state and runs first)
- before the command gate opens

It lists all open rows in sequence order and handles each one:

- **`sequence > bootSequence`: this process committed it before the reactor subscribed.** This window is latent today. Agent Control waits for `awaitCommandReady`, and clients are gated, but `restart-continuation` will add startup dispatchers.
  - Read the event by sequence and enqueue it through the **normal live entry**. The per-event dedup absorbs the copy if the live subscription also delivered it.
  - This needs no cutoff read. A row committed after the list is published after the subscription was taken (subscription → list → commit → publish), so it is delivered live.
- **`sequence <= bootSequence`: an earlier process committed it.** Apply the policy below. Each attempt first increments `recovery_attempts`. A row past `MAX_PROVIDER_INTENT_RECOVERY_ATTEMPTS = 5` is settled explicitly with `Effect.logError` (poison-row guard).

| kind                               | state                                                 | recovery action (all dispatches use deterministic ids `server:provider-intent-recovery:<sequence>` / activity id `provider-intent-recovery:<sequence>`)                                                                                      |
| ---------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| any                                | thread missing                                        | explicit settle (`thread.deleted` normally already settled it)                                                                                                                                                                               |
| `turn-start`, no `contextHandoff`  | `dispatched_at IS NULL`                               | append `provider.turn.start.failed` (tone `error`, `messageId`, `deliveryState: "not-sent"`). Summary/detail from §3.2 `recoveryCopy`. The delegated-return guard variant uses the delegated wording                                         |
| `turn-start`, no `contextHandoff`  | `dispatched_at` set                                   | the same, with `deliveryState: "uncertain"` and the uncertain wording                                                                                                                                                                        |
| `turn-start` with `contextHandoff` | any                                                   | `contextHandoffCoordinator.abandonUnstartedTurnStart(event, detail)`: `"owned"` → explicit settle. `"abandoned"` → nothing further (its terminal activity settled the row). `"unrecognized"` → generic `provider.turn.start.failed` as above |
| `turn-steer`                       | NULL / set                                            | dispatch `thread.turn.steer.resolve` with `resolution.status: "rejected"` and not-sent / uncertain wording. The decider emits `thread.turn-steer-rejected` plus `provider.turn.steer.failed`, which settles the row                          |
| `session-stop`                     | any                                                   | the shared `stopThreadSession({ threadId, at: now })` routine (§3.6). It settles via the stopped set or via `provider.session.stop.failed`                                                                                                   |
| any                                | event unreadable (missing sequence or decode failure) | `turn-start`: generic `provider.turn.start.failed` built from the row's `message_id`, uncertain wording. Other kinds: `logWarning` plus explicit settle                                                                                      |

Rules that hold during recovery:

- Recovery **never** calls `sendTurn`, `steerTurn` or `interruptTurn`.
- Recovery never touches session status for turn-start or steer rows. Orphan reconciliation owns that.
- Recovery never approves, answers or re-dispatches anything for Agent Control.
- Dispatch failures:
  - `OrchestrationCommandInvariantError` or `OrchestrationCommandPreviouslyRejectedError` on a recovery dispatch is terminal: settle plus `logWarning`.
  - Any other failure keeps the row for the next boot.
  - Each dispatch is retried once (`Effect.retry(Schedule.recurs(1))`), the same as `reconcileOrphanedProviderSessions`.

The phase logs and returns a `ProviderIntentRecoverySummary`. `restart-continuation` uses it to avoid auto-continuing a thread whose turn start was just cancelled.

### 2.6 Live-path guarantees

- **No failure on success.** A turn whose `sendTurn` succeeded never gets `provider.turn.start.failed`. The model-selection commit failure only logs.
- **Escaping failures become visible.** Every non-interrupt failure that escapes a tracked handler, including `reactor-concurrency` lane timeouts, becomes a visible outcome through `surfaceIntentFailure`, and that outcome settles the row.
  - **Exception: a row already marked dispatched.** It is left for the provider outcome, or for next-boot "uncertain" recovery. A timeout must not claim failure for a call that may have reached the provider.
- **Interrupts leave the row.** On shutdown or scope close, the row stays for the next boot.
- **Session-stop failures become visible.** They raise `provider.session.stop.failed`. Today they are only logged.

---

## 3. Step-by-step changes

### 3.1 Migration 072: `apps/server/src/persistence/Migrations/072_ProviderEffectIntents.ts` (new) + `Migrations.ts`

```ts
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE provider_effect_intents (
    sequence INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('turn-start', 'turn-steer', 'session-stop')),
    message_id TEXT,
    handoff_id TEXT,
    recorded_at TEXT NOT NULL,
    dispatched_at TEXT,
    recovery_attempts INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX provider_effect_intents_thread_kind
    ON provider_effect_intents(thread_id, kind, message_id)`;
});
```

- Register it in `Migrations.ts`: `import Migration0072 from "./Migrations/072_ProviderEffectIntents.ts";` and `[72, "ProviderEffectIntents", Migration0072]`. Other wave packages append 071/073–075 to the same array. Resolve that textual conflict by keeping numeric order.
- No backfill (see §9, issue 11).
- **Contract for future event retention.** No pruning may delete `orchestration_events` rows with `sequence >= MIN(provider_effect_intents.sequence)`. Add a code comment next to the table definition.

### 3.2 Pure planner: `apps/server/src/orchestration/providerEffectIntents.ts` (new)

The planner has no Effect services and no SQL. It exports:

```ts
export const PROVIDER_EFFECT_INTENT_KINDS = ["turn-start", "turn-steer", "session-stop"] as const;
export type ProviderEffectIntentKind = (typeof PROVIDER_EFFECT_INTENT_KINDS)[number];
/** Cancelled visibly after process loss; never re-sent (t3 PROCESS_BOUND_EFFECT_TYPES). */
export const PROCESS_BOUND_INTENT_KINDS = ["turn-start", "turn-steer"] as const;
/** Idempotent; retried after process loss (t3 REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS). */
export const REPLAY_SAFE_INTENT_KINDS = ["session-stop"] as const;
export const MAX_PROVIDER_INTENT_RECOVERY_ATTEMPTS = 5;

export interface ProviderEffectIntentRecord {
  readonly sequence: number;
  readonly eventId: EventId;
  readonly threadId: ThreadId;
  readonly kind: ProviderEffectIntentKind;
  readonly messageId: MessageId | null;
  readonly handoffId: string | null;
  readonly recordedAt: string;
}
export type ProviderEffectIntentSettlement =
  | {
      readonly _tag: "ByMessage";
      readonly threadId: ThreadId;
      readonly kind: "turn-start" | "turn-steer";
      readonly messageId: MessageId;
    }
  | { readonly _tag: "ByHandoff"; readonly threadId: ThreadId; readonly handoffId: string }
  | { readonly _tag: "DispatchedTurnStarts"; readonly threadId: ThreadId }
  | { readonly _tag: "SessionStops"; readonly threadId: ThreadId }
  | { readonly _tag: "Thread"; readonly threadId: ThreadId };
export interface ProviderEffectIntentPlan {
  readonly record: ProviderEffectIntentRecord | null;
  readonly settlements: ReadonlyArray<ProviderEffectIntentSettlement>;
  readonly beforeSequence: number; // = event.sequence
}
export const planProviderEffectIntent: (event: OrchestrationEvent) => ProviderEffectIntentPlan;
export const isTrackedProviderIntentEvent: (event: OrchestrationEvent) => boolean;
/** Shared by the planner and ProjectionPipeline so both read the failure key identically. */
export const turnStartFailureMessageId: (activity: OrchestrationThreadActivity) => MessageId | null;
export type IntentDeliveryState = "not-sent" | "uncertain";
export const recoveryCopy: (input: {
  readonly kind: "turn-start" | "turn-steer";
  readonly deliveryState: IntentDeliveryState;
  readonly delegatedReturn: boolean;
}) => { readonly summary: string; readonly detail: string };
```

Rules:

- The planner implements §2.2 and §2.3 exactly.
- Unknown and untracked events return `{ record: null, settlements: [] }` without allocating.
- Handoff activities are decoded with `Schema.decodeUnknownOption(ContextHandoffActivityPayload)`. A non-decodable payload settles nothing.

Copy (final strings; plain sentences, no raw causes):

- turn-start / not-sent:
  - summary "Message was not sent"
  - detail "Ryco restarted before this message reached the provider. Nothing was sent. Send it again to continue."
- turn-start / uncertain:
  - summary "Message delivery unconfirmed"
  - detail "Ryco restarted after handing this message to the provider but before the provider confirmed it. It may have been received. Check the thread before sending it again."
- delegated / not-sent:
  - summary "Delegated return was not submitted"
  - detail "Ryco restarted before this delegated result reached the provider. Inspect the result before sending it manually."
- delegated / uncertain:
  - summary "Delegated return delivery unconfirmed"
  - detail "Ryco restarted while submitting this delegated result. It may have reached the provider. Inspect the parent thread before sending it manually."
- steer / not-sent:
  - error "Ryco restarted before this steer message reached the provider. It was not sent."
- steer / uncertain:
  - error "Ryco restarted while delivering this steer message. It may have reached the provider. Check the turn before sending it again."

### 3.3 Repository: `persistence/Services/ProviderEffectIntents.ts` + `persistence/Layers/ProviderEffectIntents.ts` (new)

The repository is stateless and needs only `SqlClient`. It follows the existing `Services`/`Layers` repository split.

```ts
export interface ProviderEffectIntentRow extends ProviderEffectIntentRecord {
  readonly dispatchedAt: string | null;
  readonly recoveryAttempts: number;
}
export interface ProviderEffectIntentRepositoryShape {
  /** Must run inside the caller's transaction. No SQL for untracked, non-settling events. */
  readonly applyEvent: (event: OrchestrationEvent) => Effect.Effect<void, PersistenceSqlError>;
  readonly markDispatched: (input: {
    readonly sequence: number;
    readonly dispatchedAt: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly settle: (input: {
    readonly sequence: number;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly get: (input: {
    readonly sequence: number;
  }) => Effect.Effect<
    Option.Option<ProviderEffectIntentRow>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly listOpen: () => Effect.Effect<
    ReadonlyArray<ProviderEffectIntentRow>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  readonly noteRecoveryAttempt: (input: {
    readonly sequence: number;
  }) => Effect.Effect<number, PersistenceSqlError>;
}
```

SQL:

- **record:** `INSERT … ON CONFLICT(sequence) DO NOTHING`.
- **ByMessage:** `DELETE … WHERE thread_id=? AND kind=? AND message_id=? AND sequence < ?`.
- **ByHandoff:** `… AND kind='turn-start' AND handoff_id=? AND sequence < ?`.
- **DispatchedTurnStarts:** `… AND kind='turn-start' AND dispatched_at IS NOT NULL AND sequence < ?`.
- **SessionStops:** `… AND kind='session-stop' AND sequence < ?`.
- **Thread:** `… WHERE thread_id=? AND sequence < ?`.
- **markDispatched:** `UPDATE … SET dispatched_at=? WHERE sequence=? AND dispatched_at IS NULL`. Zero rows is fine.
- **noteRecoveryAttempt:** UPDATE then SELECT. Do not rely on `RETURNING`.
- **listOpen:** `ORDER BY sequence ASC`.

The repository does **not** read `orchestration_events` and does **not** probe outcomes.

- The head sequence comes from `OrchestrationEventStore.latestSequence`.
- Events are read through the existing `OrchestrationEngineShape.readEventsPage`.
- No duplicate of `hasEventAfter` or of the `LocalTaskService` probes is introduced.

### 3.4 Engine: `orchestration/Services/OrchestrationEngine.ts`, `orchestration/Layers/OrchestrationEngine.ts`

1. Add to `OrchestrationEngineShape`:
   ```ts
   /** Highest event sequence committed before this engine instance started (prior processes). */
   readonly bootSequence: number;
   ```
2. In `makeOrchestrationEngine`, yield `ProviderEffectIntentRepository`.
3. In the commit loop (`:396-403`), call `yield* providerEffectIntents.applyEvent(savedEvent);` right after `const savedEvent = yield* eventStore.append(nextEvent);` and before `projectEvent`. It is inside `sql.withTransaction`, so a rollback also removes the row. Map errors the same way as the other repositories in the transaction.
4. After `commandReadModel = yield* projectionSnapshotQuery.getCommandReadModel();` (`:540`) and **before** `Effect.forkScoped(worker)` (`:556`), add `const bootSequence = yield* eventStore.latestSequence;`. Return it on the shape and annotate the "orchestration engine started" debug log with it.
5. `OrchestrationEngineLive` gains `Layer.provide(ProviderEffectIntentRepositoryLive)`, the same way it already provides the approval repositories.
6. Update every `OrchestrationEngineShape` test double with `bootSequence: 0` (`rg "OrchestrationEngineService, \{|Layer.succeed\(OrchestrationEngineService|satisfies OrchestrationEngineShape" apps/server/src`).

### 3.5 Pending-row cleanup: `ProjectionPipeline.ts`, `ProjectionTurns.ts` (service + layer)

1. Add `deletePendingTurnStartByMessage({ threadId, messageId })` to `ProjectionTurnRepositoryShape`. It runs `DELETE FROM projection_turns WHERE thread_id=? AND pending_message_id=? AND turn_id IS NULL AND state='pending' AND checkpoint_turn_count IS NULL` and is served by the `projection_turns_user_message` index from 070.
2. `ORCHESTRATION_EVENT_PROJECTORS["thread.activity-appended"]` gains `ORCHESTRATION_PROJECTOR_NAMES.threadTurns`. The key count stays 44.
3. `applyThreadTurnsProjection` gains `case "thread.activity-appended"`. When `turnStartFailureMessageId(activity)` (from §3.2) returns M, it calls `deletePendingTurnStartByMessage({ threadId, messageId: M })`.
   - It is keyed by message, so a stale failure never removes a newer pending start.
   - Bound rows (`turn_id` set) are untouched.
4. Consequences, intended and tested:
   - A cancelled or failed start no longer holds storage cleanup (`StorageService.ts:751`).
   - It no longer ranks the thread as queued (`ThreadPriorityCandidateQuery.ts:54-57`).
   - It no longer parks completion returns behind "A newer parent start is pending" or the return-continuation wait (`CompletionReturnDelivery.ts:209-219`, `AgentControlCompletionReturns.ts:151-174`). Those returns now continue to the existing liveness, stopped and error checks. They are never auto-sent past those checks.
5. **Historical rows.** The threadTurns cursor is already at head, so stuck rows from before this change clear on the thread's next turn start, as they do today.

### 3.6 Reactor: `orchestration/Services/ProviderCommandReactor.ts`, `orchestration/Layers/ProviderCommandReactor.ts`

These changes are rebased on `reactor-concurrency`'s merged shape. §4 states the integration requirements.

1. **Dependencies.** Yield `ProviderEffectIntentRepository`. `ProviderCommandReactorLive` provides `ProviderEffectIntentRepositoryLive`.
2. **Synchronous subscription** (`start`, `:1811-1831`). Replace the lazy stream with the `ThreadDeletionReactor` pattern (`ThreadDeletionReactor.ts:94-104`):
   ```ts
   const subscription = yield * orchestrationEngine.subscribeDomainEvents;
   yield *
     Effect.forkScoped(Stream.runForEach(Stream.fromSubscription(subscription), processEvent));
   ```
   Goal-sync recovery stays where it is.
3. **`appendProviderFailureActivity`** (`:275-317`). Add optional `activityId?: EventId`, `commandId?: CommandId` and `deliveryState?: IntentDeliveryState` inputs. The defaults stay random ids, and `deliveryState` is copied into `payload` when present. Add `kind: "provider.turn.steer.failed"` only if `surfaceIntentFailure` needs it. It does not: steer outcomes go through `thread.turn.steer.resolve`.
4. **Turn start** (`processTurnStartRequested`, `:1117-1337`).
   - `!thread` → `yield* providerEffectIntents.settle({ sequence: event.sequence })` and return.
   - Replace `:1332-1336` with:
     ```ts
     yield *
       providerEffectIntents
         .markDispatched({ sequence: event.sequence, dispatchedAt: new Date().toISOString() })
         .pipe(
           Effect.andThen(providerService.sendTurn(sendTurnRequest.value, expectedReturnRuntime)),
           Effect.matchCauseEffect({
             onFailure: recoverTurnStartFailure,
             onSuccess: () =>
               commitAcceptedModelSelection.pipe(
                 Effect.catchCause((cause) =>
                   Cause.hasInterruptsOnly(cause)
                     ? Effect.interrupt
                     : Effect.logWarning(
                         "provider command reactor failed to commit accepted model selection",
                         {
                           threadId: event.payload.threadId,
                           cause: Cause.pretty(cause),
                         },
                       ),
                 ),
               ),
           }),
           Effect.forkScoped,
         );
     ```
   - A `markDispatched` failure becomes a visible start failure, and `sendTurn` is not called.
   - `recoverTurnStartFailure` keeps logging when the failure append fails. Add `Effect.retry(Schedule.recurs(1))` around the append. Under I1 the row stays open, and the next boot reports it.
   - The handoff branch (`:1246-1268`) is unchanged and never marks dispatched. The coordinator owns its dispatch states.
5. **Steer** (`processTurnSteerRequested`, `:1506-1575`).
   - Extract `steerRequestCommandId(event)` from the inline expression at `:1511-1512`. Live resolution and recovery both use it.
   - Prefix the forked chain with `markDispatched` (same pattern as the turn start).
   - In the `catchCause` handler, `Cause.hasInterruptsOnly(cause)` → `Effect.interrupt`, so the row is kept for next-boot recovery. Today an interrupt would try to resolve as rejected.
6. **Session stop.** Replace the body of `processSessionStopRequested` (`:1693-1721`) with a shared `stopThreadSession({ threadId, at })`:
   - Thread missing → `settle(sequence)`.
   - If `thread.session` is present and not `stopped`, call `providerService.stopSession({ threadId })`.
     - Treat these as "nothing left to stop" (`logDebug`) and continue: `ProviderSessionNotFoundError`, `ProviderAdapterSessionNotFoundError`, `ProviderAdapterSessionClosedError`, and `ProviderValidationError`. The last one is how `stopSession` reports a missing persisted binding (`ProviderService.ts:805-812`, `:1489-1493`).
     - Any other failure → `appendProviderFailureActivity({ kind: "provider.session.stop.failed", summary: "Provider session stop failed", detail: formatFailureDetail(cause), … })` and return. The row is settled by that activity, and the projected session stays truthful (not "stopped").
   - Dispatch the existing stopped `setThreadSession` with `updatedAt: at`.
   - Callers:
     - the live path passes `at = event.payload.createdAt` (unchanged behaviour)
     - recovery passes `at = new Date().toISOString()`
7. **Escaping failures** (`processDomainEventSafely`, `:1790-1801`, or the per-lane wrapper `reactor-concurrency` introduces). For non-interrupt causes, when `isTrackedProviderIntentEvent(event)` holds, run `surfaceIntentFailure(event, cause)` before logging:
   - `providerEffectIntents.get({ sequence })`:
     - no row (already settled) → nothing
     - `dispatchedAt !== null` → `logWarning` only (rule §2.6)
   - **turn-start:**
     - append `provider.turn.start.failed` with `messageId`, `summary: "Provider turn start failed"`, `detail: formatFailureDetail(cause)`
     - ids: `server:provider-intent-failure:<sequence>` / `provider-intent-failure:<sequence>`
   - **turn-steer:** resolve as rejected with `formatFailureDetail(cause)` (sliced to 1000 characters, as at `:1563-1565`).
   - **session-stop:** append `provider.session.stop.failed`.
   - `surfaceIntentFailure` catches its own failures and logs them. The row then survives for the next boot.
8. **`recoverIntents`.** New member on `ProviderCommandReactorShape`:
   ```ts
   export interface ProviderIntentRecoverySummary {
     readonly replayed: number;
     readonly cancelledTurnStarts: ReadonlyArray<{ readonly threadId: ThreadId; readonly messageId: MessageId; readonly deliveryState: IntentDeliveryState }>;
     readonly rejectedSteers: number;
     readonly retriedSessionStops: number;
     readonly handoffsAbandoned: number;
     readonly settledWithoutOutcome: number;
   }
   readonly recoverIntents: () => Effect.Effect<ProviderIntentRecoverySummary>;
   ```
   - It implements §2.5 sequentially (`concurrency: 1`).
   - Events are read with `orchestrationEngine.readEventsPage(row.sequence - 1, 1)`, checking that `events[0]?.sequence === row.sequence` and that the event type matches the row kind.
   - Rows above `bootSequence` are replayed through the same entry point the live subscription uses.
   - Each row's handling is wrapped in `catchCause`: non-interrupt → `logWarning`, row kept. Interrupts propagate.
   - It never fails, so startup is never blocked. It logs the summary at info.

### 3.7 Handoff: `orchestration/Services/ContextHandoffCoordinator.ts`, `orchestration/Layers/ContextHandoffCoordinator.ts`

1. Add to the shape:
   ```ts
   /**
    * Resolve a handoff turn start whose process died before the coordinator
    * took it past `requested`. Never touches source/target runtimes.
    */
   readonly abandonUnstartedTurnStart: (
     event: ContextHandoffTurnStartEvent,
     detail: string,
   ) => Effect.Effect<"owned" | "abandoned" | "unrecognized">;
   ```
2. Implementation:
   1. `acquire(handoffId)` fails (in flight in this process) → `"owned"`.
   2. Load the record. If it exists with `status !== "requested"` → `"owned"`. `recover()` already ran at `OrchestrationReactor.start` (`OrchestrationReactor.ts:21`) and owns preparing and dispatching records. Terminal records already have their activity.
   3. Validate the requested activity exactly as `processTurnStart` does (`:974-981`): `decodeRequestedActivity`, matching `handoffId` / `targetMessageId`. On failure → `"unrecognized"`.
   4. If there is no record, create it through the same helper `processTurnStart` uses. Extract `createRequestedRecord(thread, reference, requested, createdAt)` from `:983-995` so the two paths cannot drift.
   5. `resolvePresentation(thread, record)`. On failure → `"unrecognized"`, which leaves the record `requested` and nothing invisible.
   6. `appendTerminalActivity({ status: "failed", error: detail, sources: [presentation.source], … })` **before** the status transition, the same order as `finalizeFailure` (`:509-539`). If the append fails, the error propagates, so the record stays `requested` and the next boot retries.
   7. `compareAndSetStatus(requested → failed)` and increment `contextHandoffsTotal{status:"failed"}` → `"abandoned"`.
   - It **never** calls `restoreSource`, `stopSessionBinding` or `retireSessionBinding`. A `requested` record has swapped nothing yet; `runPreparing` moves to `preparing` before any runtime work (`:785-797`). This fixes the draft's error-marking of an idle `ready` source session.
   - It runs inside `Effect.ensuring(release(handoffId))`.
3. Update the test doubles in `ProviderCommandReactor.test.ts` and `OrchestrationReactor.test.ts`.

### 3.8 Startup: `orchestration/Services/OrchestrationReactor.ts`, `Layers/OrchestrationReactor.ts`, `serverRuntimeStartup.ts`

1. Add `readonly recoverProviderIntents: () => Effect.Effect<ProviderIntentRecoverySummary>` to `OrchestrationReactorShape`. It delegates to `providerCommandReactor.recoverIntents()`.
2. In `serverRuntimeStartup.ts`, extract the three orchestration phases into an exported runner. This makes the order testable without the whole startup graph:
   ```ts
   export const startOrchestrationRuntime = (reactorScope: Scope.Closeable) =>
     Effect.gen(function* () {
       const orchestrationReactor = yield* OrchestrationReactor;
       const providerSessionReaper = yield* ProviderSessionReaper;
       yield* runStartupPhase("reactors.start", Effect.all([...existing...], { concurrency: "unbounded", discard: true }));
       yield* runStartupPhase("provider-sessions.reconcile", reconcileOrphanedProviderSessions);
       return yield* runStartupPhase("provider-intents.recover", orchestrationReactor.recoverProviderIntents());
     });
   ```
3. `makeServerRuntimeStartup` calls it in place of `:778-791`. The phase therefore completes before `commandGate.signalCommandReady` (`:874`).
4. `restart-continuation` adds its phase after this one and receives the summary.

---

## 4. Integration requirements with `reactor-concurrency` (re-check against its merged code before implementing)

These requirements hold for any lane or executor shape:

- **R1.** Replayed this-process events (§2.5) enter through the **same** per-thread entry point as live events. There is no side queue. That way per-thread ordering and the dedup cache apply to both.
- **R2.** The wrapper that catches a handler's failure, including per-lane `TimeoutError`, calls `surfaceIntentFailure(event, cause)` for tracked kinds before it logs. Only interrupt-only causes skip it. A lane timeout therefore always produces a visible outcome, and that outcome settles the row.
- **R3.** `sendTurn` and `steerTurn` stay forked outside the lane timeout, after `markDispatched`. If `reactor-concurrency` moved them in-lane, the timeout must not cover anything after `markDispatched`. In either case `surfaceIntentFailure` is a no-op for dispatched rows, so a timeout can never claim failure for a call that may have reached the provider.
- **R4.** `recoverIntents` runs after `start()`: both live in the reactor scope, and startup orders them through separate phases.

`restart-continuation` (next on the branch):

- It must run after `provider-intents.recover`.
- It must skip threads listed in `summary.cancelledTurnStarts`.
- Its own startup turn starts are this-process rows (`sequence > bootSequence`), so recovery never cancels them.

---

## 5. Contract / migration changes

- **Migration 072:** as in §3.1. It has no foreign keys. The table holds only open intents, so it stays near-empty in steady state.
- **`packages/contracts`:** no change.
  - `OrchestrationThreadActivity.payload` is `Schema.Unknown`.
  - The web renders `provider.turn.start.failed`, `provider.turn.steer.failed` and `provider.session.stop.failed` generically (summary/detail).
  - `deliveryState` is informational.
- **Internal shapes:** see the header. Every test double gets a mechanical update.
- **Hosted Hub, mobile and the web phone tier:** untouched. No lifecycle or auth policy moves.
- **Agent Control:** untouched.
  - Recovery never auto-sends a delegated return.
  - It never approves or answers requests.
  - Child output labelling is unaffected.

---

## 6. Tests (write the failing ones first)

Run them focused, for example `bun run --cwd apps/server test src/orchestration/Layers/ProviderCommandReactor.test.ts`. Never use `bun test`. These are `it.effect` (TestClock) unless the test needs real fibers or sockets; use `it.live` where a test waits on a real `Deferred` across runtimes.

**`orchestration/providerEffectIntents.test.ts` (new, table-driven)**

1. Each tracked request event yields a record with the right `kind`, `messageId` and `handoffId`.
2. Each settling event yields exactly the settlements in §2.3, with `beforeSequence = event.sequence`.
3. A non-terminal handoff status (`requested`, `preparing`, `dispatching`), an undecodable handoff payload, a `provider.turn.start.failed` without `messageId`, and a non-running or non-stopped session-set all yield nothing.
4. `recoveryCopy` covers all 6 variants.

**`persistence/Layers/ProviderEffectIntents.test.ts` (new)** 5. Each settlement deletes only matching rows with `sequence < beforeSequence`. `DispatchedTurnStarts` ignores rows that were never dispatched and handoff rows. 6. `markDispatched` is idempotent and does not overwrite the first timestamp. 7. `listOpen` is ordered by sequence. 8. `noteRecoveryAttempt` increments and returns the new count.

**`persistence/Migrations/072_ProviderEffectIntents.test.ts` (new)** 9. The table exists after migrating through 72, and the `kind` CHECK rejects an unknown kind.

**`OrchestrationEngine.test.ts`** 10. `thread.turn.start` commits the message, the request event and an intent row together. A later `thread.activity.append` of `provider.turn.start.failed` with that `messageId` removes the row in the same commit. 11. A multi-event command that fails mid-transaction leaves no intent row. 12. `bootSequence` equals the event-store head at construction and does not move after later dispatches.

**`ProviderCommandReactor.test.ts`**

- Add a `dbPath?: string` harness option. It uses `makeSqlitePersistenceLive(dbPath)` instead of `SqlitePersistenceMemory`, so two sequential runtimes can share one database and simulate a restart.
- Add optional decorators for `OrchestrationEngineService.dispatch` and `ProviderEffectIntentRepository`, provided only to the reactor, for fault injection.

13. **Crash before dispatch.**
    - Runtime 1 without a reactor dispatches `thread.turn.start` and is disposed.
    - Runtime 2 runs `start()` and then `recoverIntents()`.
    - Expect one `provider.turn.start.failed` with `messageId`, `deliveryState: "not-sent"` and the not-sent copy. `sendTurn` has 0 calls, the row is gone, and the session is unchanged.
14. **Crash mid-`sendTurn`** (critique tests a and d).
    - Runtime 1 starts the reactor with `sendTurn` blocked on a `Deferred`. Wait until it is invoked, then assert `dispatched_at` is set (read the row from inside the mock).
    - Dispose runtime 1. The forked fiber is interrupted, and the row is kept with `dispatched_at` set.
    - Runtime 2 recovers: the uncertain copy, and `sendTurn` / `interruptTurn` have 0 calls.
    - Variant: runtime 2's `listSessions` reports a live session for the thread. The result must be the same, with no provider calls.
15. **Delegated return variant.** A `delegationReturnGuard` turn start uses the delegated copy, and nothing is re-dispatched.
16. **Steer.** A prior-process steer that was not dispatched produces `thread.turn-steer-rejected` plus a `provider.turn.steer.failed` activity with the not-sent copy. A dispatched one uses the uncertain copy. In both cases the row is gone and `steerTurn` has 0 calls.
17. **Session stop.**
    - A prior-process stop → `stopSession` is called once, and the session becomes `stopped` with `updatedAt` equal to the recovery time (not the event's `createdAt`).
    - `stopSession` failing with `ProviderSessionNotFoundError`, or with the no-binding `ProviderValidationError`, still produces `stopped`.
    - `stopSession` failing with `ProviderAdapterRequestError` produces a visible `provider.session.stop.failed`, the session is not `stopped`, and the row is gone.
    - The live path shows the same three outcomes.
18. **Handoff.**
    - `abandonUnstartedTurnStart` returns `"owned"` → the row is settled and no activity is added.
    - It returns `"unrecognized"` → a generic `provider.turn.start.failed` is added.
19. **Publish-after-subscribe partition** (critique test b).
    - With `startReactor: false`, dispatch a `thread.turn.start` after engine construction. It is published with no reactor subscriber, so it is missed live.
    - Then run `start()` and `recoverIntents()`. Expect `sendTurn` called **exactly once**, no cancellation activity, and `summary.replayed === 1`.
    - Second case: dispatch while `start()` holds the subscription but before the list. Expect the turn delivered once (dedup).
20. **Escaping failure** (critique test e).
    - Wrap the projection query so that `getThreadMessageById` fails, or use `reactor-concurrency`'s lane timeout under TestClock.
    - Expect a visible `provider.turn.start.failed` with the formatted detail, and the row is gone.
    - The same injection _after_ `markDispatched` (lane timeout while `sendTurn` hangs) adds no failure activity, and the row stays.
21. **Failure append fails.** `sendTurn` fails and the decorated `dispatch` rejects `thread.activity.append` (both attempts). The row stays open, and a later recovery in runtime 2 surfaces it.
22. **Model-selection commit failure.** `sendTurn` succeeds with a changed `modelSelection` and the decorated `dispatch` rejects `thread.meta.update`. Expect no `provider.turn.start.failed`, no session error, and a warning logged.
23. **`markDispatched` fails** (decorated repository). Expect a visible start failure, and `sendTurn` is not called.
24. **Idempotency and poison rows.**
    - Running recovery twice, by restarting a third runtime before settle commits (simulated by the decorated repository's `settle` being a no-op), yields exactly one activity, because the ids are deterministic and the command receipt dedups.
    - A row whose recovery dispatch always fails is settled with `logError` after 5 boots.

**`ContextHandoffCoordinator.test.ts`** 25. No record → a `failed` record is created and a terminal `failed` activity is appended. Expect no `setThreadSession` dispatch, no `restoreSessionBinding` / `stopSessionBinding` / `retireSessionBinding` calls, and an idle `ready` source session that stays `ready`. 26. A `requested` record → the same, through CAS. 27. A `preparing` record → `"owned"` and nothing is changed. 28. An undecodable requested activity → `"unrecognized"`, and the record (if any) stays `requested`. 29. A failing terminal append propagates, and the record stays `requested`.

**`ProjectionPipeline.test.ts`** 30. Routing assertion: `ORCHESTRATION_EVENT_PROJECTORS["thread.activity-appended"]` includes `threadTurns`, and the key count stays 44. 31. A `provider.turn.start.failed` activity for M deletes only M's pending row. Another message's pending row stays, and a bound turn row whose `pending_message_id = M` stays.

**`CompletionReturnDelivery.test.ts`** (written against the merged `delegation-returns` shape) 32. A sibling return after a cancelled delegated-return start (pending row removed by the recovery activity) reaches a terminal non-delivered state (`blocked` or `cancelled`), and `thread.turn.start` is never dispatched.

**`serverRuntimeStartup.test.ts`** (critique test c) 33. `startOrchestrationRuntime` with spy doubles: - for `OrchestrationReactor` (`start`, `recoverProviderIntents`) and `ProviderSessionReaper` - for the reconcile dependencies: `ProviderService.listSessions`, which records "reconcile", plus an empty `ProjectionSnapshotQuery` / `ProviderSessionDirectory` / engine - Assert the call order `start` → `reconcile` → `recover`, and that the runner returns the summary.

**`OrchestrationReactor.test.ts`** 34. `recoverProviderIntents` delegates to the provider command reactor.

Validation is proportional but cross-cutting, because shape changes ripple into test doubles:

- the focused files above
- `bun typecheck` (the TS7 gate, where `warning TS*` also fails)
- `bun lint`
- no full build

---

## 7. Edge cases

- **Two concurrent dispatched starts on one thread** (A, B both pass the active-turn check before either runs).
  - A's running set settles both dispatched rows.
  - If the process dies before B's outcome, B is not reported after restart.
  - This is accepted: it needs a double race, and the outcome of B's `sendTurn` in the live process still produces a visible failure.
- **`sendTurn` fails although the provider accepted it** (adapter-specific).
  - The failure activity deletes the pending row before the running set can bind it, so that turn row has no `pending_message_id`.
  - `AgentControlCompletionReturns.turnMessageId` (`:126-131`) then returns null for it.
  - This residual case existed before as a contradictory failure. The fix in §3.6 step 4 removes the common source of it (model-selection commit).
- **External OpenCode** (`serverUrl`).
  - A dispatched prompt may keep running remotely after the restart. Recovery says "may have been received", which is the honest wording.
  - A lost **interrupt** for such a server is not recovered. Ryco has no binding to the remote turn after restart, so `stopExactBinding` returns not-found. See §8.
- **Graceful shutdown.** In-flight provider calls are interrupted, rows are kept, and the next boot reports not-sent or uncertain. This matches t3.
- **Thread archived.** Activity append and steer resolve are allowed. If the decider rejects them, recovery settles the row and logs.
- **Thread deleted after the request.** `thread.deleted` settles every row in the same transaction.
- **Goal-resume turns.** `processGoalUpdated` starts these server-side turns at boot. They are this-process rows, so they run live and are never cancelled.
- **Two servers on one state directory.** This is unsupported, the same as for orphan reconciliation: recovery would cancel the other process's in-flight intents.
- **Projection rebuild.** The ledger is not a projection, so rebuilds do not touch it.
- **Pending-row cleanup on rebuild.** The pending-row deletion is event-derived, so a threadTurns rebuild reproduces it.

---

## 8. Out of scope and known gaps

- **Lost `thread.checkpoint-revert-requested`.** `CheckpointReactor` has the same live-only lazy subscription (`CheckpointReactor.ts:895-901`). No package currently owns this, and `rollback-correctness` covers ordering and admission, not crash loss.
  - Recommended follow-up: track it as a process-bound kind, settled by `thread.reverted` or the revert-failure activity, with the recovery wording "Ryco restarted before the revert finished; files may be partially restored".
  - It is not done here because a partial file restore needs `CheckpointReactor`-specific recovery.
- **Interrupts against provider runtimes that outlive Ryco** (external OpenCode).
- **The `CompletionReturnDelivery` "delivered" receipt status.** Unchanged; it is receipt-level by design.
- **Handoff turn starts already `preparing` at crash time.** Their resume semantics in `ContextHandoffCoordinator.recover()` are unchanged. They are resumed, not cancelled.
- **A handoff abandoned by recovery leaves its pending `projection_turns` row.** The row clears on the next turn start. Only `provider.turn.start.failed` deletes pending rows.
- **Backfilling stuck pre-072 intents.** Not done (see §9, issue 11).
- **Event retention/pruning.** Only the constraint in §3.1 is specified.
- **No UI changes.** Activities render generically.

---

## 9. Review resolution

| #   | sev           | critique issue                                                                                                                              | resolution                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | major         | Recovery conflates "never reached the provider" with "delivery not proven"                                                                  | **Accepted.** `dispatched_at` column, set immediately before `sendTurn`/`steerTurn`. Two wordings for turn start, delegated return and steer. Tests 13–16, including one with a provider session that is live in `listSessions`                                                                                                                                 |
| 2   | major         | Settling on any non-interrupt exit can delete rows while the outcome is invisible; the model-selection commit failure fakes a start failure | **Accepted, made structural.** Rows are deleted only inside the transaction that commits the outcome event (I1). Explicit settles exist only where no outcome can exist. `commitAcceptedModelSelection` failure only logs. Reactor-level failures and lane timeouts surface visibly through `surfaceIntentFailure`, and dispatched rows are exempt. Tests 20–23 |
| 3   | minor         | The cutoff split misclassifies this-process events                                                                                          | **Accepted, simplified.** The engine captures `bootSequence` before forking its worker. Rows above it replay through the live entry with the existing dedup, so no cutoff read is needed. The subscription is now acquired synchronously. Test 19                                                                                                               |
| 4   | minor         | `abandonUnstarted` → `finalizeFailure` → `restoreSource` without a binding errors the source session; "ignored" settles silently            | **Accepted.** `abandonUnstartedTurnStart` never calls `restoreSource` or the binding stop/retire calls, appends the terminal activity before the CAS, and falls back to a generic failure when the result is `"unrecognized"`. Tests 18, 25–29                                                                                                                  |
| 5   | minor         | The repository duplicates `latestSequence`, `hasEventAfter` and the LocalTask probes                                                        | **Accepted in effect.** Event-derived settlement removes outcome probes entirely. The repository only records, marks, settles, lists and gets. The head sequence comes from `OrchestrationEventStore.latestSequence` and events are read via `readEventsPage`. Extracting the LocalTask probes is rejected here: no new caller needs them                       |
| 6   | minor         | The pending-row deletion changes delegation-return semantics untested                                                                       | **Accepted.** `delegation-returns` is named as an overlap, and tests 30–32 are added                                                                                                                                                                                                                                                                            |
| 7   | minor         | Problem statement and scope are inconsistent                                                                                                | **Accepted.** "Forever" corrected (§1.3), the CompletionReturn status moved to out of scope, and checkpoint-revert crash loss listed as a known unowned gap (§8)                                                                                                                                                                                                |
| 8   | minor         | Session-stop retry is fragile                                                                                                               | **Accepted.** The shared `stopThreadSession` treats not-found and no-binding as already stopped, stamps the recovery time, and surfaces other failures visibly (live path too). Test 17                                                                                                                                                                         |
| 9   | minor         | Test gaps (a)–(e)                                                                                                                           | **Accepted.** (a) and (d) → test 14, (b) → test 19, (c) → test 33, (e) → test 20                                                                                                                                                                                                                                                                                |
| 10  | minor         | Wave-3 integration written as conditionals                                                                                                  | **Accepted.** Replaced by the shape-independent requirements R1–R4 (§4), which must be re-checked against the merged `reactor-concurrency` before coding                                                                                                                                                                                                        |
| 11  | minor         | No backfill for already-stuck intents                                                                                                       | **Rejected.** Whether historical rows were dispatched is unknowable, and a backfill would append fresh errors to arbitrarily old threads on upgrade (resurfacing them in priority and inbox). Today's stuck pending rows already clear on the thread's next turn start                                                                                          |
| —   | verdict notes | three overstated claims                                                                                                                     | **Accepted.** They are corrected in §1.3 and drive the wording in §2.4                                                                                                                                                                                                                                                                                          |

---

## 10. Risks

- **Shape churn.** The required `bootSequence` touches every engine test double. It is mechanical, but `bun typecheck` must pass.
- **SQLite contention.** `markDispatched` is one extra autocommitted write per turn start or steer. It contends with the engine transaction for the SQLite writer only briefly.
- **Per-commit overhead.** `applyEvent` adds no SQL for most events. It adds one indexed DELETE for lifecycle session-sets and for start/stop failure activities.
- **Pending-row deletion is a semantic change for consumers of `projection_turns`:** storage cleanup, thread priority and completion returns. It is intended, and tests cover it, but `delegation-returns` (W2) must be re-read before merging.
- **Rebase onto `reactor-concurrency`.** If R2 or R3 are wired incorrectly, a lane timeout could claim failure for a delivered turn. Tests 20 and 21 guard against that.
- **Poison rows.** These are bounded by `MAX_PROVIDER_INTENT_RECOVERY_ATTEMPTS`. A genuinely transient multi-boot outage could exhaust the attempts and settle a row with only a log line. This is accepted given the bound.
