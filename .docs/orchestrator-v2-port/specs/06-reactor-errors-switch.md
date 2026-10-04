# 06 · reactor-errors-switch: model switches never restart a session, plain-language reactor errors, and visible turn-start failures (bugs 9, 12, t3 #15048)

| Field | Value |
| --- | --- |
| id | `reactor-errors-switch` |
| title | Stop restarting provider sessions on model changes (fixes ACP registry "Agent default" restarts and the silent Grok context loss), map reactor failures to short user-facing text while logging the full cause, and put every turn-start preparation step (reactor and context-handoff coordinator) behind one visible failure boundary that never clobbers a concurrently running turn |
| wave | 1 (parallel, isolated worktree) |
| verdict | **partially-confirmed**. **(a) refuted as stated, real defects found.** The reactor drops the cursor, but `ProviderService.startSession` restores it from the persisted binding (`ProviderService.ts:971-976`). The real model-switch defects are: (i) ACP registry agents on "Agent default" restart on **every** turn after the first, because of a false-positive model change. Strict agents without load or resume support then break permanently from turn 2 on. (ii) A real Grok model switch restarts the session, and the non-strict ACP resume fallback can silently start a new, empty conversation. **(b) confirmed.** **(c) confirmed and wider than claimed:** the user-message count read, the context-handoff branch reads and lease, and `ContextHandoffCoordinator.processTurnStart`'s own reads all fail silently |
| size | M |
| touched files | `apps/server/src/orchestration/userFacingErrors.ts` (new) · `apps/server/src/orchestration/providerFailureActivity.ts` (new) · `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` · `apps/server/src/orchestration/Layers/ContextHandoffCoordinator.ts` · `apps/server/src/orchestration/contextHandoff/ContextHandoffBuilder.ts` (import move only) · `apps/server/src/orchestration/contextHandoff/ContextHandoffRenderer.ts` (import move only) · `packages/shared/src/String.ts` · `apps/server/src/provider/Layers/AcpAdapter.ts` (capability default, one line) · `apps/server/src/provider/Services/ProviderAdapter.ts` (doc comment only) · `docs/providers/grok.md` · tests: `apps/server/src/orchestration/userFacingErrors.test.ts` (new), `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`, `apps/server/src/orchestration/Layers/ContextHandoffCoordinator.test.ts`, `apps/server/src/provider/Layers/GrokAdapter.test.ts`, `packages/shared/src/String.test.ts` |
| migrations | none |
| contract changes | none in `packages/contracts`. Text changes only: `payload.detail` of `provider.*.failed` activities, `OrchestrationSession.lastError`, goal `synchronization.error`, steer rejection `error` and context-handoff `error` now carry short user-facing text instead of `Cause.pretty` dumps, bounded to 1,000 characters (2,000 for handoff). Internal server contract: the meaning of `ProviderSessionModelSwitchMode` changes (see §3.9). `"unsupported"` now means "reject a known model change", no longer "restart the session". The ACP adapter default becomes `"in-session"` |
| overlaps | `queue-hold-drain` (W1): consumers of `provider.turn.start.failed` / `session.lastError`, `createHarness` options, `appendProviderFailureActivity` (extracted here). `claude-meter-wake` (W1): wake-turn race guarded by `setThreadSessionErrorOnTurnStartFailure`'s new `preserveActiveTurn`. `acp-message-ids` (W1): `AcpAdapter.ts` (capabilities getter only), `GrokAdapter.test.ts` (one added case). `provider-compat` (W1): `ContextHandoffCoordinator.test.ts` `makeHarness`. `settlement-signals` (W1): `packages/shared` (we touch only `src/String.ts`). `claude-steering` (W2): `processTurnSteerRequested` catch block, `ProviderAdapter.ts` capability block. `delegation-returns` (W2): `processTurnStartRequested` return-guard block (moved unchanged). `usage-limits` (W2): extension point in `userFacingErrors.ts`. `reactor-concurrency`, `provider-effect-outbox`, `restart-continuation` (W3): named follow-ups. Details in §8 |

---

## 1. Problem (verified against the code, 2026-10-04)

### 1.1 (a) Model switch: the claim is refuted, but two real defects exist

**The claim does not hold.** On a model change with `sessionModelSwitch: "unsupported"`, the reactor restarts with `resumeCursor = undefined`:
- `ProviderCommandReactor.ts:698` sets `shouldRestartForModelChange`;
- `:717-719` drops the cursor, then calls `startProviderSession(undefined)`.

But `ProviderService.startSession` reads the persisted binding (`ProviderService.ts:956`). At `:971-976` it falls back to `persistedBinding.resumeCursor` whenever the instance matches and `resumePolicy !== "fresh"`. The reactor never sets `resumePolicy`. The directory upsert also keeps the existing cursor (`ProviderSessionDirectory.ts:145-150`). So the restart does resume natively.

The `undefined` cursor is left over from the old `"restart-session"` mode for Cursor (`17e6cad47`, renamed in `9c64f12ea`). It became dead intent once the persisted fallback was added.

**Who reports `"unsupported"`.** Only `AcpAdapter` does, and it is used by Grok and the ACP registry (`rg sessionModelSwitch`):
- `AcpAdapter.ts:1074-1076` defaults to `"unsupported"`. Grok passes no override (`GrokAdapter.ts:11-23`).
- The registry driver computes `"in-session"` only when the agent advertises `models` or a model config option (`AcpRegistryDriver.ts:186,206-208`).

**Defect (i): a false-positive model change on registry "Agent default".**
- The registry catalog offers the slug `"default"` (`AcpRegistryDriver.ts:34-41`).
- `normalizeModel` maps it to `""` (`:193`).
- `AcpAdapter.startSession` then binds no model and omits `session.model` (`AcpAdapter.ts:607-627`).
- The client always sends `modelSelection` (`packages/client-runtime/src/state/composer/sendEngine.ts:321`).
- So on every turn after the first, `modelChanged` (`ProviderCommandReactor.ts:692-694`) compares `"default"` with `undefined`. The result is true, and the reactor restarts.

Registry agents use `strictResume: true` (`AcpRegistrySupport.ts:54`). An agent that advertises neither `loadSession` nor `resume` therefore fails that restart with "This agent does not advertise session loading or resumption." (`AcpSessionRuntime.ts:473-484`). `ProviderService` has already stopped the live runtime before the start (`ProviderService.ts:957-968`). Every later turn retries the same strict resume, so the thread is permanently broken after turn 1. Agents that do support load pay a full process respawn and reload on every turn.

**Defect (ii): silent context loss on a real Grok model switch.**
- Grok is `"unsupported"`, so picking another model restarts the session.
- Grok resumes **non-strictly**. If `session/load` fails, the runtime silently creates a new session (`AcpSessionRuntime.ts:500-505`) and the conversation is gone without any signal. This is the brief's "silently loses the conversation".

**The restart gains nothing for any ACP adapter:**
- Neither Grok (`GrokAcpSupport.ts:42`, `args: ["agent", "stdio"]`) nor registry agents (`AcpRegistrySupport.ts:57-63`) put the model into the spawn arguments.
- After a restart, the model is applied by `applyAcpModelSelection`, which calls `session/set_model` on the resumed session (`AcpAdapter.ts:607-614`).
- `AcpAdapter.sendTurn` already makes that same call on the live session for every turn that carries a `modelSelection` (`AcpAdapter.ts:802-816`, `AcpModelSelection.ts:21-36`, `AcpSessionRuntime.ts:626-643`).

So restart, then `load`, then `set_model` is strictly worse than an in-session `set_model`. t3 makes the same call: `acpSelectionTransition` returns `apply_on_next_turn`, or `reject` when the session exposes no model switch. It never restarts (`t3:orchestration-v2/ProviderSelectionTransition.ts:24-37`).

### 1.2 (b) Raw `Cause.pretty` reaches users

- `formatFailureDetail` (`ProviderCommandReactor.ts:319-328`) returns `Cause.pretty(cause)` for every error that is not a `ProviderAdapterRequestError`. That includes SQL errors, defects, `ProviderSessionNotFoundError` and plain `Error`s. It feeds:
  - the turn-start failure activity and `session.lastError` (`:1161`);
  - the interrupt failure (`:1367`);
  - the goal sync error (`:806`, `:1462`);
  - the steer rejection (`:1563`).
- The approval and user-input respond failure uses `Cause.pretty(cause)` unconditionally (`:1661`).
- Nothing truncates these strings.
- Clients only strip transport errors (`transportError.ts:21-23`). `lastError` reaches the inbox row as `errorDetail` (`apps/web/src/components/inboxSidebar/inboxSidebarModel.ts:500`).
- An empty `ProviderAdapterRequestError.detail` yields `""`, which then fails the `TrimmedNonEmptyString` check on `lastError` (`packages/contracts/src/orchestration.ts:764`), so the session write itself fails.

### 1.3 (c) Swallowed turn-start failures

In `processTurnStartRequested` (`:1117-1337`), these steps run before or outside the local failure handler:
- `resolveThread` (`:1125`);
- the "turn start rejected" and "message not found" activity dispatches (`:1129-1153`);
- `resolveTurnStartMessage` (`:1142`);
- `resolveUserMessageCount` (`:1156`);
- the context-handoff branch's `resolveProject` (`:1254`) and `leaseThreadPath` (`:1262`);
- the first-turn `resolveProject` (`:1292`).

A failure in any of them propagates to `processDomainEventSafely` (`:1790-1801`), which only logs it. The user message stays saved, no turn starts and nothing is shown.

The same gap exists inside `ContextHandoffCoordinator.processTurnStart` (`ContextHandoffCoordinator.ts:967-1017`). These steps all run before `prepareAndDispatch`'s `catchCause` (`:813`):
- `resolveThread` (`:274-275`, `:972`);
- `repository.create` and `getById` (`:983-1000`);
- inside `runPreparing`: `compareAndSetStatus`, `resolvePresentation` and `providerService.getSession` (`:785-800`).

The outer catch (`:1008-1016`) logs "context handoff processing failed" **without the cause**. A record whose create succeeded and whose compare-and-set to `preparing` failed stays `requested` forever. A record that reached `preparing` is silently re-dispatched by `recover()` on the next server start (`:1019-1032`, `listRecoverable` picks `preparing` and `dispatching`, `ContextHandoffs.ts:171`), after the user already gave up on it.

The existing handler has two more faults:
1. `setThreadSessionErrorOnTurnStartFailure(...).pipe(Effect.flatMap(() => append activity))` (`:1166-1180`): when the session write fails, the visible activity is never appended.
2. `setThreadSessionErrorOnTurnStartFailure` (`:343-365`) unconditionally writes `status: "ready", activeTurnId: null`. That is safe only because, today, the active-turn check at `:1128` passed earlier.

---

## 2. Approach

1. **(a) No restarts on a model change.**
   - Model changes are applied to the live session on the next turn (`"in-session"`).
   - A session that cannot switch models (`"unsupported"`) **rejects** a known model change with a clear message.
   - An unknown active model (`session.model === undefined`) is never treated as a change.
   - The ACP adapter default becomes `"in-session"` because `sendTurn` already applies the model.
   - All remaining restarts (runtime mode, token mode, cwd, instance, Claude selection) pass the active resume cursor explicitly.
   - This fixes defect (i) and removes the model-switch route into defect (ii). The non-strict fallback on *other* restarts is a named follow-up (§7).
2. **(b) One pure mapping module, `orchestration/userFacingErrors.ts`.**
   - It turns a `Cause` into short, bounded, non-empty text.
   - Known error classes are matched with `Schema.is` against real class imports, so a renamed class fails typecheck.
   - Unknown failures use `detail`, then `Error.message`. Defects and interrupts fall back to a generic message.
   - Every handler that **swallows** a cause logs `Cause.pretty(cause)` plus a `failureTag`. Handlers that re-raise do not log, because `processDomainEventSafely` already does, so nothing is logged twice.
3. **(c) One turn-start boundary in the reactor plus a pre-dispatch reporter in the coordinator.**
   - `processTurnStartRequested` becomes dedupe plus `prepareAndSubmitTurnStart(event).pipe(catchCause(reportTurnStartFailure))`.
   - Essential reads fail the turn visibly. Best-effort reads (the first-turn message count, the first-turn project read for title and branch generation) log and continue.
   - In the preparation phase, the session update is skipped while another turn is running.
   - The coordinator reports its own pre-dispatch failures. It logs the cause, moves a `requested` or `preparing` record to `failed` so `recover()` cannot re-dispatch it, and appends `provider.turn.start.failed` for the target message. Its interface stays `Effect<void>`.
   - A shared `providerFailureActivity.ts` builds the activity command for both the reactor and the coordinator.

---

## 3. Step-by-step changes

### 3.1 `packages/shared/src/String.ts`: move `truncateUnicodeSafe`

Move `truncateUnicodeSafe(value, maxChars)` from `apps/server/src/orchestration/contextHandoff/ContextHandoffBuilder.ts:219-238` into `String.ts`, next to `truncate`, with the body unchanged. The `./String` subpath export already exists (`packages/shared/package.json:170-173`).

Update the three importers to `import { truncateUnicodeSafe } from "@ryco/shared/String"`:
- `ContextHandoffBuilder.ts`: delete the local definition and import it.
- `ContextHandoffRenderer.ts:18`: drop it from the `./ContextHandoffBuilder.ts` import list.
- `ContextHandoffCoordinator.ts:65`.

### 3.2 `apps/server/src/orchestration/userFacingErrors.ts` (new, pure, no services)

```ts
import { Cause, Schema } from "effect";
import { truncateUnicodeSafe } from "@ryco/shared/String";
import {
  PersistenceDecodeError, PersistenceSqlError,
  ProviderSessionRepositoryPersistenceError, ProviderSessionRepositoryValidationError,
} from "../persistence/Errors.ts";
import {
  ProviderAdapterSessionClosedError, ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError, ProviderInstanceNotFoundError,
  ProviderSessionDirectoryPersistenceError, ProviderSessionNotFoundError,
  ProviderUnsupportedError, ProviderValidationError,
} from "../provider/Errors.ts";

export const USER_FACING_ERROR_MAX_CHARS = 1_000;
export const UNEXPECTED_FAILURE_DETAIL =
  "Ryco hit an unexpected error. Check the server logs for details.";
export const STORAGE_FAILURE_DETAIL =
  "Ryco could not read or save its local state. Try again. If this keeps happening, check the server logs.";

/** Ordered, first match wins. Guards use real class imports so renames fail typecheck. */
const KNOWN_FAILURES: ReadonlyArray<(error: unknown) => string | undefined> = [
  (e) => (isStorageError(e) ? STORAGE_FAILURE_DETAIL : undefined),
  (e) => (Schema.is(ProviderSessionNotFoundError)(e) || Schema.is(ProviderAdapterSessionNotFoundError)(e)
    ? "The provider session is no longer running." : undefined),
  (e) => (Schema.is(ProviderAdapterSessionClosedError)(e) ? "The provider session has closed." : undefined),
  (e) => (Schema.is(ProviderInstanceNotFoundError)(e) ? `Provider instance '${e.instanceId}' is not configured.` : undefined),
  (e) => (Schema.is(ProviderUnsupportedError)(e) ? `Provider '${e.provider}' is not available in this build.` : undefined),
  (e) => (Schema.is(ProviderAdapterValidationError)(e) || Schema.is(ProviderValidationError)(e) ? e.issue : undefined),
];

export function userFacingFailureDetail(
  cause: Cause.Cause<unknown>,
  options?: { readonly fallback?: string; readonly maxChars?: number },
): string;
export function failureTag(cause: Cause.Cause<unknown>): string; // _tag | Error.name | "defect" | "interrupt" | "unknown"
```

Rules for `userFacingFailureDetail`:
1. Take the first `Cause.isFailReason` reason. With no Fail reason (defect-only or interrupt-only), return the fallback. Defect messages are internal invariants, so they go to logs only.
2. For a Fail value, apply the first match:
   - a string as-is;
   - the first `KNOWN_FAILURES` match;
   - a non-empty string `detail` field. This covers `ProviderAdapterRequestError`, `ProviderAdapterProcessError`, `ProviderDriverError`, `GitCommandError`, `TextGenerationError` and the orchestration dispatch errors;
   - `Error.message`;
   - otherwise nothing.
3. Bound the text: `truncateUnicodeSafe(text.trim(), maxChars).trimEnd()`. If the result is empty, return the bounded fallback.
   - Default `maxChars` is `USER_FACING_ERROR_MAX_CHARS`.
   - Default fallback is `UNEXPECTED_FAILURE_DETAIL`.
   - The result therefore always satisfies `TrimmedNonEmptyString` and `isMaxLength(maxChars)`, as required by the steer `error` schema (`packages/contracts/src/orchestration.ts:1822`) and the handoff `error` schema (`ContextHandoffs.ts:31`).

Leave the classifiers `findProviderAdapterRequestError`, `isUnknownPendingApprovalRequestError` and `isUnknownPendingUserInputRequestError` (`ProviderCommandReactor.ts:191-219`) on `Cause.pretty`. That is internal classification, not displayed text.

### 3.3 `apps/server/src/orchestration/providerFailureActivity.ts` (new, pure)

Move the input type of `appendProviderFailureActivity` (`ProviderCommandReactor.ts:275-317`) here, with its kinds union and optional identity, attempt and state fields unchanged, as `ProviderFailureActivityInput`. Export:

```ts
export function providerFailureActivityCommand(
  input: ProviderFailureActivityInput,
): Extract<OrchestrationCommand, { type: "thread.activity.append" }>;
```

It builds exactly today's command: `commandId: server:provider-failure-activity:<uuid>`, `tone: "error"`, and the same payload key order.

### 3.4 `ProviderCommandReactor.ts`: shared helpers

1. `appendProviderFailureActivity` (`:275-317`) becomes `(input: ProviderFailureActivityInput) => orchestrationEngine.dispatch(providerFailureActivityCommand(input))`.
2. Delete `formatFailureDetail` (`:319-328`).
3. `setThreadSessionErrorOnTurnStartFailure` (`:343-365`) gains `readonly preserveActiveTurn: boolean`. After the re-read, add: `if (input.preserveActiveTurn && session.status === "running" && session.activeTurnId !== null) return;`. In that case only the activity is appended. A comment states the reason: nothing was submitted by this request, so a running turn belongs to someone else (a wake turn, a goal resume, a provider-originated turn).
4. Add `reportTurnStartFailure` at reactor level, replacing the per-event `handleTurnStartFailure` and `recoverTurnStartFailure` (`:1157-1196`):

```ts
const reportTurnStartFailure = (input: {
  readonly event: TurnStartRequestedEvent; // Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>
  readonly cause: Cause.Cause<unknown>;
  readonly preserveActiveTurn: boolean;
}): Effect.Effect<void> => {
  const { event, cause } = input;
  // Interrupt-only: no activity. Do not re-raise. A propagated interrupt ends the
  // DrainableWorker loop (packages/shared/src/DrainableWorker.ts:58-66) and stops the reactor.
  if (Cause.hasInterruptsOnly(cause)) return Effect.void;
  const threadId = event.payload.threadId;
  const detail = userFacingFailureDetail(cause);
  return Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ "orchestration.failure_tag": failureTag(cause) });
    yield* Effect.logWarning("provider command reactor failed to start turn", {
      threadId, messageId: event.payload.messageId, commandId: event.commandId,
      failureTag: failureTag(cause), cause: Cause.pretty(cause),
    });
    if (!event.payload.delegationReturnGuard) {
      yield* setThreadSessionErrorOnTurnStartFailure({
        threadId, detail, createdAt: event.payload.createdAt,
        preserveActiveTurn: input.preserveActiveTurn,
      }).pipe(Effect.catchCause((sessionCause) =>
        Effect.logWarning("provider command reactor failed to record turn start failure on the session",
          { threadId, cause: Cause.pretty(sessionCause) })));
    }
    yield* appendProviderFailureActivity({
      threadId, kind: "provider.turn.start.failed", messageId: event.payload.messageId,
      summary: "Provider turn start failed", detail, turnId: null, createdAt: event.payload.createdAt,
    });
  }).pipe(Effect.catchCause((recoveryCause) =>
    Effect.logWarning("provider command reactor failed to recover turn start failure", {
      eventType: event.type, threadId,
      cause: Cause.pretty(recoveryCause), originalCause: Cause.pretty(cause),
    })));
};
```

The order stays session write, then activity, as today. A failing session write no longer suppresses the activity.

### 3.5 `ProviderCommandReactor.ts`: turn-start boundary (`:1117-1337`)

Split the function into two:

```ts
const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (event) {
  const key = turnStartKeyForEvent(event);
  if (yield* hasHandledTurnStartRecently(key)) return;
  yield* prepareAndSubmitTurnStart(event).pipe(
    Effect.catchCause((cause) => reportTurnStartFailure({ event, cause, preserveActiveTurn: true })),
  );
});
const prepareAndSubmitTurnStart = Effect.fn("prepareAndSubmitTurnStart")(function* (event) {
  /* today's body from :1124 on, with the edits below */
});
```

Edits inside `prepareAndSubmitTurnStart`:
- **Essential reads stay plain `yield*`**, so their failures reach the boundary: `resolveThread`, the rejection and not-found activity dispatches, and `resolveTurnStartMessage`. The `!thread` early return stays silent (deleted thread).
- **The user-message count becomes best-effort** (`:1156`):

  ```ts
  const isFirstUserMessageTurn = yield* resolveUserMessageCount(threadId).pipe(
    Effect.map((count) => count === 1),
    Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause)
      : Effect.logWarning("provider command reactor could not count user messages; skipping first-turn generation",
          { threadId, cause: Cause.pretty(cause) }).pipe(Effect.as(false))),
  );
  ```

- **Retired memory** (`:1198-1202`): `return yield* Effect.fail(new Error(REMOVED_PROJECT_MEMORY_MESSAGE));`. The boundary reports it; the detail is the same message.
- **Delegated return guard** (`:1204-1240`): move it **byte-for-byte**. The only change is that the `getSession` catch calls `reportTurnStartFailure({ event, cause, preserveActiveTurn: true }).pipe(Effect.as(Option.none()))`. The session is skipped because of the guard. The resulting double activity is a named follow-up for `delegation-returns`.
- **Handoff branch** (`:1242-1268`): remove the local `worktreeReady` catch and write `yield* ensureRecordedWorktreeAvailable(thread, project);`. Failures of `resolveProject`, the worktree check and `leaseThreadPath` now reach the boundary.
- **`buildSendTurnRequestForThread`** (`:1270-1289`): remove the local `catchCause` and the `Option` wrapping, and write `const sendTurnRequest = yield* buildSendTurnRequestForThread({...})`. Update the `.value` uses.
- **First-turn generation** (`:1291-1319`): wrap the whole block (the `resolveProject` read plus both `forkScoped` generators) in `Effect.gen(...)` with `catchCause`. The handler re-raises interrupt-only causes, otherwise it calls `Effect.logWarning("provider command reactor skipped first-turn generation", { threadId, cause: Cause.pretty(cause) })`. Title and branch generation is best-effort and must never fail a turn whose session is already started.
- **Forked `sendTurn`** (`:1332-1336`): `Effect.catchCause((cause) => reportTurnStartFailure({ event, cause, preserveActiveTurn: false }))`. This keeps today's behaviour for submission failures, because the active turn may be this request's own.

### 3.6 `ProviderCommandReactor.ts`: model switch in `ensureSessionForThread` (`:681-760`)

Replace `modelChanged`, `shouldRestartForModelChange` and the restart condition with:

```ts
const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId)).sessionModelSwitch;
const instanceChanged = requestedModelSelection !== undefined &&
  activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
// A model change never restarts a session. "in-session" adapters apply
// sendTurn.modelSelection to the live session. A session that cannot switch
// rejects a *known* change. An unknown active model (undefined) is never a change.
const activeModel = activeSession?.model;
if (sessionModelSwitch === "unsupported" && requestedModelSelection !== undefined &&
    !instanceChanged && activeModel !== undefined && requestedModelSelection.model !== activeModel) {
  return yield* new ProviderAdapterRequestError({
    provider: preferredProvider,
    method: "thread.turn.start",
    detail: `This provider session cannot switch from model '${activeModel}' to '${requestedModelSelection.model}'. Start a new thread to use '${requestedModelSelection.model}'.`,
  });
}
// The restart condition drops shouldRestartForModelChange. Everything else is unchanged:
// computerCatalogChanged, runtime mode, token mode, cwd, instance, Claude selection rule.
const resumeCursor = activeSession?.resumeCursor ?? undefined; // always the explicit active cursor
```

In the restart log, remove `modelChanged` and `shouldRestartForModelChange` and add `sessionModelSwitch`. Leave `buildSendTurnRequestForThread`'s `"unsupported"` model pinning (`:951-972`) unchanged. It is harmless and keeps the live model for turns that carry no selection.

### 3.7 `ProviderCommandReactor.ts`: the other failure sites (b)

| Site | Change | Log |
| --- | --- | --- |
| `reconcileThreadGoal` catch (`:806`) | `userFacingFailureDetail(cause)` | none (re-raised, logged once by `processDomainEventSafely`) |
| `processGoalUpdated` session catch (`:1462`) | `userFacingFailureDetail(cause)` | none (re-raised) |
| `recoverInterruptFailure` (`:1367`) | `userFacingFailureDetail(cause)` | `logWarning("provider command reactor failed to interrupt turn", { threadId, failureTag, cause: Cause.pretty(cause) })` first in the non-interrupt branch, because it swallows the cause today |
| `processTurnSteerRequested` catch (`:1562-1571`) | `error = userFacingFailureDetail(cause, { fallback: "Provider rejected turn steering." })`. This replaces the manual trim, slice and fallback, with the same bound | `logWarning("provider command reactor failed to steer turn", …)` |
| `processCallbackResponseRequested` `onFailure` (`:1661`) | the non-stale branch uses `userFacingFailureDetail(cause)`. The stale branch, `stalePendingRequestDetail` and the `responseState` logic stay **unchanged** | `logWarning("provider command reactor failed to deliver <kind> response", …)` |

**Stale-detail invariant (must hold).** Stale detection happens before formatting, on a superset of the displayed text: `error.detail`, or `Cause.pretty` covering every message. So a non-stale detail can never contain the stale phrases. These parsers keep working without changes:
- server: `ProjectionPipeline.ts:222-230`, `threadShellSummaryProjection.ts:58-62`, migration `024_*` (historic);
- client: `packages/shared/src/threadActivity.ts:101-114`, `packages/client-runtime/src/state/session/session-logic.ts:310-322`.

### 3.8 `ContextHandoffCoordinator.ts`

1. Replace the `boundedFailureDetail` body (`:118-131`) with `userFacingFailureDetail(cause, { fallback: "The target provider did not accept the context handoff.", maxChars: CONTEXT_HANDOFF_ERROR_MAX_CHARS })`. Keep the function name for its single caller (`:457`).
2. Add `reportPreDispatchFailure({ event, reference, cause })`. The catch in `processTurnStart` (`:1008-1016`) calls it for non-interrupt causes. Interrupts stay `Effect.interrupt`, as today. Steps, each with its own `catchCause` that logs and continues:
   1. `logWarning("context handoff processing failed", { operation: "context-handoff-processing", handoffId, threadId, failureTag, cause: Cause.pretty(cause) })`.
   2. `repository.getById(handoffId)`. A failed read means the state is unknown: append the activity anyway.
   3. If the record is `dispatching`, `consumed`, `failed` or `delivery-uncertain`, **return**. The record lifecycle owns the signal: finalize, or reconcile on recovery. Delivery may have happened, so the coordinator must never claim the start failed.
   4. If the record is `requested` or `preparing`, call `compareAndSetStatus({ expectedStatus: record.status, nextStatus: "failed", targetRuntimeSessionId: record.targetRuntimeSessionId, acceptedProviderTurnId: record.acceptedProviderTurnId, error: detail, updatedAt: nowIso() })`. On a transition, increment `contextHandoffsTotal{status:"failed"}`. `preparing` means not yet sent, because `dispatching` is persisted before `sendTurn` (`:724-735`). So this is safe, and it stops `recover()` from re-dispatching later. If the compare-and-set returns false, the record moved on concurrently (possibly to `dispatching`), so **return** without an activity. On a transition, finish the claimed failure best-effort: re-read the thread, resolve the presentation, roll back a reserved target epoch (`targetRuntimeSessionId !== null`: stop and retire the target binding, restore the source), and replace the decider's `requested` handoff activity with a terminal `failed` one. Nothing touches a `failed` record again, so this is the only place that can unblock later handoffs on the thread.
   5. Dispatch `providerFailureActivityCommand({ threadId, kind: "provider.turn.start.failed", messageId: reference.targetMessageId, summary: "Provider turn start failed", detail, turnId: null, createdAt: event.payload.createdAt })`.

   `detail` is `userFacingFailureDetail(cause, { maxChars: CONTEXT_HANDOFF_ERROR_MAX_CHARS })`. **Amended in review:** a `preparing` record may already have projected the target session as `starting` and called `startFreshSession` (which replaces the source binding) before `dispatching` was persisted, so the source is restored whenever a target epoch was reserved. A `requested` record never touches a runtime. The reporter runs inside the handoff's in-flight guard, and `recover()` takes the same guard per record. Backstop for paths that cannot finalize the activity (thread unreadable, or the reactor failed before the coordinator ran): `hasActionableContextHandoff` (`commandInvariants.ts`) ignores a `requested`/`preparing` handoff whose `targetMessageId` already has a `provider.turn.start.failed` activity, because nothing was sent before `dispatching`.
3. Add `cause: Cause.pretty(cause)` to the `recover()` log (`:1036-1043`), which today drops it too.

### 3.9 Provider capability semantics

- `apps/server/src/provider/Services/ProviderAdapter.ts:35-38`: change the doc comment to:
  - `"in-session"`: the adapter applies `sendTurn.modelSelection` to the live session.
  - `"unsupported"`: the live session cannot change model. Ryco rejects a turn that requests a model other than the session's known model, and never restarts a session to change model.
- `apps/server/src/provider/Layers/AcpAdapter.ts:1075`: change the default to `options.getSessionModelSwitch?.() ?? "in-session"`, with a comment: `sendTurn` applies the model through `applyAcpModelSelection`. Drivers override this only when the agent advertises no model API.
  - Grok becomes `"in-session"`.
  - The registry driver is unchanged: its `"unsupported"` agents never have a known `session.model`, so they are never rejected and never restarted.
- `docs/providers/grok.md:43-44`: replace "Changing the model on an active Grok thread requires starting a new thread." with "Changing the model on an active Grok thread applies the new model to the same Grok session on the next message; the conversation is kept."

---

## 4. Contract and migration changes

- No schema changes and no migrations.
- Text changes only, listed in the header.
- The internal capability meaning changes as described in §3.9.
- Downstream consumers that change **intentionally**:
  - `LocalTaskService.ts:106-109` treats any `provider.turn.start.failed` with the delegated `messageId` as a failed task. Delegated tasks that used to hang in `starting` (swallowed reads, coordinator pre-dispatch failures) now show `failed`.
  - Queue guards in `queue-hold-drain` and the inbox `errorDetail` see more of these signals.
- **Rule for every consumer:** match on activity `kind`, `responseState` or session `status`, never on `detail` text.

---

## 5. Tests

Run with `bun run --cwd apps/server test <file>` and `bun run --cwd packages/shared test src/String.test.ts`. Never use `bun test`. Tests marked **[failing-first]** fail on the current code.

### 5.1 `apps/server/src/orchestration/userFacingErrors.test.ts` (new, `@effect/vitest`, pure)

Each case builds a cause with `Cause.fail`, `Cause.die` or `Cause.interrupt`:
1. `ProviderAdapterRequestError` returns `detail`, unchanged.
2. `PersistenceSqlError` returns `STORAGE_FAILURE_DETAIL`. The text does not contain `"SQL"`, `"PersistenceSqlError"` or the operation name.
3. `ProviderSessionNotFoundError` and `ProviderAdapterSessionNotFoundError` return the session text. `ProviderInstanceNotFoundError` names the instance id.
4. `ProviderAdapterValidationError` returns `issue`.
5. A `GitCommandError` returns `detail`, not the verbose `message`. A plain `new Error("boom")` returns `"boom"`. A string failure returns the string.
6. A defect returns `UNEXPECTED_FAILURE_DETAIL`. A custom `fallback` is respected. An interrupt-only cause returns the fallback.
7. A whitespace-only or empty `detail` returns the fallback.
8. A 1,500-character detail returns 1,000 characters or fewer, with no trailing whitespace. A surrogate pair at the boundary is not split. A custom `maxChars` is respected.
9. The output never contains `"\n    at "` (no stack frames), whatever the input.
10. `failureTag` returns `_tag`, `"defect"` or `"interrupt"`.

### 5.2 `packages/shared/src/String.test.ts`

Cases for `truncateUnicodeSafe`:
- a shorter string is unchanged;
- a long string is cut at `maxChars`;
- a high surrogate at the boundary is dropped;
- `maxChars <= 0` gives `""`.

### 5.3 `ProviderCommandReactor.test.ts`

Harness additions to `createHarness`. Keep them additive, because other W1 packages add options too:
- `sessionModel?: (model: string) => string | undefined`. The `startSession` mock uses it for `session.model`, to simulate adapter normalization.
- `steerTurn?: ProviderServiceShape["steerTurn"]`.
- `decorateSnapshotQuery?: (live: ProjectionSnapshotQueryShape) => ProjectionSnapshotQueryShape`, implemented as `Layer.effect(ProjectionSnapshotQuery, Effect.map(ProjectionSnapshotQuery.asEffect(), decorate)).pipe(Layer.provide(projectionSnapshotLayer))`. Tests use it for one-shot failure hooks armed after setup. Only the reactor resolves this service: the engine has its own query layer.

**(a) Model switch**
1. **[failing-first] "does not restart a session whose model is unknown when the client resends the agent default".**
   - Setup: `sessionModelSwitch: "unsupported"`, `sessionModel: (m) => (m === "default" ? undefined : m)`, thread model `{codex, "default"}`.
   - Action: two turns, each with `modelSelection {codex, "default"}`.
   - Expect `startSession` called once, `sendTurn` called twice, no `provider.turn.start.failed`, and `session.runtimeSessionId === "runtime-1"`.
2. **[failing-first] "rejects a genuine model switch on a session that cannot switch models, without restarting".**
   - Setup: `"unsupported"`. Turn 1 uses `gpt-5-codex`; turn 2 uses `modelSelection {codex, "gpt-5.1-codex"}`.
   - Expect `startSession` called once and `sendTurn` called once.
   - Expect one failure activity for message 2, with a detail containing `"cannot switch"` and `"Start a new thread"`.
   - Expect `session.runtimeSessionId` still `"runtime-1"` and `session.lastError` equal to that detail.
   - No `stopSession` assertion: `ProviderService` stops internally, so that assertion would be vacuous.
3. "applies an in-session model switch on the next turn without restarting" (regression lock).
   - Setup: default `"in-session"`; turn 2 uses a different model.
   - Expect `startSession` called once and `sendTurn.mock.calls[1][0].modelSelection.model` equal to the new model.
4. The existing test "restarts the provider session when runtime mode is updated" (`:2174`, cursor assertion at `:2246`) keeps covering the explicit active resume cursor. No new test is needed, because the change is behaviour-neutral.

**(b) User-facing text**

5. **[failing-first] "shows a short storage message instead of a raw cause when session start fails".**
   - Setup: `startSession.mockImplementationOnce(() => Effect.fail(new PersistenceSqlError({ operation: "ProviderSessionDirectory.upsert", detail: "Failed to execute ProviderSessionDirectory.upsert" })))`.
   - Expect the activity `payload.detail` to equal `STORAGE_FAILURE_DETAIL` and not to contain `"PersistenceSqlError"`.
6. **[failing-first] Extend** "approval safety: ambiguous provider failure stays unresolved and cannot be replayed" (`:3183`); do not duplicate it. Add the assertion that the `provider.approval.respond.failed` payload matches `{ detail: "Connection lost after sending the decision", responseState: "uncertain" }`.
7. **[failing-first] "bounds steer rejection text and falls back for defects".**
   - Setup: `thread.session.set` to running with `activeTurnId "turn-1"`. Two `thread.turn.steer` commands with `expectedTurnId "turn-1"`.
   - The harness `steerTurn` first fails with `ProviderAdapterRequestError` whose detail is `"x".repeat(1500)`. Expect the `provider.turn.steer.failed` `payload.error` to have length 1,000 or less and be trimmed.
   - It then dies with `new Error("boom")`. Expect `payload.error === "Provider rejected turn steering."`. Today this is a `Cause.pretty` dump.
8. "interrupted turn preparation appends no failure and keeps the reactor alive" (regression lock for the new boundary).
   - Setup: `startSession.mockImplementationOnce(() => Effect.interrupt)` on turn 1.
   - Expect no `provider.turn.start.failed`.
   - Then turn 2 succeeds: `sendTurn` called once.

**(c) Turn-start boundary**

9. **[failing-first] "surfaces a thread read failure during turn start".**
   - Setup: turn 1 succeeds, so the session is `ready`. Then a one-shot `getThreadShellById` failure with `PersistenceSqlError`, followed by turn 2.
   - Expect a failure activity for message 2 with `STORAGE_FAILURE_DETAIL`, session `status: "ready"` with `lastError === STORAGE_FAILURE_DETAIL`, and `sendTurn` called once.
10. **[failing-first] "keeps a concurrently started turn running when turn-start preparation fails".**
    - Why this shape: the decider rejects `thread.turn.start` while a turn is active (`decider.ts:999-1006`). So the concurrent turn is simulated inside the failing read.
    - Setup: the one-shot `getThreadShellById` hook first dispatches `thread.session.set` to `{status: "running", activeTurnId: "turn-wake", …same runtime}`, then fails.
    - Expect the session to stay `running` with `activeTurnId "turn-wake"` and `lastError null`.
    - Expect exactly one failure activity for the message, and `startSession` and `sendTurn` not called again.
11. **[failing-first] "surfaces a message read failure during turn start".** Setup: a one-shot `getThreadMessageById` failure. Expect a failure activity with `STORAGE_FAILURE_DETAIL`.
12. **[failing-first] "still sends the turn when the first-turn message count cannot be read".**
    - Setup: `countThreadUserMessages` fails.
    - Expect `sendTurn` called once, no failure activity, and neither `generateThreadTitle` nor `generateBranchName` called.
    - Today the turn silently never starts.
13. **[failing-first] "surfaces a project read failure on the context-handoff branch".**
    - Setup: turn 1 on `codex`. Then a one-shot `getProjectShellById` failure, and turn 2 on `codex_work`, which takes the handoff branch as in the test at `:1971`.
    - Expect a failure activity for message 2 and `processContextHandoff` not called.
    - A separate `leaseThreadPath` test is not added: the lease after `ensureRecordedWorktreeAvailable` can only fail in a race, and it sits behind the same boundary.
14. Existing tests stay green unchanged, because provider-error details are the same: `:1138`, `:1272`, `:1320` (worktree failures), `:865` (goal), `:2479-2492`, `:2601-2611`, `:2842-2855`, `:907` (retired memory).

### 5.4 `ContextHandoffCoordinator.test.ts`

Harness additions to `makeHarness`: optional `getThreadDetailById` and `getSession` overrides. They are additive, next to `provider-compat`'s `ModelManifest` stub edit.

15. **[failing-first] "reports a thread read failure before dispatch".**
    - Setup: `getThreadDetailById` fails with `PersistenceSqlError`.
    - Expect exactly one `thread.activity.append` command, with kind `provider.turn.start.failed`, payload `{ messageId: targetMessageId, detail: STORAGE_FAILURE_DETAIL }`.
    - Expect no record created and `sendTurn` not called.
16. **[failing-first] "fails a preparing record when pre-dispatch reads fail and never re-dispatches it on recovery".**
    - Setup: `getSession` fails once.
    - Expect the record to end `status: "failed"` with `error === STORAGE_FAILURE_DETAIL`, and exactly one `provider.turn.start.failed` command.
    - Then `coordinator.recover()`. Expect `startFreshSession` and `sendTurn` not called.
17. The existing test "marks an explicit failed boundary…" (`:666`) keeps `error: "target rejected the turn"`, which checks the `boundedFailureDetail` rewrite.

### 5.5 `GrokAdapter.test.ts`

18. **"applies a model change to the live session without restarting".**
    - Setup: `RYCO_ACP_REQUEST_LOG_PATH`. Start with `grok-build`, then `sendTurn` with `modelSelection {grok, "grok-mock-alt"}`.
    - Expect `adapter.capabilities.sessionModelSwitch === "in-session"`.
    - Expect the request log to show exactly one `session/new`, no `session/load`, and a `session/set_model` with `modelId: "grok-mock-alt"`.
    - Expect `listSessions()[0].model === "grok-mock-alt"` and an unchanged `resumeCursor.sessionId`.
    - **[failing-first]** on the capability assertion.

---

## 6. Edge cases

- **Unknown active model.** `session.model === undefined` is never a change, so it never restarts and never rejects. A custom slug on a registry agent without a model API goes to `sendTurn`. The adapter tries `set_model`, and a rejection becomes a visible turn-start failure.
- **Runtime or token mode restarts cannot trip the new rejection.** Those paths pass the cached selection (`threadModelSelections`). That cache is written only after `ensureSessionForThread` succeeds (`:933`), and a rejected selection is never cached. So for `"unsupported"` adapters the cache equals the session model.
- **Instance changes** keep their current path (handoff, or restart with resume). The rejection excludes `instanceChanged`.
- **Claude** keeps `shouldRestartForModelSelectionChange` (option changes restart and resume), unchanged.
- **Delegated returns.** The session is never written on failure (`delegationReturnGuard`), as today.
- **The `preserveActiveTurn` check is read-then-write**, the same window as today's handler. A decider-level expected-state guard is out of scope.
- **Submission failures** (forked `sendTurn`) still reset a running session (`preserveActiveTurn: false`). The active turn there can be this request's own after the adapter emitted `turn.started`, and resetting is what un-sticks the UI today.
- **Coordinator.** If `finalizeFailure` fails half-way while the record is still `preparing`, the reporter marks it `failed` and appends the activity. A source restore that did not complete is logged. Records in `dispatching` or terminal states are never touched.
- **Empty provider `detail`** now falls back to text instead of producing an invalid empty `lastError`.

---

## 7. Out of scope, with named follow-ups

1. **ACP non-strict resume fallback** (`AcpSessionRuntime.ts:500-505`). Grok runtime-mode, token-mode and cwd restarts, and recovery after a server restart, can still silently start a new conversation when `session/load` fails. Fix: detect `started.sessionId !== resumeSessionId` and either make it visible or make resume strict. **Owner: `restart-continuation` (W3).** It must not "continue" a thread whose native session was not reloaded.
2. **Callback-response pre-reads** (`approvals.getByRequestId`, `questions.getByRequestId` and `resolveThread`, `:1598-1621`) run outside `matchCauseEffect`. A failure leaves the claim `submitting` with no `respond.failed` activity. **Owner: `provider-effect-outbox` (W3)**, which owns request-response durability. Approval authority is unaffected: only the user can approve.
3. **The steer `resolve` dispatch failure** in the forked fiber (`:1557-1571`) leaves the steer unresolved. **Owner: `claude-steering` (W2).**
4. **Post-acceptance `commitAcceptedModelSelection`** failure (`:1333`) is reported as a turn-start failure while the turn runs. **Owner: `provider-effect-outbox` (W3).**
5. **`processDomainEventSafely` re-raises interrupt-only causes**, which ends the worker loop. **Owner: `reactor-concurrency` (W3).**
6. **A delegated-return `getSession` failure** produces two activities. **Owner: `delegation-returns` (W2).**
7. **Runtime-mode and token-mode `ensureSessionForThread` failures** are still only logged (they are not turn starts). Candidate for `reactor-concurrency` (W3).

---

## 8. Overlaps and coordination

- **`queue-hold-drain` (W1).**
  - This package emits more `provider.turn.start.failed` activities and changes `lastError` and `detail` text. Hold-on-failure guards must key on kind and state, never on text.
  - Expect a textual conflict in the `ProviderCommandReactor.test.ts` `createHarness` options.
  - If that package edits `appendProviderFailureActivity`, apply the change in `providerFailureActivity.ts`.
- **`claude-meter-wake` (W1).** Wake turns are exactly the race `preserveActiveTurn` protects. If that package changes how wake turns set `session.status` or `activeTurnId`, keep the guard keyed on `status === "running" && activeTurnId !== null`. Possible `createHarness` conflict.
- **`acp-message-ids` (W1).** We change only the `AcpAdapter.ts` capabilities getter (`:1074-1076`) and add one `GrokAdapter.test.ts` case. Its id-minting edits are in other functions.
- **`provider-compat` (W1).** Adjacent edits in the `ContextHandoffCoordinator.test.ts` `makeHarness`: its `ModelManifest` stub at `:445-449`, our options and the `ProjectionSnapshotQuery` and `ProviderService` mocks at `:329-336`, `:456-457` and `:499`.
- **`settlement-signals` (W1).** Both touch `packages/shared`. We edit only `src/String.ts` and its test; there is no `package.json` export change.
- **`turn-finalization` and `delegation-guard-restart` (W1).** No shared functions. The `delegation-guard-restart` overlap in the old draft was wrong and is removed.
- **`claude-steering` (W2).** The `processTurnSteerRequested` catch block and the `ProviderAdapter.ts` capability block (adjacent `turnSteering` field). Rebase onto this package.
- **`delegation-returns` (W2).** The return-guard block moves unchanged into `prepareAndSubmitTurnStart`, and that package owns follow-up 6.
- **`usage-limits` (W2).** It may add a usage-limit mapping to `KNOWN_FAILURES` (extension point) and read `provider.turn.start.failed`.
- **W3: `reactor-concurrency` → `provider-effect-outbox` → `restart-continuation`.** They rework the same reactor functions. Follow-ups 1, 2, 4, 5 and 7 go to them.

---

## 9. Review resolution

| # | Severity | Issue | Resolution |
| --- | --- | --- | --- |
| — | verdict | (a) refuted as stated | **Verified myself.** `ProviderService.ts:971-976` restores the persisted cursor, and the reactor never sets `resumePolicy`. Verdict text is now "refuted as stated; real defects (i) registry false positive and (ii) Grok silent loss", and both are fixed here. |
| 1 | major | The turn-start boundary can wipe a running turn's session | **Accepted.** `setThreadSessionErrorOnTurnStartFailure` gets `preserveActiveTurn`, set to true for preparation-phase failures. Test 10 uses an in-read hook, because the decider rejects turn starts while a turn is active, so the literal suggested setup cannot be dispatched. `claude-meter-wake` is named. |
| 2 | major | `ContextHandoffCoordinator.processTurnStart` is a second silent path | **Accepted.** The coordinator reports pre-dispatch failures itself: it logs the cause, fails a `requested` or `preparing` record so `recover()` cannot re-dispatch it, and appends `provider.turn.start.failed`. It never claims failure for `dispatching` or terminal records. Tests 15-16. The interface stays `Effect<void>`, because the record state lives in the coordinator. |
| 3 | major | Keeping the model-change restart leaves the Grok silent loss | **Accepted, preferred option.** Model changes never restart. The ACP default is `"in-session"`, because `sendTurn` already issues the same `set_model`. `"unsupported"` rejects known changes visibly. The residual non-strict fallback on *other* restarts is follow-up 1, owned by `restart-continuation`. |
| 4 | minor | `liveSessionModel` from `threadModelSelections` can be stale | **Accepted in substance.** The final design does not derive the live model from that cache. It uses `activeSession.model` and treats `undefined` as unknown, the critique's own fallback suggestion. Test 1 covers it. |
| 5 | minor | Best-effort reads must not fail the turn | **Accepted.** The message count and the first-turn project read log and continue. Test 12 asserts `sendTurn` is still called. |
| 6 | minor | The overlaps list was inaccurate | **Accepted.** `delegation-guard-restart` is removed. `queue-hold-drain`, `claude-meter-wake` and the `createHarness` conflicts are added. The consumer note (`LocalTaskService`, queue guards) says to match kind and state, never text. |
| 7 | minor | Sibling swallowed paths (callback reads, steer resolve) | **Accepted as named follow-ups.** Callback reads go to `provider-effect-outbox` and steer resolve goes to `claude-steering`, so approval or steer state machines are not redesigned in a W1 package. User-facing text is still applied to respond and steer failures here. |
| 8 | minor | `userFacingErrors` design | **Accepted.** `Schema.is` guards on imported classes, with no import cycle (verified). `truncateUnicodeSafe` moves to `@ryco/shared/String`. The client stale parsers are listed in §3.7. |
| 9 | minor | Test plan gaps | **Accepted.** The vacuous `stopSession` assertion is replaced with call counts and the runtime id. Test `:3183` is extended instead of duplicated. Added: steer bound and fallback (7), interrupt (8), handoff-branch read (13; the lease is race-only and behind the same boundary), active-turn preservation (10). The logging rule means swallowers log and re-raisers do not, so nothing is logged twice in the goal paths. **One deliberate deviation:** interrupt-only causes are swallowed (no activity), not propagated, because a propagated interrupt ends `DrainableWorker`'s `Effect.forever` loop and stops the reactor (follow-up 5). |

---

## 10. Validation (proportional)

- Focused tests:
  - `bun run --cwd apps/server test src/orchestration/userFacingErrors.test.ts src/orchestration/Layers/ProviderCommandReactor.test.ts src/orchestration/Layers/ContextHandoffCoordinator.test.ts src/provider/Layers/GrokAdapter.test.ts`
  - `bun run --cwd packages/shared test src/String.test.ts`
- `bun typecheck`, because the change crosses packages (`@ryco/shared/String` is consumed by the server). Check the exit code; strip ANSI codes before grepping.
- `bun lint`, `bun fmt`, `bun run fmt:check` on the touched files.
- **Manual QA:** one live Grok CLI smoke test. Switch the model mid-thread, confirm the reply remembers earlier turns, and confirm the logs show no `session/new`. If real Grok rejects an in-session `set_model`, set `getSessionModelSwitch: () => "unsupported"` in `GrokAdapter.ts`. Switches then fail visibly with the "Start a new thread" message, and never silently.
