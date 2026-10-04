# 02 · turn-finalization: threads stuck on "Working" — explicit turn finalization and startup reconcile (bug 5)

| Field | Value |
| --- | --- |
| id | `turn-finalization` |
| title | End every turn with an explicit, server-decided terminal state carried on the releasing `thread.session-set`, decouple turn state from checkpoint capture, close the ACP/Cursor "started then failed" gap, and repair stale running turns at startup |
| wave | 1 (parallel, isolated worktree) |
| verdict | **confirmed**, and wider than the brief. Besides the non-git, failed-without-text and capture-failure paths, (a) ACP and Cursor prompt failures after `turn.started` emit no terminal at all, (b) the decider's in-memory model keeps every such turn `running`, which blocks context handoff, delegated returns and workspace lifecycle commands, permanently once SQL is stuck too, and (c) checkpoint events overwrite turn state mid-turn and after an interrupt |
| size | M (many small hunks across one vertical slice; no migration) |
| touched files | **contracts:** `packages/contracts/src/orchestration.ts`, `packages/contracts/src/orchestration.test.ts` · **shared:** `packages/shared/src/turnFinalization.ts` (new), `packages/shared/src/turnFinalization.test.ts` (new), `packages/shared/package.json` (one export) · **server:** `apps/server/src/orchestration/turnFinalization.ts` (new), `apps/server/src/orchestration/decider.ts`, `apps/server/src/orchestration/projector.ts`, `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`, `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`, `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`, `apps/server/src/serverRuntimeStartup.ts`, `apps/server/src/provider/acp/AcpAdapterSupport.ts`, `apps/server/src/provider/Layers/AcpAdapter.ts`, `apps/server/src/provider/Layers/CursorAdapter.ts` · **client:** `packages/client-runtime/src/state/threads/store.ts` · **tests:** `apps/server/src/orchestration/turnFinalization.test.ts` (new), `apps/server/src/orchestration/decider.turnFinalization.test.ts` (new), `apps/server/src/orchestration/Layers/turnFinalization.parity.test.ts` (new), `projector.test.ts`, `Layers/ProjectionPipeline.test.ts`, `Layers/ProviderRuntimeIngestion.test.ts`, `Layers/ProviderCommandReactor.test.ts`, `Layers/CheckpointReactor.test.ts`, `providerHistoryRecovery.test.ts`, `apps/server/src/serverRuntimeStartup.test.ts`, `apps/server/src/provider/acp/AcpAdapterSupport.test.ts`, `apps/server/src/provider/Layers/CursorAdapter.test.ts`, `packages/client-runtime/src/state/threads/store.test.ts` |
| migrations | none. `projection_turns.state`/`completed_at` already exist; legacy stuck rows are repaired by the startup reconcile, not by SQL |
| contract changes | `packages/contracts/src/orchestration.ts`: new `OrchestrationTerminalTurnState` (frozen literal set `completed`/`error`/`interrupted`), new `OrchestrationTurnOutcome` (server-internal hint) and `OrchestrationReleasedTurn`. `ThreadSessionSetCommand` (internal-only command) gains optional `turnOutcome`. `ThreadSessionSetPayload` gains optional `releasedTurn`. No new event type and no new command type. Older clients drop the unknown key (Struct decoding ignores excess keys) and pick the result up through the shell upsert. `reason` is an open `TrimmedNonEmptyString`, so new reason values never break decoding |
| overlaps | **reactor-errors-switch (W1):** `ProviderCommandReactor.setThreadSessionErrorOnTurnStartFailure`, `handleTurnStartFailure` (one new `messageId` argument), `ensureSessionForThread`/`bindSessionToThread` (one hint field). Unavoidable, small hunks. **acp-message-ids (W1):** `CursorAdapter.test.ts` (adjacent new tests only). This package edits `AcpAdapter.sendTurn`/`CursorAdapter.sendTurn`; 03 does not edit either adapter. **delegation-guard-restart (W1):** `projector.ts`, different cases (it owns `thread.message-sent`; this package edits `thread.session-set`, `thread.turn-diff-completed`, and the `thread.reverted` helper import). This package does not edit `getCommandReadModel`. **settlement-signals (W1):** `store.ts`, different reducers (it edits the worktree domain reducer near `:2644`); semantic: more turns now reach `completed`. **provider-compat (W1):** `packages/shared/package.json` exports map; insert `./turnFinalization` directly after `./threadActivity` to avoid an adjacent-line conflict. **claude-meter-wake (W1):** possible `ProviderRuntimeIngestion` lifecycle block (`:2381-2530`) if it changes wake-turn `turn.started` handling. **queue-hold-drain (W1):** semantic. `interrupted` now also comes from provider cancellations, session replacement and startup repair, so a Stop hold must key on the user's Stop intent, not on `latestTurn.state` alone. **rollback-correctness (W2):** `thread.turn-diff-completed` cases in `projector.ts`, `ProjectionPipeline.ts`, `store.ts`, and the shared `checkpointStatusToTurnState`. It must keep the new rule that a checkpoint never changes an existing turn's state. **usage-limits (W2):** `handleTurnStartFailure`, ingestion lifecycle block; must not add a member to `OrchestrationTerminalTurnState` (use `reason` or a separate field). **delegation-returns (W2):** semantic, `CompletionReturnDelivery` now sees finalized parents. **claude-steering (W2):** semantic, superseded-turn release. **reactor-concurrency / provider-effect-outbox / restart-continuation (W3, land after):** `ProviderCommandReactor` session writes keep `turnOutcome`; `reconcileOrphanedProviderSessions` now emits one session-set with `releasedTurn` instead of interrupt + session-set (spec 15 §1 line "Interrupt" must be updated); `ProjectionPipeline.applyThreadTurnsProjection` `thread.session-set` case is restructured |

---

## 1. Problem (verified against the code)

### 1.1 Where a projected turn can leave `running` today

There are three reducers of the same events, and none of them treats a session release as the end of a turn.

| Reducer | `thread.session-set` (not running) | final assistant `thread.message-sent` | `thread.turn-interrupt-requested` | `thread.turn-diff-completed` |
| --- | --- | --- | --- | --- |
| SQL `applyThreadTurnsProjection` (`ProjectionPipeline.ts:1696`) | early return, `:1717-1721` | `completed` unless interrupted/error, `:1797-1842` | `interrupted` unconditionally, `:1845-1880` | `error` if status error, otherwise `completed`, unconditionally, `:1882-1926` (`:1887`, `:1897`) |
| in-memory `projector.ts` (decider's model) | keeps `thread.latestTurn`, `:735-754` | **does not touch `latestTurn`**, `:642-705` | `interrupted` if same turn, `:760-788` | sets `latestTurn` to the payload turn unconditionally, `ready→completed / missing→interrupted / error→error`, `:822-888` (`:64-68`) |
| client `store.ts` | keeps `thread.latestTurn`, `:2420-2448` | `completed` unless interrupted/error, `completedAt = payload.updatedAt` (no `laterIsoTimestamp`), `:1617-1646` | same-turn only, `:2392-2415`, but this event is **not** on the detail stream (`ws/context/orchestrationEvents.ts:3-22`) | same mapping as the projector, same turn or null only, `:2486-2532` |

The client shows Working when the session is running **or** the latest turn is running (`client-runtime/.../threadActivityStatus.ts:30`). The shell upsert after every thread event (`ws/context/orchestrationStreams.ts:281-293`) overwrites the client's `latestTurn` with the SQL row (`store.ts:397-401`), so SQL is what the user finally sees.

### 1.2 Real event sequences

`providerCommandId` is `provider:<eventId>:<tag>` (`ProviderRuntimeIngestion.ts:115-124`); the reactor skips those for interrupts (`ProviderCommandReactor.ts:140-141`, `:1342`).

1. **Normal turn, non-git folder, no final assistant text** (tool-only turn, or a failure):
   - `turn.started X` → `thread.session.set {running, activeTurnId X}` → SQL row X `running`, in-memory `latestTurn` X `running`.
   - `turn.completed {state: completed|failed}` → ingestion dispatches only `thread.session.set {ready|error, activeTurnId null}` (`:2420-2513`, status `:2447-2450`).
   - SQL: early return. In memory: unchanged. CheckpointReactor: `resolveCheckpointCwd` returns undefined for a non-git cwd (`CheckpointReactor.ts:251-256`).
   - **Result: X stays `running` in SQL and in memory. The UI shows Working forever.**
2. **`turn.completed {interrupted|cancelled}`** (for example ACP/Cursor `stopReason: cancelled`, `AcpAdapter.ts:951-961`, `CursorAdapter.ts:1154-1165`): same as 1. No interrupt is dispatched, because ingestion only dispatches `thread.turn.interrupt` for `turn.aborted` or the reconciled idle turn (`:2515-2530`). It is stuck in non-git folders.
3. **Git folder, capture fails:** `captureCheckpointFromTurnCompletion` fails → only `appendCaptureFailureActivity` (`CheckpointReactor.ts:850-866`). Stuck.
4. **Git folder, capture succeeds after Stop:** runtime `interrupted|cancelled` maps to checkpoint status `missing` (`CheckpointReactor.ts:56-66`, `:464`). SQL turns it into `completed` (`ProjectionPipeline.ts:1887`), memory and client into `interrupted`. The three reducers disagree, and the SQL `completed` fires a "completed" notification (`threadNotifications.ts:34-48`).
5. **Git folder, Codex mid-turn:** `turn.diff.updated` dispatches a placeholder `thread.turn.diff.complete {status: missing}` mid-turn (`ProviderRuntimeIngestion.ts:2947-2980`). `captureCheckpointFromPlaceholder` immediately captures a real `ready` checkpoint (`CheckpointReactor.ts:476-529`). Mid-turn, memory flips to `interrupted` and then `completed`, and SQL to `completed`. A later `turn.completed {failed}` does not correct it, so a failed turn is shown and notified as completed.
6. **Final assistant message, then failure:** the SQL and client turn is already `completed` (`:1813-1818`). The failure only changes the session. Notified as "completed".
7. **ACP / Cursor prompt failure (git or not):** `AcpAdapter.sendTurn` emits `turn.started` (`:899-906`) and then awaits the whole `prompt` (`:917-925`). `CursorAdapter.sendTurn` emits `turn.started` (`:1049-1056`) and then can fail on attachment reads (`:1088-1105`), `bindTurn`, or `prompt` (`:1133-1145`). Neither emits a terminal event on failure, and `ProviderService.sendTurn` adds none (`ProviderService.ts:1099-1199`). The forked `sendTurn` failure (`ProviderCommandReactor.ts:1332-1336`) reaches `handleTurnStartFailure` (`:1157-1183`) → `setThreadSessionErrorOnTurnStartFailure` (`:343-364`): `status: ready`, `activeTurnId: null`, `lastError`, `updatedAt: <request time>`. X stays `running`.
   - **Race:** if the reactor's handler runs before ingestion has projected `turn.started`, the late `turn.started` sets the **session** back to `running X`, and nothing ever ends it until restart.
   - For delegated returns (`delegationReturnGuard`), the handler does not touch the session at all (`:1163-1166`), so the session itself stays `running X`.
   - OpenCode is already safe: it emits `turn.aborted` on prompt failure (`OpenCodeAdapter.ts:2516-2545`).
8. **Server-side session replacement mid-turn:** `thread.runtime-mode-set`, `thread.token-mode-set` (`:1737-1762`) and `thread.goal-updated` (`:1447`) call `ensureSessionForThread`. On a mode, cwd or model change it restarts the provider session (`:716-748`) and `bindSessionToThread` writes `activeTurnId: null` with the provider's status (`:652-678`). Mobile and Agent Control (`AgentControlExecution.ts:1336-1360`) can trigger this mid-turn. The killed turn is either left `running`, or labelled by whichever terminal from the old runtime wins the race.
9. **Restart:** `reconcileOrphanedProviderSessions` (`serverRuntimeStartup.ts:552-715`) selects only sessions that are `starting`/`running` or have an `activeTurnId` (`:616-623`). A turn stuck behind a `ready`/`error`/`stopped` session is reloaded as `running` by `getCommandReadModel` and stays so forever.

### 1.3 Consequences beyond the spinner

The decider's in-memory model is the authority for these gates. All of them stay closed while `latestTurn.state === "running"`:

- **Context handoff (switching provider instance) is rejected** with "has an unsettled turn" (`commandInvariants.ts:96`, called at `decider.ts:1044`). This is permanent if SQL is stuck too, because a restart reloads it.
- **Delegated returns are rejected** (`decider.ts:1022-1023` requires `completed`), and `CompletionReturnDelivery` keeps waiting (`CompletionReturnDelivery.ts:366-372`).
- **Workspace lifecycle commands are rejected** (`decider.ts:233-238`).
- **Plan-ready never appears**, because `completedAt` is null (`session-logic.ts:249-258`).
- No completed or failed notification ever fires.

---

## 2. Approach

The t3 reference (`orchestration-v2/RunFinalizationService.ts`) sets the run's terminal status in the orchestrator and runs checkpoint capture as a post-terminal effect that can fail without touching status. Ryco gets the same split with the smallest event-model change.

1. **The release carries the outcome.** A turn ends exactly when a `thread.session-set` moves the session off it. The **decider** (one place, using the authoritative in-memory model) works out which turn is released and how, and writes it into the event as `payload.releasedTurn = { turnId, state, completedAt, reason }`. The SQL projector, the in-memory projector and the client store all apply the **same explicit data**. None of them infers anything from the session status. Session-set events without `releasedTurn` (all legacy events) behave exactly as today.
2. **Callers state what they know.** `thread.session.set` gains an optional internal `turnOutcome` hint. Every known release site passes one:

   | Site | Outcome |
   | --- | --- |
   | provider `turn.completed` / `turn.aborted` | completed / error / interrupted |
   | provider idle or exit reconcile | interrupted |
   | provider history restore | completed / error |
   | turn-start failure bound to its own started turn | error |
   | session replaced (restart / rebind) | interrupted |
   | user session stop | interrupted |
   | interrupt failure | interrupted |
   | startup orphan | interrupted |
   | startup stale turn | error if the session is `error`, else interrupted |

3. **Fail-closed fallback.** A release with no matching hint is labelled `error` if the new session status is `error`, otherwise `interrupted`. It is **never** `completed`. `completed` can only come from a provider saying so (live or via history). Delegation therefore stays fail-closed: `CompletionReturnDelivery` cancels on `interrupted`/session `error` and waits on anything not `completed`; the decider guard requires `completed`.
4. **Precedence.** An explicit release overrides `running` and `completed`. `completed` before release is only ever an inference from a final message or a checkpoint. `interrupted` and `error` are sticky: a user Stop stays interrupted even if the provider then reports `completed`.
5. **Checkpoints never change an existing turn's state.** `thread.turn-diff-completed` attaches checkpoint fields. It sets state only when it creates the turn or the latest-turn entry (no existing entry for that id), using one shared mapping. This removes cases 4 and 5. A late diff after finalization keeps the finalized state and its `completedAt`.
6. **Close the source gap.** ACP and Cursor emit `turn.completed {state: failed, errorMessage}` for a started turn whose remainder fails. This uses one shared helper in `AcpAdapterSupport.ts`. Because the terminal follows `turn.started` on the same runtime stream, ingestion closes the turn no matter how it races the reactor.
7. **Startup repair** reuses the snapshot `reconcileOrphanedProviderSessions` already loads (no extra full load). It settles every latest turn still `running` behind a session that is not running, and folds the orphan interrupt into the orphan session-set.

### Why not a new `thread.turn-finalized` event

- One atomic event keeps session and turn in lockstep for all three reducers. The open thread view gets the turn state in the same detail-stream frame as the session, so there is no Working/completed flash.
- No change to the routing table, the detail-stream filter, sidebar-undo classification or command routing (`OrchestrationEngine.ts:110-140`).
- The legacy `orchestration.replayEvents` RPC returns `Schema.Array(OrchestrationEvent)` unfiltered (`orchestration.ts:2717`, `orchestrationRpc.ts:421-443`). An unknown event type fails the whole decode for old clients; an unknown optional key does not.

---

## 3. Step-by-step changes

### 3.1 `packages/contracts/src/orchestration.ts` (schema only)

Next to `OrchestrationLatestTurnState` (`:814-820`):

```ts
export const OrchestrationTerminalTurnState = Schema.Literals(["completed", "error", "interrupted"]);
export type OrchestrationTerminalTurnState = typeof OrchestrationTerminalTurnState.Type;

/** Server-internal: what the caller knows about how the active turn ended. */
export const OrchestrationTurnOutcome = Schema.Struct({
  /** Omitted = "the turn this release ends", whichever it is. */
  turnId: Schema.optional(TurnId),
  state: OrchestrationTerminalTurnState,
  /** Open diagnostic string (see TURN_FINALIZATION_REASON). Never a closed literal set. */
  reason: TrimmedNonEmptyString,
  completedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationTurnOutcome = typeof OrchestrationTurnOutcome.Type;

/** Decided by the server: the turn this session-set releases, and how it ended. */
export const OrchestrationReleasedTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationTerminalTurnState,
  completedAt: IsoDateTime,
  reason: TrimmedNonEmptyString,
});
export type OrchestrationReleasedTurn = typeof OrchestrationReleasedTurn.Type;
```

- `ThreadSessionSetCommand` (`:1726-1732`): add `turnOutcome: Schema.optional(OrchestrationTurnOutcome)`. The command stays in `InternalOrchestrationCommand` (`:1853-1883`), which is not part of `ClientOrchestrationCommand` (`:1686`) or `DispatchableClientOrchestrationCommand` (`:1645`). Clients and agents cannot set it.
- `ThreadSessionSetPayload` (`:2203-2206`): add `releasedTurn: Schema.optional(OrchestrationReleasedTurn)`.

### 3.2 `packages/shared/src/turnFinalization.ts` (new) and `packages/shared/package.json`

These are pure helpers used by the server reducers and the client store. Add the export `"./turnFinalization": { "types": "./src/turnFinalization.ts", "import": "./src/turnFinalization.ts" }` directly after `"./threadActivity"`.

```ts
export type TerminalTurnState = "completed" | "error" | "interrupted";

/** Moved verbatim from ProjectionPipeline.ts:204-211. */
export function laterIsoTimestamp(current: string | null, next: string): string;

export function isStickyTurnState(state: string): state is "interrupted" | "error";

/** Single mapping for checkpoint status → turn state; replaces projector.ts:64-68 and store.ts:1202-1210. */
export function checkpointStatusToTurnState(status: "ready" | "missing" | "error"): TerminalTurnState;
// ready → completed, missing → interrupted, error → error

/**
 * Apply an explicit release to an existing turn entry. interrupted/error are sticky
 * (completedAt kept, filled if null). running/pending/completed take the released state;
 * completedAt = latest of (current.completedAt, released.completedAt, current.startedAt).
 */
export function mergeReleasedTurn(
  current: { readonly state: string; readonly startedAt: string | null; readonly completedAt: string | null },
  released: { readonly state: TerminalTurnState; readonly completedAt: string },
): { readonly state: TerminalTurnState | "interrupted" | "error"; readonly completedAt: string };
```

### 3.3 `apps/server/src/orchestration/turnFinalization.ts` (new, server-only)

```ts
export const TURN_FINALIZATION_REASON = {
  providerTurnCompleted: "provider-turn-completed",
  providerTurnAborted: "provider-turn-aborted",
  providerSessionIdle: "provider-session-idle",
  providerSessionExited: "provider-session-exited",
  providerRuntimeError: "provider-runtime-error",
  providerHistory: "provider-history",
  turnStartFailed: "turn-start-failed",
  sessionReplaced: "session-replaced",
  sessionStopped: "session-stopped",
  interruptFailed: "interrupt-failed",
  startupOrphanedSession: "startup-orphaned-session",
  startupStaleTurn: "startup-stale-turn",
  sessionReleased: "session-released", // fallback
} as const;

/** One mapping for both the release hint and completionReturns.observe (ProviderRuntimeIngestion.ts:3092-3106). */
export function runtimeTerminalTurnState(
  event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>,
): OrchestrationTerminalTurnState;
// turn.aborted | interrupted | cancelled → interrupted; failed → error; otherwise completed

export function fallbackReleasedTurnState(session: Pick<OrchestrationSession, "status">): OrchestrationTerminalTurnState;
// status "error" → "error"; anything else → "interrupted". Never "completed".

export function resolveReleasedTurn(input: {
  readonly thread: OrchestrationThread;        // previous in-memory state
  readonly nextSession: OrchestrationSession;
  readonly outcome: OrchestrationTurnOutcome | undefined;
}): OrchestrationReleasedTurn | undefined {
  const latest = input.thread.latestTurn;
  const candidate =
    input.thread.session?.activeTurnId ?? (latest?.state === "running" ? latest.turnId : null);
  if (candidate === null || input.nextSession.activeTurnId === candidate) return undefined;
  const hint =
    input.outcome !== undefined &&
    (input.outcome.turnId === undefined || input.outcome.turnId === candidate)
      ? input.outcome
      : undefined;
  const same = latest?.turnId === candidate ? latest : null;
  return {
    turnId: candidate,
    state: hint?.state ?? fallbackReleasedTurnState(input.nextSession),
    reason: hint?.reason ?? TURN_FINALIZATION_REASON.sessionReleased,
    // Clamp: never before the turn started (critique minor 5).
    completedAt: latestIso(hint?.completedAt ?? input.nextSession.updatedAt, same?.startedAt, same?.requestedAt),
  };
}
```

Rules this encodes:

- The candidate is the previous `session.activeTurnId`, even when the in-memory `latestTurn` already says `completed`. That is what lets a failure correct a premature `completed` (case 6).
- If there is no active turn, the candidate is a `running` latest turn (legacy or race leftovers).
- A session-set that keeps the same active turn releases nothing. Examples: an incidental `ready` while the provider still has a turn becomes `running`, `ProviderRuntimeIngestion.ts:2440-2442`; a `session.state.changed error` that keeps `activeTurnId`.
- A session-set that starts turn Y while X is still the candidate releases X with the fallback state (`interrupted`, reason `session-released`). At most one running turn per thread.
- A hint naming a different turn is ignored. This prevents late or duplicate completions from labelling, moving or creating turns (critique minor 4).

### 3.4 `apps/server/src/orchestration/decider.ts`

- `thread.session.set` (`:1720-1757`): `const releasedTurn = resolveReleasedTurn({ thread, nextSession: command.session, outcome: command.turnOutcome })`. Set `payload: { threadId, session, ...(releasedTurn ? { releasedTurn } : {}) }`. The wake and unsettle logic is unchanged. The command still always produces the session event, so it never hits "Command produced no events" (`OrchestrationEngine.ts:406-411`). The commit stays one transaction (`:364-401`).
- `thread.history.restore` (`:1759-1825`): when it builds the inline session-set for a completed active turn (`:1805-1823`), add `releasedTurn` through the same helper with `outcome = { turnId: activeTurnId, state: failed ? "error" : "completed", reason: providerHistory, completedAt: command.createdAt }`.

### 3.5 `apps/server/src/orchestration/projector.ts` (in-memory, decider's model)

- Delete the local `checkpointStatusToLatestTurnState` (`:64-68`). Use `checkpointStatusToTurnState` from `@ryco/shared/turnFinalization` in `thread.turn-diff-completed` and `thread.reverted` (`:920`); the `thread.reverted` behaviour is unchanged.
- `thread.session-set` (`:707-757`):

  ```ts
  const released = payload.releasedTurn;
  const settled =
    released !== undefined && thread.latestTurn?.turnId === released.turnId
      ? { ...thread.latestTurn, ...mergeReleasedTurn(thread.latestTurn, released) }
      : thread.latestTurn;
  latestTurn: session.status === "running" && session.activeTurnId !== null
    ? { /* existing running branch, unchanged */ }
    : settled,
  ```

- `thread.turn-diff-completed` (`:822-888`): the checkpoint list logic is unchanged. For `latestTurn`:
  - **Same turn:** keep `state`. `completedAt` stays as is while running, otherwise `existing ?? payload.completedAt`. `assistantMessageId` as today.
  - **Null or a different turn:** today's behaviour, including the pointer move, which rollback-correctness owns. Use the shared mapping.
- Do **not** touch `thread.message-sent` (delegation-guard-restart owns it).

### 3.6 `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`

- Replace the local `laterIsoTimestamp` (`:204-211`) with the shared import (same behaviour; `message-sent` keeps using it).
- `applyThreadTurnsProjection` `thread.session-set` (`:1717-1795`): before today's early return, apply the release:

  ```ts
  const released = event.payload.releasedTurn;
  if (released !== undefined) {
    const row = yield* projectionTurnRepository.getByTurnId({ threadId, turnId: released.turnId });
    if (Option.isSome(row)) {
      yield* projectionTurnRepository.upsertByTurnId({ ...row.value, ...mergeReleasedTurn(row.value, released) });
    } // no row → nothing (no phantom rows)
  }
  const turnId = event.payload.session.activeTurnId;
  if (turnId === null || event.payload.session.status !== "running") return;
  // …existing running logic unchanged…
  ```

  No routing-table change: `thread.session-set` already reaches `threadTurns` (`:152-156`).
- `applyThreadTurnsProjection` `thread.turn-diff-completed` (`:1882-1926`):
  - **Existing row:** keep `state`. `completedAt` stays as is when the row is `running`/`pending`, otherwise `existing.completedAt ?? payload.completedAt`. Checkpoint fields and `assistantMessageId` as today.
  - **New row:** `state: checkpointStatusToTurnState(payload.status)`. Today `missing` becomes `completed`, so this also aligns SQL with the in-memory model.
  - The `clearCheckpointTurnConflict` call is unchanged.
- `applyThreadsProjection` is unchanged. For session-set, `latestTurnId = activeTurnId ?? existing` already keeps the released turn as latest (`:1098`).

### 3.7 `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`

1. Right after `shouldApplyThreadLifecycle` (`:2381-2410`), compute once:

   ```ts
   const runtimeTerminal =
     (event.type === "turn.completed" || event.type === "turn.aborted") && eventTurnId !== undefined
       ? { turnId: eventTurnId, state: runtimeTerminalTurnState(event) }
       : undefined;
   const turnOutcome: OrchestrationTurnOutcome | undefined =
     runtimeTerminal !== undefined
       ? { ...runtimeTerminal, reason: event.type === "turn.aborted" ? R.providerTurnAborted : R.providerTurnCompleted, completedAt: now }
       : reconciledInterruptedTurnId !== undefined
         ? { turnId: reconciledInterruptedTurnId, state: "interrupted", reason: event.type === "session.exited" ? R.providerSessionExited : R.providerSessionIdle, completedAt: now }
         : undefined;
   ```

2. Lifecycle `thread.session.set` dispatch (`:2492-2513`): add `...(turnOutcome ? { turnOutcome } : {})`.
3. **Delete** the follow-up `thread.turn.interrupt` dispatch (`:2515-2530`). The release now carries `interrupted` atomically in the same event. This also removes the late-abort side effects: `latest_turn_id` moving backwards (`ProjectionPipeline.ts:1115-1140`) and phantom rows (`:1867-1880`). Nothing consumes provider-prefixed interrupts: the reactor skips them, the detail stream excludes them, and `processDomainEvent` is a no-op (`:3120`). `projectReasoningForEvent(event, thread.id, reconciledInterruptedTurnId)` is unchanged.
4. `runtime.error` session-set (`:2908-2928`): add `turnOutcome: { state: "error", reason: R.providerRuntimeError, completedAt: now }`. It is turn-less and only applies when the release happens, which is when `eventTurnId` is undefined.
5. Completion observation (`:3092-3106`): `terminal = shouldApplyThreadLifecycle && !isSubagentProviderThread && runtimeTerminal ? runtimeTerminal : undefined`. This is the same mapping, now in one helper (critique minor 8).

### 3.8 `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`

- `setThreadSession` (`:330-341`): accept an optional `turnOutcome` and pass it through.
- `setThreadSessionErrorOnTurnStartFailure` (`:343-364`): take `messageId` as well.
  - `const started = thread.latestTurn?.state === "running" && thread.latestTurn.userMessageId === input.messageId ? thread.latestTurn : undefined`. `userMessageId` is the row's `pending_message_id` (`ProjectionSnapshotQuery.ts:287-290`, `:896`).
  - Pass `turnOutcome: started ? { turnId: started.turnId, state: "error", reason: R.turnStartFailed, completedAt: new Date().toISOString() } : undefined`.
  - Status: `session.status === "stopped" ? "stopped" : session.status === "error" ? "error" : "ready"`. Do not downgrade an `error` that ingestion already set from the adapter's terminal. The rest is unchanged.
  - `handleTurnStartFailure` (`:1157-1183`) passes `event.payload.messageId`.
- `bindSessionToThread` (`:652-678`): pass `turnOutcome: { state: "interrupted", reason: R.sessionReplaced, completedAt: createdAt }`. It is turn-less. It is a no-op when nothing is running, which covers first start and turn start. When a turn is running, the restart killed it, so the label is `interrupted` regardless of which old-runtime terminal won the race.
- `recoverInterruptFailure` (`:1410-1419`): pass `turnOutcome: { turnId: stoppedSession.activeTurnId, state: "interrupted", reason: R.interruptFailed, completedAt: event.payload.createdAt }`.
- `processSessionStopRequested` (`:1706-1722`): pass `turnOutcome: { state: "interrupted", reason: R.sessionStopped, completedAt: now }`. Without it, a stale `lastError` carried over (`:1718`) would not change the label (the fallback only looks at status), but the reason documents user intent.
- `ContextHandoffCoordinator` is unchanged. It only sets sessions on idle threads, and the fallback covers it.

### 3.9 ACP and Cursor: terminal for a started turn that fails

`apps/server/src/provider/acp/AcpAdapterSupport.ts`: add

```ts
/** Emit turn.completed{failed} once if `effect` fails after turn.started; skip interrupt-only causes. */
export function failStartedTurnOnError<A, E, R>(input: {
  readonly isTerminalEmitted: () => boolean;
  readonly emitFailed: (errorMessage: string) => Effect.Effect<void>;
}): (effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
```

- It uses the `onError` or `tapCause` combinator from the repo's Effect version and skips when `Cause.hasInterruptsOnly(cause)`.
- `errorMessage` is the adapter error's `detail`/`issue`, falling back to `Cause.pretty`, trimmed. If that is empty, it uses `"Provider turn failed"`, because `TurnCompletedPayload.errorMessage` must be non-empty (`contracts/providerRuntime.ts:394-401`).
- Emission failures are ignored. The original failure is re-raised unchanged, so `handleTurnStartFailure` still records `provider.turn.start.failed`.

Changes in the adapters:

- **`AcpAdapter.sendTurn` (`:888-967`):** capture `runtimeSessionId` in `prepared`. Wrap everything after `prepared` (the `prompt` call and the second `withThreadLock` block) with the helper. `emitFailed` offers `{ type: "turn.completed", turnId: prepared.turnId, payload: { state: "failed", errorMessage } }` via `offerRuntimeEventForRuntime(prepared.runtimeSessionId, …)`. Set a local `terminalEmitted = true` right after the success `turn.completed` is offered, so a later failure cannot add a second terminal.
  - If the ACP session changed (`:931-936`), the event is stamped with the old runtime id and ingestion drops it as stale (`ProviderRuntimeIngestion.ts:2262-2283`). The rebind's `session-replaced` hint covers that turn.
- **`CursorAdapter.sendTurn` (`:1041-1173`):** the same pattern. Capture `runtimeSessionId` when `turn.started` is emitted, wrap everything after it (attachment reads, validation, `bindTurn`, `prompt`, post-processing), and use the same flag.

### 3.10 `apps/server/src/serverRuntimeStartup.ts` (`reconcileOrphanedProviderSessions`, `:552-715`)

1. Load `snapshot = getCommandReadModel()` **before** `listSessions()`. Today it loads at `:570`; this is the same single load and adds no fourth full load (critique minor 9).
2. **New `settleStaleProjectedTurns(snapshot)`:** it runs before the liveness check, so it also runs when `listSessions` fails.
   - **Selection:** threads with `deletedAt === null`, `latestTurn?.state === "running"`, `session !== null`, `session.activeTurnId === null` and `session.status ∉ {running, starting}`. This set is disjoint from the orphan set.
   - **Dispatch** for each:

     ```ts
     {
       type: "thread.session.set",
       commandId: `server:startup-turn-reconciliation:${uuid}`,
       threadId,
       session: thread.session,            // unchanged
       turnOutcome: { turnId: latestTurn.turnId, state: fallbackReleasedTurnState(thread.session),
                      reason: R.startupStaleTurn, completedAt: thread.session.updatedAt },
       createdAt: reconciledAt,
     }
     ```

   - **Labelling choice (explicit):** a stale turn behind an `error` session becomes `error`; behind `ready`/`idle`/`stopped`/`interrupted` it becomes `interrupted`. We cannot know whether it completed, so we fail closed.
   - `completedAt` is the session's `updatedAt`, which approximates when the turn ended; the decider clamps it to at least `startedAt`.
   - Retry and logging follow the existing pattern: `Effect.retry(Schedule.recurs(1))`, then a warning.
   - Threads with `session === null` and a running latest turn are skipped with a debug log; this should not occur.
3. **Orphan loop (`:625-708`):** replace the `thread.turn.interrupt` dispatch (`:659-683`) and the following session-set (`:685-707`) with **one** session-set carrying `turnOutcome: { turnId: session.activeTurnId ?? undefined, state: "interrupted", reason: R.startupOrphanedSession, completedAt: reconciledAt }`. If the session has no `activeTurnId` but a running latest turn, the decider's candidate rule still settles it. Binding stop and directory updates are unchanged.
4. **Notifications:** this runs before the command gate opens and before any client connects. Clients baseline silently on (re)snapshot (`threadNotifications.ts:60-66`), so there is no notification storm.

### 3.11 `packages/client-runtime/src/state/threads/store.ts`

- Delete the local `checkpointStatusToLatestTurnState` (`:1202-1210`) and use the shared one.
- `thread.session-set` (`:2420-2448`): same settle step as §3.5. If `releasedTurn` names the current `latestTurn`, apply `mergeReleasedTurn` via `buildLatestTurn({ previous, …merged })`. The running branch is unchanged.
- `thread.turn-diff-completed` (`:2486-2532`): for the same turn keep `state` (and `completedAt` per §3.5); for a null latest turn use today's mapping.
- No change to `isThreadDetailEvent`. Session-set is already on the detail stream. Mobile and web pick this up through client-runtime; there are no app-level changes, and the web phone tier is not touched.

---

## 4. Contract and migration changes

- **Contracts:** see §3.1. Optional fields only.
  - An old server never sends them.
  - Old clients ignore `releasedTurn` and converge through the shell upsert, which carries the SQL `latestTurn`. For them the visible change is that Working ends a few milliseconds after the session goes idle, instead of never.
  - `OrchestrationTerminalTurnState` is frozen. New outcomes (for example usage limits) go into `reason` or a separate field.
- **Event log:** provider-originated `thread.turn-interrupt-requested` events are no longer written for provider aborts, idle reconciles or startup orphans. Old logs still contain them and still replay as today.
- **Migrations:** none.

---

## 5. Tests (failing-first where a bug)

Use `@effect/vitest` (`it.effect` under TestClock; `it.live` where real timers are needed). Run focused files only (§9).

### 5.1 Pure helpers

- `packages/shared/src/turnFinalization.test.ts`:
  - `mergeReleasedTurn` table: `running→{completed,error,interrupted}`, `pending→completed`, `completed→error` (`completedAt` = later), `completed→interrupted`, `interrupted+completed→interrupted` (`completedAt` kept), `error+completed→error`, sticky with null `completedAt` gets filled, `released.completedAt` before `startedAt` gets clamped.
  - `checkpointStatusToTurnState` and `laterIsoTimestamp`, the cases moved from ProjectionPipeline.
- `apps/server/src/orchestration/turnFinalization.test.ts`:
  - `runtimeTerminalTurnState`: `completed`, `failed`, `interrupted`, `cancelled`, `turn.aborted`.
  - `fallbackReleasedTurnState`: `error` → error; `ready`/`stopped`/`idle`/`starting` → interrupted (never completed).
  - `resolveReleasedTurn` table:
    - no candidate → undefined
    - same active turn kept → undefined
    - turn-less hint applies
    - hint for another turn is ignored → fallback
    - candidate from a `running` latestTurn with null `activeTurnId`
    - candidate from `activeTurnId` while latestTurn is `completed`
    - new active Y releases X with `interrupted`
    - **`session.updatedAt` earlier than `startedAt` → `completedAt === startedAt`**

### 5.2 Decider and in-memory model (`apps/server/src/orchestration/decider.turnFinalization.test.ts`, new; decider + `projectEvent`)

- **Failing-first (bug 1.3):**
  1. Create a project and thread, add a user message, dispatch session.set `running X`, then session.set `ready` with `turnOutcome {X, completed}` (exactly what ingestion now sends).
  2. Then decide `thread.turn.start` with a different `modelSelection.instanceId` (context handoff).
  3. Assert accepted. Today it is rejected at `commandInvariants.ts:96`, because `latestTurn` stays running.
  4. Also assert in-memory `latestTurn` = `{X, completed, completedAt ≥ startedAt}`.
- A session.set `error` release with no hint gives `releasedTurn.state === "error"`; `ready` with no hint gives `interrupted`.
- A legacy repair (same session, running latestTurn, null `activeTurnId`) gets `releasedTurn` with `reason startup-stale-turn`, and no `thread.unsnoozed` when `session.updatedAt < snoozedAt`.
- `thread.history.restore` with the active turn in `failedTurnIds` gives `releasedTurn {error, provider-history}`. Extend `providerHistoryRecovery.test.ts` with the end-to-end assertion.

### 5.3 Projections

- **`projector.test.ts`:**
  - Keep "preserves and settles the latest turn across session lifecycle events" (`:318`) unchanged. It proves that a payload without `releasedTurn` still preserves the turn.
  - Add `releasedTurn` cases: running→completed, interrupted sticky, `releasedTurn` naming another turn leaves `latestTurn` alone.
  - Diff cases: a placeholder `missing` for the running same turn keeps `running`; a late `ready` diff after release keeps the released state and `completedAt`.
- **`Layers/ProjectionPipeline.test.ts`:**
  - `releasedTurn` finalizes the row (`completed_at` set); a premature `completed` from a final message becomes `error` (case 6); `interrupted` stays sticky; an unknown `turnId` creates no row.
  - **Late diff `missing` after an interrupt keeps `interrupted`; late diff `ready` after an `error` release keeps `error`** (critique major 3); a diff for an existing running row keeps `running` and attaches checkpoint fields.
- **`Layers/turnFinalization.parity.test.ts` (new):** one scenario table run through `projectEvent` (`projector.ts`), through the projection pipeline and then `getCommandReadModel`, and through the client store's `applyOrchestrationEvents` (`@ryco/client-runtime/state/threads`; apps/server already depends on client-runtime). Assert identical `latestTurn {turnId, state}` and `completedAt` where all three track it. Scenarios:
  - (a) non-git turn, no text, completed
  - (b) failed after a final message
  - (c) Stop in git: interrupt, release, late `missing` diff
  - (d) placeholder diff mid-turn, then completed
  - (e) session replaced mid-turn

### 5.4 Ingestion (`Layers/ProviderRuntimeIngestion.test.ts`)

- **Failing-first `it.each`** over `turn.completed {completed|failed|interrupted|cancelled}` and `turn.aborted`, with no assistant text and no checkpoint (the harness has no git repo). Expect SQL `latestTurn.state` of `completed|error|interrupted|interrupted|interrupted` and a non-null `completedAt`. The session-set event carries the matching `releasedTurn`. No `thread.turn-interrupt-requested` event is stored.
- Update "maps turn.aborted into a terminal interrupted turn…" (`:1223`): assert `releasedTurn {turnId, interrupted, provider-turn-aborted}` on the session-set event instead of the interrupt `commandId`.
- Update "settles a stale projected turn when a recovered provider is already idle" (`:1369`): assert that the **same** session-set event (`activeTurnId: null`) carries `releasedTurn {interrupted, provider-session-idle}`. The ordering problem disappears because it is now one event.
- Add `session.exited` and `session.state.changed {stopped}` mid-turn → `interrupted`.
- **Late completion:** latest turn Y is `completed` and no turn is active; a `turn.completed {interrupted}` for older X leaves `latest_turn_id = Y` and creates no row for X (critique minor 4).
- **ACP race:** the session is already released by the reactor (`ready`, `activeTurnId: null`); then `turn.started X` and `turn.completed {failed}` X → X is `error` and the session is not `running`.
- **Failure after commentary:** a final assistant message, then `turn.completed {failed}` → SQL `error` and the shell would notify "failed" (case 6).

### 5.5 Reactor (`Layers/ProviderCommandReactor.test.ts`)

- **Failing-first (blocker 1):** a fake `sendTurn` dispatches session.set `running X` through the engine (simulating the ingested `turn.started`) and then fails with `ProviderAdapterRequestError`. Assert latestTurn `{X, error}` (**not** `completed`), session status `ready` with `lastError`, and a `provider.turn.start.failed` activity. Because `CompletionReturnDelivery` and the decider guard both require `completed`, no delegated return can be delivered.
- If the session is already `error` when the handler runs, it stays `error`.
- **Major 2:** with a running turn X projected, `thread.runtime-mode-set` restarts the session (extend `:2174`) → `releasedTurn {X, interrupted, session-replaced}` and latestTurn `interrupted`, never `completed`.
- `thread.session.stop` with a stale `lastError` during a running turn → `interrupted`.

### 5.6 Adapters and checkpoints

- `provider/acp/AcpAdapterSupport.test.ts`: the helper emits exactly once on a typed failure and on a defect, never on success, never on an interrupt-only cause, never when `isTerminalEmitted()`, and re-raises the original error.
- `Layers/CursorAdapter.test.ts`:
  - `prompt` failure after `turn.started` emits `turn.completed {state: failed, errorMessage}` with the same `turnId` and `runtimeSessionId`, then `sendTurn` fails.
  - A missing image attachment does the same.
  - A cancelled `stopReason` still emits a single `turn.completed {cancelled}`.
- `Layers/CheckpointReactor.test.ts`: in a git repo, a completed turn shows `completed` from the release; the later capture attaches the checkpoint without changing state or `completedAt`. A capture failure (activity only) still leaves the turn `completed` (case 3).

### 5.7 Startup and client

- **`serverRuntimeStartup.test.ts`:**
  - A stale running turn behind a `ready` session → `interrupted`; behind an `error` session → `error`. `completedAt` is the clamped `session.updatedAt`.
  - Exactly one session-set per repaired thread.
  - A `listSessions` failure still repairs stale turns.
  - The orphan path now writes a single session-set with `releasedTurn {interrupted, startup-orphaned-session}` and no `thread.turn-interrupt-requested`.
  - `getCommandReadModel` is called once.
- **`store.test.ts`:**
  - session-set `releasedTurn` settles the same turn, keeps a sticky `interrupted`, and ignores another turn.
  - A late diff keeps the state ("does not regress latestTurn when an older turn diff completes late" stays green).
  - A detail session-set with `releasedTurn` makes `deriveThreadActivityStatus` return `idle` immediately (no flash).
- `packages/contracts/src/orchestration.test.ts`: session-set payload decodes with and without `releasedTurn`; `turnOutcome` decodes on the internal command; an unknown `reason` string decodes.

---

## 6. Edge cases

- **Stop, then the provider reports `completed`:** stays `interrupted` (sticky). **Stop, then the provider never acknowledges:** the session stays `running`, which is unchanged and handled by the reaper or Stop retries.
- **`runtime.error` without a `turnId` mid-turn, after which the provider recovers:** the turn is released as `error` and stays `error` when the late named `turn.completed` arrives (sticky). This fails closed and is accepted.
- **ACP double failure:** the turn completes, but `ProviderService` bookkeeping (`directory.upsert`, or the model-selection commit) fails before ingestion projects `turn.completed`. The reactor's bound hint labels the turn `error`. This is rare and fails closed. provider-effect-outbox (W3) makes the model-selection commit log-only.
- **A running session-set for an already-interrupted turn re-opens it** (pre-existing, `ProjectionPipeline.ts:1731-1734`, `projector.ts:735`). The eventual release finalizes it again with precedence. Unchanged.
- **Diff for a non-latest turn** still moves the SQL and in-memory latest pointer (pre-existing, `ProjectionPipeline.ts:1144-1162`, `projector.ts:871`). The state now comes from the row or mapping. Owned by rollback-correctness.
- **Client `completedAt`:** `message-sent` sets `completedAt = payload.updatedAt` (`store.ts:1639-1643`), while SQL uses `laterIsoTimestamp`. After a release, all three converge on `later(existing, released, startedAt)`.
- **Startup repair bumps the repaired threads' `updatedAt` once** (projector `updatedAt: event.occurredAt`), which can move them in updatedAt-sorted lists.
- **Projection rebuild from old logs** re-creates the legacy stuck rows until the startup repair runs in the same boot.

---

## 7. Review resolution

| # | Severity | Decision | Reason |
| --- | --- | --- | --- |
| 1 | blocker | **Accepted, different mechanism.** | Reducers no longer infer from status, and the fallback is never `completed`. The reactor binds an `error` hint to its own started turn (`userMessageId`), keeps an existing `error` status, and ACP/Cursor now emit their own `turn.completed {failed}`, which also closes the race where `turn.started` lands after the reactor's release. Test §5.5. |
| 2 | major | **Accepted.** | `bindSessionToThread`, session stop and interrupt failure pass an explicit `interrupted` hint inside the same session-set. This is atomic, needs no extra provider-prefixed interrupt, and makes the label race-independent. The rule that explicit outcomes come first and the fallback is last resort is stated in §2. Test §5.5. |
| 3 | major | **Accepted, broadened.** | A checkpoint never changes an existing turn's state in any of the three reducers, and there is one shared status mapping. This also fixes mid-turn placeholder flips (case 5). The notification claim now holds. Tests §5.3. |
| 4 | minor | **Accepted.** | The provider interrupt dispatch is removed, and `resolveReleasedTurn` only finalizes the candidate turn. A hint naming another turn is ignored. Test §5.4. |
| 5 | minor | **Accepted.** | The clamp happens in the decider (`≥ startedAt/requestedAt`) and again in `mergeReleasedTurn` (`≥ current.startedAt`). Table rows §5.1. |
| 6 | minor | **Accepted, closed.** | An explicit release overrides a premature `completed` (the candidate is the previous `activeTurnId` even when latestTurn is `completed`). Tests §5.3 and §5.4. |
| 7 | minor | **Accepted.** | Decider/in-memory failing-first test, a three-reducer parity test, single-event ordering, ACP failure and rebind tests (§5). |
| 8 | minor | **Accepted.** | `runtimeTerminalTurnState` is one helper used by both the hint and `completionReturns.observe`. |
| 9 | minor | **Accepted.** | The repair reuses the snapshot that is already loaded, so there is no extra full load. Error-session labelling is explicit: `error` (§3.10). |
| 10 | minor | **Accepted.** | Overlaps are listed with function names. The `package.json` anchor is after `./threadActivity`. queue-hold-drain is told to key on Stop intent. |
| 11 | minor | **Accepted, resolved by construction.** | `releasedTurn` rides on the detail-stream session-set, so the open view never shows a release without its turn state. The `completedAt` note is corrected in §6. |

The verdict corrections (the detail-stream filter and the client's `completedAt`) are both taken into account. The design adds no new event type, partly for the `replayEvents` decode reason in §2.

---

## 8. Coordination notes

- **reactor-errors-switch (W1):** both packages edit `setThreadSessionErrorOnTurnStartFailure`/`handleTurnStartFailure` and `bindSessionToThread`. This package's hunks are a `messageId` argument, a `turnOutcome` field and one status expression. Whichever lands second rebases; keep the `error`-status preservation and the bound hint.
- **queue-hold-drain (W1):** `latestTurn.state === "interrupted"` now also results from provider cancellations (ACP/Cursor `cancelled`, Claude stream end), session replacement and startup repair. Key the Stop hold on the client's own Stop intent, or on a `thread.turn-interrupt-requested` whose `commandId` is not `provider:`-prefixed.
- **rollback-correctness (W2):** keep the rule that a checkpoint never changes an existing turn's state, and use `checkpointStatusToTurnState`.
- **usage-limits (W2):** report limit stops through `turnOutcome.reason` (for example `usage-limit`) or a new field, not a new terminal state.
- **delegation-returns (W2):** parents now reach `completed`/`interrupted`/`error` reliably. An `error` parent with a `ready` session still waits forever in `CompletionReturnDelivery` (`:366-372`); consider cancelling on `latestTurn.state === "error"` (fail-closed).
- **restart-continuation (W3):** find turns closed by restart via `releasedTurn.reason === "startup-orphaned-session"` in the event store, or via its own snapshot. Keep the single session-set form and do not reintroduce the separate interrupt dispatch.
- **provider-effect-outbox (W3):** its §1 "Interrupt" note about orphan reconciliation dispatching `thread.turn.interrupt` is superseded. It also adds a case to `applyThreadTurnsProjection`, next to the restructured session-set case.

---

## 9. Validation (proportional)

This is a cross-package contract change, so run `bun typecheck` and `bun run fmt:check`, plus focused tests:

```sh
bun run --cwd packages/shared test src/turnFinalization.test.ts
bun run --cwd packages/contracts test src/orchestration.test.ts
bun run --cwd apps/server test src/orchestration/turnFinalization.test.ts src/orchestration/decider.turnFinalization.test.ts src/orchestration/projector.test.ts src/orchestration/providerHistoryRecovery.test.ts src/orchestration/Layers/ProjectionPipeline.test.ts src/orchestration/Layers/turnFinalization.parity.test.ts src/orchestration/Layers/ProviderRuntimeIngestion.test.ts src/orchestration/Layers/ProviderCommandReactor.test.ts src/orchestration/Layers/CheckpointReactor.test.ts src/serverRuntimeStartup.test.ts src/provider/acp/AcpAdapterSupport.test.ts src/provider/Layers/CursorAdapter.test.ts
bun run --cwd packages/client-runtime test src/state/threads/store.test.ts src/state/threads/threadNotifications.test.ts
```

Never `bun test`. No full suite and no browser suite (no web interaction or layout change).

---

## 10. Out of scope

- OpenCode labels prompt request failures `interrupted`, because it uses `turn.aborted` (`OpenCodeAdapter.ts:2539`). Switching it to `turn.completed {failed}` is a one-line follow-up for whoever next owns OpenCodeAdapter (W3).
- Diff events moving the latest-turn pointer to older turns, and mid-turn real captures from placeholders (rollback-correctness).
- Non-latest `projection_turns` rows stuck `running`. They are not user-visible and are not repaired.
- Removing the premature `completed` that a final assistant message causes mid-turn in SQL and on the client. It is now corrected at release; removing it would touch the `message-sent` cases owned by delegation-guard-restart and acp-message-ids.
- Whether runtime or token mode changes should be allowed to restart a session mid-turn (a product decision). This package only labels the outcome correctly.
- `CompletionReturnDelivery` cancel semantics for `error` parents (delegation-returns).
