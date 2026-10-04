# 01 · queue-hold-drain: hold the follow-up queue on Stop, error and limit, and drain off-screen threads (bugs 3–4)

| Field | Value |
| --- | --- |
| id | `queue-hold-drain` |
| title | A per-thread, edge-triggered queue **hold** (Stop, a turn that ends in error, a failed queued start, a stalled start, a Claude resume review; usage limits plug in later). One **drain coordinator** in client-runtime that drains every thread with a queue, not only the visible ChatView. A message-scoped **dispatch-ack gate**. Mobile shares the same pure policy |
| wave | 1 (parallel, isolated worktree). Three commits that can be reviewed separately: **A** client-runtime policy, store and coordinator · **B** web adapter, background sender, UI, Stop · **C** mobile outbox on the shared policy |
| verdict | **confirmed**. Bug 3 is web-only: mobile already drains globally. Bug 4 affects web and mobile, and the cascade is worse than the brief says: a second `thread.turn.start` sent before the first turn's `session-set(running)` is accepted by the decider and then silently orphaned by the reactor (§1.3) |
| size | **L** (A: M, B: M–L, C: M) |
| touched files | **client-runtime:** `packages/client-runtime/src/state/message-queue/{hold.ts (new), threadView.ts (new), drain.ts (new), coordinator.ts (new), store.ts, index.ts}` · `packages/client-runtime/src/state/session/{dispatchAck.ts (new), index.ts}` · `packages/client-runtime/src/state/composer/sendEngine.ts` · `packages/client-runtime/src/state/threads/storeSelectors.ts` · tests: `message-queue/{hold,threadView,drain,coordinator,store}.test.ts`, `session/dispatchAck.test.ts`, `composer/sendEngine.test.ts`, `threads/storeSelectors.test.ts`. **web:** `apps/web/src/messageQueueDrain.ts (new)` · `apps/web/src/components/MessageQueueDrainBridge.tsx (new)` · `apps/web/src/hooks/chatSendShared.ts (new)` · `apps/web/src/hooks/sendQueuedMessageInBackground.ts (new)` · `apps/web/src/hooks/executeChatSendTurn.ts` · `apps/web/src/hooks/useChatSessionActions.ts` · `apps/web/src/hostedHub/capabilities.ts` · `apps/web/src/hostedHub/environment.ts` · `apps/web/src/components/RootAppShell.tsx` · `apps/web/src/components/ChatView.tsx` · `apps/web/src/components/ChatView.logic.ts` · `apps/web/src/components/chat/ComposerQueuedMessages.tsx` · tests: `apps/web/src/messageQueueDrain.test.ts (new)`, `apps/web/src/hooks/chatSendShared.test.ts (new)`, `apps/web/src/hooks/sendQueuedMessageInBackground.test.ts (new)`, `apps/web/src/hooks/executeChatSendTurn.test.ts`, `apps/web/src/components/ChatView.browser.helpers.tsx`, `apps/web/src/components/ChatView.Conversation.browser.tsx`. **mobile:** `apps/mobile/src/state/{threadOutbox.ts, threadOutboxModel.ts, use-thread-outbox-drain.ts}` · `apps/mobile/src/features/threads/{ThreadDetailScreen.tsx, ThreadQueuedMessages.tsx}` · tests: `apps/mobile/src/state/{threadOutbox,threadOutboxModel,use-thread-outbox-drain,outboxSettleDrain}.test.ts` |
| migrations | **none.** No server or SQLite change. Mobile adds one client KV key, `ryco.threadOutboxHolds.v1` (§3.C1) |
| contract changes | **none in `packages/contracts`.** Client-runtime API additions: `QueueHold*` types and helpers, `readQueueThreadView`, `resolveQueueDrainStep`, `createMessageQueueDrainCoordinator`, store fields and actions `holdsByThreadKey`, `acknowledgedCauseKeysByThreadKey`, `epoch`, `hold`, `release`, `removeHoldCauses`, `acknowledgeCauses`, `releaseSend`, `reset`, `selectThreadDetailLoaded`, `CommitSendTurnDispatchInput.onBeforeTurnStart`, and `state/session/dispatchAck.ts`. The local-dispatch ack helpers move there from `apps/web/src/components/ChatView.logic.ts`, which re-exports them. Web-internal: new `ExecuteChatSendTurnInput` options `claudeCacheReview`, `suppressToasts`, `onBeforeTurnStart` and `onSendError` |
| overlaps | **usage-limits (W2):** consumer of the hold API. It adds the `limit` cause in `hold.ts` `deriveQueueFailureCauses` and copy in `describeQueueHold`. Merge after this package. **claude-steering (W2):** `message-queue/*`, `ChatView.tsx` `handleSteerQueuedMessage` (untouched here), and the steer reconcile effects this package moves into the coordinator (`drain.ts` reconcile step). Claude steer must not emit `thread.turn-interrupt-requested`, or the derived interrupt cause will hold the queue. **claude-meter-wake (W1):** semantic dependency. Until it lands, a Claude wake turn has no projected turn before its first assistant frame, so the drain can still send into that gap (§6). **reactor-errors-switch (W1):** semantic dependency. The ack gate depends on `provider.turn.start.failed` activities that carry `payload.messageId` (`ProviderCommandReactor.ts:275-305`, `1126-1180`). Keep that field. **settlement-signals (W1):** semantic. A held queue still counts as `local-queue` in `canSettleThread`. Whether "held" should surface as needs-attention is deferred to them. No textual overlap: this package does not edit `threadInbox.ts` or `threadSettlement.ts`. **turn-finalization (W1):** semantic. If it changes `latestTurn.state` settling in `threads/store.ts`, the derived interrupt cause (§3.A1) still works, because it only reads `interrupted`. Textual overlap is limited to the append-only selector in `storeSelectors.ts`, not `store.ts`. **rollback-correctness (W2):** semantic. `thread.reverted` can set `latestTurn.state` to `interrupted` from a `missing` checkpoint (`threads/store.ts:2568-2580`), which can raise a spurious interrupt hold if the queue is non-empty (§6). **delegation-returns (W2) / restart-continuation (W3):** semantic. Server-initiated turns and the restart-orphan `error` status feed the hold and ack logic (§1.4, §6). **delegation-lineage (W2):** neighbouring ChatView composer-stack JSX (`AgentControlApprovals` sits next to `ComposerQueuedMessages`). **acp-message-ids (W1):** none. This package is client-only and does not touch `ProjectionThreadMessages.ts`. **delegation-guard-restart (W1):** none. It satisfies their constraint that queued or held entries are never stored as `role='user'` rows. Holds are client-only. **provider-compat, turn-finalization server parts, reactor-concurrency, provider-effect-outbox (W3):** no textual overlap |

---

## 1. Problem (verified against the code)

### 1.1 Bug 3: queued messages only send while their thread is on screen (web)

- The only web drain is the `useEffect` at `apps/web/src/components/ChatView.tsx:3937-3988`. It is keyed on `activeThreadKey` and reads `queuedMessages` for that key only (`:875-879`).
- `beginQueuedSend` and `finishQueuedSend` are used only there (`:870-871`).
- When the user switches threads, the queue survives (`apps/web/src/messageQueueStore.ts`, module-level and "intentionally NOT persisted"). Nothing sends it until that thread's ChatView is mounted again.
- `apps/web/src/lib/selectionChat.ts:62-83` enqueues into a *local draft* key. Only that draft's own ChatView can send it, because the first send creates the thread through the bootstrap.
- Mobile is not affected. `apps/mobile/src/state/use-thread-outbox-drain.ts:162-178` drains from `Stack.tsx` on socket open and on every threads-store change.

### 1.2 Bug 4: Stop, errors and limits do not pause the queue

- The drain guards (`ChatView.tsx:3941-3959`) check capability, dedupe, `deliveryStatus`, `isWorking`, environment, pending approval or input, `sendInFlightRef` and steering. Nothing looks at *how the last turn ended*.
- `derivePhase` maps every non-running status, including `error`, to `"ready"` (`packages/client-runtime/src/state/session/session-logic.ts:2306-2311`).
- After **Stop**: the interrupt aborts the turn, the session goes `ready` (`ProviderRuntimeIngestion.ts:2440-2449`, `turn.aborted → ready`), and the next queued message dispatches at once.
- After a **turn error**: `turn.completed(failed)` sets `status: "error"` with `lastError` (`ProviderRuntimeIngestion.ts:2443-2467`). The phase reads `ready`, so the next queued message is sent into the same failure (usage limit, auth, crash).
- After a **turn-start failure**: `setThreadSessionErrorOnTurnStartFailure` sets `ready` plus `lastError` (`ProviderCommandReactor.ts:343-363`) and appends `provider.turn.start.failed` with `payload.messageId` (`:1157-1180`).
- `latestTurn.state` is **not** a stable signal for any of these:
  - `thread.turn-diff-completed` rewrites it from the checkpoint status (`packages/client-runtime/src/state/threads/store.ts:2513-2525`, mapped at `:1202-1210`), so an interrupted or failed turn usually reads `completed` once the diff lands.
  - The streamed `buildLatestTurn` drops `userMessageId` (`store.ts:1229-1251`), so the client cannot tie a turn to a message from the stream.

  An explicit, recorded hold is required.

### 1.3 The cascade orphans messages

- The decider rejects `thread.turn.start` only while the session is `running` **with** an `activeTurnId` (`apps/server/src/orchestration/decider.ts:999-1007`).
- `startSession`'s bind emits `session-set` with the provider's status and `activeTurnId: null` *before* `turn.started` (`ProviderCommandReactor.ts:652-676`).
- A second queued `turn.start` sent in that window is therefore accepted, and its user message is persisted.
- The reactor then rejects it as overlapping with only a `provider.turn.start.failed` activity (`ProviderCommandReactor.ts:1126-1138`). The message sits in the transcript with no turn, and nothing re-queues it.
- The existing web gate (`isSendBusy` from `hasServerAcknowledgedLocalDispatch`, `ChatView.logic.ts:418-460`) treats *any* `session.updatedAt` or status change while not running as acknowledgement. The bind's `session-set(ready)` opens exactly this window.
- **Mobile** has the same cascade. `drainThreadOutbox` sends m2 as soon as m1's RPC resolves (`apps/mobile/src/state/threadOutbox.ts:172-208`), and `threadOutbox.test.ts:55-64` asserts two sends in one pass.
- Correction to the draft: concurrent sends of the *same* message id are already de-duplicated by `commitSendTurnDispatch`'s `pendingSends` (`packages/client-runtime/src/state/composer/sendEngine.ts:262-274`). The real mobile window is the next message, not a duplicate.

### 1.4 Constraints that shape the fix

- **Hold edge-triggering.** `lastError` survives `running` and `stopped` (`ProviderRuntimeIngestion.ts:2462-2466`: `status === "ready" ? null : previous`). Startup reconciliation sets `status: "error"` with `"Provider session did not survive a server restart. Send a new message to continue."` (`apps/server/src/serverRuntimeStartup.ts:529-530`, applied at `:686-694`). Mobile queues offline (`sendThreadTurn.ts:20-25`). A hold re-derived from *current* state would therefore also hold a message the user wrote *in response to* an error they already saw. t3 holds only at the moment of failure (`t3:apps/server/src/orchestration-v2/Orchestrator.ts:1213-1239`).
- **Server-initiated turns** (Claude wake, delegation returns, Agent Control) can change `latestTurn` while a queued send is in flight. The Claude resume path dispatches a `/compact` turn inside the same send, before the queued message (`claudeCacheReview.ts:162-205`). An ack gate that compares against a pre-send snapshot can acknowledge the wrong turn.
- **Commands are idempotent per `commandId`.** Queued sends use the deterministic `composer-send:${threadId}:${messageId}` (`sendEngine.ts:310`), and the engine returns the stored receipt for a duplicate (`OrchestrationEngine.ts:215-223`). A retry after a lost reply never creates a second turn. It still re-runs the settings writes and the Claude review, so dedupe is still required.
- **Hosted web has one connection** (`hostedConnectionCoordinator.ts:57`). Any non-discovery scope counts as foreground demand (`:512-523`), and `connect()` selects the node (`:393-395`). Background work must never create hosted connection demand.

---

## 2. Design

### 2.1 Layers

```
client-runtime (pure / platform-neutral)
  message-queue/hold.ts        causes, hold merge and precedence, release, copy
  message-queue/threadView.ts  QueueThreadView from AppState (cached, cheap)
  session/dispatchAck.ts       local-dispatch UI gate (moved) + strict queued ack
  message-queue/drain.ts       resolveQueueDrainStep: one ordered decision per thread
  message-queue/store.ts       + holds, acknowledged causes, epoch, releaseSend, reset
  message-queue/coordinator.ts generic drain loop (web consumer now)
  composer/sendEngine.ts       + onBeforeTurnStart hook

web
  messageQueueDrain.ts         coordinator singleton, web platform, foreground registry
  sendQueuedMessageInBackground.ts  headless sender for started server threads
  chatSendShared.ts            helpers extracted from ChatView (no duplication)
  ChatView / ComposerQueuedMessages / useChatSessionActions / RootAppShell

mobile
  threadOutbox.ts              persisted holds + one send per thread per pass via drain.ts
```

### 2.2 Key decisions

- **D1. The hold is explicit, recorded and edge-triggered.**
  - A hold is a recorded per-thread state, `QueueHold { reason, detail, causeKeys, heldAt }`.
  - A *failure cause* is something like `interrupt:<turnId>` or `error:<turnId>:<lastError>`. It holds the queue only if its key is new, meaning it is not in the thread's **acknowledged causes**.
  - The acknowledged set gets its **baseline** when a queue goes from empty to non-empty, or at the first evaluation of a key that has no baseline.
  - **Release (Resume)** acknowledges every key in the hold **plus** every cause that is current at release time.
  - Explicit holds come from Stop (web and mobile), from a failed or stalled queued start, and from a resume review. Derived holds come from a new `session.status === "error"`, a new `latestTurn.state === "interrupted"` (or `session.status === "interrupted"`), and a `provider.turn.start.failed` for a message this client dispatched from the queue.
- **D2. The ack gate is message-scoped.** The coordinator captures a snapshot inside `commitSendTurnDispatch`, immediately before the final `thread.turn.start` (`onBeforeTurnStart`), so after any Claude `/compact`. The send counts as acknowledged when:
  - a turn other than the snapshot's starts or settles → **started**; or
  - a `provider.turn.start.failed` activity whose `payload.messageId` is the dispatched id appears → **failed**, which becomes an error hold.

  `session-set(ready)` and `lastError` changes are **not** acks. If nothing arrives within 90 s, a `stalled` hold is set. It is auto-released if the turn starts later.
- **D3. One sender per thread.**
  - A mounted ChatView registers a **foreground** sender for its key. It sends with optimistic UI, the Claude review dialog, worktree and draft promotion, and selection-chat drafts.
  - Otherwise a **started server thread** uses the **background** sender. It is headless, never shows a dialog or toast, and a Claude resume review becomes a `review` hold.
  - Drafts and unstarted threads without a mounted ChatView wait.
- **D4. Hosted mode never creates demand.**
  - The coordinator only *reads* readiness. It never calls `retainHostedWorkspaceThreadScope`.
  - It retains a thread-detail subscription only when the environment is already mutation-ready. In hosted mode that means it is the selected node, the capability is allowed, and the shell is live.
  - A queue on a non-selected hosted node waits until that node is the selected connection.
- **D5. Resume is shown on every presentation tier**, including the frozen web phone tier, through the shared `ComposerQueuedMessages` prop. This is a deliberate, minimal exception. Without it the new hold would strand phone-tier queues, which would be a regression this package introduces. No phone-specific code is added. Retry stays hidden on the phone tier as it is today.
- **D6. Mobile shares the policy, not the loop.**
  - Mobile keeps its persisted outbox and loop.
  - It uses `readQueueThreadView`, `resolveQueueDrainStep`, `resolveQueuedDispatchAck` and the hold helpers, and sends at most one message per thread per pass.
  - Holds and baselines persist with the outbox.

---

## 3. Step-by-step changes

### Commit A: client-runtime

#### A1. `packages/client-runtime/src/state/message-queue/hold.ts` (new, pure)

```ts
export type QueueHoldReason = "interrupted" | "review" | "stalled" | "error" | "limit";
export const QUEUE_HOLD_RANK: Record<QueueHoldReason, number> =
  { interrupted: 0, review: 1, stalled: 2, error: 3, limit: 4 };

export interface QueueHold {
  readonly reason: QueueHoldReason;
  readonly detail: string | null;
  readonly causeKeys: readonly string[];   // every cause this hold covers
  readonly heldAt: string;                 // ISO
}

export interface QueueFailureCause {
  readonly reason: "interrupted" | "error" | "limit";
  readonly causeKey: string;
  readonly detail: string | null;
  /** Instance of the failed session; null = cannot be exempted by provider. */
  readonly providerInstanceId: string | null;
}

/** Derived, current causes. Usage-limits (W2) adds its `limit:` rule HERE, ranked before `error`. */
export function deriveQueueFailureCauses(
  view: QueueThreadView,
  dispatchedMessageIds: ReadonlySet<string>,
): QueueFailureCause[];
```

Rules, in this order:

1. For each `view.turnStartFailures` entry whose `messageId ∈ dispatchedMessageIds`: `{ reason: "error", causeKey: "start-failed:" + activityId, detail, providerInstanceId: null }`.
2. If `view.session?.status === "error"`: `{ reason: "error", causeKey: "error:" + (latestTurn?.turnId ?? "session") + ":" + (lastError ?? ""), detail: lastError, providerInstanceId: session.providerInstanceId }`. Do **not** include `updatedAt`: repeated `session-set(error)` and later `stopped` events must not create new keys. `stopped` and `running` never produce a cause, even when they carry a stale `lastError`.
3. If `view.latestTurn?.state === "interrupted"` or `view.session?.status === "interrupted"`: `{ reason: "interrupted", causeKey: "interrupt:" + (latestTurn?.turnId ?? "session") }`.

```ts
/** Causes not yet acknowledged nor covered by the current hold, split by provider exemption. */
export function partitionNewQueueFailureCauses(input: {
  causes: readonly QueueFailureCause[];
  acknowledgedCauseKeys: readonly string[];
  hold: QueueHold | null;
  headProviderInstanceId: string | null;
}): { hold: QueueFailureCause[]; exempt: QueueFailureCause[] };
```

- **exempt:** an `error` or `limit` cause where both `cause.providerInstanceId` and `headProviderInstanceId` are non-null and differ. This matches t3, where a message queued for another provider is the recovery path (`t3 Orchestrator.ts:1213-1224`). Exempt causes are acknowledged, never held.

```ts
export function mergeQueueHold(existing: QueueHold | null,
  incoming: { reason: QueueHoldReason; causeKeys: readonly string[]; detail: string | null },
  nowIso: string): QueueHold;
```

- `merge`: `causeKeys` is the union. Reason and detail come from the higher-ranked side; ties keep the existing one. `heldAt` is kept.

```ts
export function releaseQueueHoldKeys(hold: QueueHold | null,
  currentCauses: readonly QueueFailureCause[]): string[];       // hold.causeKeys ∪ current
export function createInterruptQueueHold(activeTurnId: string | null, nowIso: string): QueueHold;
// causeKeys: [activeTurnId ? `interrupt:${activeTurnId}` : `interrupt:user:${nowIso}`]
export function describeQueueHold(hold: QueueHold): { title: string; detail: string | null };
```

Shared copy for web and mobile:

| reason | title |
| --- | --- |
| interrupted | "Paused after Stop" |
| error | "Paused after an error" (plus detail) |
| limit | "Paused at a usage limit" (plus detail) |
| review | "Paused for Claude resume review" |
| stalled | "Paused: the last queued message has not started" |

`MAX_ACKNOWLEDGED_CAUSE_KEYS = 32`. Keep the newest keys.

#### A2. `message-queue/store.ts`

Extend `MessageQueueState` (all reducers stay pure `set` calls):

```ts
readonly holdsByThreadKey: Record<string, QueueHold>;
readonly acknowledgedCauseKeysByThreadKey: Record<string, readonly string[]>; // undefined = no baseline yet
readonly epoch: number;
readonly hold: (threadKey: string, hold: QueueHold) => boolean;          // merges; no-op (false) when queue empty
readonly release: (threadKey: string, acknowledgeCauseKeys: readonly string[]) => void;
readonly removeHoldCauses: (threadKey: string, causeKeys: readonly string[]) => void; // undo without ack
readonly acknowledgeCauses: (threadKey: string, causeKeys: readonly string[]) => void; // also creates baseline ([] allowed)
readonly releaseSend: (threadKey: string, id: string) => void;   // "sending" → no status, not "failed"
readonly reset: () => void;                                       // clears everything, epoch + 1
```

- `hold` uses `mergeQueueHold`. It returns `true` only when the stored hold changed. If the merge yields an identical value (same causes and reason), return the previous `state` so no notification fires and the coordinator cannot loop.
- `removeHoldCauses` removes the keys from `hold.causeKeys`. If none remain, it deletes the hold. It does not acknowledge them. Used to undo a Stop whose dispatch failed, and to auto-release `stalled:`.
- **Queue-empty cleanup.** When `remove`, `finishSend(accepted)`, `dequeue` or `clear` leaves a key with an empty queue, delete `holdsByThreadKey[key]` and `acknowledgedCauseKeysByThreadKey[key]` in the same `set`. The next enqueue records a fresh baseline.
- `enqueue` does not touch holds or baselines. The coordinator owns the baseline (A6), because the store has no thread state.

#### A3. `packages/client-runtime/src/state/session/dispatchAck.ts` (new, pure)

1. **Move** `LocalDispatchSnapshot`, `createLocalDispatchSnapshot` and `hasServerAcknowledgedLocalDispatch` verbatim from `apps/web/src/components/ChatView.logic.ts:391-460`. They use `Thread`, `ThreadSession` and `SessionPhase` from `../threads/types.ts`.
   - Header comment: *this is the UI-busy gate. It is intentionally loose: any server reaction, including errors and `session-set(ready)`, must release the composer spinner. It must not be used to sequence sends. Queued sends use `resolveQueuedDispatchAck`.*
2. Add the strict, message-scoped gate:

```ts
export interface QueuedDispatchSnapshot {
  readonly messageId: string;
  readonly latestTurnId: TurnId | null;
  readonly activeTurnId: TurnId | null;
  readonly capturedAt: string;
}
export function captureQueuedDispatchSnapshot(
  view: { latestTurn: { turnId: TurnId } | null; session: { activeTurnId: TurnId | null } | null } | null,
  messageId: string, nowIso: string): QueuedDispatchSnapshot;

export type QueuedDispatchAck =
  | { readonly kind: "pending" }
  | { readonly kind: "started"; readonly turnId: TurnId }
  | { readonly kind: "failed"; readonly causeKey: string; readonly detail: string | null };

export function resolveQueuedDispatchAck(input: {
  snapshot: QueuedDispatchSnapshot;
  view: QueueThreadView;
}): QueuedDispatchAck;
```

Resolution order:

1. A `view.turnStartFailures` entry with `messageId === snapshot.messageId` → `failed` with `causeKey: "start-failed:" + activityId`.
2. `session.activeTurnId` is non-null and differs from both `snapshot.latestTurnId` and `snapshot.activeTurnId` → `started`.
3. `latestTurn` is non-null and its `turnId` differs from `snapshot.latestTurnId` → `started`. This covers a turn that starts and settles inside one applied batch.
4. Otherwise → `pending`.

Never acknowledge on `session.updatedAt`, `orchestrationStatus` or `lastError` changes.

Export both from `state/session/index.ts`.

#### A4. `threads/storeSelectors.ts` and `message-queue/threadView.ts` (new)

`storeSelectors.ts` (append only):

```ts
/** True once a thread-detail window or full-detail snapshot has been applied. */
export function selectThreadDetailLoaded(state: AppState, ref: ScopedThreadRef): boolean;
// env.threadHistoryByThreadId?.[id] !== undefined || env.messageIdsByThreadId[id] !== undefined
```

Both detail paths write one of these maps: `syncServerThreadWindow` (`store.ts:2059-2074`) and `syncServerThreadDetail` (`:875-888`). Test both paths.

`threadView.ts`:

```ts
export interface QueueThreadView {
  readonly ref: ScopedThreadRef;
  readonly started: boolean;          // latestTurn !== null || messages.length > 0 || summary.latestUserMessageAt !== null
  readonly archived: boolean;         // shell.archivedAt !== null || worktreeById[shell.worktreeId]?.archivedAt != null
  readonly detailLoaded: boolean;     // selectThreadDetailLoaded
  readonly running: boolean;          // orchestrationStatus ∈ {running, starting} || activeTurnId || latestTurn.state === "running"
  readonly hasPendingApproval: boolean;   // summary flag || (detailLoaded && derivePendingApprovals(activities).length > 0)
  readonly hasPendingUserInput: boolean;  // summary flag || (detailLoaded && derivePendingUserInputs(activities).length > 0)
  readonly session: { status: OrchestrationSessionStatus; lastError: string | null;
                      providerInstanceId: string | null; activeTurnId: TurnId | null } | null;
  readonly latestTurn: { turnId: TurnId; state: OrchestrationLatestTurnState } | null;
  readonly projectedMessageIds: ReadonlySet<string>;
  readonly turnStartFailures: ReadonlyArray<{ activityId: string; messageId: string; detail: string | null }>;
  readonly steerFailedMessageIds: ReadonlySet<string>;
}
/** null when the environment has no shell for the thread. */
export function readQueueThreadView(state: AppState, ref: ScopedThreadRef): QueueThreadView | null;
/** Identity tuple for change detection; equal tuples ⇒ equal views. */
export function queueThreadViewInputs(state: AppState, ref: ScopedThreadRef): readonly unknown[];
```

- `running` deliberately matches mobile's existing `threadBusy` (`use-thread-outbox-drain.ts:126-130`) and adds `starting`. A `starting` session accepts a decider `turn.start`, so it is the same overlap window as §1.3.
- **Performance.** Cache `projectedMessageIds` in a `WeakMap` keyed by the `messageIdsByThreadId[id]` array. Cache `turnStartFailures` and `steerFailedMessageIds` in a `WeakMap` keyed by `activityIdsByThreadId[id]`.
  - Kinds read: `provider.turn.start.failed` and `provider.turn.steer.failed`, with string `payload.messageId` and optional `payload.detail`.
  - Streaming deltas change `messageByThreadId` but not the ids array, so they cost O(1).
- `queueThreadViewInputs` returns the following, for the coordinator's skip check (A6): `[shell, session, turnState, summary, messageIds, activityIds, historyEntry, worktree, env.bootstrapComplete, env.hydratedFromCacheAt]`.

#### A5. `message-queue/drain.ts` (new, pure)

```ts
export type QueueDrainWaitReason =
  | "environment" | "held" | "awaiting-ack" | "archived" | "busy" | "no-sender"
  | "detail" | "failed-head" | "in-flight" | "steering";

export interface QueueDrainInput {
  readonly nowIso: string;
  readonly queue: ReadonlyArray<{ readonly id: string; readonly deliveryStatus?: "sending" | "failed" }>;
  readonly steeringIds: ReadonlyArray<string>;
  readonly hold: QueueHold | null;
  readonly acknowledgedCauseKeys: readonly string[] | undefined;   // undefined → baseline step
  readonly headProviderInstanceId: string | null;
  readonly view: QueueThreadView | null;
  readonly draft: boolean;          // local draft key with a mounted foreground sender (web only)
  readonly environment: { readonly shellLive: boolean; readonly mutationReady: boolean };
  readonly pendingDispatch: QueuedDispatchSnapshot | null;
  readonly dispatchedMessageIds: ReadonlySet<string>;
  readonly sender: "foreground" | "background" | null;
}

export type QueueDrainStep =
  | { kind: "idle" }
  | { kind: "baseline"; causeKeys: string[] }
  | { kind: "thread-gone" }
  | { kind: "reconcile"; removeIds: string[]; endSteerIds: string[] }
  | { kind: "dispatch-started"; messageId: string }
  | { kind: "dispatch-failed"; hold: QueueHold }
  | { kind: "acknowledge"; causeKeys: string[] }
  | { kind: "hold"; hold: QueueHold }
  | { kind: "wait"; reason: QueueDrainWaitReason }
  | { kind: "send"; messageId: string; sender: "foreground" | "background" };

export function resolveQueueDrainStep(input: QueueDrainInput): QueueDrainStep;
```

The steps are tried in this **fixed order**, and the first one that applies is returned:

1. `queue.length === 0` → `idle`.
2. **Draft branch** (`view === null && draft`). This keeps existing draft behaviour:
   - held → `wait held`
   - `!mutationReady` → `wait environment`
   - head failed, sending or steering → `wait`
   - otherwise → `send` with the foreground sender.
3. `view === null` → `shellLive ? thread-gone : wait environment`.
4. `!shellLive` → `wait environment`. Cached or demoted rows cannot be trusted for dedupe or running state.
5. `acknowledgedCauseKeys === undefined` → `baseline` with `deriveQueueFailureCauses(view, dispatched)` keys.
6. **Reconcile** (only if `detailLoaded`):
   - `removeIds` = queued ids in `projectedMessageIds`, including a head that is `sending`.
   - `endSteerIds` = `steeringIds ∩ steerFailedMessageIds`.
   - If either list is non-empty → `reconcile`.
7. `pendingDispatch`:
   - ack `started` → `dispatch-started`.
   - ack `failed` → `dispatch-failed` with `mergeQueueHold(hold, {reason:"error", causeKeys:[causeKey], detail})`.
8. **New causes** (`partitionNewQueueFailureCauses`):
   - exempt non-empty → `acknowledge`.
   - else held-causes non-empty → `hold` with the merged hold, highest rank first.

   This runs **before** step 9, so a cause that appears while already held merges into the hold and is covered by a single Resume.
9. `hold !== null` → `wait held`.
10. `pendingDispatch` (still pending) → `wait awaiting-ack`.
11. `view.archived` → `wait archived`. Never send into an archived thread or worktree (t3 `Orchestrator.ts:1187-1189`).
12. `running || hasPendingApproval || hasPendingUserInput` → `wait busy`.
13. `!mutationReady` → `wait environment`.
14. `sender === null` → `wait no-sender` (an unstarted or draft thread whose ChatView is not mounted).
15. `!detailLoaded` → `wait detail`. Dedupe and failure detection need the detail window.
16. Head `failed` → `wait failed-head`. Head `sending` → `wait in-flight`. Head in `steeringIds` → `wait steering`.
17. → `send` (head id, `sender`).

#### A6. `message-queue/coordinator.ts` (new; zustand plus plain TS, no DOM or RN imports)

```ts
export interface QueueSendHooks { readonly onBeforeTurnStart: () => void }
export type QueueSendResult =
  | { kind: "accepted" } | { kind: "failed" } | { kind: "deferred" }
  | { kind: "needs-review"; detail: string };
export interface MessageQueueSender<C, S> {
  send(entry: QueuedMessage<C, S>, hooks: QueueSendHooks): Promise<QueueSendResult>;
}

export interface MessageQueueDrainPlatform<C, S> {
  readonly threads: { getState(): AppState; subscribe(listener: () => void): () => void };
  readonly readEnvironment: (environmentId: EnvironmentId, state: AppState) =>
    { shellLive: boolean; mutationReady: boolean };
  readonly subscribeEnvironmentReadiness?: (listener: () => void) => () => void;
  readonly resolveSender: (threadKey: string, view: QueueThreadView | null) =>
    { kind: "foreground" | "background"; sender: MessageQueueSender<C, S> } | null;
  readonly isLocalDraftKey?: (threadKey: string) => boolean;
  readonly headProviderInstanceId: (entry: QueuedMessage<C, S>) => string | null;
  readonly retainThreadDetail?: (ref: ScopedThreadRef) => () => void;
  readonly onEntryRemoved?: (threadKey: string, entry: QueuedMessage<C, S>,
                             cause: "accepted" | "projected") => void;
  readonly now?: () => number;
  readonly timers?: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout };
  readonly ackTimeoutMs?: number;          // default 90_000
  readonly deferRetryMs?: number;          // default 250
  readonly environmentRecheckMs?: number;  // default 5_000
}

export interface MessageQueueDrainCoordinator {
  retain(): () => void;               // ref-counted start; last release stops and clears bookkeeping
  evaluate(threadKey?: string): void; // schedules (microtask-coalesced)
  resume(threadKey: string): void;
  retry(threadKey: string, messageId: string): void;
  inspect(threadKey: string): { pendingDispatch: QueuedDispatchSnapshot | null;
                                inFlightMessageId: string | null; lastStep: QueueDrainStep | null };
}
export function createMessageQueueDrainCoordinator<C, S>(
  queueStore: StoreApi<MessageQueueState<C, S>>, platform: MessageQueueDrainPlatform<C, S>,
): MessageQueueDrainCoordinator;
```

**Internal state**, all cleared on the final release:

- `runId`
- `pending: Map<key, QueuedDispatchSnapshot>`
- `ackTimers`
- `inFlight: Map<key, { messageId; runId; epoch }>`
- `hookSnapshots: Map<messageId, QueuedDispatchSnapshot>` (bounded to 64)
- `failedSnapshots: Map<messageId, QueuedDispatchSnapshot>` (bounded to 64)
- `dispatched: Map<key, Set<messageId>>` (newest 16)
- `retains: Map<key, release>`
- `lastInputs: Map<key, unknown[]>`
- `deferTimers`
- `envRecheckTimer`

**Subscriptions**, active only while retained:

- **Queue store.** For each key whose queue went from empty or absent to non-empty, compute the baseline *synchronously*: `acknowledgeCauses(key, deriveQueueFailureCauses(view, dispatched).map(k))`. The thread state at that instant is the state the user saw while composing. Then mark the key dirty. On an `epoch` change, drop `pending`, `inFlight`, the snapshots, `dispatched`, the retains and the timers.
- **Threads store.** For each key with a non-empty queue or a pending dispatch, compare `queueThreadViewInputs` with `lastInputs`. Mark the key dirty only if they differ. Unrelated threads cost one tuple compare per active key.
- **`subscribeEnvironmentReadiness`**, plus a 5 s re-check while any key waits on `environment`. This covers WS status changes that do not touch the threads store. Mark all active keys dirty.
- Dirty keys are evaluated in one `queueMicrotask` pass, which avoids re-entrant `set` inside zustand listeners.

**Evaluate(key):**

- Build `QueueDrainInput`:
  - `headProviderInstanceId` comes from `platform.headProviderInstanceId(queue[0])`.
  - `draft` is `view === null && platform.isLocalDraftKey?.(key) && sender?.kind === "foreground"`.
- **Retain policy.** If the key is active and `environment.mutationReady`, ensure `retainThreadDetail(ref)`. Otherwise release it.
- Apply the step:

| step | action |
| --- | --- |
| `baseline` / `acknowledge` | `acknowledgeCauses`, then re-evaluate |
| `reconcile` | For each id: read the entry, call `remove`, then `onEntryRemoved(…, "projected")`. If `failedSnapshots` has the id and the queue is still non-empty, set `pending` from that snapshot and start the ack timer (lost-reply case). `endSteer` each steer id. Re-evaluate |
| `dispatch-started` | Delete `pending` and clear the timer. If the hold contains `stalled:<id>`, call `removeHoldCauses([that])`. Re-evaluate |
| `dispatch-failed` | Delete `pending`, then `hold(…)` |
| `hold` | `hold(…)` |
| `wait` | Nothing. `environment` arms the re-check timer |
| `thread-gone` | Web: nothing. Mobile does not use the coordinator |
| `send` | See below |

**`send`:**

1. `if (!store.beginSend(key, id)) return`.
2. Capture `startSnapshot = captureQueuedDispatchSnapshot(view, id)` as a fallback.
3. Record `inFlight`.
4. Call `sender.send(entry, { onBeforeTurnStart: () => hookSnapshots.set(id, capture(readQueueThreadView(current state), id)) })`.
5. Completion (a rejection is `failed`):
   - If `store.epoch` changed → ignore entirely.
   - **accepted:** `finishSend(key,id,true)`, `onEntryRemoved(…,"accepted")`, add to `dispatched`. If `runId` is unchanged, set `pending` to `hookSnapshots.get(id) ?? startSnapshot` and start the ack timer.
   - **failed:** `finishSend(key,id,false)`. If a hook snapshot exists, add it to `dispatched` and `failedSnapshots`.
   - **deferred:** `releaseSend`, then re-evaluate after `deferRetryMs`. One timer per key, so the coordinator never spins.
   - **needs-review:** `releaseSend`, then `hold(key, { reason:"review", causeKeys:["review:"+id], detail })`.
   - Always delete `inFlight`, then re-evaluate.

**Ack timer.** When it fires and `pending.get(key)?.messageId === id`, call `hold(key, { reason:"stalled", causeKeys:["stalled:"+id], detail })`. Keep `pending` so a late start auto-releases the hold through `dispatch-started`.

**Cleanup.** When the queue is empty, delete `pending`, `dispatched`, the timers, the retain and `lastInputs` for that key.

**resume(key):**

1. `release(key, releaseQueueHoldKeys(hold, deriveQueueFailureCauses(view, dispatched)))`.
2. Delete `pending` for the key. The user chose to proceed.
3. Evaluate.

**retry(key, id):** `retrySend(key, id)`, then `resume(key)` if the queue is held, then evaluate. Retry while held must send.

**Final `retain()` release:** unsubscribe, clear all timers, release all detail retains, clear every map, `runId++`. Store claims that complete later still apply `finishSend` or `releaseSend` while the epoch matches, so nothing stays stuck in `sending`. They do not arm acks.

#### A7. `packages/client-runtime/src/state/composer/sendEngine.ts`

- Add `readonly onBeforeTurnStart?: () => void` to `CommitSendTurnDispatchInput`.
- In `commitSendTurnDispatchOnce`, call `input.onBeforeTurnStart?.()` right after `input.beginLocalDispatch({ preparingWorktree: false })` and immediately before the final `dispatchCommand({ type: "thread.turn.start", … })` (`sendEngine.ts:306-307`). That point is after `reviewClaudeResumeBeforeSend`, including any `/compact` turn and its wait loop, after the settings writes and after the readiness asserts.
- Not called when review or readiness throws.
- Calls that join a pending send with the same message id through `pendingSends` do not call it; the coordinator never double-sends and falls back to `startSnapshot`.

#### A8. `message-queue/index.ts`

Export `hold.ts`, `threadView.ts`, `drain.ts` and `coordinator.ts`.

---

### Commit B: web

#### B1. `apps/web/src/hooks/chatSendShared.ts` (new). Extract from ChatView, without changing behaviour

- `formatOutgoingPrompt`: moved from `ChatView.tsx:403-413`.
- `persistThreadSettingsForNextTurn(api, current: { runtimeMode; interactionMode; tokenMode? }, input)`: the body of `ChatView.tsx:2516-2556`. ChatView's `useCallback` wraps it with `serverThread`.
- `createSourceControlContextFetcher({ environmentId, cwd, queryClient })`: the fetcher at `ChatView.tsx:3497-3538`.
- `applyBuildModeToSend({ composer, settings, enforceBuildMode })`: `resolveBuildModeModelSelection` plus the interaction-mode override (`ChatView.tsx:3310-3318`, `:3359-3364`).
- `resolveEnforceBuildMode()`: `useUiStateStore.getState().alwaysUseBuildMode && getPresentationTier() !== "phone"`. ChatView keeps its hook-based value. The background sender uses this function.
- `attachDevicePromptScreenshot({ api, threadId, composer, notify })`: `ChatView.tsx:3322-3354`. `notify` is optional; the background sender passes none.

`dispatchComposerSnapshot` calls these helpers. No duplicated logic remains between the foreground and background senders.

#### B2. `apps/web/src/hooks/executeChatSendTurn.ts`

Add to `ExecuteChatSendTurnInput`:

```ts
/** undefined = the dialog presentation (default); null = never review interactively. */
claudeCacheReview?: ClaudeCacheReviewPresentation | null;
/** Background sends never toast. */
suppressToasts?: boolean;
onBeforeTurnStart?: () => void;
/** Observes the caught error before it becomes a thread error (classification only). */
onSendError?: (error: unknown) => void;
```

- Pass `claudeCacheReview: input.claudeCacheReview === undefined ? claudeCacheReviewPresentation : (input.claudeCacheReview ?? undefined)` and `onBeforeTurnStart` to `commitSendTurnDispatch`. With no presentation, `reviewClaudeResumeBeforeSend` throws `ClaudeResumeReviewError("This Claude resume needs review…")` (`claudeCacheReview.ts:126-130`).
- Skip the expired-terminal-context toast when `suppressToasts` is set.
- Call `onSendError?.(err)` first in the catch block.

#### B3. `apps/web/src/hooks/sendQueuedMessageInBackground.ts` (new)

```ts
export async function sendQueuedMessageInBackground(
  threadKey: string, entry: WebQueuedMessage, hooks: QueueSendHooks,
): Promise<QueueSendResult>;
```

Steps:

1. Parse the ref. Read the thread (`selectThreadByRef`) and project (`selectProjectByRef`) from `useStore`, and `readEnvironmentApi(env)`. If any is missing → `deferred`.
2. If `!readWebQueueEnvironment(env).mutationReady` → `deferred`.
3. Call `rejectRetiredProjectMemory(entry.composer)`. If it throws → `failed`.
4. Apply `applyBuildModeToSend` with `resolveEnforceBuildMode()`.
5. Call `selectionAllowedAtSendBoundary({ threadStarted: true, policy: { mode: "continuation-only", lockedProvider: canonical, reason: "queued-message" }, canonicalSelection: thread.modelSelection, targetSelection })`. This is the same result the foreground gets, since `hasQueuedMessage` is always true during a queued send. If not allowed → `setThreadError(ref, "The queued provider or model needs a context handoff. Open the conversation to send it.")` → `failed`.
6. Call `attachDevicePromptScreenshot` without `notify`.
7. Call `executeChatSendTurn` with:
   - `messageId`, `preserveComposerDraft: true`, `claudeCacheReview: null`, `suppressToasts: true`, `onBeforeTurnStart: hooks.onBeforeTurnStart`, and `onSendError` captured.
   - `thread`: `sourceProviderDriver: thread.session?.provider ?? null`, `isFirstMessage: false`, `isServerThread: true`, `isLocalDraftThread: false`, plus branch, `worktreePath`, `createdAt` and `projectId` from the shell.
   - `worktree`: the all-false plan.
   - `scroll` and `draft` callbacks: no-ops, with `composerDraftTarget = ref` and `environmentId`.
   - `dispatch`: `{ api, beginLocalDispatch: noop, resetLocalDispatch: noop, setOptimisticUserMessages: noop, setThreadError: (_, e) => useStore.getState().setThreadError(ref, e) }`. Confirm that store action's name when implementing.
   - `refs`: fresh objects.
   - `sourceControl`: `createSourceControlContextFetcher` with `cwd = thread.worktreePath ?? project.cwd`.
   - `persistSettings`: `persistThreadSettingsForNextTurn(api, thread, …)`.
   - `composerHandle: { readComposer: () => null }` and `formatOutgoingPrompt`.
8. Result: accepted → `accepted`; `isClaudeResumeReviewError(captured)` → `needs-review` with `captured.message`; otherwise → `failed`.

#### B4. `apps/web/src/messageQueueDrain.ts` (new) and `components/MessageQueueDrainBridge.tsx` (new)

- **Lazy singleton.** Create `createMessageQueueDrainCoordinator(useMessageQueueStore, webPlatform)` on first use.
- **`readWebQueueEnvironment(environmentId, state = useStore.getState())`:**
  - `shellLive = selectBootstrapCompleteForEnvironment(state, env) && selectEnvironmentHydratedFromCacheAt(state, env) === null`.
  - **Hosted** (`isHostedHubMode()`): `mutationReady = shellLive && useHostedHubStore.getState().selectedNode?.environmentId === env && readHostedRpcCapability(ORCHESTRATION_WS_METHODS.dispatchCommand).allowed && readEnvironmentApi(env) !== null`.
  - **Otherwise:** `mutationReady = shellLive && getWsConnectionUiState(getWsConnectionStatusForEnvironment(env)) === "connected" && (no saved-environment record for env || savedEnvironmentRuntime.byId[env]?.connectionState === "connected") && readEnvironmentApi(env) !== null`.
  - Before relying on the WS check, verify that the web WS registry records the primary environment (ChatView already uses `useWsConnectionStatusForEnvironment`). If it does not, fall back to `readEnvironmentConnection(env)` for the primary.
  - A dropped direct socket makes the queue **wait**; it does not produce a failed head.
- **`subscribeEnvironmentReadiness`:** `useHostedHubStore.subscribe`, `useSavedEnvironmentRuntimeStore.subscribe` and `useSavedEnvironmentRegistryStore.subscribe`, plus the coordinator's 5 s re-check for WS-only changes.
- **`resolveSender`:**
  1. The top of the foreground stack for the key, if any → `foreground`.
  2. Else, if `view?.started` → `background` (`sendQueuedMessageInBackground`).
  3. Else → `null`.
- **`isLocalDraftKey`:** the key matches a draft thread in `useComposerDraftStore` (`draftThreadsByThreadKey`).
- **`headProviderInstanceId`:** `entry.composer.selectedModelSelection.instanceId`.
- **`retainThreadDetail`:** `retainThreadDetailSubscription(env, threadId)` from `environments/runtime/service.ts`. **Never** call `retainHostedWorkspaceThreadScope`. The coordinator only calls this when `mutationReady`, so hosted retains only the selected and connected node.
- **`onEntryRemoved`:** revoke `blob:` preview URLs of `entry.composer.images`, as ChatView does at `:885-899` and `:3965-3968`.
- **Foreground registry:** `registerForegroundQueueSender(threadKey, sender)` pushes onto a per-key stack and returns `unregister`. `useForegroundQueueSender(threadKey | null, sender)` registers the sender **and** calls `coordinator.retain()`, so browser suites that mount ChatView alone still drain.
- **Exports:** `retainMessageQueueDrain()`, `resumeMessageQueue(key)`, `retryQueuedMessage(key, id)`, and `holdMessageQueueForInterrupt(environmentId, threadId): { undo(): void }`.
  - `holdMessageQueueForInterrupt` uses `createInterruptQueueHold(selectThreadByRef(...)?.session?.activeTurnId ?? null, now)` and `store.hold`.
  - `undo` calls `removeHoldCauses(hold.causeKeys)`, and only if `hold()` returned `true`.
- **`MessageQueueDrainBridge`:** `useEffect(() => retainMessageQueueDrain(), [])`. Render it in `RootAppShell.tsx` next to `ThreadPriorityRefreshBridge`, under `primaryEnvironmentAuthenticated`.
- **Acyclicity:** `hostedHub/environment.ts` and the store modules must not import `messageQueueDrain.ts`.

#### B5. `apps/web/src/hostedHub/capabilities.ts` and `environment.ts`

- Add `readHostedRpcCapability(method, state = useHostedHubStore.getState())`, which holds the input mapping from `useHostedRpcCapability`. The hook becomes `useHostedHubStore(...)` plus `readHostedRpcCapability(method, state)`, so the policy lives in one place.
- In `clearWebHostedAccountScopedState`, replace `useMessageQueueStore.setState({ queuesByThreadKey: {} })` (`environment.ts:74`) with `useMessageQueueStore.getState().reset()`. The coordinator observes the epoch change; nothing imports the coordinator. In-flight completions from the previous account are dropped by the epoch check.
- `clearCoreHostedNodeScopedState` (node switch) keeps queues as today. They wait on `environment` until their node is selected again.

#### B6. `apps/web/src/components/ChatView.tsx`

1. **Delete** the drain effect (`:3933-3988`) and both steer reconcile effects (`:3264-3290`). Projected steering ids and `provider.turn.steer.failed` are now handled in the coordinator's `reconcile` step for every thread.
2. Use `chatSendShared.ts` inside `dispatchComposerSnapshot` and `persistThreadSettingsForNextTurn`.
3. Add a fourth parameter to `dispatchComposerSnapshot`: `hooks?: { onBeforeTurnStart?: () => void; onSendError?: (e: unknown) => void }`, forwarded to `executeChatSendTurn`.
4. **Foreground sender**, with live busy reads:

   ```ts
   const queueRenderBusyRef = useRef(false);
   queueRenderBusyRef.current = isSendBusy || isConnecting || isRevertingCheckpoint ||
     hostedDraftTarget.pending !== null || !dispatchCapability.allowed || activeEnvironmentUnavailable;
   const foregroundQueueSender = useMemo<MessageQueueSender<…>>(() => ({
     send: async (entry, hooks) => {
       if (queueRenderBusyRef.current || sendInFlightRef.current || editorSendPreparationRef.current)
         return { kind: "deferred" };
       const accepted = await dispatchComposerSnapshotRef.current(
         entry.composer, entry.settings, MessageId.make(entry.id), { onBeforeTurnStart: hooks.onBeforeTurnStart });
       return accepted ? { kind: "accepted" } : { kind: "failed" };
     },
   }), []);
   useForegroundQueueSender(activeThreadKey, foregroundQueueSender);
   ```

   - The refs are read at call time. `sendInFlightRef` and `editorSendPreparationRef` are live; the render-derived flags are as fresh as the last render, and the `deferred` result plus the 250 ms retry covers that lag.
   - Editor-drain failures still return `false` → `failed`. The browser test at `ChatView.Conversation.browser.tsx:590-680` relies on this.
5. **Retry:** `onRetry` → `retryQueuedMessage(activeThreadKey, id)`, still only on non-phone tiers.
6. **Hold and Resume:** select `useMessageQueueStore(s => key ? s.holdsByThreadKey[key] ?? null : null)`. Pass `hold` and `onResume={() => resumeMessageQueue(activeThreadKey)}` to `ComposerQueuedMessages` on **all tiers** (D5).
7. Remove `beginQueuedSend`, `finishQueuedSend` and `retryQueuedSend` if they become unused. `handleRemoveQueuedMessage` stays for user removal.

#### B7. `apps/web/src/components/ChatView.logic.ts`

Replace the moved definitions with `export { createLocalDispatchSnapshot, hasServerAcknowledgedLocalDispatch, type LocalDispatchSnapshot } from "@ryco/client-runtime/state/session";`. Existing imports, including `useLocalDispatchState.ts` and `ChatView.logic.test.ts:758+`, keep compiling unchanged.

#### B8. `apps/web/src/components/chat/ComposerQueuedMessages.tsx`

- New props: `hold?: QueueHold | null` and `onResume?: () => void`.
- When held, the header row reads `{describeQueueHold(hold).title} · {n}`. The detail sits inline on the same row: muted, truncated to one line, with the full text in `title`. A text button **Resume** (`aria-label="Resume queued messages"`) sits at the right.
- Follow the in-app density rules: no extra container, no repeated facts.
- Rows are unchanged. A failed head still shows Retry where it is enabled.

#### B9. `apps/web/src/hooks/useChatSessionActions.ts`

In `interruptTurn`:

1. Before dispatching, call `const held = holdMessageQueueForInterrupt(environmentId, activeThreadId)`.
2. If `interruptThreadTurn` throws, call `held.undo()` and rethrow.

This covers the composer Stop and the background-work Stop banner (`ChatView.tsx:1735-1753`).

---

### Commit C: mobile

#### C1. `apps/mobile/src/state/threadOutbox.ts`

- **Persisted holds.** New KV key `ryco.threadOutboxHolds.v1` holding `{ holds: Record<threadKey, QueueHold>; acknowledged: Record<threadKey, string[]> }`.
  - Hydrate it in `hydrateThreadOutbox`. Sanitize: drop malformed entries and unknown reasons, and cap acknowledged keys at 32.
  - Persist it on every change, fire-and-forget like `persist()`.
  - Drop a key's hold and baseline when its message group becomes empty.
- **In memory, not persisted:** `pendingDispatchByThreadKey`, `dispatchedByThreadKey` (newest 16), `hookSnapshots`, and `failedSnapshots`. After an app kill a pending ack is lost; see §6.
- **`enqueueThreadOutboxMessage(message)`.** If the thread group was empty, record a baseline synchronously with `deriveQueueFailureCauses(readQueueThreadView(useStore.getState(), ref) ?? EMPTY, dispatched)` (import `useStore` from `./threadsRuntime`). An offline message composed after a failure the user already saw is therefore **not** held. Re-enqueues (review retry) do not touch the baseline. Update the module header comment: the module now also owns hold persistence.
- **New API:**
  - `getThreadOutboxHold(threadKey)`
  - `holdThreadOutboxForInterrupt(threadKey, activeTurnId): { undo(): void }`
  - `releaseThreadOutboxHold(threadKey)`: acknowledges `releaseQueueHoldKeys(hold, current causes)` and clears the pending dispatch.

  All of them notify listeners.
- **`drainThreadOutbox(deps)`** is rewritten. New deps:

  ```ts
  readonly readThreadDrainState: (ref: ScopedThreadRef) =>
    { view: QueueThreadView | null; environment: { shellLive: boolean; mutationReady: boolean } };
  readonly sendQueuedMessage: (message: QueuedThreadMessage, hooks: QueueSendHooks) => Promise<void>;
  readonly onInterrupted?: () => boolean;
  ```

  Per thread group, in `createdAt` order (`groupQueuedThreadMessages`), loop at most `maxSteps = 8` times:

  1. Build `QueueDrainInput` with:
     - `queue`: `{ id: messageId, deliveryStatus: resumeReviewError || hasRetiredProjectMemory(m) ? "failed" : undefined }`
     - `steeringIds: []`. Mobile steering state is screen-local; see §7.
     - `draft: false`
     - `sender: view?.started ? "background" : null`
     - `headProviderInstanceId`: `head.modelSelection?.instanceId ?? null`
  2. Apply the step:

     | step | action |
     | --- | --- |
     | `baseline` / `acknowledge` / `hold` / `dispatch-*` | Mutate the persisted hold state, then continue the loop |
     | `reconcile` | Remove the ids. If a removed id is in `failedSnapshots` and messages remain, arm pending. Continue |
     | `thread-gone` | Remove the group (existing behaviour) |
     | `wait` | Break |
     | `send` | Send the head, then **break**. This is the one-send-per-pass fix |

  3. Send handling:
     - Success: remove the message, add it to `dispatched`, and set pending to the hook snapshot or the start snapshot.
     - Failure: keep the existing classification. `ClaudeResumeReviewError` → `resumeReviewError`. `resolveThreadOutboxFailureAction` → retry or discard. If a hook snapshot exists, record it in `failedSnapshots`.

  4. **Ack timeout.** Mobile has no timers in the loop. On each pass, if pending is older than 90 s (`Date.now()` against `capturedAt`), set a `stalled` hold.

#### C2. `apps/mobile/src/state/threadOutboxModel.ts`

- Delete `resolveThreadOutboxDeliveryAction` and `ThreadOutboxDeliveryAction`; the shared `resolveQueueDrainStep` replaces them.
- Delete `EnvironmentShellStatus` if nothing uses it any more.
- Keep `resolveThreadOutboxFailureAction`, grouping, attachment normalization and retry backoff.

#### C3. `apps/mobile/src/state/use-thread-outbox-drain.ts`

- Replace `readThreadDeliveryState(message)` with `readThreadDrainState(ref)`:
  - `view` comes from `readQueueThreadView(useStore.getState(), ref)`.
  - `environment` is `{ shellLive: selectBootstrapCompleteForEnvironment && selectEnvironmentHydratedFromCacheAt === null, mutationReady: shellLive && ws connected for that environment }`. Keep the existing per-environment logic and comments.
- `sendQueuedThreadMessage(message, hooks)` passes `onBeforeTurnStart: hooks.onBeforeTurnStart` to `commitSendTurnDispatch`. The mobile Claude review presentation is unchanged.
- **New `useThreadOutboxDetailRetention()`**, called from `useThreadOutboxDrain`. It subscribes to the outbox and the threads store. For each thread key that has outbox messages and whose environment is `mutationReady`, it calls `retainThreadDetailSubscription(env, threadId)` from `connection/threadDetail.ts`. It releases when the key has no messages or the environment is not ready. Detail is required for dedupe and failure acks, so without it off-screen mobile queues would wait on `detail`.

#### C4. `ThreadDetailScreen.tsx` and `ThreadQueuedMessages.tsx`

- **`onStop`:**

  ```ts
  const held = holdThreadOutboxForInterrupt(key, currentThread?.session?.activeTurnId ?? null);
  void runAction(async () => {
    try { await interruptThreadTurn(…) } catch (e) { held.undo(); throw e; }
  });
  ```

- Read the hold with `useSyncExternalStore(subscribeThreadOutbox, () => getThreadOutboxHold(key))`.
- `ThreadQueuedMessages` gets `hold` and `onResume` props. The header shows `describeQueueHold` (shared copy). The Resume `Pressable` (`accessibilityLabel="Resume queued messages"`) calls `releaseThreadOutboxHold(key)` and then `runOutboxDrain()`.
- Mobile has no component tests. All the logic lives in `threadOutbox.ts` and client-runtime.

---

## 4. Contract and migration changes

- No `packages/contracts` change and no SQLite migration (none of 071–075 is used). The server is untouched.
- Client-runtime public surface: see the header.
- New mobile KV key `ryco.threadOutboxHolds.v1`. Older apps ignore it, and a missing key means no holds and no baseline. Legacy persisted outboxes get their baseline at the first evaluation (step 5), so upgrading never holds.

---

## 5. Tests (failing first where a bug)

### client-runtime (`bun run --cwd packages/client-runtime test src/state/message-queue src/state/session/dispatchAck.test.ts src/state/composer/sendEngine.test.ts src/state/threads/storeSelectors.test.ts`)

**`hold.test.ts`**
- `status:error` yields one cause. The same error after a `stopped`, or after repeated `session-set(error)` with a new `updatedAt`, yields the **same** key.
- `running` or `stopped` with a stale `lastError` yields no cause.
- `start-failed` is raised only for dispatched ids.
- Provider-instance mismatch makes an `error` cause exempt; an interrupt is never exempt.
- `mergeQueueHold` follows the precedence order and unions keys.
- `releaseQueueHoldKeys` covers the hold keys plus the current keys.

**`store.test.ts`**
- `hold` on an empty queue is a no-op.
- An identical merge does not notify.
- `release` and `removeHoldCauses` semantics.
- Queue-empty cleanup drops the hold and the baseline.
- `releaseSend` returns the entry to no status.
- `reset` clears everything and bumps `epoch`.
- The existing claim tests stay green.

**`dispatchAck.test.ts`**
- **(failing-first)** The startSession bind sequence `session-set(ready, activeTurnId:null)` then `turn.started` stays `pending` until `turn.started`. Today's `hasServerAcknowledgedLocalDispatch` returns `true` on the first event; assert that difference explicitly in the same file.
- A `/compact` turn that started and settled **before** the snapshot does not acknowledge.
- A `provider.turn.start.failed` with a matching `messageId` → `failed`; a non-matching one → `pending`.
- A new running turn → `started`.
- A turn that started and settled inside one batch → `started`.
- The moved local-dispatch tests are added as one smoke case. The full suite stays in `ChatView.logic.test.ts` via the re-export.

**`threadView.test.ts`**
- `running` covers `starting`, `activeTurnId` and `latestTurn` `running`.
- `archived` comes from the thread or from its worktree.
- Pending flags are the OR of summary and activities.
- `projectedMessageIds` is cached by ids-array identity: the same `Set` instance across a message-content-only update.

**`drain.test.ts`** (table-driven over the step order)
- **(failing-first behaviour)** A thread that went from running to `error` after enqueue → `hold`.
- An offline-composed message on an already-errored thread: baseline, then `send`.
- The restart-orphan error present at enqueue → `send`. The same error arriving after enqueue → `hold`.
- Stop, then an error settle, then one release → `send`, with no second hold.
- Archived → `wait archived`.
- Cached environment → `wait environment` before reconcile.
- No detail → `wait detail`.
- Pending dispatch → `wait awaiting-ack`, then `dispatch-started`, then `dispatch-failed` with the error hold.
- `reconcile` removes a projected `sending` head and ends a steer on `provider.turn.steer.failed`.
- Draft branch → `send` with no thread view.
- Provider mismatch → `acknowledge`, then `send`.

**`coordinator.test.ts`** (`vi.useFakeTimers()`; real zustand queue store; threads store via `useStore.setState`)
1. **(failing-first for bug 3)** An off-screen started thread with no foreground sender drains through the background sender once the turn settles.
2. One send per thread. The next head waits until the session goes `running` on a new turn id, then sends.
3. A `provider.turn.start.failed` for the dispatched id → error hold, and the next head is not sent.
4. **(failing-first for bug 4)** A Stop hold (`store.hold(createInterruptQueueHold)`) blocks after the turn ends. `resume` sends.
5. A false ack on a server-initiated turn, followed by a start-failed activity for the dispatched id → hold.
6. A `deferred` result is retried after 250 ms. No spin: send is called twice in 300 ms.
7. `needs-review` → `review` hold and claim released (`deliveryStatus` undefined).
8. Lost reply: send rejects after `onBeforeTurnStart`, the head goes `failed`, then the message is projected → it is removed and the ack is armed, so the next head waits.
9. Ack timeout → `stalled` hold. A late `turn.started` → `stalled` cause removed and drain continues.
10. Stop and start (`retain`, release, `retain`) carries **no** stale pending ack or timers into the next run.
11. `store.reset()` during an in-flight send → the completion is ignored and no ack is armed.
12. An update that touches only an unrelated thread does not call `readEnvironment` or `resolveSender` (spies).
13. `retainThreadDetail` is called only while `mutationReady` and released when the queue empties.

**`sendEngine.test.ts`**
- `onBeforeTurnStart` is called exactly once, after `beginLocalDispatch`, immediately before `thread.turn.start`, and after the `/compact` dispatch in a compaction review.
- It is not called when review throws.

### web (`bun run --cwd apps/web test src/messageQueueDrain.test.ts src/hooks/chatSendShared.test.ts src/hooks/sendQueuedMessageInBackground.test.ts src/hooks/executeChatSendTurn.test.ts src/components/ChatView.logic.test.ts`)

**`messageQueueDrain.test.ts`**
- **Hosted:** a non-selected environment is not `mutationReady`, and `retainHostedWorkspaceThreadScope` is never called. Spy, or assert `hostedWebConnectionScopes.list()` has no entry added by the drain.
- **Direct:** a disconnected WS or a saved environment whose runtime is not connected → not ready (wait, not failed).
- The foreground stack wins over background. Unregistering falls back to background only for started server threads.
- A draft key without a foreground sender → `no-sender`.

**`sendQueuedMessageInBackground.test.ts`**
- Passes `claudeCacheReview: null` and `suppressToasts`.
- `ClaudeResumeReviewError` → `needs-review`.
- Build mode is applied.
- A handoff-requiring selection → `failed` with a thread error.
- `onBeforeTurnStart` is forwarded.
- No `toastManager.add` calls.

**`executeChatSendTurn.test.ts`**
- `claudeCacheReview: null` reaches `commitSendTurnDispatch` as `undefined`.
- `suppressToasts` skips the expired-terminal toast.
- `onSendError` sees the error.

**`chatSendShared.test.ts`**
- `persistThreadSettingsForNextTurn` dispatches only changed modes.
- `applyBuildModeToSend` matches today's ChatView behaviour.

**Browser** (`bun run --cwd apps/web test:browser src/components/ChatView.Conversation.browser.tsx`)
- `ChatView.browser.helpers.tsx`: add `useMessageQueueStore.getState().reset()` to the shared `afterEach`. The bridge's final release clears coordinator bookkeeping on unmount.
- The existing queued tests (`:230-277`, `:519-588`, `:590-680`, `:741-855`) keep their assertions. Two things may change: cleanup uses `reset()`, and where a test enqueues two items in sequence on the same `THREAD_KEY` it must emit a `turn.started` session upsert or rely on the reset. **They are no longer guaranteed unchanged.**
- **New:** "Stop holds the queue and Resume sends it". Running thread, enqueue, Stop, then the session goes `ready`: no `thread.turn.start` call; the **Resume** button is visible; clicking it sends.
- **New:** "a queued message on a thread that is not on screen sends when its turn settles". Enqueue on A, navigate to B, then emit a settled session for A: `dispatchCommand(thread.turn.start)` is called for A.
- **New:** "an error end holds the queue". Emit `session-set(status:"error", lastError)`: "Paused after an error" is shown and nothing is sent.

### mobile (`bun run --cwd apps/mobile test src/state`)

**`threadOutbox.test.ts`**
- Replace "sends deliverable messages" with **(failing-first)** "sends one message per thread per pass; the second waits for the turn-start ack".
- A hold persists across `hydrateThreadOutbox`.
- Release sends.
- An offline message composed on an errored thread sends; a failure after enqueue holds.
- Start-failed for the dispatched id holds.
- The existing remove, retry, discard, review and vanished-thread cases are re-expressed through `readThreadDrainState`.

**`use-thread-outbox-drain.test.ts`**
- The existing two-environment, cache-provenance and no-socket cases target `readThreadDrainState().environment`.
- Detail retention is only for connected, queued threads.

**`outboxSettleDrain.test.ts`**
- Updated to the new deps; settle still triggers a drain.

**`threadOutboxModel.test.ts`**
- Delete the delivery-action case; its cases move to `drain.test.ts`.

---

## 6. Edge cases and accepted residuals

- **Claude wake turn gap** (until claude-meter-wake lands). A wake turn has no projected turn before its first assistant frame, so the thread can look idle and the drain can send.
  - The decider accepts the send and the provider gets an overlapping send.
  - If the reactor rejects it with `provider.turn.start.failed`, the dispatched-id cause holds the queue. If the adapter accepts it, behaviour matches a direct send today.
  - This package does not close that gap.
- **Server-initiated turn between snapshot and acceptance.**
  - If the turn is already `running`, the decider rejects ours and the head becomes `failed` (Retry).
  - If the reactor rejects ours, a `start-failed` cause holds the queue even after a false `started` ack.
  - Residual: if the false-acked turn is still running, the next head waits for it anyway.
- **Mobile app killed between accept and turn start.** The pending ack is not persisted, so the first pass after restart may send the next head early. It is bounded to one message, and the server-side `start-failed` is still detected by the dispatched-id rule only within the same app run.
- **Spurious interrupt hold after `thread.reverted`** with a `missing` checkpoint, if the queue is non-empty and that state is new. Resume clears it; rollback-correctness may refine it.
- **Cross-device Stop.** An interrupt from another client is derived (`interrupt:<turn>`) and holds this client's queue too. This is deliberate: "Stop means stop". If `thread.turn-interrupt-requested` and `turn-diff-completed` land in one applied batch, the derived interrupt can be missed. Local Stop is always explicit.
- **Direct send while a queue is non-empty and held or failed.** The direct send is allowed, as today. The foreground sender is `deferred` while `isSendBusy` or `sendInFlightRef` is set, so the head cannot overlap the direct send.
- **Web `thread-gone`.** The queue lingers, unchanged from today, because the draft-promotion window makes "gone" unsafe to decide on web. Mobile removes it, as today.
- **Phone tier.** It shows Resume (D5). Retry stays hidden, as today.
- **Hosted node switch.** Queues on the old node wait on `environment`. The coordinator never selects a node.

---

## 7. Out of scope and follow-ups

- **Server-side durable queue** (comparison §5 "Server-side durable queue"): queue loss on reload, cross-device queue, and holds on restart. That is a separate, larger project.
- **Direct-send overlap.** The direct composer sends still use the loose UI-busy gate, so a second direct send in the bind window can still be orphaned (§1.3). The fix is to have `useLocalDispatchState` also require `resolveQueuedDispatchAck` before releasing `isSendBusy`. It is deferred because it changes composer UX in error paths.
- **Recovery for an orphaned message.** Re-offering a message that was accepted but rejected by the reactor ("Thread already has active turn") is out of scope. The hold stops the cascade.
- **t3's `validation_error` exemption.** Ryco's turn-start failures have no failure class, so every `start-failed` for a queued message holds (conservative). Revisit when reactor-errors-switch or usage-limits add classes. The provider-instance exemption is adopted (§3.A1).
- **Mobile steering race.** Mobile steering ids are screen-local, so an in-flight steer is not visible to the drain (pre-existing). Move them into the outbox with claude-steering.
- **Usage-limit `resetAt` auto-resume and snooze.** Owned by usage-limits. They add the `limit` cause and may auto-release with `removeHoldCauses`.
- **A "held" sidebar or inbox signal.** Owned by settlement-signals or a later UI pass.
- **Mobile adopting the coordinator.** Possible once the outbox and queue store are unified.

---

## 8. Overlaps (detail)

- **usage-limits (W2).** Edits `hold.ts` `deriveQueueFailureCauses` (adds a `limit` rule before `error`) and `describeQueueHold`, and may call `store.hold`, `removeHoldCauses` and `resumeMessageQueue`. Merge after this package. The hook point is exactly those functions; no other file needs to change.
- **claude-steering (W2).** Edits `message-queue/logic.ts` (steer eligibility, untouched here), ChatView `handleSteerQueuedMessage` (untouched), and the steer reconcile now in `drain.ts`, which is an append-only addition. It must not emit `thread.turn-interrupt-requested` for a steer.
- **claude-meter-wake (W1).** Semantic dependency; see §6.
- **reactor-errors-switch (W1).** Must keep `payload.messageId` (and preferably `payload.detail`) on `provider.turn.start.failed`.
- **settlement-signals (W1).** No textual overlap. Spec 08 lists `threadInbox.ts` and `threadSettlement.ts` as a possible overlap; this package does not edit them.
- **turn-finalization (W1).** Semantic; latestTurn settling. The only shared file is `threads/storeSelectors.ts` (append-only).
- **delegation-lineage (W2).** Neighbouring JSX in the ChatView composer stack around `ComposerQueuedMessages`.
- **delegation-returns (W2) / restart-continuation (W3).** Semantic: server-initiated turns and the orphan `error` status.
- **rollback-correctness (W2).** Semantic; §6.

---

## 9. Review resolution

| # | Severity | Issue | Resolution |
| --- | --- | --- | --- |
| verdict | — | Mobile "no in-flight guard" overstated | **Accepted.** `commitSendTurnDispatch` de-duplicates same-id sends (`sendEngine.ts:262-274`). §1.3 now names the real window: the next message. |
| 1 | major | The error hold is re-derived from current state, so it also holds messages composed after the failure | **Accepted.** Holds are edge-triggered: a baseline is recorded when a queue becomes non-empty (or at first evaluation), and the error key omits `updatedAt` so `stopped` and repeated `session-set` cannot re-trigger it. Tests cover the offline-composed and restart-orphan cases; the t3 `validation_error` difference is recorded in §7. |
| 2 | major | Coordinator state leaks between browser tests | **Accepted.** The final `retain()` release clears all bookkeeping. `store.reset()` is added to the browser `afterEach`, the existing tests are no longer claimed unchanged, and a stop/start test is added (coordinator #10). |
| 3 | major | Hosted retention competes for the single connection | **Accepted.** The drain never calls `retainHostedWorkspaceThreadScope`. It retains thread detail only when the environment is mutation-ready (the selected node in hosted mode), and has a test for that. |
| 4 | major | The background sender pops the Claude review modal and toasts | **Accepted.** The background sender passes `claudeCacheReview: null` and `suppressToasts`. `ClaudeResumeReviewError` → `needs-review` → a `review` hold, resolved through the foreground Resume. |
| 5 | major | The ack gate is not tied to the message | **Accepted.** The snapshot is taken in `onBeforeTurnStart`, after compaction. A `provider.turn.start.failed` with a matching `messageId` is an immediate failure. A start failure for any dispatched id is a hold cause, which covers false acks. Tests cover both. |
| 6 | major | Off-screen drain sends into archived threads | **Accepted.** `view.archived` (thread or worktree) → `wait archived`, with resolver and view tests. |
| 7 | major | A second ack definition duplicates the existing one | **Accepted.** Both gates now live in one client-runtime module (`session/dispatchAck.ts`) and ChatView re-exports them. The UI gate's intentional looseness is documented. The direct-send overlap is a named follow-up (§7), and the same event sequence is tested against both gates. |
| 8 | minor | Resolver order needs Resume twice | **Accepted.** New causes are evaluated before `held`, the hold accumulates `causeKeys`, and release acknowledges hold keys plus current keys. Tested (Stop → error → one Resume). |
| 9 | minor | Mobile re-implements the drain sequence | **Accepted.** Mobile calls `readQueueThreadView` and `resolveQueueDrainStep`. It keeps only persistence and the loop. |
| 10 | minor | Web has no environment-connected input | **Accepted.** `mutationReady` includes per-environment WS status and the saved-environment runtime state. A disconnect means wait, not a failed head. |
| 11 | minor | Foreground busy state is stale; "not now" becomes "failed" | **Accepted.** Busy reads are live refs, the sender returns `deferred`, and the claim is released with a 250 ms retry. |
| 12 | minor | A lost reply leaves the ack gate disarmed | **Accepted.** `failedSnapshots` are kept by message id. Reconciling a projected failed id arms the ack gate. Tested (coordinator #8). |
| 13 | minor | Hold UX gaps (phone tier, Retry while held) | **Accepted.** Resume is shown on all tiers as an explicit decision (D5). `retry` releases the hold. |
| 14 | minor | Import cycle; reset with in-flight sends | **Accepted.** `store.reset()` bumps `epoch` and the coordinator observes it, so `environment.ts` imports nothing new. Completions from an older epoch are dropped. |
| 15 | minor | Missing overlap notes | **Accepted.** claude-meter-wake and settlement-signals are named in the header and in §8. |
| 16 | minor | Reconcile scan is O(queue × messages) per streaming delta | **Accepted.** A per-key identity tuple skips unchanged threads, and the projected-id `Set` is cached by ids-array identity. Tested (coordinator #12, threadView cache test). |

---

## 10. Validation (proportional; cross-package change)

```sh
bun run --cwd packages/client-runtime test src/state/message-queue src/state/session/dispatchAck.test.ts src/state/composer/sendEngine.test.ts src/state/threads/storeSelectors.test.ts
bun run --cwd apps/web test src/messageQueueDrain.test.ts src/hooks src/components/ChatView.logic.test.ts src/hostedHub/environment.test.ts
bun run --cwd apps/mobile test src/state
bun run --cwd apps/web test:browser src/components/ChatView.Conversation.browser.tsx
bun typecheck
bun lint
bun run fmt:check
```

Never run `bun test`. The full repository backstop is not required: the server is untouched and no build pipeline changes.
