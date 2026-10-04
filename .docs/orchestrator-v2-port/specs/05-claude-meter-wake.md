# 05 · claude-meter-wake: Claude compaction context meter and wake-turn start (bug 8, t3 #15055)

| Field            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id               | `claude-meter-wake`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| title            | Publish Claude's post-compaction size at the compact boundary. Open Claude's provider-initiated ("wake") turns at the CLI's turn-start signal, give turn install and completion one owner, and make every provider turn recoverable by Stop and by a first-output watchdog                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| wave             | 1 (parallel, isolated worktree). If both are ready, merge after `turn-finalization`. This is a soft dependency (§8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| verdict          | **partially-confirmed**.<br>**(a) Meter: confirmed.**<br>**(b) Wake gap: partially confirmed.** No turn exists until the wake's first root assistant snapshot. But the client queue does _not_ see the thread as idle: Ryco already maps the CLI's `status: requesting` frame to a turnless `running` session, and that frame arrives 1–4 ms after `init`. The real defects are the consequences of that turnless window (§1.2).<br>**Also confirmed:** three pre-existing races in `sendTurn` / `completeTurn` / `updateResumeCursor` (§1.3). They are fixed here because Part B depends on them                                                                                                                                                                                                    |
| size             | M. Part A is S, Part B is M                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| touched files    | `apps/server/src/provider/Layers/ClaudeAdapter.ts`<br>`apps/server/src/provider/claudeContextUsage.ts` (new)<br>`apps/server/src/provider/claudeWakeTurn.ts` (new)<br>`docs/providers/claude.md` (one paragraph)<br>`docs/providers/claude-cache.md` (one sentence)<br>**Tests:** `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`, `apps/server/src/provider/claudeContextUsage.test.ts` (new), `apps/server/src/provider/claudeWakeTurn.test.ts` (new)                                                                                                                                                                                                                                                                                                                                      |
| migrations       | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| contract changes | None. The change reuses the existing runtime events `thread.token-usage.updated` and `turn.aborted`, which ingestion already handles for every provider. Internal only: `ClaudeAdapterLiveOptions` gains `runtimeEventQueueCapacity`, default 2 048, as a test seam                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| overlaps         | **Behavioural:**<br>• `turn-finalization` (W1): empty provider turns in non-git folders.<br>• `queue-hold-drain` (W1): the outcome of a send that races a wake changes.<br>• `delegation-returns` (W2): same race outcome.<br>• `usage-limits` (W2): limit failures on provider turns.<br>**Same code in `ClaudeAdapter.ts`:**<br>• `claude-steering` (W2): `sendTurn`, `ClaudeTurnState`, `completeTurn`, `handleResultMessage`.<br>• `usage-limits` (W2): `completeTurn`, `handleResultMessage`, `handleSdkTelemetryMessage`.<br>• `rollback-correctness` (W2): `updateResumeCursor`, `ClaudeSessionContext`.<br>• `reactor-concurrency` (W3): interruption of `sendTurn`; `interruptTurn` must stay non-blocking.<br>• `restart-continuation` (W3): `startSession` context init.<br>Details in §8 |

---

## 1. Problem (verified against the code)

Line numbers refer to the current worktree. `ClaudeAdapter.ts` is 5 219 lines. The baseline
`bun run --cwd apps/server test src/provider/Layers/ClaudeAdapter.test.ts` passes 102/102.

### 1.1 (a) The context meter shows almost full right after compaction

1. **The boundary handler ignores `post_tokens`.** The `compact_boundary` case is at `ClaudeAdapter.ts:3465-3480`. It does three things:
   - settles the compaction policy
   - sets `context.lastKnownTokenUsage = undefined` (`:3470`) and `context.cacheObservation = undefined` (`:3471`)
   - emits `thread.state.changed {state: "compacted"}`

   It never reads `compact_metadata.post_tokens`. The SDK declares that field as optional `number` (`sdk.d.ts:3430-3437`, SDK 0.3.263).

2. **The result falls back to cumulative usage.** In `completeTurn` (`:2215-2410`), `lastGoodUsage = context.lastKnownTokenUsage` (`:2252`). When that value is undefined, `rawUsageSnapshot` becomes `accumulatedSnapshot` (`:2253-2267`). That snapshot is the cumulative `result.usage` (`:2246-2249`), clamped to the window by `normalizeClaudeTokenUsage` (`:538-543`).
3. **Effect on `/compact`.** A `/compact` turn has no root assistant frame after the boundary. Its result therefore publishes the compaction call's cumulative input. That is roughly the pre-compaction size, clamped to the window, so the meter shows almost full right after compacting. The same bogus value also reaches `maybeEnableAutomaticCompaction` (`:2408-2409`).
4. **A second path overwrites the gauge after a boundary.** Legacy task telemetry is gated on `!context.cacheObservation`:
   - `task_progress` at `:3632-3664`
   - `task_notification` at `:3764-3790`

   The boundary clears `cacheObservation`, so this path is enabled again. A task frame with `usage` for a task that has no recorded `toolUseId` then overwrites the gauge with task totals. One example is a task first seen after a CLI restart.

5. **How the meter reads the value.** Ingestion upserts one activity per thread, `claude-context-usage:<threadId>` (`ProviderRuntimeIngestion.ts:1018-1037`). `deriveLatestContextWindowSnapshot` (`apps/web/src/lib/contextWindow.ts:76`) renders its `usedTokens`.
6. **Test gap.** The existing `/compact` attribution tests (`ClaudeAdapter.test.ts:5158-5231`) never assert usage.

t3 reference: `ClaudeAdapterV2.ts:5567-5600` publishes `round(post_tokens)` at the boundary. Its gauge only ever comes from root assistant `message.usage`, never from cumulative usage.

### 1.2 (b) Wake turns: what is true, and what is not

**Code facts:**

1. **Where turns are created.** Only two places create a turn:
   - `sendTurn` (`:4852-4990`)
   - `handleAssistantMessage` (`:3047-3091`), on the first _root_ assistant snapshot, after the subagent early return (`:2945-3008`)

   `system/init` only emits `session.configured` (`:3428-3436`).

2. **Stream handlers need a turn.** These all require `context.turnState`:
   - text and thinking deltas (`:2470-2474`)
   - thinking `content_block_start` (`:2638`)
   - `ensureAssistantTextBlock` (`:1849-1851`)

   So the first content block of a wake turn, usually the thinking block, is dropped. Text is backfilled from the snapshot but does not stream.

3. **`system/status` already marks the session running.** Ryco maps `system/status` (`:3437-3464`) to `session.state.changed {state: "running", reason: "status:<status>"}`. While idle, this event carries no `turnId`. Ingestion then projects `status: running, activeTurnId: null` (`ProviderRuntimeIngestion.ts:2437-2441`, `orchestrationSessionStatusFromRuntimeState` `:425-443`).

**Real CLI evidence.** Aggregated from local native and canonical provider logs, Claude Code 2.1.280–2.1.288:

- **Every `init` is followed at once by `status` or `result`.** Of 136 `init` frames, 133 were followed by `status` and 3 by `result`.
  - A user turn runs `command_lifecycle started → init → status requesting`.
  - A wake runs `task_notification → init` (20–60 ms later) `→ status requesting` (1–4 ms) `→ stream_event message_start` (about 1 s) `→ …`. The first root assistant snapshot comes 1.5–34 s after `init`.
- **`status` frames are always root and always inside a turn.** There were 3 352 `status: requesting` frames. None arrived while idle without a preceding `init`, and none carried `parent_tool_use_id`.
- **Time to the next root output is short, except during compaction.** "Next root output" means a root stream_event, assistant, user, result, `api_retry` or `compact_boundary`. After a `status: requesting` frame it came at p50 1.5 s, p99 6.9 s, and at most 34 s outside compaction. During compaction, `status: compacting` repeats every 30 s.
- **Outcomes of the 53 `init` frames that arrived while Ryco had no turn:**

  | Count | Sequence                                                                                               | Note                                                               |
  | ----- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
  | 49    | `requesting` → assistant                                                                               | normal wake                                                        |
  | 2     | `result success num_turns: 0`, no `requesting`                                                         | empty notification turns                                           |
  | 1     | `requesting` → `result error_during_execution` (`origin.kind: "task-notification"`), no root assistant | Ryco emitted a turnless `runtime.error` and **no lifecycle event** |
  | 1     | `requesting` → `message_start` → silence                                                               |                                                                    |

- **The canonical log of a wake.** `session.configured` and `session.state.changed {running, status:requesting}` appear at `init`+1 ms with no `turnId`. `turn.started` follows 2.9 s later, together with the first snapshot.

**What this means:**

- **The t3 symptom is mostly absent in Ryco.** Once the status frame is projected, the client sees a working thread:
  - `derivePhase` (`session-logic.ts:2306-2311`) returns `running`.
  - The ChatView queue drain (`ChatView.tsx:3940-3953`, `isWorking` at `:1705`) holds.
  - The sidebar shows working (`threadActivityStatus.ts:30`).

  The window in which a queued send can slip through is only init→status, 1–4 ms. The 20–60 ms between notification and `init` is a window no signal can close.

- **But the session has no turn for 1.5–34 s.** Four defects follow from that:
  1. **Sends are accepted into the wake.** The decider invariant (`decider.ts:999-1006`) and the reactor guard (`ProviderCommandReactor.ts:1129-1140`) only block while `activeTurnId` is set. A turn start from the server side is therefore accepted. Examples are an Agent Control return, another client, or a send that races the projection. The CLI queues that prompt behind the wake, and the wake's output streams into the user's turn.
  2. **A wake that ends without a root snapshot leaves the session stuck.** There is no turn to complete: the turnless branch of `completeTurn` (`:2279-2306`) only logs and publishes usage. Nothing resets the turnless `running` state, so the session stays running until the next turn or until it is reaped, and the client queue stays blocked. This was observed once (table above).
  3. **Stop cannot finish anything.** The reactor interrupts by session (`ProviderCommandReactor.ts:1432-1435`). `interruptTurn` (`:4992-5052`) only calls `query.interrupt()` and never finishes anything locally.
  4. **The wake's first reasoning block never reaches the work log**, and its first text block does not stream (fact 2).
- **t3 reference.** t3 5bf19d1 treats root `init` as the start of a wake and requires no notification first (`ClaudeAdapterV2.ts:1745`, `:5105-5190`, `:7152-7160`).
- **`session_state_changed` is not available in practice.** The SDK calls `system/session_state_changed` the "authoritative turn-over signal" (`sdk.d.ts:5103-5110`). It is opt-in through `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`, which appears in `sdk.mjs`'s env table. Neither Ryco nor t3 sets that variable, so it is not available today (§9).

### 1.3 Pre-existing races (confirmed, fixed here)

1. **`sendTurn` orphans a provider turn.**
   - `sendTurn` closes a stale turn only at its top (`:4859-4863`).
   - It then awaits `setModel` / `setPermissionMode` (`:4864-4905`), and only after that overwrites `context.turnState` (`:4923-4930`).
   - If a wake's first root assistant frame is processed during those awaits, it opens S (`:3049`).
   - S is then overwritten and never receives `turn.completed`. Ingestion rejects `turn.started(U)` as conflicting (`ProviderRuntimeIngestion.ts:2351`, `:2391-2396`), and also rejects U's completion. The thread stays running on S.

   This is reachable today through the assistant-frame path alone.

2. **`completeTurn` can close the same turn twice.**
   - It reads `context.turnState` only after several yields (`:2219-2279`) and clears it unconditionally at the end (`:2397-2405`).
   - Every emit can suspend on `Queue.bounded(2_048)` (`:1595`, `:1647`).
   - So when a `sendTurn` close races the stream fiber's result close, S gets two `turn.completed` events, and the later finisher wipes U's `turnState` and session.
3. **`updateResumeCursor` can write back a stale session.** At `:1834-1838` it spreads `context.session` and then yields (`nowIso`) _inside_ the object literal. A concurrent install's `status` / `activeTurnId` is then overwritten with the stale copy.

---

## 2. Approach

### Part A: the meter

- **Publish the boundary value.** At `compact_boundary`, replace the gauge with `post_tokens` and publish it at once. Use `round(post_tokens)`, clamp it to the known window, and leave out `claudeCache`, because compaction invalidated that evidence.
- **Never use the cumulative total of a turn that crossed a boundary.** A `result` whose turn crossed a compaction boundary must not use its cumulative `result.usage` as the gauge. That result may still report the cumulative figure as `totalProcessedTokens`.
- **Gate legacy task telemetry on a sticky flag.** Use `mainLoopUsageObserved`, which a boundary never clears. Today's gate is `cacheObservation`, which the boundary does clear.

### Part B: wake turns

**1. Trigger.** A root `system/status` frame with `status` `requesting` or `compacting` opens a provider turn ("wake-signal") if no turn is open. Root `system/init` opens one only on CLIs that have never been seen to emit `status: requesting` in this session. That is the legacy fallback, and it matches t3.

Why `status` rather than t3's `init`:

- `status: requesting` arrives 1–4 ms after `init`, so it is effectively as early.
- It is the exact frame that today makes the session turnlessly `running`, so the turnless window disappears instead of moving.
- It is emitted only when the CLI is about to call the model. Empty notification turns (`init → result num_turns: 0`, 2 of 53 above) therefore never open a turn. Without this, each would trigger a desktop "finished responding" notification, a checkpoint capture and an empty work-log entry.

**2. Gate (deny list, pure).** A wake signal opens nothing when any of these hold:

- a turn is open
- the session is stopped
- no prompt turn was ever installed on this runtime (resume or startup handshake)
- a `sendTurn` is between entry and install

There is no allow list and no requirement for a notification first. Cron, `ScheduleWakeup`, Monitor, rate-limit and lost-notification wakes are all covered, as in t3.

**3. One owner for install and completion.**

- `makeClaudeTurnState(...)` is the only turn-state constructor.
- `completeTurn` claims the turn synchronously at entry. A concurrent close waits on the claim's `Deferred` instead of emitting a second lifecycle event. The claimer clears `context.turnState` / `session` only if it still owns them.
- `sendTurn` counts itself in `turnInstallsInFlight` through `Effect.acquireUseRelease`. After its awaits it loops `while (context.turnState) completeTurn(...)` and then installs synchronously, with no yield between the last check and the install.
- `updateResumeCursor` computes its timestamp before spreading `context.session`.

**4. Recovery for every provider turn.** A provider turn is any turn with `openedBy !== "prompt"`.

- **Stop grace.** `interruptTurn` forks a 5 s grace check, so the reactor is not blocked. If the same provider turn is still open after the grace and the CLI never reported a result, the adapter finishes it locally as `interrupted`.
- **First-output watchdog.** A wake-signal turn that has produced no root output 120 s after opening is ended with `turn.aborted`. "Root output" means a stream_event, assistant, user, result, `api_retry`, `compact_boundary` or `status: compacting` frame. The watchdog uses `turn.aborted` rather than `turn.completed` so that ingestion settles `latestTurn` through `thread.turn.interrupt`, with no dependency on bug 5 and no checkpoint capture.
- **Why 120 s.** The maximum observed time from `requesting` to the first root output outside compaction is 34 s, and compaction sends a heartbeat every 30 s.

**5. Unchanged.**

- The assistant-frame fallback (`openedBy: "assistant-output"`) still opens a turn when no signal did.
- Result correlation by `promptUuid` (`:3138-3159`) is unchanged.
- Provider turns are **never** bound to Agent Control authority: no `bindTurn`, exactly as today's synthetic turns. Exact-turn binding stays user-prompt-only.

---

## 3. Step-by-step changes

### 3.1 `apps/server/src/provider/claudeContextUsage.ts` (new, pure)

```ts
import type { ThreadTokenUsageSnapshot } from "@ryco/contracts";

/** `compact_boundary.compact_metadata.post_tokens` as a context gauge; undefined when absent or invalid. */
export function claudePostCompactionUsage(
  compactMetadata: unknown,
  contextWindow: number | undefined,
): ThreadTokenUsageSnapshot | undefined;

/** The gauge a Claude result publishes (the logic of ClaudeAdapter.ts:2252-2267, plus one rule). */
export function selectClaudeResultUsageGauge(input: {
  readonly lastGauge: ThreadTokenUsageSnapshot | undefined;
  readonly cumulative: ThreadTokenUsageSnapshot | undefined; // normalizeClaudeTokenUsage(result.usage)
  readonly maxTokens: number | undefined;
  readonly cumulativeIsGauge: boolean; // false when the result's turn spans a compaction boundary
}): ThreadTokenUsageSnapshot | undefined;
```

**`claudePostCompactionUsage`:**

- Reads `post_tokens` from the metadata object.
- Returns `undefined` unless the value is a finite number and `Math.round(post) > 0`.
- The window counts only when it is a safe integer > 0.
- `usedTokens = maxTokens ? min(rounded, maxTokens) : rounded`.
- Returns `{ usedTokens, ...(maxTokens ? { maxTokens } : {}) }`, with no `claudeCache`.

**`selectClaudeResultUsageGauge`:**

- With `lastGauge`, it returns exactly today's merge: the gauge, plus `maxTokens` when valid, plus `totalProcessedTokens` when the cumulative total is greater than `lastGauge.usedTokens`.
- Without `lastGauge`, it returns `cumulativeIsGauge ? cumulative : undefined`.

### 3.2 `apps/server/src/provider/claudeWakeTurn.ts` (new, pure, type-only SDK import)

```ts
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeWakeSignal = "status" | "init";
/** Root system/status (requesting|compacting) → "status"; root system/init → "init"; else undefined.
 *  A frame with a non-null parent_tool_use_id is never a signal. */
export function claudeWakeSignal(message: SDKMessage): ClaudeWakeSignal | undefined;

export interface ClaudeWakeTurnGate {
  readonly signal: ClaudeWakeSignal;
  readonly hasOpenTurn: boolean;
  readonly sessionStopped: boolean;
  readonly promptSent: boolean;
  readonly turnInstallsInFlight: number;
  readonly requestingStatusObserved: boolean;
}
/** Deny-list gate; "init" opens only when the CLI was never seen to emit `status: requesting`. */
export function shouldOpenClaudeWakeTurn(gate: ClaudeWakeTurnGate): boolean;

/** Root frames that prove Claude is producing the current turn (watchdog liveness). */
export function isClaudeRootTurnOutput(message: SDKMessage): boolean;

export const CLAUDE_WAKE_TURN_FIRST_OUTPUT_TIMEOUT_MS = 120_000;
export const CLAUDE_PROVIDER_TURN_STOP_GRACE_MS = 5_000;
```

**`isClaudeRootTurnOutput`** returns true for:

- `stream_event` / `assistant` / `user` with a null or absent `parent_tool_use_id`
- `result`
- system `compact_boundary`
- system `api_retry`
- system `status` with `status === "compacting"`

Everything else returns false. That includes `init`, `status: requesting`, `task_*`, `background_tasks_changed`, `rate_limit_event`, and any subagent frame. Use a positive list so that a future periodic background frame cannot keep a phantom turn alive.

### 3.3 `apps/server/src/provider/Layers/ClaudeAdapter.ts`

**Types and constructor.**

1. Add `type ClaudeTurnOpener = "prompt" | "wake-signal" | "assistant-output"`.
2. Extend `ClaudeTurnState` (`:159-172`) with three fields:
   - `readonly openedBy: ClaudeTurnOpener`
   - `rootOutputObserved: boolean`
   - `completion: Deferred.Deferred<void> | undefined`
3. Add the module function `makeClaudeTurnState({ turnId, startedAt, openedBy, promptUuid? })`. It returns the full literal currently duplicated at `:3054-3065` and `:4911-4922`, with `rootOutputObserved: openedBy !== "wake-signal"` and `completion: undefined`. Both existing literals are deleted. `claude-steering` must use this constructor too.
4. Extend `ClaudeSessionContext` (`:234-321`) and initialise the new fields in the `startSession` literal (`:4746-4785`):
   - `promptSent: false`: a prompt turn was installed on this runtime
   - `turnInstallsInFlight: 0`
   - `requestingStatusObserved: false`
   - `mainLoopUsageObserved: false` (Part A)
   - `cumulativeUsageSpansCompaction: false` (Part A)
5. Add `ClaudeAdapterLiveOptions.runtimeEventQueueCapacity?: number` (`:340-351`). Use it in `Queue.bounded(options?.runtimeEventQueueCapacity ?? 2_048)` (`:1595`).

**Part A.**

6. `compact_boundary` (`:3465-3480`):

```ts
case "compact_boundary": {
  context.compactionPolicy = settleContextCompaction(context.compactionPolicy, context.generation);
  const postCompactionUsage = claudePostCompactionUsage(
    message.compact_metadata,
    context.lastKnownContextWindow,
  );
  // The pre-compaction gauge is gone either way; post_tokens is its only honest replacement.
  context.lastKnownTokenUsage = postCompactionUsage;
  context.cacheObservation = undefined;
  context.cumulativeUsageSpansCompaction = true;
  yield* offerRuntimeEventForContext(context, { ...base, type: "thread.state.changed", payload: { state: "compacted", detail: message } });
  if (postCompactionUsage) {
    const usageStamp = yield* makeEventStamp();
    yield* offerRuntimeEventForContext(context, {
      ...base,
      eventId: usageStamp.eventId,
      createdAt: usageStamp.createdAt,
      type: "thread.token-usage.updated",
      payload: {
        usage: withAutomaticCompactionCapability(postCompactionUsage, context.supportsAutomaticCompaction),
      },
    });
  }
  return;
}
```

7. **`handleAssistantMessage`.** In the root path, after `observeClaudeCache` (`:3012-3022`), add `if (context.cacheObservation) context.mainLoopUsageObserved = true;`.
8. **Legacy telemetry gates.** At `:3635` and `:3766`, replace `!context.cacheObservation` with `!context.mainLoopUsageObserved`. Before any boundary the two conditions are equivalent, because `observeClaudeCache` returns `previous` for invalid usage. After a boundary, only the new flag keeps the legacy path off.
9. **Usage in `completeTurn`.** Extract the usage block (`:2221-2277`) into `resolveResultUsageSnapshot(context, result)`:
   - It keeps today's `cacheObservation.mainLoopTotals` update and `lastKnownContextWindow` update.
   - It computes `rawUsageSnapshot` with `selectClaudeResultUsageGauge({ lastGauge: context.lastKnownTokenUsage, cumulative: accumulatedSnapshot, maxTokens, cumulativeIsGauge: !context.cumulativeUsageSpansCompaction })`.
   - It then sets `if (result !== undefined) context.cumulativeUsageSpansCompaction = false`. Only a real result consumes the flag. A local close with no result must not re-enable the fallback for the CLI's late result.

**Part B: ownership.**

10. **`completeTurn` claims the turn.** Restructure `completeTurn` (`:2215-2410`) into a claim step plus the existing body. Keep the signature and add one optional `options` parameter:

```ts
const completeTurn = Effect.fn("completeTurn")(function* (
  context: ClaudeSessionContext,
  status: ProviderRuntimeTurnStatus,
  errorMessage?: string,
  result?: SDKResultMessage,
  options?: { readonly abortReason?: string },
) {
  // Must stay the first statement: the claim is only atomic before any yield.
  const turnState = context.turnState;
  if (turnState?.completion !== undefined) {
    // Another fiber is finishing this turn; never emit a second lifecycle event.
    yield* Deferred.await(turnState.completion);
    return;
  }
  if (turnState === undefined) {
    return yield* publishTurnlessResult(context, status, errorMessage, result); // today's :2280-2306
  }
  const completion = Deferred.makeUnsafe<void>();
  turnState.completion = completion;
  yield* finishClaimedTurn(
    context,
    turnState,
    completion,
    status,
    errorMessage,
    result,
    options,
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        // Failed or interrupted before the turn was detached: release the claim so a later close can retry.
        if (context.turnState === turnState) turnState.completion = undefined;
        Deferred.doneUnsafe(completion, Effect.void);
      }),
    ),
  );
});
```

`finishClaimedTurn` is today's body from `:2308` onward, with three changes:

- It calls `resolveResultUsageSnapshot` first.
- It emits `turn.aborted { reason: options.abortReason }` instead of `turn.completed` when `options?.abortReason` is set.
- It ends like this:

```ts
const updatedAt = yield * nowIso;
if (context.turnState === turnState) {
  context.turnState = undefined;
  context.session = {
    ...context.session,
    status: "ready",
    activeTurnId: undefined,
    updatedAt,
    ...lastError,
  };
}
Deferred.doneUnsafe(completion, Effect.void); // release waiters before the tail effects
// unchanged tail: retireTurn, updateResumeCursor, maybeEnableAutomaticCompaction (completed only)
```

A waiter that brings its own `result` drops that result's usage. That is acceptable: it only happens when a local close already finished the turn. The waiter logs `claude.turn.result-during-completion`.

11. **`updateResumeCursor`** (`:1821-1839`): `const updatedAt = yield* nowIso;` comes first, then the synchronous `context.session = { ...context.session, resumeCursor, updatedAt }`.
12. **`sendTurn`** (`:4852-4990`):

```ts
const sendTurn = Effect.fn("sendTurn")(function* (input) {
  const context = yield* requireSession(input.threadId);
  return yield* Effect.acquireUseRelease(
    Effect.sync(() => {
      context.turnInstallsInFlight += 1;
    }),
    () => sendTurnOnContext(context, input),
    () =>
      Effect.sync(() => {
        context.turnInstallsInFlight -= 1;
      }),
  );
});
```

`sendTurnOnContext` is the current body with four changes:

- **Delete the top-of-function close** (`:4859-4863`).
- **Keep the model and permission handling unchanged.**
- **Compute ids and time first.** Compute `promptUuid`, `turnId` and `startedAt` before the loop.
- **Close and install as one step:**

```ts
// Closes a stale provider turn, one opened while the awaits above yielded, or waits for an
// in-flight completion. Re-checks until no turn is open.
while (context.turnState !== undefined) {
  yield * completeTurn(context, "completed");
}
// No yield between the last check and the install.
const turnState = makeClaudeTurnState({ turnId, promptUuid, startedAt, openedBy: "prompt" });
context.turnState = turnState;
context.session = {
  ...context.session,
  status: "running",
  activeTurnId: turnId,
  updatedAt: startedAt,
};
context.promptSent = true;
```

The rest is unchanged: `turn.started`, host-context prefix, prompt offer, and `bindTurn` (prompt turns only).

**Part B: opening provider turns.**

13. **One opener: `startProviderTurn(context, openedBy: "wake-signal" | "assistant-output")`.** It replaces the inline block at `:3047-3091`:

```ts
const turnId = TurnId.make(yield * Effect.sync(() => crypto.randomUUID()));
const startedAt = yield * nowIso;
// Synchronous from here to the install: re-check after the yields above.
if (context.turnState !== undefined || context.stopped) return;
if (openedBy === "wake-signal" && (context.turnInstallsInFlight > 0 || !context.promptSent)) return;
const turnState = makeClaudeTurnState({ turnId, startedAt, openedBy });
context.turnState = turnState;
context.session = {
  ...context.session,
  status: "running",
  activeTurnId: turnId,
  updatedAt: startedAt,
};
// offer turn.started exactly as today (:3071-3090);
// raw.method stays "claude/synthetic-turn-start", raw.payload becomes { openedBy }.
if (openedBy === "wake-signal") {
  yield *
    Effect.sleep(Duration.millis(CLAUDE_WAKE_TURN_FIRST_OUTPUT_TIMEOUT_MS)).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          context.turnState === turnState && !turnState.rootOutputObserved && !context.stopped
            ? completeTurn(context, "interrupted", WAKE_NO_OUTPUT_REASON, undefined, {
                abortReason: WAKE_NO_OUTPUT_REASON,
              })
            : Effect.void,
        ),
      ),
      Effect.ignoreCause({ log: true }),
      Effect.forkDetach,
    );
}
```

- `WAKE_NO_OUTPUT_REASON` is `"Claude started a background turn but produced no output."`.
- `handleAssistantMessage` becomes `if (!context.turnState) yield* startProviderTurn(context, "assistant-output");`. This fallback has no gate, because the dropped-delta problem must never come back. Update the comment at `:3047-3048`, and the comment in the turnless branch (`:2295-2298`), to mention wake signals.
- Do **not** call `context.agentControl.bindTurn` here.

14. **`handleSystemMessage`** (`:3235`). Insert this _before_ `const stamp` / `const base` (`:3243-3256`), so that the `session.state.changed` / `session.configured` of the triggering frame carry the new `turnId`:

```ts
if (message.subtype === "status" && message.status === "requesting") {
  context.requestingStatusObserved = true;
}
const wakeSignal = claudeWakeSignal(message);
if (
  wakeSignal !== undefined &&
  shouldOpenClaudeWakeTurn({
    signal: wakeSignal,
    hasOpenTurn: context.turnState !== undefined,
    sessionStopped: context.stopped,
    promptSent: context.promptSent,
    turnInstallsInFlight: context.turnInstallsInFlight,
    requestingStatusObserved: context.requestingStatusObserved,
  })
) {
  yield * startProviderTurn(context, "wake-signal");
}
```

15. **`handleSdkMessage`** (`:3956-3993`). Move the `switch` into `routeSdkMessage(context, message)`. After it returns, mark liveness:

```ts
const open = context.turnState;
if (open && !open.rootOutputObserved && isClaudeRootTurnOutput(message)) {
  open.rootOutputObserved = true;
}
```

Marking after routing means a turn opened by `status: compacting` is marked by its own trigger.

**Part B: Stop.**

16. **`interruptTurn`** (`:4992-5052`). Capture `const target = context.turnState` at entry. After `query.interrupt()` resolves, fork the grace check only when all of these hold:
    - `target` exists
    - `target.openedBy !== "prompt"`
    - `turnId === undefined || target.turnId === turnId`. The reactor passes no turn id (`ProviderCommandReactor.ts:1432-1435`).

```ts
yield *
  Effect.sleep(Duration.millis(CLAUDE_PROVIDER_TURN_STOP_GRACE_MS)).pipe(
    Effect.andThen(
      Effect.suspend(() =>
        context.turnState === target && !context.stopped
          ? completeTurn(
              context,
              "interrupted",
              "Claude did not end the background turn after Stop.",
            )
          : Effect.void,
      ),
    ),
    Effect.ignoreCause({ log: true }),
    Effect.forkDetach,
  );
```

`interruptTurn` must not wait for the grace (bug 13 / `reactor-concurrency`). Log `claude.turn.provider-turn-finalized-after-stop` when the grace actually completes the turn.

### 3.4 Docs

- **`docs/providers/claude.md`.** Add a short "Background wake turns" paragraph:
  - Claude may start turns without a prompt, for example when background work finishes. Ryco shows them as working from the moment Claude starts the request.
  - Stop ends them.
  - A wake that produces no output is ended after two minutes.
- **`docs/providers/claude-cache.md`.** Add one sentence: after a compaction boundary, the context meter shows the post-compaction size reported by Claude, without cache evidence, until the next main-loop request reports usage.

---

## 4. Contract and migration changes

- **No schema, contract or migration change.** `thread.token-usage.updated` and `turn.aborted` already exist (`packages/contracts/src/providerRuntime.ts:338-356`, `:404-407`).
- **`turn.aborted` from Claude is new on the wire, but ingestion already handles it for every provider:**
  - it sets the session to ready
  - it dispatches `thread.turn.interrupt` for the turn (`ProviderRuntimeIngestion.ts:2398`, `:2426-2530`)
  - it closes reasoning (`:2203`)
  - it sends a `completionReturns` terminal of `interrupted` (`:3084-3110`)

  `CheckpointReactor` ignores it, which is correct because the turn produced no output.

- **Internal only:** `ClaudeAdapterLiveOptions.runtimeEventQueueCapacity`.

---

## 5. Tests

Conventions:

- Use `@effect/vitest` `it.effect`. Use TestClock (`import { TestClock } from "effect/testing"`) for the watchdog and the grace.
- Stream fixtures must carry `parent_tool_use_id: null`. Otherwise they are dropped as subagent narration (`:2430-2468`).
- Status fixture: `{ type: "system", subtype: "status", status: "requesting", uuid, session_id }`.
- Extend `FakeClaudeQuery` with an optional `permissionModeGate: Promise<void>`. `setPermissionMode` awaits it before recording.
- Extend `makeHarness` with `runtimeEventQueueCapacity`.

### Unit tests: `claudeContextUsage.test.ts` (new)

- **`claudePostCompactionUsage`:**
  - missing or `null` metadata, missing `post_tokens`, `0`, `-1`, `NaN`, `Infinity` and `"42000"` all return `undefined`
  - `0.4` returns `undefined`
  - `41_999.6` returns `{ usedTokens: 42_000, maxTokens: 200_000 }`
  - `250_000` with window `200_000` is clamped to `200_000`
  - an unknown or invalid window (`undefined`, `0`, `1.5`, `NaN`) leaves out `maxTokens`
- **`selectClaudeResultUsageGauge`:**
  - a gauge is merged with a valid `maxTokens` only
  - `totalProcessedTokens` is set only when the cumulative total is greater than the gauge
  - with no gauge and `cumulativeIsGauge: true` it returns the cumulative snapshot
  - with no gauge and `cumulativeIsGauge: false` it returns `undefined`

### Unit tests: `claudeWakeTurn.test.ts` (new)

- **`claudeWakeSignal`:**
  - `status` `requesting` and `compacting` return `"status"`
  - `status: null` (with `compact_result`) returns `undefined`
  - `init` returns `"init"`
  - a `status` frame with `parent_tool_use_id: "x"` returns `undefined`
  - `task_notification`, `assistant` and `result` return `undefined`
- **`shouldOpenClaudeWakeTurn`:** full truth table. Each deny condition alone blocks. `init` opens only when `requestingStatusObserved` is false. `status` opens regardless.
- **`isClaudeRootTurnOutput`:**
  - root and subagent stream_event / assistant / user frames (root true, subagent false)
  - `result` true
  - `compact_boundary` and `api_retry` true
  - `status` `compacting` true, `requesting` false
  - `init`, `task_notification`, `background_tasks_changed` and `rate_limit_event` false

### Adapter tests, Part A (`ClaudeAdapter.test.ts`)

Fixtures: use one model id, for example `claude-sonnet-4-6`, in both the assistant `message.model` and the `modelUsage` key. `mainClaudeContextWindowFromModelUsage` (`:485-498`) keys on it.

- **A1 (fails today): `/compact` publishes `post_tokens` at the boundary and never the cumulative total.**
  1. Prompt turn. A root assistant reports usage `{input 12, cache_read 160_000, cache_creation 8_000, output 1}`. The result has `modelUsage` window `200_000`.
  2. `sendTurn("/compact")`, then `status compacting`, then `compact_boundary {manual, pre 168_012, post 41_999.6}`.
  3. Assert a `thread.token-usage.updated` with the compact turn's `turnId` and `usage` `{ usedTokens: 42_000, maxTokens: 200_000 }`, with no `claudeCache`.
  4. Emit the result. It is a success, `user_message_uuids: [turn.turnId]`, usage `{input 3, cache_read 168_000, output 4_000}`, window 200 000.
  5. Assert that the last usage event before `turn.completed` has `usedTokens: 42_000` and `totalProcessedTokens: 172_003`. Also assert that no usage event after the boundary has `usedTokens >= 168_000`.
- **A2 (fails today): a boundary without `post_tokens`.** Same as A1, but the metadata is `{manual, pre}`. Assert that no `thread.token-usage.updated` is emitted after the boundary.
- **A3 (guard): auto-compaction mid-turn.** Boundary with post 42 000, then a root assistant frame with usage 47 000. The final gauge is 47 000.
- **A4 (fails today): legacy telemetry stays off after a boundary.**
  1. A modern session, meaning a root assistant usage was seen.
  2. A boundary with post 42 000.
  3. A `task_notification` with `usage: { total_tokens: 150_000 }` for a task id that was never started.
  4. Assert there is no usage event with 150 000, and the result's gauge is 42 000.
- **A5 (fails today): a boundary while no turn is open.**
  1. After a completed turn, emit a boundary with post 42 000. Assert a usage event without `turnId`, with `usedTokens: 42_000`.
  2. Then emit a turnless `result` with cumulative usage 190 000. Assert its usage event has `usedTokens: 42_000`.

### Adapter tests, Part B (`ClaudeAdapter.test.ts`)

- **B1 (fails today): a wake turn opens at the idle `status: requesting`, before any output.**
  1. Run a prompt turn: `init` → `status requesting` → root assistant → `result` → `turn.completed(U)`.
  2. While idle, emit `task_notification` and then `init`. Assert there is no `turn.started` yet.
  3. Emit `status requesting`. Assert:
     - `turn.started(S)` with `raw.payload.openedBy === "wake-signal"`
     - the `session.state.changed` with `reason "status:requesting"` carries `turnId S` and comes _after_ `turn.started(S)`
     - `listSessions()[0].activeTurnId === S`
  4. Emit root `stream_event` frames: `message_start`, `content_block_start` (thinking, index 0) and `thinking_delta`.
  5. Assert `item.started` (reasoning) and `content.delta` with `turnId S` _before_ any assistant snapshot.
  6. Emit the root assistant snapshot and then `result {origin: {kind: "task-notification"}}`.
  7. Assert exactly one `turn.started` and one `turn.completed` for S, and `activeTurnId` undefined afterwards.
- **B2 (guards):**
  - **(i) No prompt sent yet.** In a resumed session, before the first `sendTurn`, `init` + `status requesting` → no `turn.started`. The existing resume test (`:3629-3750`) must still pass unchanged.
  - **(ii) Empty notification turn.** After a prompt turn that emitted `requesting`, emit idle `init` → `result success num_turns 0 origin task-notification`. Assert no `turn.started` / `turn.completed`; the existing turnless path applies.
  - **(iii) Install in flight.** Call `sendTurn({ interactionMode: "default" })` with `permissionModeGate` pending. While gated, emit idle `status requesting`. Release the gate. Assert exactly one `turn.started`, and it is U.
  - **(iv, fails today) Legacy fallback.** In a session whose prompt turn never emitted a `status` frame, an idle `init` opens the provider turn (`openedBy: "wake-signal"`). Contrast: in a session that did observe `requesting`, an idle `init` alone opens nothing.
- **B3 (new): first-output watchdog.**
  - **Main case.** S is opened by `status requesting` and there is no further frame.
    - After `TestClock.adjust("119 seconds")`: no lifecycle event.
    - After `adjust("1 second")`: `turn.aborted(S)` with the reason. Session ready, `activeTurnId` undefined. No `turn.completed(S)`.
  - **Variant: `status: compacting`** inside the window, then 130 s → no abort. A later result completes S normally.
  - **Variant: a root `message_start`** → no abort.
- **B4 (new): Stop on a provider turn.**
  - **Main case.**
    - S is open. `adapter.interruptTurn(THREAD_ID)` returns without advancing the clock (it does not block), and `interruptCalls.length === 1`.
    - No CLI result arrives.
    - After `adjust("5 seconds")`: `turn.completed(S, "interrupted")`.
  - **Variant: the CLI reports a result in time.** The CLI emits `result error_during_execution` within the grace. Exactly one `turn.completed(S)`, and nothing more after `adjust("5 seconds")`.
  - **Variant: a prompt turn.** A Stop on a prompt turn schedules no grace: no local completion after 5 s.
- **B5 (fails today, pre-existing): `sendTurn` must not orphan a provider turn opened during its awaits.**
  1. `permissionModeGate` is pending; call `sendTurn({ interactionMode: "default" })`.
  2. While gated, emit a root assistant frame, which opens S via `assistant-output`.
  3. Release the gate.
  4. Assert `turn.completed(S)` comes before `turn.started(U)`.
  5. U's result yields `turn.completed(U)`.
  6. Every `turn.started` has exactly one terminal event.
- **B6 (fails today, pre-existing): `completeTurn` must never close a turn twice.**

  Setup:
  - Use `runtimeEventQueueCapacity: 1` and a gated consumer: it collects into a test queue and blocks on a `Deferred` gate before taking the next event.
  - Open S (assistant-output) with two root `tool_use` `content_block_start` frames left in flight. Those force three or more emits in `completeTurn`: two `item.completed`, usage and `turn.completed`.

  Steps:
  1. Close the gate.
  2. Emit S's result (`origin task-notification`, with usage). The stream fiber is now suspended inside `completeTurn(S)`.
  3. Fork `sendTurn(U)`.
  4. Open the gate.
  5. Emit U's result.

  Assert:
  - exactly one `turn.completed` with `turnId S`
  - `turn.started(U)` follows it
  - `turn.completed(U)` is emitted
  - `listSessions()[0].activeTurnId` is undefined at the end

  Today this deterministically emits two `turn.completed(S)`.

- **B7 (guard, Agent Control).** Extend the bridge test at `:394`. After a wake turn opens and completes, `bindTurnAuthority` was called only for the prompt turn.
- **Unchanged existing tests that must keep passing:**
  - `does not emit turn.completed for a result with no active turn` (`:4853`)
  - the `/compact` attribution loop (`:5158-5231`)
  - the auto-compaction test (`:2504-2597`). Its unrealistic _idle_ `status: compacting` fixture now opens a provider turn; its assertions are unaffected.

### Validation (proportional)

```sh
bun run --cwd apps/server test src/provider/Layers/ClaudeAdapter.test.ts src/provider/claudeContextUsage.test.ts src/provider/claudeWakeTurn.test.ts
bun run --cwd apps/server typecheck
bun run fmt:check && bun lint
```

**Manual QA.** For desktop dev, rebuild the server bundle first (`bun run --filter ryco-cli build:bundle`). Then:

1. **Background wake.** Ask Claude to run `sleep 20 && echo done` in the background and end its turn. In the canonical provider log, the wake shows:
   - `turn.started` (`openedBy: wake-signal`) right after `session.configured`
   - `session.state.changed status:requesting` with that turn id
   - the reasoning item streaming before the first assistant snapshot
2. **`/compact`.** After `/compact`, the composer meter shows roughly the post-compaction size, not almost full.

---

## 6. Edge cases

- **`post_tokens` undershoots.** `post_tokens` counts the compacted messages, not the system prompt or tool definitions. The meter reads low until the next main-loop request reports real usage, usually within the same turn after auto-compaction. This is documented in `claude-cache.md`.
- **Boundary while no turn is open.** The usage event has no `turnId`, and the flag is consumed by the next `result`, which is the turnless result of that compaction (test A5).
- **Model switch during a turn that crosses a boundary.** `sendTurn` clears `lastKnownTokenUsage` (`:4874-4875`). The selector then finds no gauge, and the result's cumulative usage is suppressed until the flag is consumed. No wrong value is published.
- **Back-to-back turns.** In 35 of 136 logged cases, the CLI starts a notification turn immediately after a result. The stream fiber finishes `completeTurn(U)` before it reads the next frame, so `status requesting` then opens S cleanly.
- **A wake starts after Stop.** This happens: stopped-task notifications start a model turn, and this was observed. It opens a provider turn, because `status: requesting` means Claude really is calling the model. Stop can end it again. There is deliberately no suppression after Stop (§10).
- **A wake that errors before any snapshot.** `result error_during_execution` now completes S as `failed` (`turnStatusFromResult`), with `runtime.error` carrying S. The session leaves `running` instead of staying turnless.
- **Frames that arrive while another fiber is finishing the turn.** These only occur when `sendTurn` force-closes a provider turn whose CLI is still producing output. Such frames attach to the completing turn and can be emitted after its `turn.completed`. This is pre-existing behaviour of today's stale-close, it is rare, and it is not made worse here.
- **The watchdog fires early.** This needs more than 120 s with no root frame and no `compacting` heartbeat. The maximum observed is 34 s. The result is benign: an aborted empty turn, followed by a new `assistant-output` turn when output arrives.
- **Stop grace vs a late CLI result.** If the result arrives after the grace finished the turn, it takes the turnless path (usage only, log). No lifecycle event is duplicated.
- **Detached sleepers.** The watchdog and grace fibers re-check `context.turnState === target` and `!context.stopped`, so they are no-ops after a session restart, stop or replacement. Under TestClock they never fire unless the clock is advanced.

---

## 7. Risks

1. **CLI ordering assumption.** The design assumes that `status: requesting` (and, for legacy CLIs, `init`) precedes a turn's first output, and that both are root-only. This is verified on 2.1.280–2.1.288 logs (§1.2). If a future CLI stops emitting `requesting`, `init` takes over after one session, through `requestingStatusObserved`. If a future CLI emits idle `requesting` frames that are not turns, the watchdog bounds the damage to 120 s, and Stop clears it in 5 s.
2. **A phantom provider turn blocks sends for up to 120 s.** The decider and reactor reject turn starts while it is open (`decider.ts:999-1006`, `ProviderCommandReactor.ts:1129-1140`), and the client queue holds. Stop recovers within 5 s. The probability is very low, because no idle `requesting` frame without a turn was seen in 3 352 frames.
3. **The outcome of a send that races a wake start changes.**
   - **Before:** it was accepted into the turnless window, and the wake output was mixed into the user's turn.
   - **Now:** it usually fails at the decider invariant. The RPC rejects, and the client keeps the item as a failed queue entry needing retry (`ChatView.tsx:3960-3965`). Rarely, it fails at the reactor with a "Provider turn start rejected" activity: the message is projected but no turn runs.
   - **Window:** the time between projecting `turn.completed(U)` and `turn.started(S)` for back-to-back turns, a few ms on the server, plus client latency.
   - **Ownership:** `queue-hold-drain` should auto-retry items rejected by the active-turn invariant once idle (§8).
4. **Empty provider turns still occur in rare cases.** They come from a legacy `init` fallback with an empty wake, or a `requesting` wake that fails before output. Side effects:
   - the desktop "The agent finished responding." notification (`ChatView.tsx:1513-1537`)
   - a checkpoint capture (`CheckpointReactor.ts:845-865`)
   - in non-git folders, `latestTurn` stays `running` until `turn-finalization` (bug 5) lands

   Watchdog closures avoid all three by using `turn.aborted`.

5. **Waiting on another fiber's completion.** `sendTurn` can now wait for the stream fiber's in-flight completion. That wait is bounded by runtime-event backpressure, which is the same dependency `sendTurn` already has when it emits `turn.started`. There is no new lock cycle, because waiters never hold anything the claimer needs.
6. **Restructuring `completeTurn` is the riskiest edit.** It is covered by B5/B6 and by every existing completion test in the file (102 today).

---

## 8. Overlaps (named functions)

- **`turn-finalization` (W1), behavioural.**
  - Provider turns that end without an assistant message rely on bug-5 finalization in non-git folders. These are rare once the status trigger is in place.
  - Watchdog closures use `turn.aborted` so they do not depend on it.
  - There is no shared function. Prefer merging `turn-finalization` first. It does not block this package.
- **`queue-hold-drain` (W1), behavioural.** See risk 3. Keep the queued item until its turn actually starts. Auto-retry a dispatch rejected with the active-turn invariant (`decider.ts:999-1006`) when the thread is idle again, and do not treat an accepted RPC as delivery. There is no shared code.
- **`reactor-errors-switch` (W1).** It may reword the "Provider turn start rejected" activity (`ProviderCommandReactor.ts:1129-1140`). There is no shared function.
- **`claude-steering` (W2), same file.** It touches:
  - `sendTurn` / `sendTurnOnContext`
  - `ClaudeTurnState` + `makeClaudeTurnState`
  - the `completeTurn` claim
  - the `handleResultMessage` correlation

  Steering must decide what happens when the open turn is a provider turn: `openedBy !== "prompt"`, no `promptUuid`, no Agent Control binding. It must create turn state only through `makeClaudeTurnState` and respect `turnInstallsInFlight`. Land this package first.

- **`usage-limits` (W2), same file.** It touches `completeTurn`, `handleResultMessage`, and `handleSdkTelemetryMessage`, where `rate_limit_event` now carries the wake turn id. A wake that hits a limit is now a failed _provider_ turn opened at `requesting` (today it is a turnless error or a synthetic turn opened late). Classify it as Limited, but never auto-resume a provider turn as a user turn.
- **`rollback-correctness` (W2), same file.** It touches `updateResumeCursor` (reordered here), the `ClaudeSessionContext` fields, and `context.turns`, which also holds provider turns. Resume-at-target must treat provider turns like any other turn.
- **`delegation-returns` (W2), behavioural.** `CompletionReturnDelivery` into a parent that has a wake turn open now meets the decider/reactor active-turn rejection during the wake's think time (1.5–34 s). Before, it was accepted into the turnless window. Delivery must wait or retry, not fail.
- **`delegation-lineage` (W2).** No overlap.
- **`reactor-concurrency` (W3).** Timeouts around provider calls can interrupt `sendTurn`:
  - `acquireUseRelease` guarantees the `turnInstallsInFlight` release
  - `Effect.ensuring` releases a `completeTurn` claim

  The grace in `interruptTurn` is forked, so it must stay non-blocking.

- **`provider-effect-outbox` (W3).** A replayed interrupt of a provider turn behaves exactly like a user Stop, grace included.
- **`restart-continuation` (W3).** It may add context fields in the `startSession` literal. A continuation prompt goes through `sendTurn` and sets `promptSent`.
- **No overlap:** `settlement-signals`, `acp-message-ids`, `delegation-guard-restart`, `provider-compat`.

---

## 9. Out of scope and follow-ups

- **Enabling `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`.** Then treat `session_state_changed: idle` as the authoritative close for provider turns, and `running` as an even earlier start. This needs a check on its handling in `handleSystemMessage` (today it would hit the "Unhandled subtype" warning) and an env change in `ClaudeHome`. It is a follow-up.
- **Turnless `session.state.changed {running}`.** Status frames while no turn is open now only occur on the denied paths (startup, install in flight). Mapping `status: null` to `running` (`:3459`) is a separate oddity.
- **A Stop-grace for prompt turns.** This covers a user turn whose CLI never reports a result after interrupt. It belongs to `turn-finalization` / `reactor-concurrency`.
- **Suppressing the turn-complete notification for empty provider turns.** That is web code, and the web phone tier is frozen.
- **t3 #15029.** The working timer resets for each wake turn.

---

## 10. Review resolution

| #   | Critique item                                                                       | Decision                          | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| —   | Verdict "both confirmed"                                                            | **Disputed for (b), re-verified** | (b) is partially confirmed: `status: requesting` already projects a turnless `running` 1–4 ms after `init`, so the client queue does not see an idle thread. The defects are the turnless window's consequences (§1.2). (a) is confirmed                                                                                                                                                                                                                                                                                                                                      |
| 1   | **Major:** phantom wake turn cannot be recovered                                    | **Accepted**                      | Two recovery paths: Stop grace (5 s, forked, any provider turn) and the first-output watchdog (120 s, `turn.aborted`). Risk text corrected. The `status` trigger also makes phantoms far less likely than `init` would                                                                                                                                                                                                                                                                                                                                                        |
| 2   | **Major:** `completeTurn` is not safe to re-enter; the `sendTurn` fix is incomplete | **Accepted**                      | Synchronous claim with a per-turn `Deferred`. Concurrent closes wait. The claimer clears state only while it still owns it; the claim is released on failure. `sendTurn` loops `while (turnState) completeTurn` and then installs without yielding. Also fixed the stale spread in `updateResumeCursor`. Test B6 makes the race deterministic through `runtimeEventQueueCapacity`                                                                                                                                                                                             |
| 3   | Empty synthetic turns opened by `init` have side effects                            | **Accepted, via a design change** | The primary trigger is root `status` (`requesting`/`compacting`), so empty notification turns (2 of 53 logged) never open a turn. `init` is used only on legacy CLIs. Watchdog closures use `turn.aborted` and capture no checkpoint. Remaining effects and the soft `turn-finalization` dependency are listed (§7.4, §8)                                                                                                                                                                                                                                                     |
| 4   | Gate is narrower than t3; `session_state_changed` evidence was wrong                | **Accepted, one part rejected**   | The allow list is replaced by a deny list (open turn, stopped, no prompt yet, install in flight), so cron, Monitor, rate-limit and lost-notification wakes are covered. "Arm on `background_tasks_changed`" is moot because nothing is armed. The `session_state_changed` evidence is corrected (opt-in env var; §1.2, §9). **Rejected:** "ignore init after Stop until the next prompt". A post-Stop wake that reaches `requesting` is real model work (observed in logs). Suppressing it would recreate the turnless `running` window and leave Stop with nothing to target |
| 5   | `turnInstallsInFlight` can leak; the re-check in `startSyntheticTurn` is incomplete | **Accepted**                      | `Effect.acquireUseRelease` is used. `startProviderTurn` re-checks `turnState`, `stopped`, `turnInstallsInFlight` and `promptSent` synchronously before installing                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6   | Part A: legacy telemetry overwrite and undershoot                                   | **Accepted**                      | The `mainLoopUsageObserved` gate replaces `!cacheObservation`. Test A4 is added. The undershoot is documented (§6 and docs)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 7   | Justification inaccuracies; B4 premise; reactor rejection not mentioned             | **Accepted**                      | The orphan is stated as pre-existing and reachable through the assistant-frame path (§1.3). The decider and reactor rejection outcome is in risks and overlaps. Line references were refreshed. The old "user send during an open wake" test is dropped: the normal path cannot reach it. B5/B6 now cover the actual adapter races                                                                                                                                                                                                                                            |
| 8   | Test gaps                                                                           | **Accepted, adapted**             | Pure-module unit tests are added, plus A4, A5, B3 (watchdog), B4 (Stop grace), B5, B6, B7 (Agent Control binding), and the `parent_tool_use_id: null` fixture note. The suggested "prompt clears an armed gate" and "nested / `skip_transcript` notification does not arm" tests are moot because there is no arming. They are replaced by B2(i)–(iv) and the `claudeWakeSignal` subagent case                                                                                                                                                                                |
| 9   | Turn-state literal is duplicated                                                    | **Accepted**                      | `makeClaudeTurnState` is the only constructor, used by `sendTurn` and `startProviderTurn`. `claude-steering` must use it too                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 10  | Overlaps `usage-limits` and `delegation-returns` are missing                        | **Accepted**                      | Both are added with concrete obligations (§8)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
