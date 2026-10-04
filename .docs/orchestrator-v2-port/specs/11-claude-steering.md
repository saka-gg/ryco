# 11 · claude-steering: Claude active-turn steering, follow-up behaviour setting, Mod+Enter inversion

| Field            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id               | `claude-steering`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| title            | Claude `steerTurn` with exact-turn attribution and a safe Stop protocol; a `followUpBehavior` (`queue` \| `steer`) client setting where Mod+Enter does the opposite; direct steer from the composer; late steers are deferred into the queue and sent as the next turn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| wave             | 2 (parallel, isolated worktree). Rebase onto wave-1 `queue-hold-drain`, `claude-meter-wake` and `reactor-errors-switch` before starting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| verdict          | **feature**. Verified: only Codex steers today. Claude has no `steerTurn`, and `ProviderService.steerTurn` rejects every other adapter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| size             | **L**. Server adapter work about 45%, orchestration and contracts 15%, client-runtime, web and mobile 40%                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| touched files    | **Server:** `apps/server/src/provider/Errors.ts` · `apps/server/src/provider/claudeSteering.ts` (new) · `apps/server/src/provider/Layers/ClaudeAdapter.ts` · `apps/server/src/provider/Layers/ClaudeProvider.ts` · `apps/server/src/provider/Layers/ProviderService.ts` · `apps/server/src/provider/Layers/CodexAdapter.ts` · `apps/server/src/orchestration/turnSteerFailure.ts` (new) · `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` · `apps/server/src/orchestration/decider.ts`. **Contracts and shared:** `packages/contracts/src/orchestration.ts` · `packages/contracts/src/settings.ts` · `packages/shared/src/turnSteer.ts` (new) · `packages/shared/package.json`. **Client runtime:** `packages/client-runtime/src/state/message-queue/logic.ts` · `packages/client-runtime/src/state/message-queue/store.ts` · `packages/client-runtime/src/state/session/session-logic.ts`. **Web:** `apps/web/src/components/ChatView.tsx` · `apps/web/src/components/chat/ChatComposer.tsx` · `apps/web/src/components/chat/ComposerPromptShell.tsx` · `apps/web/src/components/chat/composerFollowUp.ts` (new) · `apps/web/src/components/settings/ComposerSettings.tsx` · `apps/web/src/components/settings/settingsSearchIndex.ts` · `apps/web/src/components/settings/settingsRestore.ts` · `apps/web/src/hostedHub/environment.ts`. **Mobile:** `apps/mobile/src/state/threadOutbox.ts` · `apps/mobile/src/features/threads/ThreadDetailScreen.tsx`. **Docs:** `docs/providers/claude.md` · `KEYBINDINGS.md`. **Tests:** `claudeSteering.test.ts` (new) · `ClaudeAdapter.test.ts` · `ProviderService.test.ts` · `CodexAdapter.test.ts` · `turnSteerFailure.test.ts` (new) · `ProviderCommandReactor.test.ts` · `decider.steer.test.ts` · `AgentControlExecution.test.ts` · `packages/contracts/src/settings.test.ts` · `packages/shared/src/turnSteer.test.ts` (new) · `message-queue/logic.test.ts` · `message-queue/store.test.ts` · `session-logic.test.ts` · `composerFollowUp.test.ts` (new) · `settingsRestore.test.ts` · `ChatView.Composer.browser.tsx` · `apps/mobile/src/state/threadOutbox.test.ts` |
| migrations       | none                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| contract changes | **Contracts:** `orchestration.ts` gains the `TurnSteerRejectionReason` literal (`"deferred" \| "failed"`), plus an `optionalKey` `reason` on the rejected branch of `thread.turn.steer.resolve` and on `ThreadTurnSteerRejectedPayload`. `settings.ts` gains the `FollowUpBehavior` literal (`"queue" \| "steer"`), `DEFAULT_FOLLOW_UP_BEHAVIOR = "queue"`, `ClientSettingsSchema.followUpBehavior` (decoding default `"queue"`) and `ClientSettingsPatch.followUpBehavior` (`optionalKey`). All changes are additive, and older persisted events and settings still decode. **Behaviour:** the decider's `thread.turn.steer` no longer throws when the turn has ended or the expected turn does not match. It now emits a deferred rejection. **Activity payload:** `provider.turn.steer.failed` gains `reason`, and deferred rows use `tone: "info"`. **Server-internal:** a new `ProviderTurnNotSteerableError` joins `ProviderAdapterError`. `ProviderService.steerTurn` maps a turn mismatch to it, and maps an unsupported adapter to it. The Claude adapter declares `turnSteering: "native"`, and the Claude presentation sets `supportsTurnSteering: true`. **Shared:** new subpath export `@ryco/shared/turnSteer`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| overlaps         | **W1 `queue-hold-drain`:** owns the drain. The steer-attempt exclusion and the reconciliation must run where the drain runs, in ChatView today or in a global client-runtime drain afterwards. Also `message-queue/store.ts` (`beginSend`, steering map) and mobile `threadOutbox.ts` `drainThreadOutbox`. **W1 `claude-meter-wake`:** `ClaudeAdapter.completeTurn` usage computation (extracted here into `computeResultUsageSnapshot` / `emitTokenUsageSnapshot`) and the synthetic-turn creation site in `handleAssistantMessage` (constructed here via `makeClaudeTurnState`). **W1 `reactor-errors-switch`:** `ProviderCommandReactor.formatFailureDetail` and the `catchCause` in `processTurnSteerRequested`. **W2 `usage-limits` (same wave, unavoidable):** `ClaudeAdapter.handleResultMessage`, `turnStatusFromResult` and the `completeTurn` tail. **W2 `rollback-correctness` (same wave):** the `completeTurn` tail (`context.turns.push`, `updateResumeCursor`) and session-context replacement versus the identity re-check in `steerTurn`. **W2 `delegation-returns` (same wave):** steer-based parent-wake delivery will consume Claude steering and the deferred-rejection semantics. **W1 `delegation-guard-restart`:** touches a different decider case, so there is no shared function. **W1 `settlement-signals` / `provider-compat`:** adjacent `packages/shared/package.json` export-map edits. **W3 `provider-effect-outbox`:** a crash-cancelled steer must resolve as rejected with `reason: "deferred"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## 1. Current behaviour (verified against the code, 2026-10-04)

### 1.1 Capability and service gate

- `apps/server/src/provider/Layers/CodexProvider.ts:28-33` is the only presentation with `supportsTurnSteering: true`. `ClaudeProvider.ts:52-56` omits it and `Drivers/AcpRegistryDriver.ts:139` sets it to `false`.
- `ClaudeAdapter.ts:5196-5199` returns `capabilities: { sessionModelSwitch: "in-session" }` and no `steerTurn`.
- `ProviderService.steerTurn` (`ProviderService.ts:1245-1313`) handles failures as follows:
  - `!routed.isActive` raises `ProviderSessionNotFoundError`.
  - A turn mismatch (`:1266-1271`) raises `ProviderValidationError`.
  - `turnSteering !== "native"` (`:1272-1278`) also raises `ProviderValidationError`.

### 1.2 Orchestration flow

1. The client queues a message. The user clicks Steer, which calls `buildQueuedMessageSteerCommand` (`client-runtime/src/state/message-queue/logic.ts:45-67`).
2. The decider handles `thread.turn.steer` (`decider.ts:1239-1273`). It throws `OrchestrationCommandInvariantError` when the session is not running or the expected turn does not match. Otherwise it emits `thread.turn-steer-requested`.
3. The reactor runs `processTurnSteerRequested` (`ProviderCommandReactor.ts:1505-1574`), which calls `providerService.steerTurn` and dispatches `thread.turn.steer.resolve`.
4. Accepted resolution (`decider.ts:2020-2068`): `thread.message-sent` (user, `turnId = expectedTurnId`, `dispatchMode: "steer"`) and `thread.turn-steer-accepted`. **The user message is already projected into the current turn on acceptance.**
5. Rejected resolution (`decider.ts:2070-2118`): `thread.turn-steer-rejected` plus an activity with id `turn-steer-rejected:<requestCommandId>`, kind `provider.turn.steer.failed`, **always `tone: "error"`**. The error text comes from `formatFailureDetail` (`:319-328`), which falls back to `Cause.pretty`.

### 1.3 Clients

- **Steer reconciliation is keyed by messageId only.** This applies to web (`ChatView.tsx:3262-3291`) and mobile (`ThreadDetailScreen.tsx:698-731`). Any historical rejection for that id ends a _new_ attempt. Mobile shows every rejection in its `sendError` banner.
- **Enter while running enqueues the message** (`ChatView.tsx:3893-3922`). `ChatComposer.tsx:1768-1771` treats Mod+Enter exactly like Enter. There is no follow-up setting: `ClientSettingsSchema` is at `settings.ts:67-136`.
- **The drains differ.**
  - Web (`ChatView.tsx:3936-3985`) skips the queue head while it is steering.
  - The mobile drain (`threadOutbox.ts:172-208`) has no steering exclusion.

### 1.4 Claude adapter internals that block steering

- **Turn start.** `sendTurn` creates `turnState` with `promptUuid === turnId` (`:4908-4925`) and offers the SDK user message with `uuid: promptUuid` (`:4966-4969`).
- **A steered turn would never complete.** `handleResultMessage` (`:3130-3163`) drops every result whose `user_message_uuids` lacks `promptUuid`. A steered CLI turn's result echoes only the steer uuid, so it would be dropped and the turn would never complete.
- **The steer's abort would end the turn.** `turnStatusFromResult` (`:1268-1281`) ignores `terminal_reason`, and an aborted result completes the turn as `interrupted`. The abort caused by a `priority: "now"` steer would therefore end the Ryco turn. The steer's reply would then open a synthetic turn (`:3049-3080`).
- **Replies would merge into the aborted text block.** Open assistant text blocks are keyed by stream index (`:1850-1875`). A new CLI turn's index-0 text would be appended to the aborted block unless that block is closed first.
- **Reasoning blocks can stay open.** They close only on `content_block_stop` (`:2744-2765`), and `completeTurn` (`:2309-2352`) never closes them. A thinking block cut off by an abort keeps spinning.
- **The interrupt receipt is discarded.** `interruptTurn` (`:4991-5050`) throws it away, and `ClaudeQueryRuntime.interrupt` is typed `() => Promise<void>` (`:322`).

## 2. Claude Agent SDK facts this design relies on

These were verified in `apps/server/node_modules/@anthropic-ai/claude-agent-sdk` 0.3.263 (`sdk.d.ts`, `sdk.mjs`).

1. **Priority and uuid.** `SDKUserMessage.priority?: 'now' | 'next' | 'later'` (`sdk.d.ts:5377`). `uuid` is the echo key. t3 steers with `priority: "now"` (`t3:.../ClaudeAdapterV2.ts:7266-7298`). It swallows the next result when its `terminal_reason ∈ {aborted_streaming, aborted_tools}` and the turn was steered but not interrupted (`:2319-2323`, `:6240-6244`).
2. **Uuid echoes.** A result's `user_message_uuids` (`sdk.d.ts:4991`, `:5014`) lists every user message the turn consumed. That includes "any queued user message folded into the running turn between tool rounds". The **first non-ping `stream_event`** carries `user_message_uuid(s)` (`sdk.d.ts:4836-4848`), which gives an early echo. Ryco sets `includePartialMessages: true` (`ClaudeAdapter.ts:4627`).
3. **Pending turns and stop reasons.**
   - `queued_turn_count` (`sdk.d.ts:4982`, `:5045`): "Greater than 0 means at least one more user turn (and result) follows without further input, barring cancellation; 0 means none is pending."
   - `terminal_reason` (`TerminalReason`, `sdk.d.ts:8559`) includes `aborted_streaming` and `aborted_tools`.
4. **Interrupt receipt.**
   - `Query.interrupt()` resolves to `SDKControlInterruptResponse | undefined` (`sdk.d.ts:2601-2615`). `still_queued` lists uuids that "WILL still run unless cancelled first". `cancelled` is present only when `cancel_queued` is set (`sdk.d.ts:4075-4096`).
   - A plain interrupt leaves queued uuid-stamped messages in place.
   - The public type takes no argument. The **0.3.263 runtime** does accept one: `async interrupt(e){…{subtype:"interrupt",...e?.cancelQueued===!0&&{cancel_queued:!0}}…}` (`sdk.mjs`).
   - `cancel_queued` also dequeues uuid-less task notifications (`sdk.d.ts:4079`).
   - The runtime also has an untyped `cancelAsyncMessage(uuid)`. It is not used here.
5. **Capabilities.** CLI capabilities arrive on `system/init.capabilities` (`sdk.d.ts:5196`): `interrupt_receipt_v1` and `interrupt_cancel_queued_v1`. Ryco runs the user's own CLI (`pathToClaudeCodeExecutable`, `ClaudeAdapter.ts:4611`), so detection must be per session.
6. **Queue offers.** In effect 4.0.0-beta.107, `Queue.offer` returns `Effect<boolean>`, which is `false` after shutdown. The `mapError` in `sendTurn` is dead code.

**Not verifiable offline:** whether the CLI handles `"now"` by aborting and starting a new turn, or by folding the message in at the next tool boundary. The design handles both. Manual QA §11 captures the native NDJSON log to confirm it.

## 3. Approach

### Decisions

- **D1. Claude steering mechanism.**
  - `steerTurn` pushes an SDK user message `{ priority: "now", uuid: S }` into the live `promptQueue`.
  - The Ryco turn keeps its `turnId` and absorbs every CLI segment until no accepted steer is pending.
  - The user message projection is unchanged: the decider projects it into `expectedTurnId` on acceptance.
  - Agent Control turn authority is unchanged: same `turnId`, and `retireTurn` runs only at final completion.
- **D2. Turn attribution uses a pure classifier, and no waiting is unbounded.**
  - A result belongs to the turn if it echoes `promptUuid` **or** any steer uuid of that turn.
  - On such a result, echoed steers become _settled_.
  - The turn **waits** instead of completing only when all of these hold:
    - Stop was not requested.
    - At least one steer is still unsettled.
    - The segment ended by abort or success.
    - `queued_turn_count > 0`, which is the CLI's positive promise of another result.
  - In every other case the turn completes.
  - No timers are used. The open state requires that positive promise. Stop always closes it, and stream exit and session stop already close open turns (`:4003-4032`, `:4070`).
- **D3. A segment seal runs between CLI turns.** It closes in-flight tools, assistant text blocks and reasoning blocks, and emits a usage update, while the turn stays open.
- **D4. Stop protocol.**
  - `interruptRequested` is set on the current turn state unconditionally, because Stop is thread-scoped.
  - `cancelQueued` is sent only when the turn has unsettled steers **and** the CLI advertised `interrupt_cancel_queued_v1`. This keeps Stop byte-identical to today when no steer is pending.
  - The receipt decides whether the turn is force-closed now and which steer uuids go into a session-level _discard set_.
  - A later CLI turn whose early echo consists only of discarded uuids, and that no open turn owns, is interrupted again and its frames are dropped.
  - A per-session `turnLock` serializes SDK frame handling against the Stop bookkeeping and the steer registration.
- **D5. Gate.** Claude steering requires `interrupt_receipt_v1` in the session's init capabilities. It is refused, as _deferred_ through `ProviderTurnNotSteerableError`, in these cases:
  - an approval or question is pending;
  - the input is a slash command;
  - Stop has been requested;
  - the session context changed.
- **D6. One rejection vocabulary: `reason: "deferred" | "failed"`.**
  - _Deferred_ means the message stays queued and the queue sends it as the next turn. This is Ryco's form of "a steer arriving after the turn ended becomes a new turn".
  - Deferred rejections are quiet: info tone, excluded from the work log, no mobile banner.
  - The decider no longer throws for an ended or mismatched turn. It emits a deferred rejection.
- **D7. Client steer attempts are keyed by the steer's request `commandId`.**
  - One pure reconciliation helper serves both web and mobile.
  - No drain dispatches an entry with a live attempt.
- **D8. Follow-up behaviour.**
  - New client setting `followUpBehavior`, default `"queue"`. This matches t3's default, so upgrading changes nothing.
  - While a turn runs, Enter applies the setting and Mod+Enter does the opposite.
  - "Steer" is implemented as _enqueue, then start a steer attempt immediately_, so every failure falls back to the existing queue.
  - An ineligible steer becomes a queue entry. This is silent when implicit, and shows a warning toast when the user asked for it explicitly with Mod+Enter.
  - The running-state placeholder shows the effective action and the alternate shortcut.
  - On the web phone tier the message is always queued and no hint is shown, because that tier is frozen.
- **D9. Ordering.** A direct steer jumps ahead of older queued entries. It targets the running turn, while queued entries wait for a new turn. This matches the existing per-row Steer button and t3.
- **D10. Codex.** A `turn/steer` request error is mapped to `turn-ended` when the runtime's active turn no longer matches. This is a state check, not string matching.

### Why not start a new turn on the server (t3 `Orchestrator.ts:4464-4482`)?

Ryco's steer command does not carry the turn-start parameters: model selection, runtime, interaction and token modes, and source-control contexts. The client queue entry does. Deferring reuses the queue path, its ordering, and the hold semantics that `queue-hold-drain` adds, such as Stop holding queued work.

### Stop scenarios (normative; each has a test in §6)

| #   | State when Stop lands                                                     | Receipt                              | Result                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | No steers                                                                 | any                                  | `interrupt()` with no argument. Behaviour is unchanged: the aborted result completes the turn as `interrupted`                                                                                                 |
| S2  | Prompt segment ended (waiting), steer S queued, CLI has `cancel_queued`   | `{still_queued: [], cancelled: [S]}` | Force-close as `interrupted` now. S never runs                                                                                                                                                                 |
| S3  | Same as S2, but the CLI has only the receipt capability                   | `{still_queued: [S]}`                | Force-close now. S goes into the discard set. When S's CLI turn starts, it is interrupted again and its frames and result are dropped. No synthetic turn                                                       |
| S4  | Prompt P still streaming, S queued                                        | `{still_queued: [S]}`                | No force-close. P's aborted result completes the turn once. S is discarded later                                                                                                                               |
| S5  | Prompt segment ended, S in transit (not yet seen by the CLI)              | `{still_queued: []}`                 | S counts as running, so there is no force-close. S's first frame is owned by the open turn, which is marked `interruptRequested`, so the turn is interrupted again. S's aborted result completes the turn once |
| S6  | Waiting state cleared by a wake turn's frames, S queued                   | `{still_queued: [S]}`                | No steer is running and the prompt is done, so force-close                                                                                                                                                     |
| S7  | Turn has steers, the prompt is queued behind a wake turn, `cancel_queued` | `cancelled ∋ promptUuid`             | Force-close: the prompt never ran                                                                                                                                                                              |
| S8  | No receipt (defensive; steering is gated on receipt capability)           | `undefined`                          | Force-close only if `awaitingSteerContinuation` is set. Every unsettled steer goes into the discard set                                                                                                        |

## 4. Changes by file

### 4.1 `packages/shared/src/turnSteer.ts` (new) and the `./turnSteer` subpath export

```ts
import type { TurnSteerRejectionReason } from "@ryco/contracts";

export const TURN_STEER_FAILED_ACTIVITY_KIND = "provider.turn.steer.failed" as const;
export const turnSteerRejectionActivityId = (requestCommandId: string): string =>
  `turn-steer-rejected:${requestCommandId}`;

export interface TurnSteerRejectionActivity {
  readonly messageId: string | null;
  readonly reason: TurnSteerRejectionReason;
  readonly error: string;
}
/** Legacy rows (no `reason`) read as "failed". Returns null for other kinds. */
export function readTurnSteerRejectionActivity(activity: {
  readonly kind: string;
  readonly payload: unknown;
}): TurnSteerRejectionActivity | null;
```

The server decider uses this module, and so do the client-runtime work log and queue reconciliation. This removes the duplicated `"provider.turn.steer.failed"` / `turn-steer-rejected:` literals. Add the export to `packages/shared/package.json` in the existing explicit-subpath style.

### 4.2 `packages/contracts`

- **`orchestration.ts`**
  - Next to `TurnDispatchMode` (`:706`), add `export const TurnSteerRejectionReason = Schema.Literals(["deferred", "failed"])` and its type.
  - On the rejected branch of `ThreadTurnSteerResolveCommand` (`:1807-1825`), add `reason: Schema.optionalKey(TurnSteerRejectionReason)` to `resolution`.
  - In `ThreadTurnSteerRejectedPayload` (`:2125-2132`), add `reason: Schema.optionalKey(TurnSteerRejectionReason)`.
- **`settings.ts`**
  - Add `FollowUpBehavior = Schema.Literals(["queue", "steer"])` and `DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = "queue"`.
  - In `ClientSettingsSchema`, add `followUpBehavior: FollowUpBehavior.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_FOLLOW_UP_BEHAVIOR)))`.
  - In `ClientSettingsPatch`, add `followUpBehavior: Schema.optionalKey(FollowUpBehavior)`.
  - The setting is client-owned, so `isServerSettingKey` returns `false` with no change needed.

### 4.3 Server: provider layer

#### `provider/Errors.ts`

```ts
export class ProviderTurnNotSteerableError extends Schema.TaggedError<ProviderTurnNotSteerableError>()(
  "ProviderTurnNotSteerableError",
  {
    provider: Schema.String,
    threadId: Schema.String,
    turnId: Schema.optional(Schema.String),
    reason: Schema.Literals(["turn-ended", "busy", "unsupported"]),
    /** User-facing sentence; surfaced verbatim in the deferred activity. */
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
```

Add it to the `ProviderAdapterError` union, which also makes it part of `ProviderServiceError`. No exhaustive `_tag` switch exists over this union (checked with `rg`).

#### `provider/claudeSteering.ts` (new, pure, no Effect services)

- **Constants:** `CLAUDE_CLI_CAPABILITY_INTERRUPT_RECEIPT = "interrupt_receipt_v1"`, `CLAUDE_CLI_CAPABILITY_INTERRUPT_CANCEL_QUEUED = "interrupt_cancel_queued_v1"`, `CLAUDE_DISCARDED_STEER_CAP = 64`.
- **Moved here** from `ClaudeAdapter.ts:459-478`, so the classifier is testable without the layer: `resultErrorsText` and `isInterruptedResult`. `ClaudeAdapter` re-imports them.
- `claudeEchoedPromptUuids(message: SDKMessage): ReadonlyArray<string>`. For `result` and `stream_event`, returns `user_message_uuids` when non-empty, else `[user_message_uuid]`, else `[]`. Reads the fields through `Reflect.get`.
- `classifyClaudeResultKind(result): "success" | "abort" | "failure"`:
  - `success` when `subtype === "success" && !is_error`.
  - `abort` when `terminal_reason ∈ {aborted_streaming, aborted_tools}`, or when `terminal_reason` is absent and `isInterruptedResult(result)` holds.
  - Otherwise `failure`.
- `claudeResultBelongsToTurn({ echoed, origin, promptUuid, steerPromptUuids }): boolean`. This replaces the inline check at `:3138-3157`. A result belongs to the turn if it echoes the prompt or any steer. Without an echo, it does not belong if its origin is not human. The legacy behaviour for synthetic turns is kept: when `promptUuid` is undefined, the caller skips the check.
- `decideClaudeTurnResult(input)` returns `{ decision, newlySettled, unsettled, discardUnsettled, abortedBySteer }`:

```ts
export interface ClaudeTurnResultDecisionInput {
  readonly kind: "success" | "abort" | "failure";
  readonly echoedPromptUuids: ReadonlyArray<string>;
  readonly queuedTurnCount: number | undefined;
  readonly steerPromptUuids: ReadonlySet<string>;
  readonly settledSteerPromptUuids: ReadonlySet<string>;
  readonly interruptRequested: boolean;
}
// newlySettled = steer ∩ echoed − settled; unsettled = steer − settled − echoed
// "await-steer" iff !interruptRequested && unsettled.length > 0
//   && (kind === "abort" || kind === "success")
//   && typeof queuedTurnCount === "number" && queuedTurnCount > 0
// otherwise "complete"
```

- **Closing status:** `decideClaudeTurnClose({ resultStatus, decision, interruptRequested, echoedPromptUuids, promptUuid, steerPromptUuids, foldedIntoDiscardedCliTurn })` returns `{ status, cause }`. The status follows `turnStatusFromResult` except where that would misstate the turn, checked in this order:
  - `folded-into-discarded-cli-turn`: the result ends a discarded steer's dropped CLI turn that the CLI folded this turn's prompt or steer into. `failed` (the reply was dropped and, after the discard's re-interrupt, usually never produced), or `interrupted` (cause `stopped`) when Stop was requested. Ryco's own re-interrupt is never reported as a user Stop.
  - `stopped`: Stop was requested and a result with status `completed` echoes a steer but not the prompt (a steer's CLI turn closes the stopped turn, for example with an API-error reply). `interrupted`.
  - `failed-segment-dropped-steers`: no Stop, the segment failed and dropped its pending steers (`discardUnsettled`), but the result has status `completed`: the SDK reports a request that failed at the API as `subtype: "success", is_error: true`. `failed`, with the result text as the error and a `runtime.error`, so the queue holds and the dropped steer is explained.
  - `aborted-by-steer`: `completed` (a steer is never an interrupt).
  - Otherwise `result`.
- **Receipt parsing:** `readClaudeInterruptReceipt(value: unknown): { stillQueued: ReadonlyArray<string>; cancelled: ReadonlyArray<string> | undefined } | undefined`. It is defensive and accepts only string arrays.
- **Stop decision:** `decideClaudeStop({ unsettledSteers, promptUuid, sealedSegmentCount, awaitingSteerContinuation, receipt })` returns `{ forceClose: boolean; discard: ReadonlyArray<string> }`. It implements the §3 Stop table:

```text
receipt undefined: forceClose = awaitingSteerContinuation; discard = unsettled
receipt present:   outstanding = still_queued ∪ cancelled
                   runningSteers = unsettled − outstanding
                   promptDone = sealedSegmentCount > 0 || (promptUuid ∈ cancelled)
                   forceClose = promptDone && runningSteers.length === 0
                   discard = unsettled − cancelled
```

- **Discard set:** `rememberDiscardedSteer(set, uuid, cap = CLAUDE_DISCARDED_STEER_CAP)`, a FIFO-bounded insert.
- **Capabilities:** `parseClaudeCliCapabilities(initMessage): ReadonlySet<string>`. Returns an empty set when the field is absent.

#### `provider/Layers/ClaudeAdapter.ts`

1. **Turn state.** Extend `ClaudeTurnState` (`:158-171`) with:

   ```ts
   readonly steerPromptUuids: Set<string>;
   readonly settledSteerPromptUuids: Set<string>;
   interruptRequested: boolean;
   sealedSegmentCount: number;
   awaitingSteerContinuation: { readonly since: string; readonly segmentStatus: ProviderRuntimeTurnStatus } | undefined;
   ```

   Add `makeClaudeTurnState({ turnId, promptUuid?, startedAt })`. Use it in `sendTurn` (`:4910-4921`) and in the synthetic-turn path (`:3054-3064`), or at the new synthetic-turn site if `claude-meter-wake` moved it.

2. **Session context.** Extend `ClaudeSessionContext` (`:234-318`) with:

   ```ts
   cliCapabilities: ReadonlySet<string> | undefined;
   readonly discardedSteerPromptUuids: Set<string>;
   discardingCliTurn: { readonly uuids: ReadonlySet<string> } | undefined;
   readonly turnLock: Semaphore.Semaphore;
   ```

   Initialize these in the `startSession` context literal (`:4733-4780`) with `turnLock: yield* Semaphore.make(1)`, the same pattern as `ThreadPriorityCoordinator.ts:108`. `stopSessionInternal` clears the discard set and `discardingCliTurn`.

3. **Query runtime type.** Change `ClaudeQueryRuntime.interrupt` (`:322`) to `(options?: { readonly cancelQueued?: boolean }) => Promise<unknown>`. Add a comment that the 0.3.263 runtime forwards `cancelQueued` (§2.4), that the public `.d.ts` does not declare it, and that the receipt is always parsed defensively. Call it as `context.query.interrupt()` when not cancelling, so the prior call shape is preserved, and as `context.query.interrupt({ cancelQueued: true })` otherwise. Always call through `context.query`, because SDK methods rely on `this`.

4. **`handleSystemMessage` `case "init"`** (`:3428`). Set `context.cliCapabilities = parseClaudeCliCapabilities(message)` before the existing `session.configured` emission.

5. **`runSdkStream`** (`:3995-4001`). Run each message as `context.turnLock.withPermits(1)(handleSdkMessage(context, message))`. Deadlock review:
   - `offerRuntimeEventForContext` backpressure drains independently of the lock.
   - `canUseTool` is an SDK callback outside this path.
   - `interruptTurn` awaits `query.interrupt()` _outside_ the lock.

6. **`handleSdkMessage` prelude**, after `logNativeSdkMessage` and `ensureThreadId`:

   ```ts
   if (yield * routeSteerFrame(context, message)) return; // true = consumed/dropped
   const ts = context.turnState;
   if (ts?.awaitingSteerContinuation && isClaudeRootTurnFrame(message))
     ts.awaitingSteerContinuation = undefined;
   ```

   `isClaudeRootTurnFrame` matches `stream_event`, `assistant` and `user` frames with a null or undefined `parent_tool_use_id`.

   `routeSteerFrame` works as follows:
   - **No discard in progress:**
     - **Pass through** unless the message is a `stream_event`, a root `assistant` frame or a `result` with echo uuids `E` (non-empty). A CLI turn that streams nothing echoes on its first root assistant frame (`sdk.d.ts:3327-3336`), for example the synthetic error reply of a request that failed at the API.
     - **Uuids owned by the open turn.** If `context.turnState` owns any uuid in `E` (its prompt or a steer), process the frame normally. If that turn has `interruptRequested`, also fire one plain re-interrupt, recorded once per uuid set (scenario S5), unless the frame is a synthetic API-error reply (`isClaudeApiErrorReply`): that reply ends its CLI turn, so the interrupt could only reach the CLI's next turn.
     - **Only discarded uuids.** Otherwise, if every uuid in `E` is in `discardedSteerPromptUuids`:
       - set `discardingCliTurn = { uuids: E }`;
       - fork a plain `query.interrupt()` with `runFork`, bounded to 5 s, errors ignored, unless the frame is a synthetic API-error reply (`isClaudeApiErrorReply`), which ends its CLI turn anyway;
       - log `claude.turn.discarding-cancelled-steer`;
       - drop the frame.
   - **Discard in progress:**
     - On the next `result`, remove its uuids from the discard set and clear `discardingCliTurn`. Then `emitTokenUsageSnapshot(context, computeResultUsageSnapshot(context, result), undefined)` and drop the result. Exception: a result that echoes a uuid the open turn owns (the CLI folded that turn's prompt or steer into the discarded CLI turn) closes that turn through `handleResultMessage` with `foldedIntoDiscardedCliTurn`, so it ends as `failed` with a resend notice (or `interrupted` after Stop), never as Ryco's own re-interrupt.
     - Drop `stream_event`, `assistant`, `user`, `tool_progress` and `tool_use_summary` frames.
     - Let `system` frames (task lifecycle) and `rate_limit_event` frames through.

7. **`handleResultMessage`** (`:3130-3163`), new body before the existing tail:

   ```ts
   const turnState = context.turnState;
   if (turnState?.promptUuid !== undefined && !claudeResultBelongsToTurn({...})) { /* existing log */ return; }
   if (turnState) {
     const d = decideClaudeTurnResult({ kind: classifyClaudeResultKind(message),
       echoedPromptUuids: claudeEchoedPromptUuids(message), queuedTurnCount: message.queued_turn_count,
       steerPromptUuids: turnState.steerPromptUuids, settledSteerPromptUuids: turnState.settledSteerPromptUuids,
       interruptRequested: turnState.interruptRequested });
     for (const u of d.newlySettled) { turnState.settledSteerPromptUuids.add(u); context.discardedSteerPromptUuids.delete(u); }
     if (d.decision === "await-steer") {
       const segmentStatus = turnStatusFromResult(message);
       yield* sealTurnSegment(context, turnState, segmentStatus, message);
       yield* emitTokenUsageSnapshot(context, yield* computeResultUsageSnapshot(context, message), turnState.turnId);
       turnState.sealedSegmentCount += 1;
       turnState.awaitingSteerContinuation = { since: yield* nowIso, segmentStatus };
       yield* Effect.logInfo("claude.turn.awaiting-steer-continuation", { threadId, turnId, queuedTurnCount, unsettled: d.unsettled.length, terminalReason });
       return;
     }
     if (d.discardUnsettled) // Stop, or a failure (including a success flagged as an error)
       for (const u of d.unsettled) rememberDiscardedSteer(context.discardedSteerPromptUuids, u);
   }
   // close = decideClaudeTurnClose(...) (resultStatus otherwise); a non-`result` cause seals the
   // segment on resultStatus first unless close.status is failed; errorMessage by cause;
   // emitRuntimeError on failed; completeTurn(context, close.status, errorMessage, message)
   ```

   - **Failure with unsettled steers.** The steers are discarded rather than run as a surprise turn after a failed turn. This is consistent with `queue-hold-drain` holding queued work after a failure.
   - **Success with `queued_turn_count` 0 or absent.** The steer still runs and lands in a synthetic turn, which is the edge in §7.

8. **`turnStatusFromResult`** (`:1268-1281`). Return `"interrupted"` when `terminal_reason ∈ {aborted_streaming, aborted_tools}`, checked before the error-text heuristics. An abort is never a failure, even when the error text lacks "abort".

9. **`completeTurn` refactor** (`:2215-2411`). Behaviour is the same except for the reasoning fix.
   - **Usage.** Extract `computeResultUsageSnapshot(context, result)`, which covers the `cacheObservation.mainLoopTotals` and context-window updates and the snapshot math, and `emitTokenUsageSnapshot(context, snapshot, turnId?)`. Apply this on top of `claude-meter-wake`'s version of the computation.
   - **Seal.** Extract `sealTurnSegment(context, turnState, status, result?)`. It includes:
     - the in-flight tool completion loop (`:2309-2340`), with status `completed` if `status === "completed"`, else `failed`;
     - `inFlightTools.clear()` and `suppressedSubagentBlocks.clear()`;
     - forced completion of the assistant text blocks (`:2343-2349`);
     - **new:** for each open `turnState.reasoningBlocks` entry, emit `item.completed { itemType: "reasoning", status: status === "failed" ? "failed" : "completed", title: "Reasoning" }`, then clear the map.
   - **Call order.** `completeTurn` runs `sealTurnSegment`, then `turns.push`, then usage, then `turn.completed`, the same order as today.
   - **Guard.** Add an optional last parameter `options?: { readonly expectedTurnState?: ClaudeTurnState }`. When it is present and `context.turnState !== expectedTurnState`, return immediately.

10. **New `steerTurn`**:

    ```ts
    const steerTurn: NonNullable<ClaudeAdapterShape["steerTurn"]> = Effect.fn("steerTurn")(
      function* (input) {
        const context = yield* requireSession(input.threadId);
        const refuse = (reason, detail) =>
          new ProviderTurnNotSteerableError({
            provider: PROVIDER,
            threadId: input.threadId,
            turnId: input.expectedTurnId,
            reason,
            detail,
          });
        const turnState = context.turnState;
        if (
          !turnState ||
          turnState.turnId !== input.expectedTurnId ||
          context.session.activeTurnId !== input.expectedTurnId ||
          turnState.interruptRequested
        )
          return yield* refuse(
            "turn-ended",
            "The turn finished before this message could be steered. It stays queued and is sent next.",
          );
        if (context.pendingApprovals.size > 0 || context.pendingUserInputs.size > 0)
          return yield* refuse(
            "busy",
            "Claude is waiting for an approval or answer. The message stays queued.",
          );
        if (!context.cliCapabilities?.has(CLAUDE_CLI_CAPABILITY_INTERRUPT_RECEIPT))
          return yield* refuse(
            "unsupported",
            "This Claude Code version can't steer a running turn. The message stays queued.",
          );
        if (input.input?.trimStart().startsWith("/"))
          return yield* refuse(
            "unsupported",
            "Slash commands can't be steered into a running turn. The message stays queued.",
          );
        const message = yield* buildUserMessageEffect(
          {
            threadId: input.threadId,
            ...(input.input ? { input: input.input } : {}),
            attachments: input.attachments ?? [],
            ...(context.cacheModelSelection ? { modelSelection: context.cacheModelSelection } : {}),
          },
          { fileSystem, attachmentsDir: serverConfig.attachmentsDir, boundInstanceId },
        );
        const steerUuid = yield* Effect.sync(() => crypto.randomUUID());
        const registered = yield* context.turnLock.withPermits(1)(
          Effect.gen(function* () {
            if (
              sessions.get(input.threadId) !== context ||
              context.stopped ||
              context.turnState !== turnState ||
              turnState.interruptRequested
            )
              return false;
            turnState.steerPromptUuids.add(steerUuid);
            const offered = yield* Queue.offer(context.promptQueue, {
              type: "message",
              message: { ...message, uuid: steerUuid, priority: "now" },
            });
            if (!offered) turnState.steerPromptUuids.delete(steerUuid);
            return offered;
          }),
        );
        if (!registered)
          return yield* refuse(
            "turn-ended",
            "The turn finished before this message could be steered. It stays queued and is sent next.",
          );
        yield* Effect.logInfo("claude.turn.steered", {
          threadId: input.threadId,
          turnId: turnState.turnId,
          awaiting: turnState.awaitingSteerContinuation !== undefined,
        });
        return { threadId: context.session.threadId, turnId: turnState.turnId };
      },
    );
    ```

    Notes on `steerTurn`:
    - **No host-context prefix.** That prefix is delivered only on `sendTurn`.
    - **Effort prefix.** It follows the running turn's model selection (`context.cacheModelSelection`). The client eligibility check guarantees that the queued and active selections are equal.
    - **Synthetic (wake) turns can be steered.** They grant no Agent Control authority, the same fail-closed behaviour as today.
    - **Identity re-check after attachment reads.** This covers `rollback-correctness`, which replaces the context.

11. **`interruptTurn`** (`:4991-5050`):
    - Capture `const turnState = context.turnState` first, and set `turnState.interruptRequested = true` when it exists.
    - Keep the `retireTurn` and `stopTask` sweep unchanged.
    - Compute `unsettled` from the captured state. Set `cancelQueued = unsettled.length > 0 && cliCapabilities?.has(CANCEL_QUEUED)`.
    - Call `interrupt` as described in step 3, and parse the receipt.
    - Then, under `context.turnLock`, and only if `context.turnState === turnState`:
      - `decideClaudeStop(...)`;
      - `rememberDiscardedSteer` for each `discard` uuid;
      - if `forceClose`, `completeTurn(context, "interrupted", "Interrupted by user.", undefined, { expectedTurnState: turnState })`.
    - Log `claude.turn.interrupt-receipt` with the `stillQueued`/`cancelled` counts and `cancelQueued`. Log counts only.

12. **Return shape** (`:5196-5216`): `capabilities: { sessionModelSwitch: "in-session", turnSteering: "native" }` and `steerTurn`.

#### `provider/Layers/ClaudeProvider.ts`

Add `supportsTurnSteering: true` to `CLAUDE_PRESENTATION` (`:52-56`).

#### `provider/Layers/ProviderService.ts` `steerTurn` (`:1245-1313`)

- Keep `ProviderSessionNotFoundError` for `!routed.isActive`.
- **Turn mismatch** raises `new ProviderTurnNotSteerableError({ provider: routed.adapter.provider, threadId, turnId: expectedTurnId, reason: "turn-ended", detail: "The turn finished before this message could be steered. It stays queued and is sent next." })`.
- **Unsupported adapter** raises `ProviderTurnNotSteerableError({ reason: "unsupported", detail: "<display> can't steer a running turn. The message stays queued." })`.
- Keep the ordering, analytics and directory upsert unchanged.

#### `provider/Layers/CodexAdapter.ts` `steerTurn` (`:2307-2329`)

After the existing `mapError`, add `Effect.catchTag("ProviderAdapterRequestError", (error) => …)`:

- read `session.runtime.getSession`;
- if `activeTurnId !== input.expectedTurnId`, fail with `ProviderTurnNotSteerableError({ reason: "turn-ended", cause: error, … })`;
- otherwise re-fail with `error`.

Do not touch `mapCodexRuntimeError`, which `usage-limits` may edit.

### 4.4 Server: orchestration

#### `orchestration/turnSteerFailure.ts` (new, pure)

```ts
export interface TurnSteerFailureClassification {
  readonly reason: TurnSteerRejectionReason;
  readonly error: string;
}
export function classifyTurnSteerFailure(
  cause: Cause.Cause<unknown>,
  formatFailed: (cause: Cause.Cause<unknown>) => string,
): TurnSteerFailureClassification;
```

- `ProviderTurnNotSteerableError` → `deferred`, using `error.detail`.
- `ProviderSessionNotFoundError`, `ProviderAdapterSessionNotFoundError` and `ProviderAdapterSessionClosedError` → `deferred` with "The turn already finished. The message stays queued and is sent next." This never exposes the raw "Unknown provider thread: …" text.
- Everything else → `failed`, using `formatFailed(cause)` trimmed, or "Provider rejected turn steering." when empty.
- The error is capped at 1,000 characters, matching the schema.

#### `orchestration/Layers/ProviderCommandReactor.ts` `processTurnSteerRequested` (`:1505-1574`)

- The `resolve` rejected variant gains `reason`.
- `catchCause` uses `classifyTurnSteerFailure(cause, formatFailureDetail)`. After `reactor-errors-switch`, use its user-facing formatter instead.
- Nothing else changes, including the fork and dedupe.

#### `orchestration/decider.ts`

- **Shared rejection helper.** Add `planTurnSteerRejection({ commandId, requestCommandId, threadId, expectedTurnId, messageId, error, reason, occurredAt })`, which returns `[thread.turn-steer-rejected (payload incl. reason), thread.activity-appended]`. The activity:
  - id: `turnSteerRejectionActivityId(requestCommandId)`;
  - kind: `TURN_STEER_FAILED_ACTIVITY_KIND`;
  - tone and summary: `info` / "Steer deferred" for `deferred`, `error` / "Steer failed" for `failed`;
  - payload: `{ messageId, expectedTurnId, error, reason }`;
  - `turnId: expectedTurnId`.
- **`thread.turn.steer`** (`:1239-1273`). When the session is not running, `activeTurnId` is null, or the active turn does not match, return `planTurnSteerRejection({ commandId: command.commandId, requestCommandId: command.commandId, reason: "deferred", error: "The turn finished before this message could be steered. It stays queued and is sent next.", occurredAt: command.requestedAt })` instead of throwing. Thread existence is still checked with `requireThread`.
- **`thread.turn.steer.resolve` rejected branch** (`:2070-2118`). Use the helper with `reason: command.resolution.reason ?? "failed"`.

#### Agent Control

`AgentControlExecution.ts:1191-1250` needs **no code change**:

- The pre-dispatch "approved steer target changed" check is unchanged.
- A target that ends between that check and dispatch now produces a rejection event, which the subscription already handles. That leads to `queued-after-steer-fallback`, then `waitForIdle`, then `revalidateExecution({ allowTurnAdvance: true })`.
- This is the same path a provider-level rejection takes today. Previously the operation failed with an invariant error.
- `CompletionReturnDelivery` stays queue-only (`:365`).

Agents still cannot approve anything: steering refuses while approvals are pending. A steer that races an approval aborts the tool, and Ryco settles the aborted `canUseTool` as _cancelled_ (`:4304`, `:4476`), never as approved.

### 4.5 `packages/client-runtime`

#### `state/message-queue/logic.ts`

```ts
export type ComposerFollowUpAction = "send" | "queue" | "steer";
export function alternateFollowUpBehavior(b: FollowUpBehavior): FollowUpBehavior;
/** Pure resolver: not running → "send"; preferred = invert ? alternate(b) : b;
 *  "steer" degrades to "queue" when !surfaceAllowsSteer or isSlashCommand. */
export function resolveComposerFollowUpAction(input: {
  readonly turnRunning: boolean;
  readonly followUpBehavior: FollowUpBehavior;
  readonly invert: boolean;
  readonly surfaceAllowsSteer: boolean;
  readonly isSlashCommand: boolean;
}): ComposerFollowUpAction;

export interface QueuedMessageSteerAttempt {
  readonly commandId: string;
  readonly expectedTurnId: TurnId;
  readonly startedAt: string;
  readonly explicit: boolean;
}
export type QueuedMessageSteerOutcome =
  | { readonly status: "pending" }
  | { readonly status: "accepted" }
  | {
      readonly status: "rejected";
      readonly reason: TurnSteerRejectionReason;
      readonly error: string;
    };
export function indexTurnSteerRejections(
  activities: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly payload: unknown;
  }>,
): ReadonlyMap<string, TurnSteerRejectionActivity>; // keyed by activity id
/** accepted if projected; rejected only for the activity id of THIS attempt's commandId; else pending. */
export function resolveQueuedMessageSteerOutcome(input: {
  readonly messageId: string;
  readonly attempt: QueuedMessageSteerAttempt;
  readonly projectedMessageIds: ReadonlySet<string>;
  readonly rejectionsByActivityId: ReadonlyMap<string, TurnSteerRejectionActivity>;
}): QueuedMessageSteerOutcome;
```

`resolveQueuedMessageSteerEligibility` is unchanged. Pending approvals are deliberately not a client rule, so Codex behaviour is unchanged. Claude refuses on the server instead.

#### `state/message-queue/store.ts`

Replace `steeringIdsByThreadKey: Record<string, string[]>` with `steerAttemptsByThreadKey: Record<string, Readonly<Record<string, QueuedMessageSteerAttempt>>>`.

- `beginSteer(threadKey, id, attempt)`: a no-op if an attempt for that id already exists.
- `endSteer(threadKey, id, commandId)`: ends the attempt only if its `commandId` matches, so a stale outcome cannot end a newer attempt.
- `beginSend`: refuses when an attempt exists, replacing the old `includes(id)`.
- `remove` and `clear`: drop the attempts.
- Export `steeringIdsOf(attempts): ReadonlyArray<string>` for components.

#### `state/session/session-logic.ts` `shouldIncludeActivityInWorkLog` (`:903-940`)

Return `false` when `readTurnSteerRejectionActivity(activity)?.reason === "deferred"`. Failed rows stay visible.

### 4.6 `apps/web`

#### `components/ChatView.tsx`

1. **Store selection (`:866-883`).** Select the attempts record for the thread, using a stable empty constant. Derive `steeringQueuedMessageIds` with `useMemo(() => Object.keys(attempts))`.
2. **Extract `steerQueuedEntry(message, { explicit, prepareEditors })`** from `handleSteerQueuedMessage` (`:3198-3260`):
   - check eligibility; when it fails and `explicit` is set, show the existing warning toast;
   - mint `commandId` first;
   - call `beginSteer` **synchronously** with `{ commandId, expectedTurnId, startedAt, explicit }`, before any `await`;
   - optionally prepare editors, build text and attachments, then dispatch `buildQueuedMessageSteerCommand({ commandId, … })`.

   If the dispatch throws, call `endSteer(id, commandId)` and show the existing error toast. The row's Steer button calls the function with `{ explicit: true, prepareEditors: true }`.

3. **Replace the two reconciliation effects (`:3262-3291`) with one effect:**
   - build `indexTurnSteerRejections(threadActivities)` and the projected-id set;
   - for each attempt, apply `resolveQueuedMessageSteerOutcome`:
     - `accepted`: `handleRemoveQueuedMessage(id)`;
     - `rejected`: `endSteer(id, attempt.commandId)`;
     - if `attempt.explicit`, also show a toast: info "Not steered" for deferred, error "Steer failed" for failed, using the activity's `error` text.

   After `queue-hold-drain`, run this reconciliation wherever the drain lives, before drain eligibility is checked.

4. **Signatures.** `runSend(e?, options?: { readonly invertFollowUp?: boolean })`. `onSend` forwards `options`.
5. **Running branch (`:3893-3922`).**
   - Compute `action = resolveComposerFollowUpAction({ turnRunning: true, followUpBehavior: settings.followUpBehavior, invert, surfaceAllowsSteer: presentationTier !== "phone", isSlashCommand: trimmed.startsWith("/") })`.
   - Enqueue exactly as today.
   - If `action === "steer"`, call `steerQueuedEntry(entry, { explicit: invert, prepareEditors: false })`, because editors were already drained.
   - When eligibility fails, a warning toast "Queued instead" with the reason appears only when `invert` is set.
   - Never call `steerQueuedEntry` for phone tier or slash input.
6. **Drain (`:3936-3985`).** Keep the head guard, now backed by attempts. Unchanged semantics: an entry with a live attempt is never sent as a turn.
7. **Composer hint.** Pass `getFollowUpSteerUnavailableReason(snapshot: { modelSelection; runtimeMode; interactionMode; tokenMode }) => string | null` (a thin wrapper over the eligibility function) and `followUpSurfaceAllowsSteer` to `ChatComposer`.

#### `components/chat/composerFollowUp.ts` (new)

- `isFollowUpInvertModifier(event: Pick<KeyboardEvent, "metaKey" | "ctrlKey">, platform = navigator.platform): boolean`. On Mac, `metaKey && !ctrlKey`; elsewhere, `ctrlKey && !metaKey`. Uses `isMacPlatform`.
- `describeRunningFollowUp({ followUpBehavior, steerUnavailableReason, surfaceAllowsSteer, platform })` returns `{ effective: "queue" | "steer"; placeholder: string | null }`. The shortcut label uses `formatShortcutLabel({ key: "enter", modKey: true, … })`. Placeholders:
  - steer is effective: "Steer this turn · ⌘↵ to queue instead";
  - queue mode with steering available: "Queue a follow-up · ⌘↵ to steer";
  - steer mode but steering unavailable: "Queue a follow-up · steering unavailable";
  - queue mode without steering: "Queue a follow-up";
  - phone tier: `null`.

#### `components/chat/ChatComposer.tsx` and `ComposerPromptShell.tsx`

- **`onSend` type.** `onSend: (e?, options?: { readonly invertFollowUp?: boolean }) => void`. `submitComposer` forwards it.
- **Enter handling.** In `onComposerCommandKey` (`:1768-1771`), call `submitComposer(undefined, { invertFollowUp: isFollowUpInvertModifier(event) })`. The menu branch above it is unchanged. When the composer is not running, the invert flag is ignored and Enter sends.
- **Placeholder.** Compute `runningFollowUpPlaceholder` from `settings.followUpBehavior`, the composer's own `selectedModelSelection` and its modes, using `getFollowUpSteerUnavailableReason`. Pass it to `ComposerPromptShell`. In its placeholder chain (`:316-341`), use it when `phase === "running" && !isComposerCollapsedMobile`, before the generic "Ask anything…" text.

#### Settings

- `settings/ComposerSettings.tsx`: add a row:
  - title: "Messages sent while a turn runs";
  - description: "Queue waits for the turn to finish. Steer adds the message to the running turn when the provider supports it. ⌘↵ / Ctrl+Enter does the opposite.";
  - a `Select` with Queue and Steer, using `useSettings` / `useUpdateSettings`;
  - a reset button when the value differs from `DEFAULT_UNIFIED_SETTINGS.followUpBehavior`.

  The section is already hidden on the phone tier (`SettingsPanels.tsx:688`).

- `settingsSearchIndex.ts`: add a `general` / `client` entry with keywords "steer queue follow-up enter".
- `settingsRestore.ts`: add `followUpBehavior: "Follow-up while working"`.

#### `hostedHub/environment.ts:74`

Also reset `steerAttemptsByThreadKey: {}`.

### 4.7 `apps/mobile`

- `state/threadOutbox.ts`:
  - module-level `steeringOutboxMessageIds`;
  - exports `markThreadOutboxSteering(id)` and `clearThreadOutboxSteering(id)`;
  - in `drainThreadOutbox`, add `if (steeringOutboxMessageIds.has(message.messageId)) break;` to preserve ordering;
  - `resetThreadOutboxForTests` clears the set.
- `features/threads/ThreadDetailScreen.tsx` (`:626-731`):
  - local state becomes `Map<string, QueuedMessageSteerAttempt>`;
  - mint `commandId` before dispatch, then `mark` and `clear` around the attempt;
  - reconcile with the shared `indexTurnSteerRejections` / `resolveQueuedMessageSteerOutcome`;
  - `setSendError` only for `failed`; deferred stays quiet, and the row stays visibly queued;
  - clear the marks on unmount;
  - pass `new Set(map.keys())` to `ThreadQueuedMessages`.

  Screen logic stays thin, because mobile has no component tests.

- Mobile does **not** get the follow-up setting or the composer inversion. See §8.

### 4.8 Docs

- `docs/providers/claude.md` gains a "Steering" section covering:
  - the `priority: "now"` mechanism;
  - the gates: CLI capability, approvals, slash commands;
  - that Stop cancels pending steers;
  - the known edges in §7.
- `KEYBINDINGS.md`, under `composerFocus`: "Mod+Enter in the focused composer is reserved: while a turn runs it does the opposite of the follow-up setting. Do not bind `mod+enter` to commands that can fire while the composer is focused."

## 5. Contract and migration changes

- **Migrations:** none.
- **Contracts:** all additive.
  - The new optional fields decode older persisted `thread.turn-steer-rejected` events and resolve commands.
  - `followUpBehavior` decodes to `"queue"` for existing settings blobs.
  - Older web clients still reconcile deferred rows correctly, because they key by messageId and end the attempt. They will show an info "Steer deferred" work-log row until they update.
- **Behaviour change:** the decider's `thread.turn.steer` is now total for existing threads. It rejects instead of throwing.
- **New shared subpath:** `@ryco/shared/turnSteer`.

## 6. Tests

Run each focused file with `bun run --cwd <pkg> test <file>`. Never run `bun test`. `it.effect` runs under TestClock. The suite uses no real timers.

### Server, pure: `apps/server/src/provider/claudeSteering.test.ts` (new)

**`decideClaudeTurnResult` matrix:**

| #   | Steers / settled                  | Result                         | Expected                                     |
| --- | --------------------------------- | ------------------------------ | -------------------------------------------- |
| 1   | none                              | abort                          | complete (regression)                        |
| 2   | S unsettled                       | abort, count 1                 | await-steer                                  |
| 3   | S unsettled                       | abort, count 0                 | complete                                     |
| 4   | S unsettled                       | abort, count absent            | complete                                     |
| 5   | S settled earlier                 | abort, count 1                 | complete (critique case: steers all settled) |
| 6   | S echoed now (folded)             | success                        | complete, newlySettled [S]                   |
| 7   | S unsettled                       | success, count 1               | await-steer                                  |
| 8   | S unsettled                       | failure (`api_error`), count 1 | complete                                     |
| 9   | S unsettled, `interruptRequested` | abort, count 1                 | complete                                     |
| 10  | S1 settled, S2 unsettled          | abort, count 1                 | await-steer                                  |

**Other pure cases:**

- `classifyClaudeResultKind`:
  - `aborted_tools` with no "abort" in the error text → abort;
  - no `terminal_reason` with "Request was aborted" → abort;
  - success with `is_error: true` → failure, including the SDK's API-error shape (`terminal_reason: "api_error"`, `api_error_status`, the error text in `result`), which matrix row 8 then drops.
- `decideClaudeTurnClose`: each cause in §4.3, its precedence, and that a Stop racing the prompt's own result keeps that result's status.
- `claudeResultBelongsToTurn`: a steer-only echo belongs; a foreign echo does not; an empty echo with a non-human origin does not.
- `decideClaudeStop`: every row S1–S8 of §3.
- `readClaudeInterruptReceipt`: `undefined`, valid input, and garbage.
- `rememberDiscardedSteer`: FIFO cap.
- `parseClaudeCliCapabilities`: field present and absent.

### Server: `ClaudeAdapter.test.ts`

Extend `FakeClaudeQuery` so that `interrupt(options?)` records the options and returns a configurable receipt. Add a helper that emits `system/init` with `capabilities`. Read the offered prompts from the captured `createInput.prompt`.

- **(a) Steer message shape.** `steerTurn` offers `{ priority: "now", uuid: <fresh> }`, carrying the turn's effort prefix. It returns the same `turnId`. The adapter declares `capabilities.turnSteering === "native"`.
- **(b) Refusals.** Each case fails with `ProviderTurnNotSteerableError` and the reason given:
  - no init capability → `unsupported`;
  - wrong `expectedTurnId` → `turn-ended`;
  - pending approval → `busy`;
  - input `"/review x"` → `unsupported`;
  - after `interruptTurn` → `turn-ended`;
  - session stopped → `ProviderAdapterSessionNotFoundError` (a different error).
- **(c) Abort, then continue.**
  - Setup: run P. While P has an open text block (index 0), an open thinking block (index 1) and an in-flight tool, steer S.
  - Emit an aborted result: `terminal_reason: "aborted_streaming"`, `user_message_uuids: [P]`, `queued_turn_count: 1`.
  - Expect from the abort: **no** `turn.completed`; `item.completed` for the text block (completed), the reasoning block (completed) and the tool (failed); and `thread.token-usage.updated` with the turnId.
  - Then emit S's `stream_event` (echo `[S]`) with index-0 text. Expect a **new** itemId, and no synthetic `turn.started`.
  - Then emit a success result echoing `[S]`. Expect exactly one `turn.completed` (completed) for P's turnId.
- **(d) Folded steer.** A success result echoing `[P, S]` completes immediately.
- **(e) S2.** Expect `interrupt` called with `{ cancelQueued: true }`. The receipt `{ still_queued: [], cancelled: [S] }` produces an immediate `turn.completed` (interrupted).
- **(f) S3.**
  - The receipt `{ still_queued: [S] }` produces an immediate completion.
  - Later S frames (a `stream_event` echoing `[S]`, an assistant frame, a result echoing `[S]`) emit no `turn.started`, no `content.delta` and no `turn.completed`.
  - `interruptCalls.length === 2`.
- **(g) S4.**
  - No force-close happens at Stop.
  - An aborted result echoing `[P]` produces exactly one `turn.completed` (interrupted).
  - S's frames are then discarded.
- **(h) S5.**
  - No force-close happens at Stop.
  - S's first `stream_event` is processed and triggers a second interrupt.
  - An aborted result echoing `[S]` produces exactly one `turn.completed` (interrupted).
- **(i) S1.** `interrupt()` is called with no argument. The existing tests "treats user-aborted Claude results as interrupted…" and "interruptTurn settles every acknowledged live task…" stay green.
- **(j) Failed segment.** A failed segment (`api_error`, count 1) with unsettled S produces `turn.completed` (failed). Then S's frames are discarded. The same holds for the SDK's API-error shape (`subtype: "success", is_error: true`): the turn fails with the result text and one `runtime.error`.
- **(j2) Stopped steer with an API-error reply.** S3 (stale receipt) and S5 (in transit): S's first reply is an echoed root assistant frame with `error: "server_error"`. No re-interrupt (`interruptCalls` holds only Stop's call), and S's flagged-success result closes the turn once as `interrupted` with no `runtime.error`.
- **(j3) Prompt folded into a discarded CLI turn.** With the discard's re-interrupt sent, the CLI's result echoes `[S, P2]`, aborted or finished. P2's turn ends once as `failed` with the resend notice and a `runtime.error`, never as `interrupted`, and the dropped reply never streams.
- **(k) Reasoning fix without steers.** An aborted result while a thinking block is open emits `item.completed` (reasoning) before `turn.completed`.
- **(l) `terminal_reason` mapping.** An `aborted_tools` result whose error text lacks "abort" produces `turn.completed` (interrupted), with no runtime error.
- **(m) Correlation.** Extend the existing `foreignResult` table at `:5157-5300`: a result echoing only the turn's steer uuid is accepted, and foreign results are still dropped.

### Server: other files

- **`ProviderService.test.ts`:** add a Claude-shaped fake adapter (`turnSteering: "native"` plus `steerTurn`) and check routing. Error cases:
  - turn mismatch → `ProviderTurnNotSteerableError` (`turn-ended`);
  - non-steering adapter → `ProviderTurnNotSteerableError` (`unsupported`);
  - `!isActive` → `ProviderSessionNotFoundError` (unchanged).
- **`CodexAdapter.test.ts`:**
  - a runtime `turn/steer` request error when the runtime's active turn differs → `ProviderTurnNotSteerableError` (`turn-ended`);
  - the same error when the active turn matches → the original `ProviderAdapterRequestError`.
- **`turnSteerFailure.test.ts` (new):**
  - not-steerable → deferred with its detail;
  - each session-not-found or closed tag → deferred with the friendly text (asserting that "Unknown provider thread" does not appear);
  - a request error → failed with its detail;
  - an empty detail → the fallback text;
  - the 1,000-character cap.
- **`ProviderCommandReactor.test.ts`:**
  - a `steerTurn` failing with `ProviderTurnNotSteerableError` → resolve rejected with `reason: "deferred"`;
  - `ProviderAdapterSessionNotFoundError` → deferred;
  - `ProviderAdapterRequestError` → `failed`.
- **`decider.steer.test.ts`.** These two cases are **failing-first**, because today the decider throws:
  - **no running session** → events `[thread.turn-steer-rejected, thread.activity-appended]` with `reason: "deferred"`, `tone: "info"` and id `turn-steer-rejected:<commandId>`;
  - **mismatched expected turn** → the same.

  Also cover:
  - resolve rejected with `reason: "deferred"` → info activity;
  - resolve without `reason` → legacy error "Steer failed".

- **`AgentControlExecution.test.ts`:** a variant of "falls back from rejected steering…" (`:675`) whose rejection payload carries `reason: "deferred"` → `delivery: "queued-after-steer-fallback"`, with `thread.turn.start` dispatched after idle.

### Contracts, shared, client-runtime

- **`packages/contracts/src/settings.test.ts`:** `followUpBehavior` defaults to `"queue"`; the patch accepts `"steer"`; an invalid literal is rejected.
- **`packages/shared/src/turnSteer.test.ts` (new):** the id builder; the reader returns `reason` and `error`; a legacy row without `reason` reads as `"failed"`; an unrelated kind returns `null`.
- **`message-queue/logic.test.ts`:**
  - **`resolveComposerFollowUpAction`:**
    - not running → send;
    - queue → queue; queue plus invert → steer;
    - steer → steer; steer plus invert → queue;
    - phone surface → queue;
    - slash input → queue.
  - **`resolveQueuedMessageSteerOutcome`:**
    - projected → accepted;
    - a rejection for this attempt's `commandId` → rejected with its reason;
    - **a stale rejection for an older `commandId` of the same message → pending** (critique #3);
    - a legacy row → `failed`.
- **`message-queue/store.test.ts`:**
  - `beginSteer` stores the attempt; `endSteer` with a mismatched `commandId` is a no-op;
  - `beginSend` refuses while an attempt is live;
  - `remove` and `clear` drop attempts.
- **`session-logic.test.ts`:** a deferred steer row is excluded from the work log; a failed row is included.

### Web and mobile

- **`composerFollowUp.test.ts` (new):** modifier detection on Mac and Windows (including both modifiers held); all four placeholder strings; `null` on phone.
- **`settingsRestore.test.ts`:** `followUpBehavior` is restorable and labelled.
- **`ChatView.Composer.browser.tsx`:** run only this file. Use a running thread whose provider status has `supportsTurnSteering: true`.
  - steer mode, Enter → dispatches `thread.turn.steer` and the row shows steering;
  - steer mode, Mod+Enter → enqueues with no steer command;
  - queue mode → the inverse;
  - a stale deferred rejection for an earlier `commandId` does not end a re-steer.
- **`apps/mobile/src/state/threadOutbox.test.ts`:** the drain stops at a message marked as steering, leaving later messages for that thread waiting. It resumes after `clearThreadOutboxSteering`.

## 7. Edge cases

- **Steer accepted just as the turn finishes.** If S is accepted after the CLI produced P's success result but before Ryco processed it, then `queued_turn_count` is 0 and the turn completes. S then runs as its own CLI turn and its reply lands in a synthetic turn. The user message stays in the completed turn. This is a narrow race and the reply is still visible. It is logged as `claude.turn.result-without-active-turn` or as the synthetic-turn path.
- **Wake turns while waiting.** A background wake turn can run between the aborted segment and S. Its frames are attributed to the open turn, and its result is dropped as another prompt's. This is existing behaviour for wakes during a prompt. Stop still closes the turn (scenario S6).
- **`cancel_queued` drops more than steers.** It also dequeues uuid-less task notifications. That is why it is sent only when the turn has unsettled steers. In that case dropping pending wakes matches what Stop means.
- **Two steers close together** may run as one CLI turn. The result lists both uuids and both settle.
- **Steer during compaction** (`status: compacting`): allowed. The CLI queues S.
- **Discard path** requires the early echo from `includePartialMessages`, which Ryco always sets. On a CLI that echoes only on the result, a discarded steer's output would leak into a synthetic turn. That turn has no other result to close it, so the steer's fully discarded result is routed to it and completes it instead of being dropped. Steering is gated on `interrupt_receipt_v1`, a modern capability, so this is unlikely.
- **Stop arriving before S reaches the CLI:** handled by scenario S5. The steer is counted as running, so the turn is not force-closed.
- **Stale receipt (implementation note).** The stream fiber can route S's first echoed frame into the stopped turn before the interrupt fiber handles a receipt that still lists S as queued. A steer whose echo was routed into the turn counts as running whatever the receipt says, so the turn is not force-closed and S's re-interrupted aborted result closes it (S5 behaviour).
- **Cancelled steers stay settled (implementation note).** With `interrupt_cancel_queued_v1`, the uuids the receipt cancelled are marked settled on the turn, so a stopped turn's closing result handled after the receipt does not put them back into the discard set, where they would defer every later wake signal.
- **Echo on the assistant reply (implementation note).** A discarded steer's CLI turn that streams nothing carries its echo on its first root assistant frame. That frame starts the discard like the stream echo, so the deferred wake turn never opens. A synthetic API-error reply (`error` set, other than `max_output_tokens`) ends its CLI turn, so it is not re-interrupted: the interrupt would land on the CLI's next turn. The same applies to the S5 re-interrupt.
- **Prompt folded into a discarded CLI turn (implementation note).** If the CLI folds the next prompt (or a steer of the open turn) into a discarded steer's CLI turn, only the result shows it. That result echoes a uuid the open turn owns, so it closes the turn instead of being dropped (D2). The prompt gets no reply at all: the discard's re-interrupt was sent at the CLI turn's first reply, so the folded result is normally the aborted one, and a folded uuid never runs as its own turn (`sdk.d.ts` `cancel_queued`). Even when the CLI turn finishes first, its reply was already dropped with the discarded frames. The turn therefore ends as `failed` with a notice to send the message again, never as `interrupted`, which would make the client queue hold as "Paused after Stop" for a Stop the user never pressed.
- **Stopped turn closed by a steer's own result (implementation note).** A steer whose first reply is a synthetic API-error reply counts as started, so a stale receipt does not force-close the stopped turn (S3), and no re-interrupt is sent (S3 and S5). The steer's flagged-success result then closes the turn. Because it echoes only a steer and Stop was requested, the turn ends as `interrupted`, as the S3/S5 rows require, not as `completed`.
- **Failure flagged as success (implementation note).** The SDK reports a request that failed at the API after its retries as `subtype: "success", is_error: true`, and `turnStatusFromResult` maps that to `completed`. When such a result drops pending steers (matrix row 8), the turn ends as `failed` with the result text and a `runtime.error` instead, so the queue holds as the discard rule assumes and the user sees why the steer got no reply. Without pending steers the existing mapping is unchanged.
- **Discarded steer batched with the next prompt.** If the CLI runs a discarded steer in the same CLI turn as the next prompt, the echo is not fully discarded, so the CLI turn is kept and the steer is answered inside that prompt's turn. Documented in `docs/providers/claude.md`.
- **Prompt queued behind its own steer (known edge, deferred).** When `sendTurn` installs P while the CLI is still running another CLI turn (for example a wake turn its stale-turn loop closed locally), P waits in the CLI queue. If the user then steers S and the CLI runs the `"now"` S before the queued P instead of batching them, S's result settles every steer and the turn completes before P ran; P's reply lands in a background turn. Ryco does not track prompt consumption for this. Handling it needs the prompt to be treated like a pending steer in the await rule and in the Stop protocol (cancel, discard, re-interrupt), which waits on manual QA §11 showing how the CLI orders the two. Documented in `docs/providers/claude.md`.
- **Lost client attempts.** If the server restarts after `thread.turn-steer-requested` was persisted but before it resolved, the attempt stays pending. The row's Remove button stays enabled (`ComposerQueuedMessages.tsx:116-123`). W3 `provider-effect-outbox` must resolve such steers as rejected with `reason: "deferred"`.
- **Timeline order of a queued-then-steered message.** The steer keeps the queue `createdAt`, the same as for Codex today. A direct composer steer uses "now".
- **`turn.completed.usage` (main-loop, per CLI turn)** reflects only the last segment. The context meter is updated for every segment, and `totalCostUsd` is cumulative.

## 8. Out of scope

- Starting a turn on the server for a late steer, and a server-side queue.
- Mobile follow-up setting and composer inversion. Mobile keeps the explicit Steer button and now also gets it for Claude.
- Per-uuid cancellation through the untyped `cancelAsyncMessage`.
- Steering for Copilot, OpenCode, Cursor, ACP and Grok.
- Steering slash commands and Claude skills (t3 `planClaudeSkillDispatch`).
- A decider guard against duplicate message ids. The in-memory model does not hold every message, see spec 04.
- Accumulating usage across segments into `turn.completed.usage`.
- Moving `sendTurn`'s stale-turn `completeTurn` under `turnLock`. That race predates this work.
- A UI warning in `KeybindingsSettings` for user `mod+enter` rules. This spec covers it with a docs note only.

## 9. Coordination and overlaps

- **`queue-hold-drain` (W1).** This package rebases on it. The drain owner must skip entries with a live steer attempt, and must run `resolveQueuedMessageSteerOutcome` reconciliation before checking eligibility. Deferred entries are subject to its holds (Stop or failure), which is intended.
- **`claude-meter-wake` (W1).** Extract `computeResultUsageSnapshot` / `emitTokenUsageSnapshot` from _their_ version of the `completeTurn` usage code. If they moved the synthetic-turn creation site (#15055), construct it with `makeClaudeTurnState`. `routeSteerFrame` runs before any synthetic-turn creation.
- **`reactor-errors-switch` (W1).** `classifyTurnSteerFailure` takes the formatter as a parameter, so pass their user-facing formatter.
- **`usage-limits` (W2, same wave, unavoidable overlap in `handleResultMessage`, `turnStatusFromResult` and the `completeTurn` tail).** Their usage-limit classification applies to results this classifier marks `complete`, because usage-limit results are `failure`, which never waits. Agreed split:
  - this package owns the correlation check and the await branch at the top of `handleResultMessage`, and the `terminal_reason` abort line in `turnStatusFromResult`;
  - `usage-limits` owns failure classification and the error class. Their usage-limit result (also `subtype: "success", is_error: true`) takes precedence over this package's `failed-segment-dropped-steers` close; both end the turn as `failed`, and a pending steer is still discarded by `decideClaudeTurnResult`.

  Whichever merges second rebases.

- **`rollback-correctness` (W2, same wave).** They own the `context.turns.push` / `updateResumeCursor` tail of `completeTurn` and the query or context replacement. This package owns `sealTurnSegment` and the usage extraction at the top. The identity re-check and the offer boolean in `steerTurn` make a replaced context fail as `turn-ended`.
- **`delegation-returns` (W2, same wave).** If parent wakes are delivered by steer, treat any `thread.turn-steer-rejected` (deferred or failed) as "queue". Do not edit `decider.ts` `thread.turn.steer` or the reactor steer handler. The untrusted-result labelling stays.
- **`settlement-signals` / `provider-compat` (W1).** Adjacent edits to the `packages/shared/package.json` exports map. Keep all entries.
- **`provider-effect-outbox` (W3).** When steer effects become unsafe-on-crash, cancel them by dispatching `thread.turn.steer.resolve` rejected with `reason: "deferred"`.

## 10. Review resolution

| #   | Severity | Issue                                                                           | Resolution                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | major    | Stop does not stop a steer the CLI has queued                                   | **Accepted, extended.** Verified that the 0.3.263 runtime forwards `interrupt({ cancelQueued: true })`. The flag is sent only when steers are pending and the CLI advertises `interrupt_cancel_queued_v1`. The receipt drives force-close and the discard set. The §3 S1–S8 table covers the in-transit and wake cases the critique did not list, and each row has a test |
| 2   | major    | The await step can leave a turn running forever                                 | **Accepted, strengthened.** Waiting requires unsettled steers after subtracting settled ones, an abort or success segment, and a _positive_ `queued_turn_count > 0`. An absent or zero count completes the turn. `interruptRequested` is set unconditionally. Matrix rows 3, 4, 5 and 9 pin this down                                                                     |
| 3   | major    | Rejection reconciliation keyed only by messageId                                | **Accepted.** Attempts are keyed by `commandId`, and `endSteer` matches the `commandId`. The shared pure helper is used by web and mobile and handles deferred rejections quietly. The mobile drain gets the steering exclusion. Stale-rejection tests are added                                                                                                          |
| 4   | minor    | Reasoning blocks are left open on seal or completion                            | **Accepted.** `sealTurnSegment` closes them, and `completeTurn` inherits the fix. Tests (c) and (k)                                                                                                                                                                                                                                                                       |
| 5   | minor    | Slash input can be steered mid-turn                                             | **Accepted.** The adapter refuses `unsupported`, which is deferred, and the client resolver queues slash input. Test (b) and resolver matrix                                                                                                                                                                                                                              |
| 6   | minor    | Codex late steer reads "failed" and shows raw session text                      | **Accepted.** Codex `steerTurn` checks state to map to `turn-ended`. Session-not-found and closed errors become deferred with a friendly sentence                                                                                                                                                                                                                         |
| 7   | minor    | Incomplete coordination; `steerTurn` captures a stale context                   | **Accepted.** §9 names `claude-meter-wake`, `rollback-correctness`, `usage-limits` and `delegation-returns`. `steerTurn` re-checks identity and the offer boolean under `turnLock`                                                                                                                                                                                        |
| 8   | minor    | The deferred activity pollutes the work log                                     | **Accepted.** Deferred rows are info tone and excluded in `session-logic`                                                                                                                                                                                                                                                                                                 |
| 9   | minor    | No usage update between segments                                                | **Accepted.** The await branch emits `thread.token-usage.updated` from the segment result. Per-segment accumulation into `turn.completed.usage` is out of scope (§8)                                                                                                                                                                                                      |
| 10  | minor    | Ordering, labels, silent fallback and Mod+Enter reservation are under-specified | **Accepted.** D9 lets a direct steer jump ahead, with a test. The running placeholder uses the alternate action. A warning toast appears only for explicit Mod+Enter fallback. KEYBINDINGS.md gets a reservation note                                                                                                                                                     |
| 11  | minor    | Test gaps                                                                       | **Accepted.** Every listed case is in §6: the classifier matrix, receipt fakes, ProviderService and reactor deferral, the client stale-attempt case, the Agent Control deferred variant, and a Claude-shaped adapter in ProviderService                                                                                                                                   |

The verdict "feature" was re-verified independently; see §1.1.

## 11. Manual QA (record findings in `docs/providers/claude.md`)

1. Run Claude with `nativeEventLogPath` set and follow-up set to **Steer**. Start a long tool-using turn and press Enter mid-stream. Expect the message to appear in the same turn, the reply to continue in that turn, one Working state and one completion. **Record** from the NDJSON log whether `"now"` aborted (and with which `terminal_reason`) or folded, and the `queued_turn_count` values.
2. Steer while a Bash tool is running, which exercises `aborted_tools`.
3. Steer, then press Stop at once. Do this with a CLI that has `interrupt_cancel_queued_v1`, and if available, with one that has only the receipt capability. Expect no new Working turn and no reply to the steer.
4. Steer while an approval is pending. The message stays queued. After approving, the row's Steer button works.
5. Press Enter just after the turn ends. The message is sent as a new turn, with no toast and no work-log row.
6. In Queue mode, Mod+Enter steers and Enter queues. The placeholder text matches.
7. Codex parity: steps 1, 5 and 6.
8. Mobile: the Steer button on a Claude thread. A deferred rejection shows no banner.

## 12. Validation

Run only the focused files listed in §6:

- `bun run --cwd apps/server test <file>`;
- `bun run --cwd packages/client-runtime test <file>`;
- `bun run --cwd packages/contracts test src/settings.test.ts`;
- `bun run --cwd packages/shared test src/turnSteer.test.ts`;
- `bun run --cwd apps/web test src/components/chat/composerFollowUp.test.ts`;
- `bun run --cwd apps/mobile test src/state/threadOutbox.test.ts`.

Also run `bun typecheck`, because the change crosses packages, and the single browser file `ChatView.Composer.browser.tsx`. The full backstop is not required: the change is cross-package but each surface is focused.
