# 14 · reactor-concurrency: per-thread lanes, bounded provider operations, Stop that always gets through, and turn liveness (bug 13)

| Field | Value |
| --- | --- |
| id | `reactor-concurrency` |
| title | Replace the provider command reactor's single global worker with per-thread lanes. Add a fence so Stop cancels pending and in-flight session starts. Deliver approvals and Stop to a thread whose lane is busy with a context-handoff turn. Put a real deadline on every provider operation, one that holds even when the loser cannot be interrupted, and show a readable error when it fires. Add a liveness check for active turns: it settles turns whose runtime is gone, and only warns when a live provider goes quiet |
| wave | 3 (sequential, same branch). Order: **`reactor-concurrency`** → `provider-effect-outbox` → `restart-continuation`. This package runs first |
| verdict | **confirmed, and worse than the brief says.** (1) There is one global serial worker (`ProviderCommandReactor.ts:1803-1809`, `DrainableWorker.ts:56-65`). (2) Session start, recovery start, interrupt, stop, approval responses and goal sync are all unbounded (`ProviderService.ts:1020-1025`, `:750-766`, `:1336`, `:1500-1502`, `:1421`, `:1213`). (3) The reaper never looks at active turns (`ProviderSessionReaper.ts:79-88`), and `lastSeenAt` does not move on runtime events (`ProviderService.ts:320-346`). (4) **New: today an ACP-target context handoff deadlocks the whole reactor.** The worker awaits the handoff (`:1262-1266`). The handoff awaits `sendTurn` (`ContextHandoffCoordinator.ts:734-748`). ACP `sendTurn` awaits the entire `prompt` (`AcpAdapter.ts:916-924`, `CursorAdapter.ts:1134`). A permission request inside that turn waits for a decision Deferred (`AcpAdapter.ts:532-571`) that can only be resolved by a reactor event queued behind the handoff. (5) **New:** `Effect.timeoutOption` and `race` await the loser's interruption (`effect/src/internal/effect.ts:1548`, `:3729-3747`). So even the one existing bound, the stale stop (`ProviderService.ts:635`), does not hold for an adapter that cannot be interrupted |
| size | **L** |
| touched files | **shared (new):** `packages/shared/src/KeyedSerialWorker.ts` (+`.test.ts`), `packages/shared/src/KeyedSerialExecutor.ts` (+`.test.ts`), `packages/shared/package.json` (2 exports). **server, provider:** `apps/server/src/provider/detachedDeadline.ts` (new, +test), `apps/server/src/provider/providerOperationPolicy.ts` (new, +test), `apps/server/src/provider/Errors.ts`, `apps/server/src/provider/Services/ProviderAdapter.ts`, `apps/server/src/provider/Services/ProviderService.ts`, `apps/server/src/provider/Layers/ProviderService.ts` (+test), `apps/server/src/provider/Layers/AcpAdapter.ts` (capabilities literal only), `apps/server/src/provider/Layers/CursorAdapter.ts` (capabilities literal only). **server, orchestration:** `apps/server/src/orchestration/threadLaneControl.ts` (new, +test), `apps/server/src/orchestration/providerTurnLiveness.ts` (new, +test), `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` (+test), `apps/server/src/orchestration/Services/ProviderCommandReactor.ts`, `apps/server/src/orchestration/Services/ContextHandoffCoordinator.ts`, `apps/server/src/orchestration/Layers/ContextHandoffCoordinator.ts` (+test), `apps/server/src/orchestration/Layers/OrchestrationReactor.test.ts` (test double only), `apps/server/src/orchestration/providerFailureActivity.ts` (from W1 `reactor-errors-switch`: kinds plus one info builder), `apps/server/src/orchestration/turnFinalization.ts` (from W1 `turn-finalization`: 3 reason keys), `apps/server/src/orchestration/userFacingErrors.test.ts` (2 cases). **agent control:** `apps/server/src/agentControl/Layers/CompletionReturnDelivery.ts` (raise `MAX_COLD_WAKES_IN_FLIGHT`, one constant plus comment), with its test expectation. **client-runtime:** `packages/client-runtime/src/state/message-queue/threadView.ts` and `packages/client-runtime/src/state/session/dispatchAck.ts` (from W1 `queue-hold-drain`: read one more activity kind), plus their tests |
| migrations | **none.** No number used. 071–075 belong to other packages |
| contract changes | **None in `packages/contracts`.** Activity `kind` is an open `TrimmedNonEmptyString` (`orchestration.ts:774`, `:805`). New kinds: `provider.turn.start.cancelled` (info), `provider.turn.unresponsive` (info), `provider.turn.lost` (error), `provider.session.restart.failed` (error). **Internal server shapes:** `ProviderAdapterCapabilities.turnSubmission?` (new); `ProviderServiceShape.interruptTurn` never recovers and fails `ProviderSessionNotFoundError` when no runtime is live; `ProviderServiceShape.listRuntimeActivity?` (new, optional); `ProviderServiceShape.sendTurn` drops the unused `expectedRuntime` parameter (W2 cleanup, §3.6); `ProviderServiceError` gains `ProviderOperationTimeoutError`; `ContextHandoffCoordinatorShape.processTurnStart(event, control?)` (optional second argument); `ProviderCommandReactorShape.sweepLiveness` (new, required); `ProviderServiceLiveOptions.operationTimeouts?`; `makeProviderCommandReactorLive(options?)`. **Operator env (optional):** `RYCO_PROVIDER_SESSION_START_TIMEOUT_MS`, `RYCO_PROVIDER_TURN_ACCEPT_TIMEOUT_MS`, `RYCO_PROVIDER_CONTROL_TIMEOUT_MS`, `RYCO_PROVIDER_UNRESPONSIVE_AFTER_MS` |
| overlaps | **W3 `provider-effect-outbox` (next):** `ProviderCommandReactor.start`, the lane entry point, `processLaneItemSafely` (its R1–R4, §8), `processTurnStartRequested`, `ContextHandoffCoordinatorShape`. **W3 `restart-continuation`:** synthetic events and the fence rule, plus handoff `recover()` at startup (§7). **W1 `reactor-errors-switch`:** `reportTurnStartFailure`, `setThreadSessionErrorOnTurnStartFailure`, `processDomainEventSafely` (its follow-ups 5 and 7 are taken here), `providerFailureActivity.ts`, `userFacingErrors.ts`, the coordinator's `processTurnStart` catch, and the `AcpAdapter.ts` capabilities literal. **W1 `turn-finalization`:** `setThreadSession` `turnOutcome`, `TURN_FINALIZATION_REASON`, `bindSessionToThread`, `processSessionStopRequested`, `recoverInterruptFailure`. **W1 `queue-hold-drain`:** `threadView.ts` / `dispatchAck.ts` kind list. **W1 `settlement-signals`:** semantic only (new activity kinds). **W1 `acp-message-ids`, `provider-compat`:** test-harness neighbours only. **W2 `delegation-returns`:** removes the guarded `sendTurn` caller and leaves the parameter for this package to delete; this package lifts its cold-wake cap. **W2 `claude-steering`:** `Errors.ts` (adjacent class), `ProviderService.steerTurn` (one added line), `ProviderAdapterCapabilities` (adjacent field). **W2 `rollback-correctness`:** `resolveRoutableSession` recovery bound (`rollbackConversation` uses it), and a possible adjacent capability field. **W2 `usage-limits`:** `reportTurnStartFailure` (cancel branch inserted before its limit branch). **W1 `claude-meter-wake`:** semantic: Claude `sendTurn` can now be interrupted by the acceptance deadline. Details in §8 |

---

## 1. Problem (verified against `9e545b3ae`, re-read for every claim)

### 1.1 One worker for every thread

- `makeDrainableWorker` runs **one** fiber: `TxQueue.take` → `process` → `Effect.forever` (`packages/shared/src/DrainableWorker.ts:56-65`).
- The reactor creates a single instance (`ProviderCommandReactor.ts:1803-1809`, capacity 512). Every provider-intent event from every thread goes into it (`:1812-1826`). That includes startup goal recovery (`:1832-1851`).
- Inside it, `ensureSessionForThread` (`:522-762`) is awaited by:
  - turn start (`:926-930`)
  - goal update (`:1447`)
  - runtime-mode change (`:1743`)
  - token-mode change (`:1756`)

  It ends in `ProviderService.startSession`, which has no deadline (`ProviderService.ts:930-1080`; adapter start at `:1020-1025`).
- So one cold or hung start blocks every thread's Stop (`thread.turn.interrupt`; the composer sends no `turnId`, `apps/web/src/hooks/chatSessionActions.ts:15-22`). It also blocks approvals, user-input answers and turn starts.

### 1.2 Every provider control call is unbounded

| Call | Where | Bound today |
| --- | --- | --- |
| adapter `startSession` (fresh, restart, handoff) | `ProviderService.ts:1020-1025` | none; also waits unbounded on the per-thread start lock (`:300-318`) and admission (`:491-507`) |
| recovery `startSession` | `:750-766` (reached through `resolveRoutableSession(allowRecovery: true)`, `:854-857`) | none |
| `interruptTurn` | `:1315-1350`; uses `allowRecovery: true` (`:1324-1328`), so it takes the start lock and can **resurrect** a dead runtime just to interrupt it | none |
| `stopSession` | `:1500-1502` | none; the reactor's caller has no catch (`ProviderCommandReactor.ts:1702-1704`), so a failed Stop is only logged (`:1790-1801`) |
| `respondToRequest` / `respondToUserInput` | `:1421`, `:1468` | none |
| `setThreadGoal` / `getThreadGoal` / `clearThreadGoal` | `:1201-1243` (awaited in the turn-start path via `reconcileThreadGoal`, `:764-871`) | none |
| stale-runtime stop | `stopExactBinding`, `:634-637` | `timeoutOption(2s)`, but see 1.4 |
| `sendTurn` acceptance | Claude awaits `query.setModel` / `setPermissionMode` (`ClaudeAdapter.ts:4870`, `:4896-4905`). OpenCode `promptAsync` (`OpenCodeAdapter.ts:2504`). Copilot `sendAndWaitForTurnStart` (`CopilotAdapter.session.ts:500`). ACP and Cursor await the **whole** prompt after emitting `turn.started` (`AcpAdapter.ts:897-924`, `CursorAdapter.ts:1050`, `:1134`) | none (Codex RPC has its own 20 s) |

### 1.3 Context handoff turns block the reactor; with ACP targets this is a deadlock

- The handoff branch awaits `contextHandoffCoordinator.processTurnStart(event)` inside the worker (`ProviderCommandReactor.ts:1262-1266`).
- The coordinator awaits `providerService.sendTurn` (`ContextHandoffCoordinator.ts:734-748`).
- For ACP adapters (ACP registry and Grok are built on `makeAcpAdapter`, `GrokAdapter.ts:12`) and for Cursor, `sendTurn` returns only when the turn ends.
- A permission request inside that turn parks on `Deferred.await(decision)` (`AcpAdapter.ts:532-571`). The decision is delivered by `thread.approval-response-requested`, which sits in the same worker queue behind the handoff. Result: the **global** reactor waits forever, and so does every thread on the server.
- Interrupt and session stop for the handoff thread are queued behind the turn too.
- Fresh handoffs keep the source runtime alive until acceptance (`ProviderService.ts:1048-1058`). On failure, `finalizeFailure` → `restoreSource` re-binds the source and projects it `ready` (`ContextHandoffCoordinator.ts:414-443`, `:496-502`). Any design that lets Stop reach a handoff mid-turn must stop that restore from bringing the source back (critique blocker).

### 1.4 Effect timeouts await the loser

- `raceAll` / `raceAllFirst` resume with `flatMap(uninterruptible(fiberInterruptAll(fibers)), () => exit)` (`apps/server/node_modules/effect/src/internal/effect.ts:1503`, `:1548`). `fiberInterruptAll` awaits the interrupted fibers (`:887-897`).
- `timeout` and `timeoutOption` are built on `raceFirst` (`:3676-3747`). So a deadline wrapped directly around an adapter call that sits in an uninterruptible region, or that has slow scope finalizers (ACP `Scope.close(sessionScope)` kills a child process, `AcpAdapter.ts:416-419`), returns only after that region ends.
- `forkIn` removes its scope finalizer when the fiber exits (`internal/effect.ts:5320-5331`). Forking per lane does not leak finalizers.

### 1.5 The reaper ignores hung turns

- `ProviderSessionReaper` skips any binding whose projected session has an active turn (`ProviderSessionReaper.ts:79-88`).
- Its signal is `binding.lastSeenAt`. That value is written by `directory.upsert` (`ProviderSessionDirectory.ts:144`), which runs on start, send, steer and stopAll only. `publishRuntimeEvent` never touches it (`ProviderService.ts:320-346`).
- A hung provider with an active turn is therefore never reaped. Wall time alone cannot tell a hung turn from a long, silent one: a Codex shell command, an ACP tool, or a turn waiting on a user approval.

### 1.6 Cross-thread invariants (audit for removing global serialization)

| Shared state | Cross-thread? | Action |
| --- | --- | --- |
| `ensureRecordedWorktreeAvailable` recreating a missing worktree (`:413-520`) | **Yes.** Two threads with the same recorded `worktreePath` can both get past the re-check (`:474-483`) and race `createWorktree` (`:485`). The git driver's per-destination lock turns the loser into "Worktree destination already exists" | Keyed lock on the resolved path (§3.9.4) |
| Provider startup admission (per instance: 4 running, 64 pending, `ProviderService.ts:103-104`, `:377-508`) | Yes, but already concurrency-safe. The serial worker used to hide it; lanes make bursts possible | Throttle synthetic goal recovery (§3.9.10). Raise, but keep, the Agent Control cold-wake cap (§3.13) |
| `handledTurnStartKeys` cache (`:260-271`) | Keys are per command/event, and each event belongs to one thread, so its lane sees it | none |
| `threadModelSelections` (`:273`), `stageComputerTurn` (`computerTurnLifecycle.ts:21-24`) | Keyed by thread id | none |
| `ContextHandoffCoordinator.inFlight` (keyed by handoff id), handoff source and target (same thread) | No | none |
| Delegated returns (parent thread turn start) | No: the guard is decided in the decider, and the reactor sees only the parent's lane | none |

### 1.7 Related findings, owned elsewhere

- `OrchestrationReactor.start` awaits `contextHandoffCoordinator.recover()` before any reactor starts (`OrchestrationReactor.ts:20-31`). Startup awaits that before reconciling orphans (`serverRuntimeStartup.ts:778-791`). A recovered ACP handoff in `preparing` can therefore block startup for a whole turn, and its runtime events are published before ingestion subscribes. Moving that recovery into thread lanes interacts with the order of `reconcileOrphanedProviderSessions`, so it belongs to **`restart-continuation`** (§7).

---

## 2. Design

### 2.1 Concurrency model

```
engine.streamDomainEvents ──► consumer fiber (one) ──► routeProviderIntentEvent(event, { fenceSequence })
                                   │  1. laneControl.noteEvent(event)          (sync bookkeeping, fires start cancels)
                                   │  2. if turn-owning handoff & user stop/interrupt → outOfBandLanes.enqueue
                                   │  3. approval / user-input response       → callbackLanes.enqueue(threadId)
                                   │     everything else                      → lifecycleLanes.enqueue(threadId)
                                   ▼
             lifecycleLanes  (KeyedSerialWorker<ThreadId>, FIFO per thread, threads run concurrently)
             callbackLanes   (KeyedSerialWorker<ThreadId>, FIFO per thread)
             outOfBandLanes  (KeyedSerialWorker<ThreadId>, provider-side stop/interrupt only)
```

- **Lifecycle lane, one per thread.** Handles turn start (including handoff), steer, interrupt, session stop, runtime-mode and token-mode changes, goal updated and cleared, and liveness-check items.
  - All items for a thread run in the order they were committed.
  - Threads run concurrently.
  - The lane is the **only writer** of provider-lifecycle projections for its thread: the thread's session and the cancel / stop / interrupt settlement.
- **Callback lane, one per thread.** Handles `thread.approval-response-requested` and `thread.user-input-response-requested`. These are pure deliveries to one exact runtime:
  - the claim state machine (`:1597-1607`);
  - the runtime identity check against the projection (`:1620-1627`);
  - `expectedRuntimeSessionId` re-checked by `ProviderService` on the live routed session (`:1407-1413`, `:1454-1460`);
  - no recovery, no session start, and activity appends as the only projection writes.

  Running them outside the lifecycle lane cannot hand a decision to the wrong runtime: a replaced runtime fails the identity check, so the response ends as `invalidated`. It removes the deadlock in 1.3, because an approval no longer queues behind a turn that is waiting for it. Approval authority is unchanged: only user commands reach this path, and agents still cannot approve.
- **Start fence** (`threadLaneControl.ts`). The consumer records stop intent **before** enqueueing, so it never waits behind a busy lane.
  - A **session stop**, or a **user interrupt without `turnId`**, cancels every start-capable lane item of the thread with a lower fence sequence. This covers the item running now (through its registered cancel Deferred) and any queued item (checked when it begins).
  - **Any user interrupt**, with or without `turnId`, also cancels in-flight **restarts**: runtime-mode, token-mode and goal items. Such a restart would kill the turn anyway.
  - A `turnId`-carrying interrupt never cancels a later pending **turn start** (critique minor 10). Agent Control interrupts always carry a `turnId` (`AgentControlExecution.ts:1285-1299`), so an agent can never use the fence to cancel a user's queued turn. Provider-originated interrupts (`provider:` command ids, `:140-141`) are ignored, as today.
- **Turn ownership (handoff only).**
  - From the moment the coordinator persists `dispatching` until `processTurnStart` returns, the lane item **owns a running turn**.
  - The lane is **not** released (critique blocker), so items behind it keep their order.
  - A user stop or interrupt for that thread that arrives during ownership gets its **provider-side action** right away, through `outOfBandLanes`: `interruptTurn`, escalating to `stopSession` if that fails, or `stopSession` directly. The action marks the handoff as stop-requested.
  - The same event still runs **in order** in the lifecycle lane once the handoff item exits. There it only settles the projection, using the recorded outcome.
  - The coordinator's failure path asks `stopRequested` and never restores the source as `ready` after a stop (§3.11).

### 2.2 Ordering guarantees

| Guarantee | Before | After |
| --- | --- | --- |
| Lifecycle items of one thread run in commit order | yes (global FIFO) | yes (per-thread FIFO) |
| Items of different threads wait for each other | yes | **no**; only the global capacity (1024 outstanding) is shared, §3.1 |
| Approval/user-input responses of one thread in order | yes | yes (callback lane FIFO) |
| Approval vs. lifecycle item of the same thread | serialized | may overtake; safe because of exact-runtime checks (§2.1) |
| Stop reaches a hung start | after the start returns, unbounded | immediately: the cancel fence (start calls are detached, §2.3) |
| Stop reaches a handoff ACP turn | never while the turn runs | immediately: out-of-band provider action, then in-order settle |
| Final projection after Stop during handoff | n/a | `stopped`: the coordinator does not restore-as-ready, and the in-order settle runs last |

### 2.3 Bounded provider operations: `runDetachedWithDeadline`

All deadlines on provider calls use one helper (`apps/server/src/provider/detachedDeadline.ts`). It forks the operation into the **ProviderService layer scope**, waits with a deadline, and stops waiting promptly whichever way it ends:

- **Deadline fires** → the caller gets a typed timeout error at the deadline. The detached fiber is interrupted **in the background**. An `onAbandon(exit)` hook runs once that fiber has really exited.
- **Caller interrupted** (Stop cancel) → returns immediately and abandons in the same way.
- **Late success** after the caller stopped waiting → `onAbandon(Success)` undoes it: it stops the new runtime, or interrupts the late turn.

Per-thread locks and admission permits are acquired **inside** the detached fiber. They are released only when that fiber exits, so the invariant "one adapter start per thread at a time" still holds. The next start for the thread waits inside **its own** detached fiber, also bounded. If the previous start never finalizes, the next one fails with "a previous start for this thread is still shutting down", not a silent hang.

### 2.4 Turn acceptance

- `ProviderAdapterCapabilities.turnSubmission?: "acceptance" | "completion"` (default `"acceptance"`). It is `"completion"` for `AcpAdapter` (and so ACP registry and Grok) and for `CursorAdapter`.
- `ProviderService.sendTurn` applies `turnAcceptanceMs`:
  - `"acceptance"` adapters: the deadline covers the whole adapter call.
  - `"completion"` adapters: the deadline covers only the time until the adapter's `turn.started` for the routed runtime is observed in `processRuntimeEvent`, or until the call exits, whichever is first. After acceptance the caller keeps awaiting completion with no deadline. Callers see no other semantic change.

### 2.5 Cancellation and its client-visible signal

A turn start cancelled by the fence:

1. **Dispatches `thread.session.set`.** It always does this, even with no projected session. The session has `activeTurnId: null`, a fresh `updatedAt` and `lastError` unchanged. Status is decided by liveness: if `providerService.getSession` finds an exact live runtime equal to the projected one, keep the status (`starting` and `running` become `ready`); otherwise use `stopped`. It also carries `turnOutcome: { state: "interrupted", reason: "turn-start-cancelled" }`. This acknowledges the local dispatch (`ChatView.logic.ts:421-466`, `hasServerAcknowledgedLocalDispatch`; `queue-hold-drain` moves it to `dispatchAck.ts`). Critique major 4.
2. **Appends `provider.turn.start.cancelled`.** Tone `info`, summary "Turn start cancelled", payload `{ detail, messageId, reason: "stopped-before-start" }`. It is a **distinct kind**, so nothing treats a user cancel as an error (critique minor 7). `queue-hold-drain`'s dispatch-ack reader treats it as *settled*, not *failed* (§3.14).
3. **Leaves goal synchronization pending** for goal items. The next session start reconciles it, so the goal is never marked `failed` by a cancel.

### 2.6 Turn liveness (replaces a wall-time reaper rule)

- **Signal.** `ProviderService` keeps an in-memory `lastActivityAtMs` per thread and runtime (Clock-based). It updates on every runtime event, and on start, accepted send and steer. It is exposed through `listRuntimeActivity`.
- **Sweep.** Every `livenessSweepIntervalMs` (60 s) the reactor checks each thread that has a runtime-activity entry and whose lifecycle lane is idle. Any action goes through that thread's **lifecycle lane** as a `liveness-check` item, so it is serialized with restarts and Stop. The pure classifier in `providerTurnLiveness.ts` decides:
  - **lost**: the projection says `running` with an active turn on runtime R, there is **no exact live adapter session** for R (`getSession` none), there were no runtime events in the last sweep interval, and this was seen on **two consecutive sweeps** for the same R and turn. Settle: session-set `error`, `activeTurnId: null`, `lastError` "The provider session ended without finishing the turn.", `turnOutcome { turnId, state: "error", reason: "provider-runtime-lost" }`, and activity `provider.turn.lost` (error). After that the reaper can reap the binding normally. The signal is not wall time.
  - **unresponsive**: the live session matches, there are no pending approvals or user input (`hasPendingApprovals` / `hasPendingUserInput` on the shell), no `backgroundLiveness`, and no events for ≥ `unresponsiveAfterMs` (15 min). Append `provider.turn.unresponsive` (info) **once per turn**. **Never stop automatically.** Silent long work (Codex shell commands, ACP tools, OpenCode) would be a false positive. Stop works because interrupt and stop are bounded (§2.3), and an interrupt that times out escalates to a bounded stop (existing `recoverInterruptFailure`).
- `ProviderSessionReaper` keeps skipping active turns. That skip is now correct, because the lost verdict clears `activeTurnId` for dead runtimes.

---

## 3. Step-by-step changes

### 3.1 `packages/shared/src/KeyedSerialWorker.ts` (new) + `package.json` export `./KeyedSerialWorker`

```ts
export interface KeyedSerialWorker<K, A> {
  /** Never waits behind another key; waits only when `capacity` items are outstanding in total. */
  readonly enqueue: (key: K, item: A) => Effect.Effect<void>;
  readonly drain: Effect.Effect<void>;            // every key idle and empty
  readonly drainKey: (key: K) => Effect.Effect<void>;
  readonly isIdle: (key: K) => Effect.Effect<boolean>;
  readonly metrics: Effect.Effect<QueuePolicyMetricsSnapshot>;
}
export const makeKeyedSerialWorker: <K, A, E, R>(options: {
  readonly policy: LosslessBackpressureQueuePolicy;     // capacity = total outstanding items across keys
  readonly process: (key: K, item: A) => Effect.Effect<void, E, R>;
  readonly laneDepthWarning?: number;                   // default 64
}) => Effect.Effect<KeyedSerialWorker<K, A>, never, Scope.Scope | R>;
```

- **State.** One `TxRef<{ pending: Map<K, ReadonlyArray<A>>; active: Set<K>; outstanding; highWater; blockedMs }>`. Capture the construction `Scope` once.
- **`enqueue`**:
  1. *Interruptible* wait until `outstanding < capacity` (`Effect.txRetry` inside `Effect.tx`).
  2. Then, inside `Effect.uninterruptibleMask`, one transaction re-checks capacity (loop if it is full again), appends, increments `outstanding`, and marks the key active if it was idle. Still uninterruptible, it then `forkIn(runLane(key), scope, { uninterruptible: false })` when the key went from idle to active.

  Commit and fork cannot be separated by an interrupt (critique minor 9b). Log a warning and record a metric when one key's pending depth crosses `laneDepthWarning`.
- **`runLane(key)` loop.** A transaction takes the head of `pending[key]`. If there is none, it deletes `active[key]` and `pending[key]` and the loop ends. Otherwise it runs `process(key, item)` wrapped as follows:
  - Every cause is caught, logged and continued. That includes interrupt-only causes, which can only come from inner fibers: a lane fiber that is itself interrupted never reaches the handler. This closes `reactor-errors-switch` follow-up 5.
  - `Effect.ensuring(decrement outstanding)`.
  - `Effect.withSpan(\`${policy.component}.item\`, { root: true })`, so items are not children of the enqueuing span (critique minor 9d).

  An enqueue racing the lane's exit is safe: STM orders the two transactions, so either the lane sees the item or the enqueue forks a fresh lane.
- **Capacity.** The global head-of-line case is documented in the module header: it can only happen if a single blocked thread accumulates `capacity` items, and the bounded operations (§2.3) make that transient (critique minor 9a).
- **No `FiberMap`.** `forkIn` already removes its finalizer when the fiber exits (§1.4). Critique 9c is rejected for that reason.

### 3.2 `packages/shared/src/KeyedSerialExecutor.ts` (new) + export `./KeyedSerialExecutor`

Port `t3:apps/server/src/orchestration-v2/KeyedSerialExecutor.ts` (55 lines) unchanged: `withLock(key, effect)`, a refcounted per-key `Semaphore(1)`, with the entry deleted at the last release. Used for the worktree recreation lock.

### 3.3 `apps/server/src/provider/detachedDeadline.ts` (new)

```ts
export interface DetachedDeadlineOptions<A, E, E2> {
  readonly scope: Scope.Scope;                       // outlives callers (ProviderService layer scope)
  readonly timeoutMs: number;
  readonly onTimeout: () => E2;                      // evaluated at the deadline
  readonly onAbandon?: (exit: Exit.Exit<A, E>) => Effect.Effect<void>;  // background, after the fiber really exits
}
export const runDetachedWithDeadline = <A, E, R, E2>(effect: Effect.Effect<A, E, R>, o: DetachedDeadlineOptions<A, E, E2>) =>
  Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
    const fiber = yield* Effect.forkIn(effect, o.scope, { startImmediately: true });
    const abandon = Effect.forkIn(
      Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)),
        Effect.flatMap((exit) => o.onAbandon?.(exit) ?? Effect.void),
        Effect.catchCause((c) => Effect.logWarning("provider.detached-abandon-failed", { cause: Cause.pretty(c) }))),
      o.scope).pipe(Effect.asVoid);
    const waited = yield* restore(Fiber.await(fiber).pipe(Effect.timeoutOption(Duration.millis(o.timeoutMs))))
      .pipe(Effect.onInterrupt(() => abandon));
    if (Option.isNone(waited)) { yield* abandon; return yield* Effect.fail(o.onTimeout()); }
    return yield* waited.value;  // Exit is an Effect
  }));
```

- `timeoutOption` here only races a `Fiber.await` **observer**. Interrupting an observer is instant, and the operation fiber is never awaited on the caller's path.
- Add `runDetachedWithDeadlineOption` for `stopExactBinding`. It returns `Option.none()` on timeout instead of failing.

### 3.4 `apps/server/src/provider/providerOperationPolicy.ts` (new)

```ts
export interface ProviderOperationTimeouts {
  readonly sessionStartMs: (driver: ProviderDriverKind | string) => number;
  readonly turnAcceptanceMs: number;
  readonly controlRequestMs: number;   // interrupt, stop, respond, goal sync
  readonly unresponsiveAfterMs: number;
}
export const DEFAULT_SESSION_START_TIMEOUT_MS = 120_000;
export const DEFAULT_REGISTRY_SESSION_START_TIMEOUT_MS = 300_000; // acpRegistry may download agents on first run
export const DEFAULT_TURN_ACCEPTANCE_TIMEOUT_MS = 90_000;
export const DEFAULT_CONTROL_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_UNRESPONSIVE_AFTER_MS = 15 * 60_000;
export function resolveProviderOperationTimeouts(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly overrides?: Partial<{ sessionStartMs: number; turnAcceptanceMs: number; controlRequestMs: number; unresponsiveAfterMs: number }>;
}): ProviderOperationTimeouts & { readonly invalidEnv: ReadonlyArray<string> };
```

- Precedence: overrides, then env (`RYCO_PROVIDER_SESSION_START_TIMEOUT_MS`, `RYCO_PROVIDER_TURN_ACCEPT_TIMEOUT_MS`, `RYCO_PROVIDER_CONTROL_TIMEOUT_MS`, `RYCO_PROVIDER_UNRESPONSIVE_AFTER_MS`; positive safe integers only), then defaults.
- An env value for session start applies to **all** drivers. Without one, `acpRegistry` uses the registry default.
- Invalid env names are returned so the caller can log one warning. The function is pure. Operators can tune the values without code changes (critique minor 13).

### 3.5 `apps/server/src/provider/Errors.ts`

```ts
export class ProviderOperationTimeoutError extends Schema.TaggedError<ProviderOperationTimeoutError>()(
  "ProviderOperationTimeoutError",
  {
    provider: Schema.String,
    operation: Schema.Literals(["session.start", "session.recover", "turn.start", "turn.interrupt",
      "session.stop", "request.respond", "user-input.respond", "goal.sync"]),
    timeoutMs: Schema.Number,
    detail: Schema.String,     // one user-facing sentence (below)
  },
) { override get message() { return this.detail; } }
```

- Add it to `ProviderServiceError`.
- It has a `detail` field, so `reactor-errors-switch`'s `userFacingFailureDetail` renders it through its generic "non-empty `detail`" rule with no mapper change. Add a test case for it to `userFacingErrors.test.ts`.
- `detail` texts. `<label>` is the instance id or display label, `<s>` is seconds:
  - start: "Provider '<label>' did not finish starting within <s>s. Ryco stopped waiting; send the message again to retry."
  - start, still waiting for the per-thread lock: "Provider '<label>' could not start because a previous start for this thread is still shutting down (waited <s>s). Try again shortly."
  - start, still waiting for admission: "Provider '<label>' is busy starting other sessions (waited <s>s). Try again shortly."
  - recover: "Provider '<label>' did not resume this thread within <s>s."
  - turn: "Provider '<label>' did not accept the turn within <s>s. Ryco cancelled the request; send it again to retry."
  - interrupt: "Provider '<label>' did not respond to the interrupt within <s>s."
  - stop: "Provider '<label>' did not confirm the stop within <s>s. Ryco will keep trying to stop it in the background."
  - respond: "Provider '<label>' did not acknowledge the response within <s>s; it may or may not have been delivered."
  - goal: "Provider '<label>' did not confirm the goal change within <s>s."

### 3.6 `apps/server/src/provider/Services/ProviderAdapter.ts`, `Services/ProviderService.ts`, `Layers/AcpAdapter.ts`, `Layers/CursorAdapter.ts`

- `ProviderAdapterCapabilities`: add the field below. Then add `turnSubmission: "completion"` to the capabilities literal in `AcpAdapter.ts` (`:1073`; `reactor-errors-switch` edits the same literal's `sessionModelSwitch`, so keep both) and in `CursorAdapter.ts` (`:1277`).

  ```ts
  /** "acceptance" (default): sendTurn resolves once the provider accepted the turn.
   *  "completion": sendTurn spans the whole turn; acceptance is the adapter's `turn.started`,
   *  which MUST be emitted before the long-running call (AcpAdapter.ts:897-904, CursorAdapter.ts:1050). */
  readonly turnSubmission?: "acceptance" | "completion";
  ```

- `ProviderServiceShape`:
  - **`interruptTurn` doc.** "Never recovers a runtime. Fails `ProviderSessionNotFoundError` when no runtime is live for the thread."
  - **Add `listRuntimeActivity?`** with `ProviderRuntimeActivity = { threadId; runtimeSessionId; lastActivityAtMs }`:

    ```ts
    readonly listRuntimeActivity?: () => Effect.Effect<ReadonlyArray<ProviderRuntimeActivity>>;
    ```

  - **`sendTurn`: drop the `expectedRuntime` parameter.** `delegation-returns` (W2, §4.14) removed its only caller and left the deletion to this package to avoid a W3 conflict. Before deleting, verify that `rg -n "sendTurn\([^)]*,"` in `apps/server/src` finds no caller. *Fallback, only if W2 did not land:* keep the parameter and route the guarded path through §3.7.6's lock-until-acceptance helper.

### 3.7 `apps/server/src/provider/Layers/ProviderService.ts`

1. **Construction.**
   - `const serviceScope = yield* Effect.scope`.
   - `const timeouts = resolveProviderOperationTimeouts({ env: process.env, overrides: options?.operationTimeouts })`; log `invalidEnv` once.
   - `runtimeActivity: Ref<Map<ThreadId, ProviderRuntimeActivity>>`.
   - `acceptanceWaiters: Map<string /* threadId:runtimeSessionId */, Set<Deferred<TurnId>>>`. Plain JS map, mutated only in `Effect.sync`.
   - Add `operationTimeouts?` to `ProviderServiceLiveOptions`.
2. **`processRuntimeEvent`** (`:554-577`). Before `publishRuntimeEvent`:
   - get `Clock.currentTimeMillis` and set `runtimeActivity[threadId] = { runtimeSessionId, lastActivityAtMs }`;
   - if `event.type === "turn.started"`, succeed every waiter under `${threadId}:${runtimeSessionId}` with `event.turnId`.
3. **`startSession`** (`:912-1082`).
   - Hoist the cheap `registry.getInstanceInfo` (driver kind for the deadline) and the `runtimeSessionId` mint out of the lock.
   - Track `phase: "lock" | "admission" | "adapter"` in a `MutableRef`.
   - Run `withSessionStartLock(threadId, startLocked)` through `runDetachedWithDeadline({ scope: serviceScope, timeoutMs: timeouts.sessionStartMs(driver), onTimeout: () => timeout error by phase, onAbandon })`.
   - Inside `startLocked`:
     - set `phase = "admission"` after the lock, and `"adapter"` right before `adapter.startSession` (`:1020-1025`);
     - wrap the section from `adapter.startSession` through `upsertSessionBinding` (`:1045-1047`) in `Effect.onInterrupt`, which runs `stopExactBinding({ threadId, provider, providerInstanceId, runtimeSessionId }, true)`;
     - if this start already stopped the replaced binding (`:956-969`), also `directory.upsert({ ...replaced identity, status: "stopped", runtimePayload: { activeTurnId: null } })`. The resume cursor is kept, because the identity is unchanged.
   - `onAbandon(Success(session))` runs for a start that completed after the caller gave up. It stops the exact new binding and marks it stopped in the directory.
   - On success, set `runtimeActivity`.
4. **Recovery.**
   - `resolveRoutableSession` with `allowRecovery: true` (`:854-857`): read the binding first (for the driver), then run `withSessionStartLock(...resolveRoutableSessionUnlocked(input))` through `runDetachedWithDeadline` with `sessionStartMs(driver)` and a `"session.recover"` timeout.
   - In `recoverSessionForThread` (`:750-783`), wrap the adapter start and the upsert in `Effect.onInterrupt`, which stops the exact recovered binding.
5. **`stopExactBinding`** (`:624-654`): replace `timeoutOption` with `runDetachedWithDeadlineOption(adapter.stopSession, staleSessionStopTimeoutMs)`. The existing `rememberStaleBinding` and metric logic stay. On `"stopped"`/`"not-found"`, delete the matching `runtimeActivity` entry.
6. **`sendTurn`** (`:1099-1199`):

   ```ts
   const submitTurn = (routed, input) => {
     const mode = routed.adapter.capabilities.turnSubmission ?? "acceptance";
     if (mode === "acceptance")
       return runDetachedWithDeadline(routed.adapter.sendTurn(input), { scope: serviceScope,
         timeoutMs: timeouts.turnAcceptanceMs, onTimeout: () => turnTimeout(routed),
         onAbandon: (exit) => Exit.isSuccess(exit)
           ? boundedInterrupt(routed, exit.value.turnId) : Effect.void });   // late acceptance is cancelled
     // "completion": register the waiter BEFORE calling the adapter
     return Effect.acquireUseRelease(registerWaiter(threadId, routed.session.runtimeSessionId),
       (accepted) => Effect.gen(function* () {
         const fiber = yield* Effect.forkIn(routed.adapter.sendTurn(input), serviceScope, { startImmediately: true });
         const first = yield* Effect.raceFirst(
           Deferred.await(accepted).pipe(Effect.as("accepted" as const)),
           Fiber.await(fiber).pipe(Effect.as("exited" as const)),
         ).pipe(Effect.timeoutOption(Duration.millis(timeouts.turnAcceptanceMs)),
                Effect.onInterrupt(() => Effect.forkIn(Fiber.interrupt(fiber), serviceScope)));
         if (Option.isNone(first)) { yield* Effect.forkIn(Fiber.interrupt(fiber), serviceScope); return yield* Effect.fail(turnTimeout(routed)); }
         return yield* Fiber.join(fiber).pipe(Effect.onInterrupt(() => Effect.forkIn(Fiber.interrupt(fiber), serviceScope)));
       }), (_accepted) => unregisterWaiter(...));
   };
   ```

   - Both racers are observers, so the race never awaits the adapter call.
   - Interrupting the caller (the reactor's layer scope closing, as today) interrupts the adapter call, in the background.
   - Set `runtimeActivity` on acceptance.
   - *Fallback helper (only if the §3.6 deletion is not possible):* `lockedUntilAcceptance`. It takes the start-lock permit inside a detached fiber bounded by `turnAcceptanceMs`. It releases the permit when acceptance is observed or when the adapter fiber exits, never from the caller, which keeps the "retain the permit until the adapter finalizes" rule at `:1195-1196`.
7. **`interruptTurn`** (`:1315-1350`):
   - A missing binding fails `ProviderSessionNotFoundError`.
   - Call `resolveRoutableSession({ allowRecovery: false })`. If `!routed.isActive`, fail `ProviderSessionNotFoundError`. There is no start lock and no recovery (critique majors 2 and 3), the same rule as `stopBackgroundTask` (`:1360-1362`).
   - Run `routed.adapter.interruptTurn` through `runDetachedWithDeadline(controlRequestMs, "turn.interrupt")`.
8. **`stopSession`** (`:1480-1528`). Run `routed.adapter.stopSession` through `runDetachedWithDeadline(controlRequestMs, "session.stop")`, caught as an `Exit`. Then:
   - always do the existing `directory.upsert(status: "stopped")`;
   - on timeout, first `rememberStaleBinding({ threadId, provider, providerInstanceId, runtimeSessionId })`, so the reaper's stale retry (`ProviderSessionReaper.ts:34-52`) keeps trying, then fail with the timeout error;
   - on success, delete the `runtimeActivity` entry.
9. **`respondToRequest`, `respondToUserInput`, `setThreadGoal`, `getThreadGoal`, `clearThreadGoal`:** wrap the adapter call (`:1421`, `:1468`, `:1213`, `:1226`, `:1241`) in `runDetachedWithDeadline(controlRequestMs, …)`.
10. **`steerTurn`** (`:1245-1313`): set `runtimeActivity` after the directory upsert. It is one line (`claude-steering` also edits this function). The steer call itself is forked by the reactor and stays unbounded (out of scope, §7).
11. **`runStopAll`:** clear `runtimeActivity`.
12. **Expose `listRuntimeActivity`** = a snapshot of the map's values.

### 3.8 `apps/server/src/orchestration/threadLaneControl.ts` (new)

```ts
export class ProviderSessionStartCancelledError extends Schema.TaggedError<ProviderSessionStartCancelledError>()(
  "ProviderSessionStartCancelledError",
  { threadId: Schema.String, stopSequence: Schema.Number, detail: Schema.String },  // detail: "Stopped before the provider session started."
) { override get message() { return this.detail; } }

export type StartKind = "turn" | "restart";
export type OutOfBandOutcome =
  | { readonly kind: "interrupted" }
  | { readonly kind: "nothing-live" }
  | { readonly kind: "stopped-after-interrupt-failure"; readonly detail: string; readonly stopFailed?: string }
  | { readonly kind: "stopped" }
  | { readonly kind: "stop-failed"; readonly detail: string };

export interface ThreadLaneControl {
  /** Consumer-only, before enqueue. Returns whether a provider-side out-of-band action is needed. */
  readonly noteEvent: (event: ProviderIntentEvent) => Effect.Effect<{ readonly outOfBand: boolean }>;
  readonly guardStart: <A, E, R>(at: { threadId: ThreadId; fenceSequence: number; kind: StartKind },
    effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | ProviderSessionStartCancelledError, R>;
  readonly failIfCancelled: (at: { threadId: ThreadId; fenceSequence: number; kind: StartKind }) => Effect.Effect<void, ProviderSessionStartCancelledError>;
  readonly cancelsStart: (at: { threadId: ThreadId; fenceSequence: number; kind: StartKind }) => Effect.Effect<boolean>;
  readonly cancelledAStart: (eventId: EventId) => Effect.Effect<boolean>;
  /** Handoff: fails Cancelled if a user stop/interrupt was noted after fenceSequence; else records ownership. */
  readonly beginTurnOwnership: (threadId: ThreadId, fenceSequence: number) => Effect.Effect<void, ProviderSessionStartCancelledError>;
  readonly endTurnOwnership: (threadId: ThreadId) => Effect.Effect<void>;
  readonly stopRequestedSince: (threadId: ThreadId, fenceSequence: number) => Effect.Effect<boolean>;
  readonly registerOutOfBand: (eventId: EventId) => Effect.Effect<Deferred.Deferred<OutOfBandOutcome>>;
  readonly takeOutOfBand: (eventId: EventId) => Effect.Effect<Option.Option<Deferred.Deferred<OutOfBandOutcome>>>;
  readonly prune: (threadId: ThreadId, processedSequence: number) => Effect.Effect<void>;
}
export const makeThreadLaneControl: Effect.Effect<ThreadLaneControl>;
export const isUserStopIntent: (event: ProviderIntentEvent) => boolean;   // session-stop, or interrupt w/o provider: commandId
```

- **Per-thread state** in one `Ref<Map<ThreadId, LaneState>>`. Every operation is **one** `Ref.modify`, so check-and-register in `guardStart` is atomic with `noteEvent`. `LaneState`:
  - `stopAllSeq` and `stopAllEventId`;
  - `stopRestartsSeq` and `stopRestartsEventId`;
  - `userStopSeq`;
  - `currentStart?: { fenceSequence, kind, cancel: Deferred<{ eventId, seq }> }`;
  - `owner?: { fenceSequence, stopRequested }`;
  - `outOfBand: Map<EventId, Deferred>`;
  - `cancelled: Set<EventId>`.
- **`noteEvent`**, provider-originated events excepted:
  - **Session stop:** raise `stopAllSeq`, `stopRestartsSeq` and `userStopSeq`.
  - **User interrupt:** raise `stopRestartsSeq` and `userStopSeq`. When `payload.turnId === undefined`, also raise `stopAllSeq`.
  - **Firing the running start:** fire `currentStart.cancel` when the start's sequence is lower and either (a) its kind is `restart` and the stop-restarts sequence rose, or (b) the stop-all sequence rose. Record the event id in `cancelled`.
  - **Handoff ownership:** if `owner` is set and `seq > owner.fenceSequence`, set `owner.stopRequested` and return `{ outOfBand: true }`.
- **`guardStart`.** If `cancelsStart(at)`, fail immediately, recording the cancelling event id. Otherwise register `currentStart` and run:

  ```ts
  effect.pipe(Effect.raceFirst(Deferred.await(cancel).pipe(Effect.flatMap(({ seq }) => Effect.fail(new ProviderSessionStartCancelledError(…))))))
  ```

  `ensuring` clears `currentStart` only if it is still ours. Contract, documented in the module: `guardStart` may wrap **only promptly interruptible** effects, meaning `ProviderService.startSession` / `startFreshSession`, which are detached (§2.3).
- **`cancelsStart`.** `kind === "turn"`: `stopAllSeq > fenceSequence`. `kind === "restart"`: `stopRestartsSeq > fenceSequence`.
- **`prune`.** Drop the thread's entry when there is no `owner`, no `currentStart`, no `outOfBand`, and `max(stopAllSeq, stopRestartsSeq, userStopSeq) <= processedSequence`. The reactor calls it after each lifecycle item when the lane is idle (critique minor 11b).

### 3.9 `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`

These steps are written against the code **after** W1 and W2 have landed. Those packages give us `reportTurnStartFailure` / `prepareAndSubmitTurnStart` (`reactor-errors-switch`), `turnOutcome` on `setThreadSession` (`turn-finalization`), and the guarded return path removed (`delegation-returns`). Line numbers refer to `9e545b3ae`.

1. **Construction.**
   - `makeProviderCommandReactor(options?: { livenessSweepIntervalMs?: number; unresponsiveAfterMs?: number; maxConcurrentRecoveries?: number; lifecycleCapacity?: number })`.
   - `export const makeProviderCommandReactorLive = (options?) => Layer.effect(ProviderCommandReactor, makeProviderCommandReactor(options)).pipe(...)`.
   - `ProviderCommandReactorLive = makeProviderCommandReactorLive()`.
   - `unresponsiveAfterMs` defaults to `resolveProviderOperationTimeouts({ env: process.env }).unresponsiveAfterMs`.
   - Create `laneControl` (§3.8), `worktreeLocks = makeKeyedSerialExecutor<string>()`, `recoveryPermits = Semaphore.make(options.maxConcurrentRecoveries ?? 4)`, and the three workers:
     - `lifecycleLanes`: `KeyedSerialWorker<ThreadId, LaneItem>`, capacity 1024, `process: (_, item) => processLaneItemSafely(item)`;
     - `callbackLanes`: capacity 512, `process: (_, e) => processDomainEventSafely(e)`;
     - `outOfBandLanes`: capacity 256, `process: (_, job) => runOutOfBandControl(job)`.
   - Delete the `makeDrainableWorker` use (`:1803-1809`) and its import.

   ```ts
   type LaneItem =
     | { readonly kind: "event"; readonly event: LifecycleIntentEvent; readonly fenceSequence: number; readonly recovery?: true }
     | { readonly kind: "liveness"; readonly threadId: ThreadId; readonly verdict: TurnLivenessVerdict };
   ```

2. **`routeProviderIntentEvent(event, { fenceSequence = event.sequence, recovery })`.** This is the **single per-thread entry point** for live, synthetic and (later) replayed events (`provider-effect-outbox` R1):
   1. Callback events → `callbackLanes.enqueue(threadId, event)`.
   2. Otherwise:
      - `const { outOfBand } = yield* laneControl.noteEvent(event)`;
      - if `outOfBand`, `const outcome = yield* laneControl.registerOutOfBand(event.eventId)` and `outOfBandLanes.enqueue(threadId, { event, outcome })`;
      - then `lifecycleLanes.enqueue(threadId, { kind: "event", event, fenceSequence, ...(recovery ? { recovery } : {}) })`.

   `processEvent` in `start` (`:1812-1827`) calls it.
3. **`processLaneItemSafely(item)`** replaces `processDomainEventSafely` for lifecycle items. It is the one per-item failure wrapper and the `provider-effect-outbox` R2 hook point:
   - Run the item: the event switch (today's `processDomainEvent` minus the callback cases), or `applyLivenessVerdict`.
   - In the `catchCause`: interrupt-only causes are logged at debug and **not** re-raised (W1 follow-up 5). Other causes log a warning, as today.
   - Then call `laneControl.prune(threadId, fenceSequence)` when `lifecycleLanes.isIdle(threadId)`.

   Synthetic recovery items run inside `recoveryPermits.withPermits(1)`. **There is no whole-item lane timeout.** Every provider operation is bounded at its own call site (§2.3). That means a lane timeout can never cut a `sendTurn` that may have reached the provider (`provider-effect-outbox` R3).
4. **`ensureRecordedWorktreeAvailable`** (`:413-520`). Wrap the part from the first `pathEntryExists(worktreePath)` (`:447`) through the `worktree.meta.update` dispatch (`:509-517`) in `worktreeLocks.withLock(worktreeIdentity(worktreePath), …)`. The re-checks then run under the lock, so the second thread sees the recreated, registered worktree and returns at `:447-455`.
5. **`ensureSessionForThread(threadId, createdAt, options: { fenceSequence: number; kind: StartKind; modelSelection?; computerCatalogChanged? })`.** `fenceSequence` and `kind` are required, and all four callers pass them.
   - The first statement is `yield* laneControl.failIfCancelled({ threadId, fenceSequence, kind })`.
   - `startProviderSession` (`:636-650`) becomes `laneControl.guardStart({ threadId, fenceSequence, kind }, providerService.startSession(...))`.
6. **`settleSessionAfterCancelledStart(threadId, { createdAt, force })`** (new helper). It re-reads the thread and runs `const live = yield* providerService.getSession(threadId)`.
   - The status rule is §2.5.
   - When `force` is false (restart and goal items), dispatch only if the projection is inconsistent: its status is `starting`/`running`, or no live runtime matches the projected `runtimeSessionId` while the projection is not `stopped`.
   - Pass `turnOutcome: { state: "interrupted", reason: R.turnStartCancelled, completedAt: createdAt }`.
7. **Turn start** (`processTurnStartRequested` / `prepareAndSubmitTurnStart`; `kind: "turn"`):
   - **Boundary catch** (`reportTurnStartFailure`). First, if the cause contains `ProviderSessionStartCancelledError`, **or** `yield* laneControl.cancelsStart({ threadId, fenceSequence, kind: "turn" })` (a session stop or `turnId`-less interrupt arrived after this start, for example a forked `sendTurn` failing because Stop killed the session), run `settleCancelledTurnStart(event)`:
     - `settleSessionAfterCancelledStart(force: true)`;
     - `provider.turn.start.cancelled` (§2.5, built with `providerNoticeActivityCommand`, §3.10);
     - return.

     This goes before `usage-limits`' limit branch and before the error path.
   - **Before forking `sendTurn`** (`:1332`): `if (yield* laneControl.cancelsStart(...)) return yield* settleCancelledTurnStart(event)`. The forked send keeps today's shape and catch (`provider-effect-outbox` R3).
   - **Handoff branch** (`:1242-1268`). Pass a control object, and keep `ensureRecordedWorktreeAvailable` / `leaseThreadPath` as W1 left them:

     ```ts
     yield* contextHandoffCoordinator.processTurnStart(event, {
       guardStart: (eff) => laneControl.guardStart({ threadId, fenceSequence, kind: "turn" }, eff),
       onDispatchStarted: laneControl.beginTurnOwnership(threadId, fenceSequence),
       stopRequested: laneControl.stopRequestedSince(threadId, fenceSequence),
     }).pipe(Effect.ensuring(laneControl.endTurnOwnership(threadId)));
     ```

     The lane item stays busy for the whole handoff, which keeps it fenced.
8. **Interrupt** (`processTurnInterruptRequested`, `:1339-1436`):
   1. Provider-originated → return (unchanged).
   2. `Option.some(d) = takeOutOfBand(event.eventId)` → `outcome = yield* Deferred.await(d)`. The wait is bounded, because the action is bounded (≤ 2 × control timeout). Then **settle only**:
      - `interrupted`: nothing; ingestion or the handoff success path settles.
      - `nothing-live`: `settleAfterInterruptWithoutRuntime`.
      - `stopped-after-interrupt-failure`: re-read; if still not stopped, apply today's `recoverInterruptFailure` projection write (session-set `stopped` with `lastError: detail` and W1's `turnOutcome`, plus `provider.turn.interrupt.failed`).
   3. `yield* laneControl.cancelledAStart(event.eventId)` → return. The cancelled item already settled the projection, and no provider call is made, so there is no recovery (critique major 2).
   4. No session, or session `stopped` → existing failure activity (`:1351-1360`).
   5. `providerService.interruptTurn(...)`. On `ProviderSessionNotFoundError` → `settleAfterInterruptWithoutRuntime`: if the projection is not `stopped`, session-set `stopped`, `activeTurnId: null`, `lastError` unchanged, `turnOutcome { turnId: payload.turnId, state: "interrupted", reason: R.interruptWithoutRuntime }`, and no failure activity. Other failures → the existing `recoverInterruptFailure`. Its `stopSession` is now bounded.
9. **Session stop** (`processSessionStopRequested`, `:1693-1723`):
   - **Out-of-band outcome present:** await it and skip the provider call.
   - **Otherwise:** if not stopped, `providerService.stopSession(...)` with `Effect.exit`.
   - **Failure (non-interrupt):** append `provider.session.stop.failed` with `userFacingFailureDetail(cause)`; the kind already exists in the union.
   - **Always:** write the `stopped` projection. Set `lastError` to the stop failure detail when the stop failed; otherwise keep the old value. Keep W1's `turnOutcome`.
   - This fixes the silent Stop.
10. **Goal items** (`processGoalUpdated`, `:1438-1494`; `kind: "restart"`):
    - pass `fenceSequence`;
    - in the session catch (`:1448-1470`), if the cause contains `ProviderSessionStartCancelledError`, call `settleSessionAfterCancelledStart(force: false)` and **return without** the `goal-session-failed` dispatch and without re-raising. The goal stays pending.
    - **Synthetic startup recovery** (`:1832-1851`): keep `event.sequence = snapshot.snapshotSequence`, but call `routeProviderIntentEvent(event, { fenceSequence: 0, recovery: true })`. Any stop or interrupt this process observes therefore cancels it before it runs (critique minor 10). `restart-continuation` inherits this rule for any synthetic item.
11. **Runtime-mode / token-mode** (`:1737-1762`; `kind: "restart"`). Pass `fenceSequence` and catch:
    - **Cancelled** → `settleSessionAfterCancelledStart(force: false)`.
    - **Any other non-interrupt failure** (W1 follow-up 7: these were log-only) → append `provider.session.restart.failed` (error, `userFacingFailureDetail(cause)`). Then, if no live runtime matches the projection, session-set `stopped` with `lastError: detail`. Otherwise leave the session alone.
12. **`runOutOfBandControl({ event, outcome })`.** It runs in `outOfBandLanes` (serialized per thread), and completes `outcome` exactly once (`Effect.onExit` guarantees completion with `stop-failed` on a defect):
    - **interrupt:** `interruptTurn`.
      - Success → `interrupted`.
      - `ProviderSessionNotFoundError` → `nothing-live`.
      - Other failure → `stopSession`. Its result maps to `stopped-after-interrupt-failure { detail, stopFailed? }`.
    - **stop:** `stopSession` → `stopped` | `stop-failed`.
13. **Liveness.**
    - **`sweepLiveness`** (exported on the shape) does the following:
      1. reads `Clock.currentTimeMillis`;
      2. reads `providerService.listRuntimeActivity?.() ?? []`;
      3. for each entry, takes `getThreadShellById`, `getSession` and `lifecycleLanes.isIdle`;
      4. runs `classifyTurnLiveness` with the previous suspect state and the `warned` map;
      5. on `lost` / `unresponsive`, enqueues `{ kind: "liveness", threadId, verdict }`.

      Prune `suspects` and `warned` entries whose thread no longer has the same active turn.
    - **`applyLivenessVerdict`**, in the lane: re-read the shell and `getSession`, and re-classify with the item's verdict as `previous`. Act only if the verdict still holds:
      - `lost` → session-set plus `provider.turn.lost` (§2.6);
      - `unresponsive` → `provider.turn.unresponsive` once, recorded in `warned`.

      Its payload is `{ detail, turnId, runtimeSessionId, lastActivityAt (ISO), thresholdMs }`. The detail reads: "No provider activity for N minutes. It may be running a long silent command, or it may be stuck. Stop the turn if it does not recover."
    - **In `start`:** after the stream fork, run `Effect.forkScoped(sweepLiveness.pipe(Effect.catchCause(log), Effect.repeat(Schedule.spaced(Duration.millis(livenessSweepIntervalMs))), Effect.delay(...)))`.
14. **`drain`** = `Effect.all([lifecycleLanes.drain, callbackLanes.drain, outOfBandLanes.drain], { discard: true })`. Forked `sendTurn`/steer stay untracked, as today.

### 3.10 `apps/server/src/orchestration/providerFailureActivity.ts` (from `reactor-errors-switch`), `turnFinalization.ts` (from `turn-finalization`)

- **`providerFailureActivity.ts`:**
  - add `"provider.turn.lost"` and `"provider.session.restart.failed"` to the failure-kinds union;
  - add `providerNoticeActivityCommand(input: { threadId; kind: "provider.turn.start.cancelled" | "provider.turn.unresponsive"; summary; payload; turnId; createdAt })`. It is the same command shape with `tone: "info"`.
- **`TURN_FINALIZATION_REASON`:** add `turnStartCancelled: "turn-start-cancelled"`, `providerRuntimeLost: "provider-runtime-lost"`, `interruptWithoutRuntime: "interrupt-without-runtime"`. These are open strings, not new terminal states, as `turn-finalization` requires.

### 3.11 `ContextHandoffCoordinator` (`Services/ContextHandoffCoordinator.ts`, `Layers/ContextHandoffCoordinator.ts`)

1. **Shape** (`Services/…:10-20`):

   ```ts
   export interface ContextHandoffLaneControl {
     readonly guardStart: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | ProviderSessionStartCancelledError, R>;
     readonly onDispatchStarted: Effect.Effect<void, ProviderSessionStartCancelledError>;
     readonly stopRequested: Effect.Effect<boolean>;
   }
   readonly processTurnStart: (event: ContextHandoffTurnStartEvent, control?: ContextHandoffLaneControl) => Effect.Effect<void>;
   ```

   Export `NO_LANE_CONTROL` (identity, `Effect.void`, `Effect.succeed(false)`). `recover()` uses it and is otherwise unchanged (§7).
2. **Thread `control`** through `processTurnStart` → `runPreparing` → `prepareAndDispatch` / `finalizeFailure`.
3. **`prepareAndDispatch`:**
   - `providerService.startFreshSession(...)` (`:696-706`) → `control.guardStart(providerService.startFreshSession(...))`.
   - Right after the `dispatching` compare-and-set succeeds (`:722-733`) and **before** `sendTurn`: `yield* control.onDispatchStarted`. It fails `Cancelled` if a user stop or interrupt was already noted. That closes the window between the start and ownership.
4. **`finalizeFailure`** (`:445-545`):
   - `const stopRequested = Cause.hasFails…(ProviderSessionStartCancelledError) || (yield* control.stopRequested)`.
   - When it is true:
     - `error = "Stopped before the handoff turn was accepted."` (record and terminal activity);
     - stop and retire the target as today (`:483-495`);
     - call `restoreSource({ …, afterStop: true })`.
5. **`restoreSource`** (`:414-443`) gains `afterStop?: boolean`. With `afterStop`:
   - keep `restoreSessionBinding(sourceBinding)`, so the directory again holds the source's resume cursor and the next start resumes the source conversation;
   - then `providerService.stopSession({ threadId })` (bounded, errors ignored);
   - project the source endpoint with `status: "stopped"`, `lastError: null`. Never `ready`.

   This fixes the clobber in the critique blocker. The reactor's in-order stop or interrupt settle then runs after it.
6. **`markDeliveryUncertain` / `reconcileDispatching`:** unchanged (recovery only).
7. **`reactor-errors-switch`'s `reportPreDispatchFailure`:** a `Cancelled` cause before `dispatching` reaches it only through `runPreparing`'s catch → `finalizeFailure`. Keep its record-state rules.

### 3.12 `apps/server/src/orchestration/providerTurnLiveness.ts` (new, pure)

```ts
export type TurnLivenessVerdict =
  | { readonly kind: "not-applicable" } | { readonly kind: "healthy" }
  | { readonly kind: "suspect-lost"; readonly runtimeSessionId: RuntimeSessionId; readonly turnId: TurnId }
  | { readonly kind: "lost"; readonly runtimeSessionId: RuntimeSessionId; readonly turnId: TurnId }
  | { readonly kind: "unresponsive"; readonly runtimeSessionId: RuntimeSessionId; readonly turnId: TurnId; readonly silentForMs: number; readonly lastActivityAtMs: number };
export function classifyTurnLiveness(input: {
  readonly session: OrchestrationSession | null;
  readonly hasPendingRequest: boolean;
  readonly backgroundLiveness: "working" | "monitoring" | null | undefined;
  readonly liveRuntimeSessionId: RuntimeSessionId | null;     // exact live adapter session for the bound runtime
  readonly activity: ProviderRuntimeActivity | null;
  readonly previous: TurnLivenessVerdict | null;
  readonly alreadyWarned: boolean;
  readonly nowMs: number; readonly sweepIntervalMs: number; readonly unresponsiveAfterMs: number;
}): TurnLivenessVerdict;
```

Rules, in order:

1. Not `running`, or no `activeTurnId`, or no `runtimeSessionId` → `not-applicable`.
2. `activity` missing, or for another runtime → `not-applicable`.
3. `liveRuntimeSessionId === null`:
   - events within `sweepIntervalMs` → `healthy`;
   - otherwise, `previous` is `suspect-lost` for the same runtime and turn → `lost`;
   - otherwise → `suspect-lost`.
4. Live runtime ≠ projected → `not-applicable`.
5. `hasPendingRequest || backgroundLiveness != null` → `healthy`.
6. Silent for ≥ `unresponsiveAfterMs` and `!alreadyWarned` → `unresponsive`.
7. Otherwise → `healthy`.

### 3.13 `apps/server/src/agentControl/Layers/CompletionReturnDelivery.ts`

Raise `MAX_COLD_WAKES_IN_FLIGHT` (added by `delegation-returns` §3.4) from 1 to 4, and update its comment.

- Cold wakes no longer block other threads.
- 4 matches the default number of concurrent provider starts per instance (`ProviderService.ts:103`). This avoids admission-busy failures in post-restart bursts.
- No other Agent Control logic changes. Proposals, exact-turn binding and untrusted labelling are untouched.

### 3.14 `packages/client-runtime/src/state/message-queue/threadView.ts`, `state/session/dispatchAck.ts` (from `queue-hold-drain`)

- **`threadView.ts`:** add `provider.turn.start.cancelled` (with a string `payload.messageId`) to the kinds that `readQueueThreadView` collects.
- **`dispatchAck.ts`:** the dispatch-ack gate maps a matching cancelled id to **settled**, as for a started-then-interrupted turn. It must not map it to **failed**: a cancel is the user's own Stop, which already places the explicit Stop hold. Without this, the queued message waits 90 s and adds a spurious `stalled` cause.
- No other client change.

### 3.15 Test double

`OrchestrationReactor.test.ts`: add `sweepLiveness: Effect.void` to the `ProviderCommandReactor` double.

---

## 4. Contract / migration changes

- **Migrations:** none.
- **`packages/contracts`:** none.
- **Activity kinds (open strings), new:**
  - `provider.turn.start.cancelled` (info; payload `{ detail, messageId, reason: "stopped-before-start" }`)
  - `provider.turn.unresponsive` (info)
  - `provider.turn.lost` (error)
  - `provider.session.restart.failed` (error)

  Existing `provider.session.stop.failed` is now actually emitted.
- **Internal server API** (no external consumers): as listed in the header. `ProviderServiceShape` additions are optional, and `ContextHandoffCoordinatorShape.processTurnStart`'s new argument is optional, so existing test doubles keep compiling. `ProviderCommandReactorShape.sweepLiveness` is required (one double to update).
- **`@ryco/shared` gains two subpath exports.** Insert them next to `./DrainableWorker` / `./KeyedCoalescingWorker` (`packages/shared/package.json:126-133`). That is away from the export lines that `turn-finalization`, `provider-compat`, `settlement-signals` and `claude-steering` touch.

---

## 5. Tests

Test style:

- `packages/shared` and pure modules use `@effect/vitest` (`it.effect` with `TestClock`, or `it.live` only where real fibers must interleave; no sleeps).
- `ProviderService.test.ts` uses its existing `it.effect` / `it.layer` style with `TestClock.adjust`.
- Reactor and coordinator tests use the existing async harnesses with `Deferred`-gated mocks. No timers; thresholds of `0` and `Number.MAX_SAFE_INTEGER` replace sleeps.

**FAIL-FIRST** marks a test that fails on the code before this package.

### 5.1 `packages/shared/src/KeyedSerialWorker.test.ts` (new)

1. Items of one key run in FIFO order.
2. A blocked key (Deferred) does not block another key.
3. `drain` waits for every key; `drainKey(a)` resolves while `b` is still blocked.
4. An enqueue that lands while the lane is exiting is processed. Run 200 iterations with `Effect.yieldNow` in `process`.
5. A failing `process`, and one that ends with an interrupt-only cause from a joined child, does not stop the lane; the next item runs.
6. At `capacity`, `enqueue` blocks, and interrupting the blocked enqueuer works. The commit-and-fork step leaves no key active without a lane: after the interrupt, `drain` resolves.
7. `isIdle` and `metrics` (`depth`, `highWaterMark`).

### 5.2 `packages/shared/src/KeyedSerialExecutor.test.ts` (new)

Same key is serialized, different keys run in parallel, and the entry map is empty after release.

### 5.3 `apps/server/src/provider/detachedDeadline.test.ts` (new, `it.effect` + `TestClock`)

1. Success before the deadline returns the value; `onAbandon` is not called.
2. **The uninterruptible case** (critique major 5). The effect is `Effect.uninterruptible(Effect.never)`. After `TestClock.adjust(timeoutMs)`, the caller fails with `onTimeout()`. It does not hang.
3. Caller interruption returns immediately. `onAbandon` runs after the detached fiber exits (gated by a Deferred inside an uninterruptible region).
4. An effect that completes **after** the deadline in an uninterruptible region calls `onAbandon(Success)`.

### 5.4 `apps/server/src/provider/providerOperationPolicy.test.ts` (new)

Defaults; the `acpRegistry` start default; env overrides for every driver; precedence over env; invalid env (`"0"`, `"abc"`, `"-5"`) is ignored and reported.

### 5.5 `apps/server/src/provider/Layers/ProviderService.test.ts`

Uses the fake adapter's `startSessionEffect` and fake `sendTurn` / `interruptTurn` / `stopSession` overrides.

1. **FAIL-FIRST.** `startSessionEffect = Effect.never` → `ProviderOperationTimeoutError { operation: "session.start" }` after `sessionStartMs`, with the start-phase detail text.
2. **FAIL-FIRST.** `startSessionEffect = Effect.uninterruptible(Effect.never)` → the timeout still arrives at the deadline. A second `startSession` for the same thread fails at its own deadline with the "previous start … still shutting down" detail. A start for a **different** thread succeeds meanwhile.
3. A start that registers the adapter session and is then abandoned results in the exact new runtime stopped and the directory binding `stopped`.
4. **FAIL-FIRST.** `interruptTurn` for a thread with a persisted resume cursor but no live adapter session → fails `ProviderSessionNotFoundError`. `startSession` on the adapter is **not** called (no recovery).
5. **FAIL-FIRST.** Adapter `interruptTurn = Effect.never` → `turn.interrupt` timeout at `controlRequestMs`.
6. **FAIL-FIRST.** Adapter `stopSession = Effect.never` → `session.stop` timeout; `listStaleSessionBindings()` contains the exact binding; the directory status is `stopped`.
7. **Completion-style adapter** (`capabilities.turnSubmission: "completion"`). It emits `turn.started` through its stream, then blocks on a Deferred. `sendTurn` does **not** fail after `TestClock.adjust(turnAcceptanceMs * 2)`; resolving the Deferred returns the turn.
8. **FAIL-FIRST.** A completion-style adapter that never emits `turn.started` and blocks → `turn.start` timeout at `turnAcceptanceMs`. The adapter fiber is interrupted in the background (observed through `onInterrupt` in the fake).
9. **Acceptance-style:** `sendTurn` hangs → timeout; then the fake resolves late → `adapter.interruptTurn(threadId, turnId)` is called.
10. `listRuntimeActivity` reflects runtime events (`TestClock` time) and is cleared by `stopSession`.
11. **FAIL-FIRST.** `stopExactBinding` (via `stopSessionBinding`) with `stopSession = Effect.uninterruptible(Effect.never)` returns `"timed-out"` at `staleSessionStopTimeoutMs`.
12. `respondToRequest` with an adapter that never answers → `request.respond` timeout.

### 5.6 `apps/server/src/orchestration/threadLaneControl.test.ts` (new, `it.effect`)

- Fence matrix:
  - session stop cancels `turn` and `restart` kinds with a lower sequence;
  - a `turnId`-less user interrupt cancels both;
  - a `turnId` interrupt cancels `restart` only;
  - provider-originated interrupts cancel nothing;
  - higher sequences are never cancelled.
- `guardStart` fails immediately when a stop is already noted. An in-flight guarded `Effect.never` is cancelled by a later `noteEvent`. `cancelledAStart` records the event.
- Atomicity: `noteEvent` interleaved with `guardStart` registration (yield between them) never misses the stop.
- `beginTurnOwnership` fails when a user interrupt was noted after the fence. Afterwards, `noteEvent` returns `outOfBand: true` and `stopRequestedSince` turns true.
- `prune` removes idle state and keeps state that still has an owner or out-of-band entry.

### 5.7 `apps/server/src/orchestration/providerTurnLiveness.test.ts` (new, pure)

One table case per rule in §3.12. Include the pending-approval, background-liveness and runtime-mismatch exclusions, and the requirement that lost needs two observations.

### 5.8 `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`

Extend `createHarness` with:

- `startSessionEffect?(input)`: a per-call override that can return a Deferred-gated effect, with `onInterrupt` tracking;
- `getSession` (already present);
- `listRuntimeActivity?`;
- `respondToRequest` gating;
- `processContextHandoff` receiving `(event, control)`;
- a `secondThread` option that dispatches `thread.create` for `thread-2`;
- `reactorOptions` passed to `makeProviderCommandReactorLive`.

1. **FAIL-FIRST.** Thread-1's turn start blocks in `startSession`. Thread-2's turn start reaches `sendTurn` while thread-1 is still blocked.
2. **FAIL-FIRST.** Same setup: an approval response on thread-2 reaches `respondToRequest` while thread-1 is blocked.
3. **FAIL-FIRST.** Stop cancels an in-flight first start. Thread-1's start blocks; dispatch `thread.turn.interrupt` without `turnId`. Expect:
   - the gated start effect is interrupted;
   - `sendTurn` is not called;
   - a `provider.turn.start.cancelled` activity with `messageId` and `reason`;
   - a `thread.session-set` event was dispatched (session `stopped`, `activeTurnId: null`, `updatedAt` changed);
   - `interruptTurn` is **not** called.
4. **FAIL-FIRST** (critique major 2). A running session with an active turn. `thread.runtime-mode.set` whose `startSession` never completes, then `thread.turn.interrupt` (the decider fills `turnId`). Expect the restart cancelled, `interruptTurn` and recovery **not** invoked, and the session settled (`getSession` none → `stopped`, `activeTurnId: null`).
5. A turn start queued behind a blocked runtime-mode restart, followed by `thread.session.stop`: the queued start never calls `startSession`, and gets the cancel settlement. A turn start dispatched **after** the stop proceeds normally.
6. **FAIL-FIRST.** `stopSessionEffect` fails → projection `stopped` plus a `provider.session.stop.failed` activity carrying the detail.
7. **FAIL-FIRST** (the 1.3 deadlock). `processContextHandoff` mock: `yield* control.onDispatchStarted`, then await a Deferred (an ACP turn). Expect:
   - while it is pending, an approval response on the **same thread** reaches `respondToRequest`;
   - a dispatched `thread.turn.interrupt` reaches `interruptTurn` before the Deferred resolves;
   - after resolving it, the interrupt's in-order settle runs, and `drain` resolves.
8. Handoff, stop noted before dispatch: the mock calls `control.guardStart(Effect.never)` while a `thread.session.stop` arrives → the guard fails with Cancelled. Variant: a stop arrives before `onDispatchStarted` → that call fails with Cancelled.
9. A goal update cancelled by Stop leaves `synchronization.state === "pending"` and no `provider.goal.update.failed`.
10. **Synthetic goal recovery:** with 6 pending goals across 6 threads and gated starts, at most `maxConcurrentRecoveries` (4) `startSession` calls run at once. A Stop observed before a recovery item runs cancels it (fence 0).
11. **Visible timeout end to end.** `startSession` fails with `ProviderOperationTimeoutError(session.start)` → `provider.turn.start.failed` with exactly the timeout `detail`, and `session.lastError` set (when a session exists).
12. **Runtime-mode restart failure** (non-cancel) → `provider.session.restart.failed` activity (W1 follow-up 7).
13. **Regression guard (not fail-first; passes today on the serial worker):** two threads whose shared recorded worktree is missing both start a turn. `createWorktree` is called once and both turn starts reach `sendTurn`.
14. **Liveness, unresponsive:** `listRuntimeActivity` returns `{ thread-1, runtime-1, lastActivityAtMs: 0 }`, the session is `running` with an active turn, `getSession` matches, and `unresponsiveAfterMs: 0`. Two `sweepLiveness` calls plus `drain` → exactly **one** `provider.turn.unresponsive`. With `hasPendingApprovals` → none.
15. **Liveness, lost:** the projection is `running` with an active turn on runtime-1 and `getSession` returns none. One sweep → no change. Two sweeps → session-set `error` plus `provider.turn.lost`. With activity within the sweep interval (`unresponsiveAfterMs` irrelevant; `livenessSweepIntervalMs: Number.MAX_SAFE_INTEGER`) → nothing.
16. A forked `sendTurn` failing after a `thread.session.stop` for the same thread produces `provider.turn.start.cancelled`, not `provider.turn.start.failed`.

### 5.9 `apps/server/src/orchestration/Layers/ContextHandoffCoordinator.test.ts`

1. `control.onDispatchStarted` is called exactly once, after the `dispatching` compare-and-set and before `sendTurn`. It is **not** called when `startFreshSession` fails. `recover()` never calls it (it uses `NO_LANE_CONTROL`).
2. **FAIL-FIRST** (critique blocker, coordinator half). `control.stopRequested` yields true, and the mocked `sendTurn` fails after `onDispatchStarted`. Expect:
   - the final session projection is the source endpoint with status `stopped` (not `ready`);
   - `restoreSessionBinding` is called, then `providerService.stopSession`;
   - the terminal activity is `failed` with "Stopped before the handoff turn was accepted.";
   - the record status is `failed`.
3. `control.guardStart` failing with Cancelled → no `sendTurn`, a failed terminal, and the source stopped.

### 5.10 Other test files

- `apps/server/src/orchestration/userFacingErrors.test.ts`: `ProviderOperationTimeoutError` and `ProviderSessionStartCancelledError` render their `detail`.
- `agentControl/Layers/CompletionReturnDelivery.test.ts`: update `delegation-returns`' T5 expectation for the cap of 4.
- client-runtime (`queue-hold-drain` files): a `provider.turn.start.cancelled` for the dispatched id settles the ack gate without an error hold and without a `stalled` cause.

---

## 6. Edge cases and risks

- **A truly uninterruptible adapter start.** The zombie fiber keeps the per-thread start lock. Later starts for **that thread** fail fast-ish (at their deadline) with the "still shutting down" text until the zombie exits or the process restarts. Other threads are unaffected. This is deliberate: two adapter starts for one thread would be worse.
- **Legitimate slow starts and turns cut by a deadline.** Defaults are generous, `acpRegistry` gets 300 s, and env overrides exist. A retry starts from scratch.
- **Late acceptance after the turn deadline.** The late turn is interrupted best-effort, so "Ryco cancelled the request" stays true in effect. A provider that ignores interrupts may still run it. `provider-effect-outbox` treats this as a dispatched row, so it never claims failure twice.
- **The handoff out-of-band interrupt succeeds.** The ACP prompt returns `cancelled`, the coordinator takes its success path (consumed, source stopped), and the in-order settle does nothing.
- **Interrupt and escalation stop both time out during a handoff.** The binding is queued for the reaper's stale retry. The lane stays owned until the adapter returns, and the thread shows the stop failure.
- **A cancelled same-instance restart.** `ProviderService` had already stopped the old runtime (`:956-969`). The directory marks it `stopped`, keeping the cursor. The projection settles `stopped`. The next turn resumes from the cursor.
- **A cancelled start leaves a staged computer plan** (`stageComputerTurn`, `:913-925`). This happens today for failed starts too. The next turn re-stages it.
- **Two threads with symlink-different spellings of one missing worktree path** get different lock keys. The git driver's destination lock then turns the loser into an error, as today (rare).
- **False lost verdict.** It needs two consecutive observations 60 s apart, no runtime events in the window, an exact-runtime match, and an idle lane at both enqueue and apply time. Restarts run in the same lane, so they cannot interleave.
- **False unresponsive verdict.** Long silent work (Codex shell commands, ACP tools, OpenCode) can trigger it. It is info only, shown once per turn, and never stops anything.
- **Settlement and inbox.** New activity kinds are `info`/`error` provider activities, not user or assistant work. `settlement-signals` must not count them as activity after a merge.

---

## 7. Out of scope

- **Moving `ContextHandoffCoordinator.recover()` into thread lanes** (1.7). This changes the startup order against `reconcileOrphanedProviderSessions` and ingestion subscription. It belongs to **`restart-continuation`**.
- **A whole-item lane timeout.** Interrupting non-provider steps (git `createWorktree`, SQL) mid-way risks partial state. Only provider calls are bounded.
- **Bounding `steerTurn`.** It is forked, not in a lane. A timeout cannot prove that the steer was not delivered. `claude-steering` / `provider-effect-outbox` own its semantics.
- **Changing ACP `sendTurn` to return at acceptance.** It is an adapter contract change. The `"completion"` capability plus the acceptance waiter cover the deadline without it.
- **Server-side queueing of overlapping turn starts** (`queue-hold-drain` §1.3), and pending-row deletion for cancelled starts. `provider-effect-outbox` should extend its "`provider.turn.start.failed` removes the pending row" rule to `provider.turn.start.cancelled` (§8).
- **Web phone tier and mobile:** no changes. The policy lives in client-runtime.

---

## 8. Overlaps and merge notes

- **`provider-effect-outbox` (W3, next).**
  - R1: `routeProviderIntentEvent` is the single per-thread entry point, so route replays through it.
  - R2: `processLaneItemSafely` is the single per-item failure wrapper. Call `surfaceIntentFailure` there, before logging. There is no lane `TimeoutError`; provider timeouts are `ProviderOperationTimeoutError`.
  - R3: `sendTurn` and steer stay forked outside the lane.
  - R4: unchanged.
  - Also: extend pending-row deletion to `provider.turn.start.cancelled`. Callback responses stay in `callbackLanes`. Keep the start fence around any start it replays.
- **`restart-continuation` (W3).**
  - Synthetic or replayed items use `fenceSequence: 0` (or the replay rule from `provider-effect-outbox`).
  - Its own turn starts are ordinary events and need nothing special.
  - It owns handoff `recover()` placement.
- **`reactor-errors-switch` (W1).**
  - This package inserts the cancel branch at the top of `reportTurnStartFailure`, keeps `preserveActiveTurn`, and replaces `processDomainEventSafely` with `processLaneItemSafely`. That takes its follow-ups 5 and 7.
  - New errors need no mapper change, because they carry `detail`.
  - The `AcpAdapter.ts` capabilities literal now holds both fields.
- **`turn-finalization` (W1).** Every new session-set passes `turnOutcome`; three reason keys are added. The ACP and Cursor failed-terminal change is compatible with the acceptance waiter (it only reads `turn.started`).
- **`queue-hold-drain` (W1).** One kind is added to the ack reader (§3.14). Its Stop hold remains client-side.
- **`delegation-returns` (W2).** This package deletes the now-unused `expectedRuntime` (its §4.14 cleanup) and raises `MAX_COLD_WAKES_IN_FLIGHT` to 4.
- **`claude-steering` (W2).** Adjacent edits in `Errors.ts` (new class) and `ProviderService.steerTurn` (one `runtimeActivity` line after its upsert), and possibly an adjacent `ProviderAdapterCapabilities` field. Keep both.
- **`rollback-correctness` (W2).** `rollbackConversation`'s recovery is now bounded through `resolveRoutableSession`. If it added a capability field, keep both.
- **`usage-limits` (W2).** The cancel branch must stay before any limit branch in `reportTurnStartFailure`.
- **`claude-meter-wake` (W1).** Claude `sendTurn` can now be abandoned at the acceptance deadline. Its `acquireUseRelease` / `ensuring` releases and its forked interrupt grace stay correct (its §8).
- **`settlement-signals`, `provider-compat`, `acp-message-ids`, `delegation-guard-restart`, `delegation-lineage`.** No shared function. `package.json` export placement is in §4.

---

## 9. Review resolution

| # | Severity | Issue | Resolution |
| --- | --- | --- | --- |
| 1 | blocker | Releasing the lane at handoff dispatch lets Stop race `restoreSource` and bring the source back | **Accepted, both remedies.** The handoff stays the running lane item, never released. Stop and interrupt get through as out-of-band provider actions and settle in order afterwards (a). `finalizeFailure` checks `stopRequested`, restores the binding only for its cursor, stops the source and projects `stopped` (b). `onDispatchStarted` fails if a stop came first. Tests 5.8-7/8, 5.9-2/3 |
| 2 | major | A Stop that cancelled a restart then revives the old runtime via interrupt recovery | **Accepted.** `interruptTurn` never recovers (`ProviderSessionNotFoundError`). An interrupt that cancelled a start makes no provider call. Any user interrupt cancels in-flight restarts. Test 5.8-4 (FAIL-FIRST), 5.5-4 |
| 3 | major | The interrupt timeout omits the start-lock wait; FIFO lanes make it a per-thread deadlock | **Accepted.** Interrupt takes no lock now. Every deadline wraps lock plus admission plus adapter inside the detached fiber. The guarded path that held the lock across ACP turns is gone (W2), and the parameter is deleted. Tests 5.5-2/5 |
| 4 | major | A cancel by interrupt leaves the composer busy | **Accepted.** The cancel always dispatches a session-set (fresh `updatedAt`, `activeTurnId: null`, liveness-based status) with a `turnOutcome`. The queue ack reader handles the new kind. Test 5.8-3 asserts the session-set |
| 5 | major | timeout/race await the loser's interruption | **Accepted, verified** (`internal/effect.ts:1548`, `:3729-3747`). All provider deadlines use `runDetachedWithDeadline`, which forks into the service scope, abandons in the background, and undoes late successes. `stopExactBinding` is converted too. Tests 5.3-2, 5.5-2/11 |
| 6 | major | The turn-start timeout was dropped | **Accepted.** `turnSubmission` capability, plus an acceptance deadline for every adapter. ACP and Cursor count until `turn.started` is observed. Late acceptance is interrupted. Tests 5.5-7/8/9 |
| 7 | minor | Reusing `provider.turn.start.failed` for a cancel; goal sync on cancel | **Accepted.** A distinct `provider.turn.start.cancelled` with `payload.reason`. Goal sync stays pending (test 5.8-9) |
| 8 | minor | Overlap ownership placed on W1 packages | **Accepted.** This spec owns the cancel branch in `reportTurnStartFailure`, error rendering (via `detail`, with tests), `turnOutcome` reasons, and the queue ack-reader change (§3.10, §3.14) |
| 9 | minor | KeyedSerialWorker hazards | **Partly accepted.** (a) Documented, with a per-lane depth warning. (b) Commit and fork are uninterruptible. (d) Items get root spans. **(c) Rejected:** `forkIn` removes its scope finalizer when the fiber exits (`internal/effect.ts:5320-5331`), so finalizers do not accumulate and `FiberMap` is not needed |
| 10 | minor | Cancellation key too coarse; synthetic events not cancellable | **Accepted.** Only session stops and `turnId`-less user interrupts cancel turn starts. Synthetic recovery uses fence 0 (test 5.8-10) |
| 11 | minor | Reaper design gaps | **Accepted.** `Clock`-based, with a pure classifier and `TestClock`/threshold-0 tests. Maps are pruned. The logic lives in the orchestration layer and settles through the thread lane (no provider-layer dispatch). Codex false positives are documented. The lost verdict uses the exact-live-session signal. `settlement-signals` is listed |
| 12 | minor | Test gaps and mislabels | **Accepted.** The worktree test is relabelled as a regression guard (5.8-13). Added tests: `dispatchStarted` (5.9-1), Stop during handoff (5.8-7/8), Stop after a cancelled restart (5.8-4), an interrupt that does not wait on a lock (5.5-4/5), and end-to-end timeout text (5.8-11). All are in §10's run list |
| 13 | minor | Operational defaults | **Accepted.** Per-driver start default (`acpRegistry` 300 s), env overrides (`providerOperationPolicy.ts`), recovery throttled to 4 instead of bursting into admission-busy, and the cold-wake cap raised to 4 rather than removed. Retry-from-scratch is documented (§6) |

Verdict agreement: the critique's verification holds. Two further instances were confirmed here:

- the **global** deadlock of an ACP handoff awaiting a permission decision (`AcpAdapter.ts:532-571` together with `ProviderCommandReactor.ts:1262-1266`);
- the unbounded startup `recover()` (handed to `restart-continuation`).

---

## 10. Validation

This change is cross-cutting: core reactor, `ProviderService`, coordinator and shared workers. Run the focused files first, then the backstop (AGENTS.md: high-risk runtime boundary).

```sh
bun run --cwd packages/shared test src/KeyedSerialWorker.test.ts src/KeyedSerialExecutor.test.ts src/DrainableWorker.test.ts
bun run --cwd apps/server test src/provider/detachedDeadline.test.ts src/provider/providerOperationPolicy.test.ts src/provider/Layers/ProviderService.test.ts src/provider/Layers/ProviderSessionReaper.test.ts
bun run --cwd apps/server test src/orchestration/threadLaneControl.test.ts src/orchestration/providerTurnLiveness.test.ts src/orchestration/userFacingErrors.test.ts src/orchestration/Layers/ProviderCommandReactor.test.ts src/orchestration/Layers/ContextHandoffCoordinator.test.ts src/orchestration/Layers/OrchestrationReactor.test.ts
bun run --cwd apps/server test src/provider/Layers/CursorAdapter.test.ts src/provider/Layers/GrokAdapter.test.ts src/agentControl/Layers/CompletionReturnDelivery.test.ts
bun run --cwd packages/client-runtime test src/state/message-queue src/state/session/dispatchAck.test.ts
bun fmt && bun run fmt:check && bun lint && bun typecheck && bun run test
```

Never run `bun test`.
