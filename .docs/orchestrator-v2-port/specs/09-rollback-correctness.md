# 09 · rollback-correctness: checkpoint revert that tells the truth (bugs 1–2)

| Field | Value |
| --- | --- |
| id | `rollback-correctness` |
| title | Provider-first checkpoint revert with admission checks, shared-checkout safety, Claude resume-at-target, Codex `thread/revert`, and honest refusal for providers that cannot forget turns |
| wave | 2 (parallel, isolated worktree). Ship as **4 stacked commits** (A → B → C → D), each green on its own (§3) |
| verdict | **confirmed** (both bugs, plus two more found in review: OpenCode drops the kept turn, and Codex ≥ 0.160 rejects `thread/rollback` outright) |
| size | L (A: M, B: M, C: S, D: S–M) |
| touched files | **A (orchestration):** `packages/contracts/src/orchestration.ts` · `apps/server/src/orchestration/checkpointRevertPolicy.ts` (new) · `apps/server/src/checkpointing/restoreSafety.ts` (new) · `apps/server/src/orchestration/threadSettlementInput.ts` · `apps/server/src/orchestration/commandInvariants.ts` (one export) · `apps/server/src/orchestration/decider.ts` · `apps/server/src/orchestration/projector.ts` · `apps/server/src/orchestration/Layers/CheckpointReactor.ts` · `apps/server/src/orchestration/Services/CheckpointReactor.ts` · `apps/server/src/orchestration/Layers/OrchestrationReactor.ts` · `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts` · `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` · `apps/server/src/checkpointing/Services/CheckpointStore.ts` · `apps/server/src/checkpointing/Layers/CheckpointStore.ts` · `apps/server/src/provider/Services/ProviderAdapter.ts` · `apps/server/src/provider/Services/ProviderService.ts` · `apps/server/src/provider/Layers/ProviderService.ts` · `apps/server/src/provider/Errors.ts` · signature-only: `Layers/ClaudeAdapter.ts`, `Layers/CodexAdapter.ts`, `Layers/OpenCodeAdapter.ts`, `Layers/CursorAdapter.ts`, `Layers/CopilotAdapter.session.ts`, `Layers/AcpAdapter.ts`, `apps/server/integration/TestProviderAdapter.integration.ts` · tests: `orchestration/decider.checkpointRevert.test.ts` (new), `orchestration/checkpointRevertPolicy.test.ts` (new), `checkpointing/restoreSafety.test.ts` (new), `orchestration/projector.test.ts`, `orchestration/Layers/CheckpointReactor.test.ts`, `orchestration/Layers/checkpointEpochSafety.test.ts`, `orchestration/Layers/OrchestrationReactor.test.ts`, `orchestration/Layers/ProjectionSnapshotQuery.test.ts`, `checkpointing/Layers/CheckpointStore.test.ts`, `provider/Layers/ProviderService.test.ts`. **B (Claude):** `apps/server/src/provider/Layers/ClaudeAdapter.ts` · `ClaudeAdapter.test.ts`. **C (Codex):** `apps/server/src/provider/Layers/CodexSessionRuntime.ts` · `Layers/CodexAdapter.ts` · `CodexSessionRuntime.test.ts` · `CodexAdapter.test.ts`. **D (other providers + clients):** `Layers/OpenCodeAdapter.ts` · `OpenCodeAdapter.test.ts` · `Layers/CursorAdapter.ts` · `Layers/CopilotAdapter.session.ts` · `Layers/AcpAdapter.ts` · `packages/contracts/src/server.ts` · `apps/server/src/provider/Layers/ProviderRegistry.ts` (+ test) · `packages/client-runtime/src/state/composer/providerModels.ts` (+ index export, + test) · `apps/web/src/hooks/chatSessionActions.ts` · `apps/web/src/hooks/useChatSessionActions.ts` · `apps/web/src/components/ChatView.tsx` (one call site) · `apps/web/src/hooks/chatSessionActions.test.ts` · `apps/mobile/src/features/threads/sessionActions.ts` (+ test) |
| migrations | **none.** No migration number is used. Pending-revert state lives in a lifecycle activity that already has a table (`projection_thread_activities`) |
| contract changes | `orchestration.ts`: new `CHECKPOINT_REVERT_ACTIVITY_KIND`, `CheckpointRevertStatus`, `CheckpointRevertFailureReason`, `CheckpointRevertActivityPayload` (schema only). Internal command `thread.revert.complete` and event payload `ThreadRevertedPayload` gain **optional** `droppedTurnIds` and `latestTurn`; older events decode unchanged. `server.ts`: `ServerProvider.supportsConversationRollback` (optional boolean, absent = unknown). Activity kind `checkpoint.revert.failed` is no longer emitted (old rows stay readable). Server-internal: `ProviderAdapterCapabilities.conversationRollback`, `rollbackThread(threadId, input)`, `ProviderService.rollbackConversation` input, `ProviderOperationUnsupportedError`, `CheckpointReactorShape.recover`, `CheckpointStoreShape.hasHeadCommit`, optional `ProjectionSnapshotQueryShape.listPendingCheckpointReverts`. Persisted provider state: the Claude resume cursor gains an optional `rewind` marker. An OpenCode binding's `sessionId` changes after a revert |
| overlaps | **Same wave (W2):** `claude-steering` (`ClaudeAdapter.ts` `capabilities` literal, `sendTurn` head, `startSession`; `ProviderAdapter.ts` capabilities interface), `usage-limits` (`ClaudeAdapter.ts` `handleResultMessage` head; `decider.ts` `thread.turn.start`; `server.ts` `ServerProvider`; maybe `ProviderRegistry.ts`), `delegation-returns` (`decider.ts` `thread.turn.start`; semantic: returns blocked during a revert), `delegation-lineage` (no textual overlap expected). **W1 (merged before this):** `delegation-guard-restart` (semantic dependency, projector revert on the hydrated model, handed to this package), `turn-finalization` (semantic dependency: admission needs `latestTurn` to leave `running`), `reactor-errors-switch` (line overlap in `CheckpointReactor.processDomainEvent` catch blocks and `appendRevertFailureActivity`, which this package replaces), `queue-hold-drain` (semantic: new `thread.turn.start` rejection during a revert), `settlement-signals` (imports from `packages/shared/src/threadSettlement.ts`, not edited; possible adjacent edit in `threadSettlementInput.ts`), `claude-meter-wake` (`ClaudeAdapter.ts`, different functions), `provider-compat` (`ProviderRegistry.ts`, `server.ts` adjacent fields), `acp-message-ids` (`AcpAdapter.ts`, different functions). **W3:** `reactor-concurrency` (CheckpointReactor worker), `provider-effect-outbox` (should subsume the revert journal's crash window), `restart-continuation` (must honour the Claude `rewind` marker and the OpenCode fork session id) |

---

## 1. Problem (verified against the code at `9e545b3ae`)

### 1.1 Claude rollback is cosmetic (bug 1)

- `ClaudeAdapter.ts:5110-5117` `rollbackThread` splices `context.turns` and calls `updateResumeCursor`. The live SDK query is never closed.
- `updateResumeCursor` (`:1821-1838`) writes `resumeSessionAt: context.lastAssistantUuid`, the newest assistant uuid. The cursor field is informational only. `startSession` never passes it to the SDK: `queryOptions` (`:4608-4632`) sets only `resume` / `sessionId`. `ClaudeAdapter.test.ts:3628-3661` deliberately asserts `options.resumeSessionAt === undefined`, because pinning the newest assistant uuid on a plain resume would truncate legitimate tail entries.
- `context.turns` is reset to `[]` on every start (`:4753`). After a restart, the adapter's turn list does not match the orchestration's checkpoints.
- Subagent snapshots (`parent_tool_use_id` set) also overwrite `lastAssistantUuid` (`:3006`), so it can point into a sidechain.
- The pinned SDK (`@anthropic-ai/claude-agent-sdk` 0.3.263, `sdk.d.ts:1933-1990`) supports `resumeSessionAt`, which forks at "the KEPT turn's last chain entry", and `resumeDropsTurn`, a validator. It also exports `getSessionMessages(sessionId, { dir, includeSystemMessages })` (`sdk.d.ts:797`), which reads the main chain from the JSONL transcript.

### 1.2 Revert has no safety rails (bug 2)

- **Files before provider.** `CheckpointReactor.ts:744-756` runs `restoreCheckpoint` (`git restore --source <c> --worktree --staged -- .` then `git clean -fd -- .`, `CheckpointStore.ts:215-224`). Only after that does `:763-768` call `providerService.rollbackConversation`. A provider failure leaves the files reverted while the agent still remembers the work.
- **No admission.** `decider.ts:1414-1434` only calls `requireThread`. A revert is accepted while a turn runs, while an approval or question is pending, while a context handoff is in flight, or in the window after a user message is accepted but before `ProviderCommandReactor` starts the turn. `latestTurn` is not set on `thread.turn-start-requested`; see `projector.ts`, which has no such case.
- **No shared-checkout safety.** A thread whose workspace is the project root wipes every other thread's uncommitted edits in that checkout. When ref 0 is missing, `fallbackToHead` (`CheckpointStore.ts:205-207`) resets the whole checkout to `HEAD`.
- **Live session required.** `CheckpointReactor.ts:680-689` fails without a live session, even though `ProviderService.rollbackConversation` already recovers sessions.
- **Providers without native rollback:**
  - Copilot is a silent no-op (`CopilotAdapter.session.ts:674-678`).
  - Grok and the ACP registry (`AcpAdapter.ts:1024-1040`) return an error *after* the files were restored.
  - Cursor (`CursorAdapter.ts:1230-1242`) trims an in-memory list.
  - `ProviderService.rollbackConversation` (`ProviderService.ts:1606-1645`) recovers or spawns a session before learning that the adapter cannot roll back, and never persists the adapter's new resume cursor.
- **Codex.** `CodexSessionRuntime.ts:2269-2281` calls `thread/rollback`. `schema.gen.ts:1326` marks it deprecated, and the vendored schema has no `thread/revert` (`meta.gen.ts:23`). **Live check, Codex 0.160.0 with a throwaway `CODEX_HOME`:**
  - `thread/rollback` returns `-32600 "Invalid request: unknown variant \`thread/rollback\`"`.
  - `thread/revert` is a known method; it rejected only the bogus thread id.
  - `codex app-server generate-json-schema` emits `ThreadRevertParams { threadId, beforeTurnId }` ("Replace a paginated thread's durable history with the prefix before one turn. … does not revert local file changes"), `ThreadRevertResponse` (`turns` always empty) and `ThreadRevertedNotification`.
  - Today, **every Codex revert on a current binary restores files and then fails**.
- **OpenCode.** `OpenCodeAdapter.ts:2764-2787` passes the last *kept* assistant message to `session.revert`. OpenCode's boundary is exclusive (t3 `OpenCodeAdapterV2.ts:746-761`), and reverting at an assistant message reverts that message's whole user turn. So the kept turn is dropped. A revert to 0 sends no `messageID`. OpenCode 1.x `session.revert` also reverts files itself; there is no `files: false` before OpenCode 2 (`OpenCode2AdapterV2.test.ts:2878`).
- **Handoff epoch off by one.** `providerRollbackEpochViolation` (`CheckpointReactor.ts:129-131`) uses `<`. The handoff transcript is the provider input of the first epoch turn (`ContextHandoffCoordinator.ts:735-746`), so reverting to the epoch baseline drops the whole handed-off context while the UI still shows those turns. The check must be `<=`.
- **Hydrated command model** (handoff from `04-delegation-guard-restart.md:501-510`):
  - After a restart the engine model has `checkpoints: []` and only the first and latest user messages (`ProjectionSnapshotQuery.ts` ~2383-2416).
  - `thread.reverted` (`projector.ts:890-935`) then sets `latestTurn = null` and keeps user anchors by count, including a reverted latest anchor.
  - Effects: a phantom `queued-turn` blocker, and the delegated-return fence disagreeing with SQL.

### 1.3 Why the ContextHandoffCoordinator cannot back non-native rollback

The coordinator is driven by `thread.turn-start-requested` with a model-selection change. It uses `modelSelectionRequiresContextHandoff` (`decider.ts:1036-1110`) and mode `"full-context-fresh-session"`. It keys the handoff to the *target message* of that turn start and builds the transcript from SQL inside `processTurnStart`. A rollback handoff would need:

- a new handoff mode,
- a "next turn needs handoff" marker created by the revert,
- decider wiring that triggers on a turn start without a model change, and
- new epoch-guard semantics.

That is a separate feature. **Decision:** providers without native rollback get a **clear refusal** before anything changes, surfaced in the work log and, from commit D, before the user confirms.

## 2. Approach

1. **Admission in the decider.** All checks are pure and use the command model:
   - session `starting`/`running`, or an unsettled `latestTurn`;
   - a pending approval or question;
   - an actionable context handoff;
   - **a queued turn start**: `hasQueuedTurnStart(threadSettlementInput(...))`, the shared 2-minute rule;
   - **another pending revert**.

   An accepted revert emits two events:
   - a lifecycle **activity** `checkpoint.revert` with status `requested` and id `checkpoint-revert:<commandId>`;
   - the existing `thread.checkpoint-revert-requested`.

   While that activity is pending, `thread.turn.start` is rejected.
2. **Provider first.** The reactor validates, then runs the shared-checkout safety check, then rolls back the provider conversation. Only after that does it restore files.
   - A provider failure leaves files and history untouched.
   - A file failure after the provider succeeded still projects `thread.reverted`, because the conversation now matches checkpoint K. It reports `files-not-restored` honestly.
3. **A durable phase journal** in the activity payload: `requested → rolling-back → restoring-files → terminal`. A startup `recover()` finishes `restoring-files`, and marks `rolling-back` as `interrupted` and `requested` as `failed`, each with guidance. This is an interim journal until `provider-effect-outbox` (W3).
4. **Shared-checkout safety.** This deliberately relaxes t3's "isolated worktree only" rule; see §6.3 for the rationale.
   - A revert restores the whole working tree at the checkpoint cwd.
   - It is refused when another thread that **shares that working tree** is busy, or has activity newer than checkpoint K.
   - When the restore would fall back to `HEAD`, any overlap at all refuses it.
   - Nested worktrees and repositories (a `.git` entry between the paths) do not overlap.
5. **Precise provider targets.** `rollbackConversation` gets `{ numTurns, targetTurnId, droppedTurnIds }`. The ids are orchestration turn ids, which equal provider turn ids: Claude's prompt uuid, Codex's native turn id.
   - **Claude:**
     1. Close the live query and wait for the CLI to exit.
     2. Reopen with `resume` + `resumeSessionAt` = the chain entry just before the first dropped prompt, read from the transcript, or else the target turn's recorded head. For K = 0, open a fresh session id.
     3. Probe the reopened CLI. On failure, reopen the previous cursor and report.
     4. A `rewind` marker in the cursor keeps later resumes truncated until a new turn completes.
   - **Codex:** `thread/revert { beforeTurnId: droppedTurnIds[0] }`, falling back to `thread/rollback` only on old binaries.
   - **OpenCode:** `session.fork` at the first dropped user message. This leaves files alone; the context is rebound and the permissions re-applied.
   - **Copilot, Cursor, Grok/ACP:** `conversationRollback` is absent, so ProviderService refuses *before* any recovery.
6. **Projector coherence.** `thread.reverted` carries the authoritative `latestTurn` and `droppedTurnIds`, read by the reactor from SQL. The projector uses them, plus a `createdAt ≤ boundary` rule for items whose turn is unknown. This fixes the hydrated model. Legacy events keep today's logic.

## 3. Step-by-step changes

### Commit A: orchestration ordering, admission, safety, journal

#### A1. `packages/contracts/src/orchestration.ts` (schema only)

```ts
export const CHECKPOINT_REVERT_ACTIVITY_KIND = "checkpoint.revert";
export const CheckpointRevertStatus = Schema.Literals([
  "requested", "rolling-back", "restoring-files",              // pending
  "completed", "files-not-restored", "failed", "interrupted",  // terminal
]);
export const CheckpointRevertFailureReason = Schema.Literals([
  "thread-busy", "target-unavailable", "handoff-boundary", "not-git", "shared-checkout",
  "provider-unsupported", "provider-failed", "files-failed", "restart",
]);
export const CheckpointRevertActivityPayload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  revertRequestId: CommandId,               // NOT "requestId": that key is special-cased by
                                            // decider.ts:1960 and ProjectionPipeline.ts:213/1513
  turnCount: NonNegativeInt,                // target K
  fromTurnCount: Schema.optional(NonNegativeInt),
  status: CheckpointRevertStatus,
  reason: Schema.optional(CheckpointRevertFailureReason),
  detail: Schema.optional(TrimmedNonEmptyString),
  cwd: Schema.optional(TrimmedNonEmptyString), // set from "rolling-back" on; used by recovery
});
```

Add to `ThreadRevertCompleteCommand` and `ThreadRevertedPayload`:
- `droppedTurnIds: Schema.optional(Schema.Array(TurnId))`
- `latestTurn: Schema.optional(Schema.NullOr(OrchestrationLatestTurn))`

Both are optional, so legacy events decode unchanged.

#### A2. `apps/server/src/orchestration/threadSettlementInput.ts`

Add `threadShellSettlementInput(shell: OrchestrationThreadShell, nowIso: string): ThreadSettlementInput`. It maps:

- `session.status`, `latestTurn.*`, `latestUserMessageAt`, `hasPendingApprovals`, `hasPendingUserInput`, `archivedAt`, `settled*`, `createdAt`, `updatedAt`
- `deletedAt: null`, `worktreeArchivedAt: null`, `prState: null`, `hasLocalQueuedMessage: false`, `deliveryUnknown: false`, `autoSettleAfterDays: null`

The existing `threadSettlementInput` is unchanged.

#### A3. `apps/server/src/orchestration/checkpointRevertPolicy.ts` (new, pure)

- `checkpointRevertActivityId(revertRequestId) => EventId.make(\`checkpoint-revert:${id}\`)`.
- `CHECKPOINT_REVERT_PENDING_STALE_MS = 10 * 60_000`.
- `makeCheckpointRevertActivity({ revertRequestId, turnCount, fromTurnCount?, status, reason?, detail?, cwd?, createdAt })`:
  - Returns an `OrchestrationThreadActivity` with `turnId: null`, so it survives the revert's activity filter.
  - Tone is `info` for pending and `completed`, `error` otherwise.
  - Summaries:
    - pending: "Reverting to checkpoint K"
    - `completed`: "Reverted to checkpoint K"
    - `files-not-restored`: "Reverted conversation; files were not restored"
    - `failed`: "Revert failed"
    - `interrupted`: "Revert interrupted"
- `latestCheckpointRevert(activities)`: picks the newest `checkpoint.revert` activity, ordered by `(sequence, createdAt, id)` like `compareThreadActivities`, and decodes it with `Schema.decodeUnknownOption(CheckpointRevertActivityPayload)`.
- `isCheckpointRevertPending(activities, nowMs)`: true if the status is pending **and** `nowMs - createdAt < STALE_MS`. The stale window is a fail-open backstop for a lost terminal update.
- `threadBusyReason(input: ThreadSettlementInput)`, the single shared definition. It returns, in order:
  - `"session-starting"` if `sessionStatus === "starting"`;
  - `"session-running"` if `sessionStatus === "running" || latestTurnState === "running"`;
  - `"pending-approval"`, then `"pending-user-input"`;
  - `"queued-turn"` if `hasQueuedTurnStart(input)` (from `@ryco/shared/threadSettlement`, imported, not edited);
  - otherwise `null`.
- `requireThreadReadyForCheckpointRevert({ readModel, thread, command })` fails with `OrchestrationCommandInvariantError` and user-facing text:
  - busy (`session-*`): "This thread is still working. Wait for the turn to finish, or stop it, before reverting."
  - `pending-approval`: "This thread is waiting for your approval. Answer it before reverting."
  - `pending-user-input`: "This thread is waiting for your answer. Answer it before reverting."
  - `queued-turn`: "A message you just sent is still starting. Wait for it to finish before reverting."
  - `hasActionableContextHandoff(thread)` (exported from `commandInvariants.ts`, no behaviour change): "This thread is switching models. Wait for the switch to finish before reverting."
  - pending revert: "A revert is already in progress for this thread."

  Inputs: `threadSettlementInput(readModel, thread, command.createdAt)` and `Date.parse(command.createdAt)`.
- `requireNoPendingCheckpointRevert({ thread, command })`: "A checkpoint revert is in progress for this thread. Send your message when it finishes."

This lives in its own module, not in `commandInvariants.ts`, to avoid an import cycle with `threadSettlementInput.ts`.

#### A4. `apps/server/src/orchestration/decider.ts`

- **`thread.checkpoint.revert`** (`:1414`): `requireThread`, then `requireThreadReadyForCheckpointRevert`. Return `[activityAppended(status "requested", fromTurnCount omitted), checkpointRevertRequested]`. The activity event comes first, and both share `withEventBase` with the command id.
- **`thread.turn.start`** (`:977`, right after `requireThread`): `yield* requireNoPendingCheckpointRevert(...)`. This is a single line; `claude-steering`, `usage-limits` and `delegation-returns` edit nearby.
- **`thread.revert.complete`** (`:1933`): pass `droppedTurnIds` and `latestTurn` through to the `thread.reverted` payload when present.

#### A5. `apps/server/src/orchestration/projector.ts` (`thread.reverted`, `:890-935`)

- Export `latestTurnFromCheckpoint(checkpoint)`, built from the existing `checkpointStatusToLatestTurnState` logic. It is reused by the reactor.
- When the payload has `latestTurn !== undefined`, use the **authoritative** form:
  - `latestTurn = payload.latestTurn`
  - `retained = checkpoints≤K.turnId ∪ {payload.latestTurn?.turnId}`
  - `dropped = new Set(payload.droppedTurnIds ?? [])`
  - `boundaryAt = payload.latestTurn?.completedAt ?? null` (null means nothing that is bound to a turn survives)
  - An item with `turnId ≠ null` is kept iff `retained.has(turnId) || (!dropped.has(turnId) && boundaryAt !== null && item.createdAt <= boundaryAt)`. This applies to messages, activities and proposed plans. It keeps hydrated plans and activities from older retained turns, which the in-memory model has no checkpoints for.
  - For messages with `turnId === null`, extend `retainThreadMessagesAfterRevert` with an optional `boundaryAt`. Fallback user and assistant candidates must also satisfy `createdAt <= boundaryAt`. This prunes a reverted latest user anchor on the hydrated model. Existing count semantics are unchanged otherwise.
- Without the new fields (legacy events, replays), keep today's exact behaviour.
- Do not touch `thread.message-sent` (owned by `delegation-guard-restart` and `acp-message-ids`).

#### A6. `apps/server/src/checkpointing/restoreSafety.ts` (new, pure; inject I/O)

```ts
export interface CheckoutPathOps {
  readonly canonicalize: (p: string) => string;   // canonicalizeFilesystemPath (git/worktreeReconciliation.ts:255)
  readonly caseSensitive: boolean;                // isCaseSensitiveFileSystem() (:264)
  readonly hasGitEntry: (dir: string) => boolean; // isGitRepository (git/Utils.ts:4)
}
export function sharesWorkingTree(checkoutRoot: string, candidate: string, ops: CheckoutPathOps): boolean;
export type RestoreSource = "ref" | "head-fallback";
export interface RestoreNeighbour {
  readonly threadId: ThreadId; readonly title: string;
  readonly paths: ReadonlyArray<string>;
  readonly busy: boolean;                      // threadBusyReason(...) !== null || backgroundLiveness === "working"
  readonly lastActivityAt: string | null;      // getThreadLastActivityTimestamp(threadShellSettlementInput(...))
}
export type CheckpointRestoreSafety =
  | { readonly kind: "safe" }
  | { readonly kind: "conflict"; readonly reason: "neighbour-busy" | "neighbour-newer" | "head-fallback-shared";
      readonly threads: ReadonlyArray<{ threadId: ThreadId; title: string }> };
export function evaluateCheckpointRestoreSafety(input: {
  readonly checkoutRoot: string; readonly source: RestoreSource; readonly targetInstantMs: number;
  readonly neighbours: ReadonlyArray<RestoreNeighbour>; readonly ops: CheckoutPathOps;
}): CheckpointRestoreSafety;
export function checkpointRestoreConflictMessage(result, turnCount: number): string;
```

**`sharesWorkingTree(root, p)`** uses `R = canon(root)`, `P = canon(p)`, both case-folded when not case-sensitive, and returns:
- `true` if `P === R`;
- `true` if `P` is an ancestor of `R` (the neighbour works above the checkout, which is conservative);
- if `P` is inside `R`: `true` unless some directory on the path from `P` up to (but excluding) `R` has a `.git` entry. That entry marks a nested worktree or repository, for example `<root>/.ryco/worktrees/x` or a submodule. `git restore -- .` and `git clean -fd` (single `-f`) leave nested repositories alone;
- otherwise `false`.

The checkpoint cwd is always a working-tree root, because `resolveCheckpointCwd` requires `isGitRepository(cwd)`.

**`evaluateCheckpointRestoreSafety`** considers only overlapping neighbours, meaning any of their `paths` shares the working tree. It returns, in order:
- `head-fallback-shared` if `source === "head-fallback"` and any neighbour overlaps (this closes the HEAD-reset hole);
- `neighbour-busy` if any overlapping neighbour is busy;
- `neighbour-newer` if any `Date.parse(lastActivityAt) > targetInstantMs`;
- otherwise `safe`.

**Messages.** All are prefixed "Nothing was changed.":
- busy: `"<title>" is working in this checkout. Wait for it to finish, or give this thread its own worktree.`
- newer: `"<title>" changed this checkout after checkpoint K, so restoring files would discard its work.`
- head-fallback: `Checkpoint 0 is missing, so restoring it would reset this checkout to the last commit and discard other threads' uncommitted work.`

At most 3 titles, then "and N more".

#### A7. `CheckpointStore` (service + layer)

Expose the existing private `hasHeadCommit(cwd)` (`Layers/CheckpointStore.ts:61-69`) as `hasHeadCommit: (cwd) => Effect<boolean, CheckpointStoreError>`. Nothing else changes.

#### A8. Provider interfaces

- `Services/ProviderAdapter.ts`:
  - `ProviderAdapterCapabilities.conversationRollback?: "native" | "unsupported"` (missing means unsupported, mirroring `turnSteering`);
  - `export interface ProviderRollbackInput { readonly numTurns: number; readonly targetTurnId: TurnId | null; readonly droppedTurnIds: ReadonlyArray<TurnId> }`;
  - `rollbackThread: (threadId, input: ProviderRollbackInput) => Effect<ProviderThreadSnapshot, TError>`.
- `Errors.ts`: `ProviderOperationUnsupportedError({ provider, operation, detail })` with `message = detail`. Add it to the `ProviderServiceError` union. Do not reuse `ProviderUnsupportedError`, whose message reads "not implemented".
- `Services/ProviderService.ts`: `rollbackConversation(input: { threadId; numTurns; targetTurnId: TurnId | null; droppedTurnIds: ReadonlyArray<TurnId> })`.
- `Layers/ProviderService.ts` (`:144`, `:1606-1645`). Update the schema `ProviderRollbackConversationInput` to the new fields; if `numTurns === 0`, return. Then:
  1. Read the binding (`directory.getBinding`). If none, raise the existing validation error. `adapter = registry.getByInstance(instanceId)`.
  2. **Before any recovery:** if `adapter.capabilities.conversationRollback !== "native"`, fail `ProviderOperationUnsupportedError` with detail `"<displayName ?? provider> can't remove turns from its conversation, so this thread can't be reverted. Start a new thread to try a different approach."`. `displayName` comes from `registry.getInstanceInfo`.
  3. Run `withSessionStartLock(threadId, …)` around:
     - `resolveRoutableSessionUnlocked({ allowRecovery: true })`. Call the unlocked variant; the semaphore is not reentrant.
     - `adapter.rollbackThread(routed.threadId, { numTurns, targetTurnId, droppedTurnIds })`.
     - **persist the binding:** find the adapter session for the thread via `adapter.listSessions()` and call `upsertSessionBinding(session, threadId, { lastRuntimeEvent: "provider.rollback", lastRuntimeEventAt })`. This persists Claude's `rewind` cursor and OpenCode's fork id.

     Holding the lock serializes the rollback with orchestration `sendTurn` (`:1197`), with stale-binding stops (`:657`) and with recovery.
  4. **No** ProviderService-level `activeTurnId` check. A Codex `activeTurnId` can go stale (`CodexSessionRuntime.ts:2258-2266`); turn-precise refusals belong to the adapters.
- Adapters, signature only in A:
  - Claude, Codex: `conversationRollback: "native"`, use `input.numTurns` as today.
  - OpenCode, Cursor, Copilot, Acp: no capability (unsupported). OpenCode becomes native in D.
  - `TestProviderAdapter.integration.ts`: native, and record the whole input.

#### A9. `apps/server/src/orchestration/Layers/CheckpointReactor.ts`

- `providerRollbackEpochViolation` (`:129-131`): change `<` to `<=`. New message: `Reverting to checkpoint K would discard the turn that carried the context handoff (checkpoint F). Revert to checkpoint F or later. Nothing was changed.`
- Replace `appendRevertFailureActivity` with `updateRevert(...)`, which dispatches `thread.activity.append` with `makeCheckpointRevertActivity(...)` and the same activity id. Its failures are logged.
- Rewrite `handleRevertRequested(event)`. Let `K = event.payload.turnCount`, `revertRequestId = event.commandId` and `now = new Date().toISOString()`. Validation steps use `fail(reason, detail)`, which sets `failed`, ends with "Nothing was changed." and returns.
  1. `thread = getThreadDetailById`; `shell = getThreadShellById`; `projects`. If missing, fail `target-unavailable`.
  2. **Own-thread re-check (TOCTOU):** `threadBusyReason(threadShellSettlementInput(shell, now))` or `shell.backgroundLiveness === "working"` fails `thread-busy`.
  3. `current = max(checkpointTurnCount)` over the SQL detail's checkpoints. If `K > current`, fail `target-unavailable`.
  4. Epoch guard: fail `handoff-boundary`.
  5. `cwd = resolveCheckpointCwd({ preferSessionRuntime: true })`. This is the live session cwd, else the thread or project workspace, and it removes the "no active session" failure. Undefined means not git: fail `not-git`.
  6. **Restore plan:**
     - `targetRef = K === 0 ? refFor(0) : checkpoint(K).checkpointRef`;
     - `source = (await hasCheckpointRef) ? "ref" : (K === 0 && (await hasHeadCommit)) ? "head-fallback" : none`;
     - none fails `target-unavailable`.
  7. **Safety:**
     - `neighbours = buildRestoreNeighbours(threadId)`: `getShellSnapshot()`, every thread other than this one; its `paths` are `resolveThreadWorkspaceCwd({ thread, projects: shell.projects })` plus that thread's non-`closed` session cwd from `providerService.listSessions()`. Dedupe paths and canonicalize once per call.
     - `targetInstantMs = K === 0 ? Date.parse(thread.createdAt) : Date.parse(checkpoint(K).completedAt)`. Both are conservative, because the real capture happened at or after them.
     - A conflict fails `shared-checkout` with `checkpointRestoreConflictMessage`.
  8. `dropped` = SQL checkpoints with count > K, ascending. `targetTurnId = K === 0 ? null : checkpoint(K).turnId`. `latestTurn = K === 0 ? null : latestTurnFromCheckpoint(checkpoint(K))`. If `dropped.length > 0`:
     - `updateRevert(status "rolling-back", fromTurnCount: current, cwd)`;
     - `providerService.rollbackConversation({ threadId, numTurns: current - K, targetTurnId, droppedTurnIds })`:
       - `ProviderOperationUnsupportedError` fails `provider-unsupported` with `error.message`;
       - any other error fails `provider-failed`: "Ryco could not rewind the agent's conversation, so nothing was changed. <message>";
     - `updateRevert(status "restoring-files", …)`.
  9. `finishRevert(...)` is shared with recovery:
     - Re-run step 7. A conflict sets `filesRestored = false`, `reason = shared-checkout`.
     - Otherwise run `restoreCheckpoint({ cwd, checkpointRef: targetRef, fallbackToHead: source === "head-fallback" })` with `Effect.result`. A failure or a `false` result sets `filesRestored = false`, `reason = files-failed`.
     - If files were restored, `workspaceEntries.invalidate(cwd)`.
     - Delete stale refs (counts > K) as today; this is best-effort and logs on failure.
     - Dispatch `thread.revert.complete { threadId, turnCount: K, droppedTurnIds, latestTurn }`. On dispatch failure, log an error and **leave the activity in `restoring-files`** so startup recovery finishes it; the pending state goes stale after 10 minutes.
     - `updateRevert` to `completed`, or to `files-not-restored` with this detail: "The agent forgot the discarded turns, but files were not restored: <reason text>. The checkout still contains changes from those turns. Review them in Changes or with git before continuing."
  10. `processDomainEvent` wraps `handleRevertRequested` in `Effect.catchCause`. An interrupt-only cause is re-raised. Any other cause sets `failed`, `provider-failed`, with `Cause.pretty`-derived detail. This replaces the `Effect.catch` at `:809-821`; this is the line overlap with `reactor-errors-switch`.
- **`recover()`** (new; part of `CheckpointReactorShape`):
  - Read `projectionSnapshotQuery.listPendingCheckpointReverts?.()`. If the method is absent, return `Effect.void`.
  - For each pending entry:
    - `requested` → `failed` (`restart`): "Ryco restarted before this revert started. Nothing was changed."
    - `rolling-back` → `interrupted` (`restart`): "Ryco stopped while rewinding the agent's conversation. The agent may already have forgotten the newer turns, but files and history were not changed. Revert to checkpoint K again to finish."
    - `restoring-files`: reload the SQL detail and run `finishRevert` with the persisted `cwd`. Recompute `dropped`, `latestTurn` and the restore source from SQL; the checkpoints > K are still present because `thread.reverted` was not dispatched.
  - Errors per thread are logged; recovery never fails startup.
- The worker stays serial in this package (`reactor-concurrency`, W3).

#### A10. Wiring

- `Services/CheckpointReactor.ts`: add `readonly recover: () => Effect.Effect<void>`.
- `Layers/OrchestrationReactor.ts`: run `yield* checkpointReactor.recover()` right after `contextHandoffCoordinator.recover()`, before the reactors start.
- `ProjectionSnapshotQuery` (service + layer): add an optional `listPendingCheckpointReverts?: () => Effect<ReadonlyArray<{ threadId: ThreadId; activity: OrchestrationThreadActivity; payload: CheckpointRevertActivityPayload }>, ProjectionRepositoryError>`.
  - SQL: `SELECT … FROM projection_thread_activities WHERE kind = 'checkpoint.revert'`.
  - In TS: keep the newest per thread by `(sequence, created_at, activity_id)`, decode it, and keep pending statuses only.
  - It runs once at startup. The method is optional so the roughly 9 hand-written fakes need no edits.
- **Do not** add `checkpoint.revert` to `listActionableThreadActivityRows`. Startup recovery terminalizes pending reverts before the reactors start. `getCommandReadModel` is left untouched; it is heavily edited by W1.

### Commit B: Claude resume-at-target (`ClaudeAdapter.ts`)

**Pre-step V1** (manual, about 15 minutes; record the outcome in the PR). Use the pinned SDK and a logged-in CLI, in a scratch script outside the repo:
- (a) Start a query with session id S. Send "remember APPLE", then "remember BANANA", and await both results.
- (b) Call `close()`. Read `getSessionMessages(S, { dir, includeSystemMessages: true })` and locate the BANANA prompt uuid P and its predecessor H.
- (c) `query({ resume: S, resumeSessionAt: H })`, await `initializationResult()`, then ask which words it remembers. Expect only APPLE.
- (d) Repeat (c) with a bogus `resumeSessionAt`.
- (e) Repeat (c) with `resumeDropsTurn` set to a wrong uuid.

For (d) and (e), record whether the failure surfaces as a rejected control request, a stream error or an error `result` **before** the first prompt, or only on the first prompt.

1. **Context fields:**
   - `startInput: ProviderSessionStartInput` (without `resumeCursor`), stored at start;
   - `turnHeads: Array<{ turnId: TurnId; head: string }>` (in memory, FIFO-capped at 64);
   - `pendingRewind: { at: string } | undefined`;
   - `probing: boolean`;
   - `probeFailure: Deferred<string> | undefined`.

   Add `lastChainUuid?: string` to `ClaudeTurnState`. Add `initializationResult?: () => Promise<unknown>` to `ClaudeQueryRuntime`, and inject `readSessionMessages?` through `ClaudeAdapterLiveOptions`. The default `readSessionMessages` is the SDK's `getSessionMessages`.
2. **Chain tracking** in `handleSdkMessage` (`:3956`), before dispatch:
   - For `user`, `assistant`, or `system` with subtype `compact_boundary`;
   - with a string `uuid`;
   - and with `parent_tool_use_id` null or absent (main chain only, so subagent sidechains are excluded):
   - set `context.turnState.lastChainUuid = uuid` when a turn is active.

   In `completeTurn` (`:2215`), push `{ turnId, head: lastChainUuid }` when known. If `status === "completed"`, also clear `context.pendingRewind`. `updateResumeCursor` writes `rewind: { at }` only while `pendingRewind` is set. The existing informational `resumeSessionAt` field stays, so the test at `:3628` keeps passing.
3. **Resume state:**
   - `readClaudeResumeState` parses `rewind.at` when it is a string.
   - Only when both `resume` and `rewind` are present does `startSession` pass `resumeSessionAt: rewind.at` in `queryOptions`, and initialise `context.pendingRewind`.
   - Plain cursors behave exactly as today.
4. **Split `startSession`** into a guard plus `openSessionContext(input, { probe?: boolean; resumeDropsTurn?: string })`. `resumeDropsTurn` is used only for the immediate rewind reopen and is **not** persisted (§6).
   - With `probe`: set `context.probing = true` before forking the stream fiber. After the fork, run `Effect.raceFirst(controlRequest, Deferred.await(probeFailure).pipe(Effect.flatMap(fail)))` with a 30 s timeout. `controlRequest` is `initializationResult?.() ?? mcpServerStatus?.() ?? Promise.resolve()`.
   - While probing:
     - the stream-exit handler records the failure into `probeFailure` instead of calling `handleStreamExit`;
     - `handleResultMessage` (`:3130`) records error results (including the `Resume rejected by --resume-drops-turn:` prefix) when no turn is active.

     No `runtime.error` or `session.exited` is emitted.
   - On success, `probing = false`.
   - `startSession` rejects with a validation error while `rewindingThreads.has(threadId)`: "Claude is rewinding this thread; try again in a moment."
5. **`stopSessionInternal`** (`:4034`) gains an option `awaitQueryExitMs`. When it is set: close the query first, await the stream fiber for up to that many ms (the iterator ends when the CLI's output closes), and interrupt only if still running. The default path is unchanged.
6. **`rollbackThread(threadId, { numTurns, targetTurnId, droppedTurnIds })`:**
   1. `requireSession`. Refuse with `ProviderAdapterRequestError` (method `thread/rollback`, user-facing detail) if:
      - `turnState` is set: "A Claude turn is still running.";
      - `liveTaskIds.size > 0`: "Claude still has background tasks running. Stop them, then revert again.";
      - pending approvals or user inputs exist.
   2. **Plan:**
      - `targetTurnId === null` → fresh, with a cursor `{ threadId }` and no `resume`.
      - Otherwise, transcript first: read the chain for `resumeSessionId` with `dir` = session cwd (retry without `dir` when empty), with a 10 s bound; errors count as empty. Then `i = index of uuid === droppedTurnIds[0]` with a null parent:
        - `i > 0` → `{ at: chain[i - 1].uuid, dropsTurn: droppedTurnIds.length === 1 ? droppedTurnIds[0] : undefined }`;
        - `i === 0` → fresh.
      - Else the recorded head: `turnHeads.find(turnId === targetTurnId)` → `{ at: head }` (unvalidated).
      - Else refuse: "Claude has no recorded transcript position for checkpoint K. Revert to an earlier checkpoint or start a new thread."
   3. `rewindingThreads.add(threadId)`; `previousCursor = context.session.resumeCursor`.
   4. Run `stopSessionInternal(context, { emitExitEvent: false, awaitQueryExitMs: 5_000 })`. Agent Control is revoked with `runtime-teardown` and re-issued on reopen; exact-turn binding is unchanged.
   5. Build `nextCursor = { threadId, resume, rewind: { at }, turnCount: max(0, prev - numTurns) }`, or the fresh cursor. Then call `openSessionContext({ ...startInput, modelSelection: context.cacheModelSelection ?? startInput.modelSelection, runtimeSessionId: same, resumeCursor: nextCursor }, { probe: true, resumeDropsTurn: V1-confirmed ? dropsTurn : undefined })`.
   6. On probe failure:
      - stop that context silently;
      - `openSessionContext({ …, resumeCursor: previousCursor }, { probe: true })`. If that also fails, emit `session.exited` (reason "Claude could not restart after a failed rewind") so orchestration shows the session ended; recovery uses the untouched binding;
      - fail with "Claude refused to rewind this conversation, so nothing was changed. <probe detail>".
   7. `finally rewindingThreads.delete(threadId)`. Return `snapshotThread(newContext)`.
7. Declare `capabilities.conversationRollback: "native"` (already set in A).

### Commit C: Codex `thread/revert`

- `CodexSessionRuntime.ts`: export `revertCodexThread(client, { threadId, beforeTurnId?, numTurns })`, testable like `openCodexThread`.
  - If `beforeTurnId` is set: `client.raw.request("thread/revert", { threadId, beforeTurnId })`, decoded leniently with `Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) })`. This follows the raw-request precedent at `:2127` and `CodexResetCredits.ts:84`.
  - On `CodexAppServerRequestError`, or when there is no `beforeTurnId`, try `client.request("thread/rollback", { threadId, numTurns })`.
  - Unknown method means `code === -32601`, or `code === -32600 && /unknown variant/i.test(errorMessage)`.
  - If the legacy call is an unknown method, fail with the **original** `thread/revert` error. That covers a legacy-history thread on a new binary.
  - If there was no revert error, fail "This Codex version can't rewind threads."
  - Return `{ threadId, turns: [] }`; no consumer reads the snapshot.
  - The runtime's `rollbackThread(input: { numTurns; beforeTurnId? })` calls it, then keeps `updateSession({ status: "ready", activeTurnId: undefined })`.
- `CodexAdapter.ts:2524`: call `runtime.rollbackThread({ numTurns: input.numTurns, beforeTurnId: input.droppedTurnIds[0] })`. Error mapping is unchanged.
- **Do not** regenerate the vendored schema in this package. The pinned `UPSTREAM_REF` refresh is a separate, wider change; the raw request with a local decoder is sufficient and was verified against 0.160.0. The unknown `thread/reverted` notification reaches the optional unknown-notification handler and fails nothing (`client.ts:175`).

### Commit D: OpenCode fix, honest adapters, client pre-confirm

- **`OpenCodeAdapter.ts`:**
  - Make `openCodeSessionId` mutable. The event filter reads it dynamically (`:1432`).
  - Rewrite `rollbackThread`:
    1. Refuse while `activeTurnId || pendingPrompt`.
    2. `messages = session.messages(root)`; `users = role === "user"`. If `numTurns > users.length`, refuse ("OpenCode's conversation is shorter than this thread's history; it may already be reverted").
    3. `boundary = users[users.length - numTurns]` (for `numTurns === users.length` this is the first user message, the revert to 0). `boundaryIndex = messages.indexOf(boundary)`.
    4. Set `context.rewinding = true`. While it is set, the handler ignores `session.created` so the fork isn't adopted as a subagent child.
    5. `fork = session.fork({ sessionID, messageID: boundary.id })`, then `retained = session.messages(fork.id)`. If `retained.length !== boundaryIndex`, fail "OpenCode did not preserve the requested rewind boundary"; t3 does the same.
    6. `session.update({ sessionID: fork.id, permission: buildOpenCodePermissionRules(context.session.runtimeMode) })`. This is security-relevant: never inherit looser rules.
    7. Rebind `openCodeSessionId`, clear `childSessionIds`, trim `turns`, set `session.resumeCursor = { schemaVersion, sessionId: fork.id }`.
    8. Return `readThread`.

    `session.fork` does not touch files, unlike 1.x `session.revert`. The old session is kept for audit. Declare `conversationRollback: "native"`.
- `CursorAdapter.ts:1230`, `CopilotAdapter.session.ts:674`, `AcpAdapter.ts:1024`: fail with `ProviderAdapterRequestError` "… does not support conversation rollback". Remove Cursor's misleading splice and Copilot's fake success. These paths are unreachable through ProviderService, but must stay honest.
- **`packages/contracts/src/server.ts`:** `ServerProvider.supportsConversationRollback: Schema.optional(Schema.Boolean)`.
- **`ProviderRegistry.ts`:** add `conversationRollback` to `buildSnapshotSource(instance)` from `instance.adapter.capabilities.conversationRollback`. `correlateSnapshotWithSource` stamps `supportsConversationRollback: source.conversationRollback === "native"`. That makes the adapter capability the single source of truth, with no per-provider presentation edits. Unavailable shadow snapshots stay unstamped (unknown).
- **`client-runtime/state/composer/providerModels.ts`** (export from the composer index): `checkpointRevertUnsupportedMessage(provider: ServerProvider | undefined): string | null` returns:
  - `null` unless `provider?.supportsConversationRollback === false`. A missing field means an older server, so allow it and let the server decide.
  - otherwise `"<displayName ?? driver> can't remove turns from its conversation, so this thread can't be reverted. Start a new thread to try a different approach."`
- **Web:**
  - `chatSessionActions.ts`: `revertThreadCheckpointWithGuards` takes `providerRefusal: string | null` and returns `{ type: "provider-unsupported", message }` before confirming.
  - `useChatSessionActions.ts`: the message mapper returns `failure.message`, and the confirm text becomes: `Revert this thread to checkpoint N?` / `The agent forgets the newer turns, and the files in this checkout go back to how they were at that checkpoint. Changes made since then, including your own edits, are discarded.` / `This action cannot be undone.`
  - `ChatView.tsx` `onRevertToTurnCount` (`:3042`): resolve the provider the way `:3159-3162` does (`session.providerInstanceId`, else `modelSelection.instanceId`, in `composerProviderStatuses`) and pass the message.

  This is shared code; nothing phone-tier specific is extended.
- **Mobile** `sessionActions.ts:196`: same guard input and failure for parity. The function is currently not wired to a screen; it is only tested.

## 4. Contract and migration changes

- **No migrations.**
- **Contracts.** All additions are optional or new schemas (§A1, §D). Old clients ignore `supportsConversationRollback` and the new payload keys. Old events replay with the legacy projector path.
- **Persisted provider state:**
  - Claude cursor `rewind: { at }` (optional).
  - A downgraded server ignores it and resumes the full chain, resurrecting dropped turns until the next revert. This downgrade risk is accepted.
  - The OpenCode cursor `sessionId` switches to the fork.
- **Activity semantics.** `checkpoint.revert` replaces `checkpoint.revert.failed`. Clients render it generically; error-tone entries show in the work log.

## 5. Tests (failing-first where a bug)

Run focused files only, e.g. `bun run --cwd apps/server test src/orchestration/decider.checkpointRevert.test.ts`. Use `it.effect` with fakes; use `TestClock.adjust` for the probe timeout and the stale window; use `it.live` only where real git or timers are needed. `CheckpointReactor.test.ts` already uses real git repos.

**A**
1. `decider.checkpointRevert.test.ts` (new, modelled on `decider.contextHandoff.test.ts`):
   - **FAIL-FIRST:** rejects a revert while the session is `running` or `starting`; while `latestTurn.state === "running"`; with an open `approval.requested`; with an open `user-input.requested`; with an actionable handoff.
   - **FAIL-FIRST:** rejects when a user message was sent 30 s ago and `latestTurn.requestedAt` is older (queued turn start).
   - Rejects while another `checkpoint.revert` activity is `requested`. A 10-minute-old pending activity does not block.
   - An idle thread emits `[activity-appended { kind: checkpoint.revert, status: requested, id: checkpoint-revert:<cmd> }, checkpoint-revert-requested]`.
   - `thread.turn.start` is rejected while pending, and accepted once the activity is `completed`.
   - `thread.revert.complete` passes `droppedTurnIds` and `latestTurn` into `thread.reverted`.
2. `checkpointRevertPolicy.test.ts`: `latestCheckpointRevert` ordering; `isCheckpointRevertPending` stale cutoff; a garbage payload is not pending.
3. `projector.test.ts`:
   - **FAIL-FIRST, hydrated shape:**
     - Setup: `checkpoints: []`; messages are the first user anchor (t1) and the latest user anchor (t9), both `turnId: null`; `latestTurn` is turn-9; proposed plans for turn-3 and turn-9; an activity with turnId turn-9.
     - Apply `thread.reverted { turnCount: 5, droppedTurnIds: [6..9], latestTurn: turn-5 @ t5 }`.
     - Expect: `latestTurn.turnId === turn-5` (today: null); only the t1 anchor remains (today: both); the turn-3 plan is kept and the turn-9 plan dropped; the turn-9 activity is dropped.
   - A live thread with full checkpoints gives the same result with and without the new fields.
   - A legacy payload (no fields) is unchanged (regression).
4. `restoreSafety.test.ts` (new, pure, with fake `ops`):
   - same path → overlap; a monorepo subfolder without `.git` → overlap; `<root>/.ryco/worktrees/x` with `.git` → no overlap; a neighbour above the root → overlap; unrelated → no overlap; case-insensitive match when `caseSensitive: false`;
   - busy → `neighbour-busy`; activity after the target → `neighbour-newer`; activity before → safe;
   - `head-fallback` with an idle neighbour that has old activity → `head-fallback-shared`; no neighbours → safe;
   - message caps the list at 3 titles.
5. `checkpointEpochSafety.test.ts`: **FAIL-FIRST** change at `:136-144`. With boundary checkpoint 4, K = 4 is allowed and K = 3 is rejected with "would discard the turn that carried the context handoff".
6. `CheckpointReactor.test.ts`:
   - **FAIL-FIRST, provider-first:** `rollbackConversation` fails. README stays `v3`, ref 2 still exists, the activity is `failed/provider-failed`, and no `thread.reverted` (today README becomes `v2`).
   - **Ordering:** the rollback fake reads README at call time and sees `v3`.
   - Called with `{ numTurns: 1, targetTurnId: turn-1, droppedTurnIds: [turn-2] }`.
   - `ProviderOperationUnsupportedError` → `failed/provider-unsupported`; files unchanged.
   - **FAIL-FIRST, shared checkout:** create `thread-2` with `worktreePath: null` (project root = cwd) and dispatch `thread.session.set` running → refused with `shared-checkout`, provider not called, files unchanged.
   - An idle neighbour whose `latestTurn.completedAt` is after checkpoint K is refused; one before K proceeds.
   - A neighbour in a real nested worktree (`git worktree add <cwd>/.ryco/worktrees/n`) that is running → revert proceeds.
   - **FAIL-FIRST, HEAD fallback:** delete ref 0, K = 0, and an idle project-root neighbour with old activity → refused (`head-fallback-shared`). The same without neighbours restores to `HEAD`.
   - **Files fail after provider success:** the rollback fake marks `thread-2` running in the same checkout.
     - Expect `thread.reverted`, README unchanged, activity `files-not-restored` with the honest detail, and ref 2 deleted.
     - Then take `thread-2` out of the checkout with `thread.delete`, because deleted threads are not neighbours, and dispatch `thread.checkpoint.revert` to K = current. Files are restored and no provider call is made. This is the API-level recovery path.
   - Activity statuses arrive in order: `requested → rolling-back → restoring-files → completed`.
   - No live session: uses the thread workspace cwd and calls `rollbackConversation`. This replaces "appends an error activity when revert is requested without an active session" (`:1137`).
   - **Recovery** (call `reactor.recover()` after seeding activities through `thread.activity.append`): `restoring-files` with `cwd` → files restored, `thread.reverted`, `completed`; `rolling-back` → `interrupted`; `requested` → `failed/restart`.
7. `ProviderService.test.ts`:
   - an unsupported adapter → `ProviderOperationUnsupportedError`, and the adapter's `startSession` and the recovery path are **not** invoked;
   - native: forwards `targetTurnId`/`droppedTurnIds`, and **the binding is upserted with the adapter's new `resumeCursor`** after the rollback;
   - a concurrent `sendTurn(…, expectedRuntime)` resolves only after the rollback releases the lock (deferred-gated fake);
   - update the rollback fakes at `:227`, `:304`, `:825-932` and `:1034-1145` to the new input and `conversationRollback: "native"`.
8. `CheckpointStore.test.ts`: `hasHeadCommit` true on a repo with a commit, false on an empty repo. `OrchestrationReactor.test.ts`: `recover` runs before the reactors start (add `recover` to the fake at `:55`). `ProjectionSnapshotQuery.test.ts`: `listPendingCheckpointReverts` returns the newest pending entry per thread and skips terminal ones.

**B**: add `makeSequencedHarness()`. Each `createQuery` returns a new `FakeClaudeQuery`; inputs are recorded; `initializationResult` resolves unless `failInit`; `readSessionMessages` is a fake.
1. **FAIL-FIRST:**
   - Setup: two completed turns; the transcript fake is `[p1, a1, P2 (= turn-2 id), a2]`.
   - Call `rollbackThread(t, { numTurns: 1, targetTurnId: turn-1, droppedTurnIds: [turn-2] })`.
   - Expect: the first query has `closeCalls === 1`; a second `createQuery` has `options.resume === S` and `options.resumeSessionAt === "a1"`; the same `runtimeSessionId`; the session cursor has `rewind.at === "a1"`.
2. Revert to 0 → the new options have `sessionId` set (a fresh uuid) and no `resume` or `resumeSessionAt`.
3. A synthetic first-dropped turn (the transcript lacks its id) → `resumeSessionAt` is the recorded head of the target turn. The recorded head ignores an assistant snapshot that has `parent_tool_use_id` set.
4. Refuses (no close, no new query) while a turn runs, with a live task, or with a pending approval. Refuses with the "no recorded transcript position" error when there is neither a transcript match nor a head.
5. **Probe failure:**
   - Setup: the second fake query's stream fails immediately, or `failInit`.
   - Expect: no `session.exited` or `runtime.error` events; a third `createQuery` with the previous cursor (no `resumeSessionAt`); the rollback fails with "Claude refused to rewind…"; three queries in total.
   - Variant: the third query also fails → exactly one `session.exited`.
6. The `rewind` marker survives a `turn.completed` with status `interrupted`, and is cleared by one with status `completed`. `startSession` with a cursor carrying `rewind` passes `resumeSessionAt`. The existing plain-cursor test (`:3628`) still asserts `undefined`.
7. `startSession` during a rewind fails with the rewinding error.
8. (Only if V1 confirms boot-time refusal) a single dropped user turn passes `resumeDropsTurn`; an error `result` starting with `Resume rejected by --resume-drops-turn:` during the probe is mapped to the restore path.
9. Replace the old "trimming in-memory turns" test (`:3790`).

**C**: `CodexSessionRuntime.test.ts`:
- **FAIL-FIRST:** `revertCodexThread` sends `thread/revert { threadId, beforeTurnId }` (today: `thread/rollback`);
- an unknown-variant `thread/revert` falls back to `thread/rollback { numTurns }`;
- a `thread/revert` error plus an unknown-variant `thread/rollback` fails with the revert error text;
- no `beforeTurnId` → `thread/rollback`.

`CodexAdapter.test.ts`: the adapter forwards `droppedTurnIds[0]` (update the fake at `:105`/`:150` to the new runtime signature).

**D**:
- `OpenCodeAdapter.test.ts`:
  - **FAIL-FIRST:** messages `[u1, a1a, a1b, u2, a2]`, `numTurns: 1` → `session.fork({ messageID: u2 })`, not `revert`, so the kept turn's `a1b` survives;
  - `numTurns: 2` → fork at `u1`;
  - `numTurns: 3` → refused;
  - a retained-length mismatch → error;
  - `session.update` is called with the runtime-mode permission rules;
  - the cursor's `sessionId` is the fork id;
  - a `session.created` for the fork is not adopted as a child.
- `ProviderRegistry.test.ts`: snapshots are stamped `supportsConversationRollback` true for a native fake and false for an unsupported one.
- `providerModels.test.ts` (client-runtime): `false` → message; `true` or absent → null.
- `chatSessionActions.test.ts` and mobile `sessionActions.test.ts`: a provider refusal returns `provider-unsupported` without calling `confirm` or dispatching.

**Final backstop.** This is a cross-cutting change: `bun fmt`, `bun run fmt:check`, `bun lint`, `bun typecheck`, `bun run test`, `bun run build`. The web interaction change is a guard only, so no browser suite is needed.

## 6. Edge cases

1. **Revert to K = current** (`dropped` empty). This restores files only and makes no provider call. It works for every provider, with safety applied. It is the API-level recovery after `files-not-restored`. The UI has no affordance for it (follow-up).
2. **Steering.** A steer adds a `role: user` message after `requestedAt`, so `hasQueuedTurnStart` blocks a revert for up to 2 minutes after a steer. This fails safe; `claude-steering` may refine `latestUserMessageAt`.
3. **Delegated returns and queued sends during a revert.** `thread.turn.start` is rejected. The web queue holds the message for manual retry (`queue-hold-drain`). `CompletionReturnDelivery` marks the return `blocked`, and the user returns it manually. There is no typed rejection code: no client branches on it, and the prose is user-facing.
4. **Claude `rewind` marker.**
   - It is kept through failed or interrupted post-rewind turns. A restart then truncates those too, which is consistent with "until a turn completes".
   - It is cleared on the first `completed` turn. After that, the newest transcript leaf is the new branch.
   - `resumeDropsTurn` is never persisted. After a new prompt is written, the range past the fork point no longer matches the dropped turn.
5. **Claude model-change restart** (`ProviderCommandReactor.ts:717-744`) uses the live cursor, so it honours `rewind`.
6. **Context handoff then revert.** The `<=` epoch guard keeps the handoff turn. A Claude target inside the new epoch is found in the new session's transcript.
7. **Archived threads** can be reverted, as today. **Deleted threads** are not neighbours (§7).
8. **Hydrated model after a revert.** If SQL's new latest user message was never hydrated (a middle message), the in-memory `findLast(user)` is the first anchor. The delegated-return fence then fails closed until the next user message. This is documented in `04-delegation-guard-restart`; no phantom `queued-turn` remains.
9. **Codex legacy-history threads** on binaries without `thread/rollback` are refused with Codex's own error. Nothing is changed.
10. **OpenCode** assumes one root user message per Ryco turn (count boundary). Native compaction or other OpenCode-internal user messages would shift it; the retained-length check and the `numTurns > users` guard catch only gross mismatches.
11. **Agent Control.**
    - Pending proposals whose origin turn was dropped stay pending and **user-approval only**. Revert never approves, expires or auto-resolves anything; expiring them is a follow-up through the proposal service.
    - The Claude reopen revokes and re-issues the Agent Control lease. Exact-turn binding happens on the next `sendTurn` as today.
    - Agents cannot trigger reverts; revert is not exposed through Agent Control.
12. **Clock skew.** Decider checks use the client's `command.createdAt`, the same skew characteristics as settle and snooze today.

## 7. Risks

1. **Claude CLI behaviour (V1).** If a bad `resumeSessionAt` or `resumeDropsTurn` only fails at the first prompt, the probe cannot catch it. Then the revert reports success and the first turn fails. Mitigations: omit `resumeDropsTurn` unless V1 proves boot-time refusal; heads come from exact transcript or stream uuids.
2. **Crash window.** A crash during `rolling-back` leaves the provider possibly rewound but the projection not. Recovery marks it `interrupted` with guidance.
   - Re-reverting is idempotent for Claude: the dropped prompt is still on the newest leaf.
   - For Codex (`beforeTurnId` gone) and OpenCode (`numTurns > users`) the retry fails **safely**, but the split remains.
   - This is owned by `provider-effect-outbox` (W3).
3. **Deliberate relaxation of t3's "isolated worktree only" rule.** Ryco users commonly run project-root threads, and t3's rule would remove file revert for all of them. Remaining exposure:
   - writes after K by **non-thread writers** (terminals, editors, the user) and by deleted threads are discarded. The confirm text now says so; terminals are deliberately not considered, because dev servers would make revert unusable;
   - neighbour "activity" timestamps approximate edit times; this is conservative for running turns.
4. **Serial reactor.** A Claude reopen takes seconds and blocks other threads' checkpoint captures until `reactor-concurrency` (W3).
5. **Providers that lose revert:** Copilot, Cursor, Grok, ACP registry. This is a visible UX regression that replaces a silent lie. Users are told before confirming (D).
6. **Unvalidated truncation** without `resumeDropsTurn`. A background-task notification absorbed *inside* the dropped range is dropped with it.
7. **Synthetic first-dropped Claude turn after a restart.** No recorded head and no transcript id, so the revert is refused. Persisting heads on `turn.completed` is left to `restart-continuation`.

## 8. Out of scope / follow-ups

- Fresh-session plus context-handoff rollback for non-native providers (needs a handoff mode, §1.3).
- A UI affordance for "restore files to the current checkpoint".
- Client-runtime use of `droppedTurnIds`/`latestTurn` in `packages/client-runtime/src/state/threads/store.ts:2534`.
- Rendering a "Reverting…" phase in the composer.
- Making the queue drain wait on a pending revert.
- Regenerating the vendored Codex schema.
- Expiring Agent Control proposals from dropped turns.
- Persisting Claude turn heads on turn completion.
- Per-thread reactor concurrency.

## 9. Overlaps (explicit)

- **`claude-steering` (W2, same wave).** `ClaudeAdapter.ts`:
  - the `capabilities` literal (adjacent keys `turnSteering`/`conversationRollback`);
  - the head of `sendTurn` (none added here beyond what `startSession` needs);
  - `startSession`, which is split into `openSessionContext`. Rebase so steering edits land inside `openSessionContext`.

  Also `ProviderAdapter.ts` `ProviderAdapterCapabilities` (adjacent field).
- **`usage-limits` (W2).** `ClaudeAdapter.ts` `handleResultMessage` (the probing hook is 3 lines at the top); `decider.ts` `thread.turn.start` (one line); `packages/contracts/src/server.ts` `ServerProvider` (adjacent optional field); possibly `ProviderRegistry.ts`.
- **`delegation-returns` (W2).** `decider.ts` `thread.turn.start`: the pending-revert check sits before the fence at `:1008-1033`. Semantic: returns are blocked during a revert.
- **`delegation-guard-restart` (W1).** Semantic dependency: this package implements its handoff (§A5) on top of the 2-anchor hydration. No overlap in `getCommandReadModel`.
- **`turn-finalization` (W1).** Semantic dependency: revert admission and the TOCTOU re-check rely on `latestTurn` leaving `running` for turns without checkpoints.
- **`reactor-errors-switch` (W1).** Line overlap in `CheckpointReactor.processDomainEvent` (`:808-821`) and the removed `appendRevertFailureActivity`. Rebase onto its error-handling helpers if it introduces any.
- **`queue-hold-drain` (W1).** Semantic only (§6.3).
- **`settlement-signals` (W1).** Imports `hasQueuedTurnStart` and `getThreadLastActivityTimestamp` unchanged. A possible adjacent addition in `threadSettlementInput.ts`.
- **`provider-compat` (W1).** `ProviderRegistry.ts` (different functions) and `server.ts` (adjacent fields).
- **`claude-meter-wake` / `acp-message-ids` (W1).** Same files, different functions.
- **`reactor-concurrency` → `provider-effect-outbox` → `restart-continuation` (W3).**
  - The revert handler must stay serialized per thread.
  - The outbox should replace the activity journal's crash window.
  - Continuation must honour Claude `rewind` and the OpenCode fork `sessionId`.

## 10. Review resolution

| # | Sev | Issue | Resolution |
| --- | --- | --- | --- |
| 1 | major | OpenCode labelled native but broken | **Accepted.** I verified it: `OpenCodeAdapter.ts:2774-2783` passes the kept assistant message and sends no boundary for K = 0, and 1.x `revert` touches files. Fixed in D with `session.fork` at the first dropped user message plus a permission re-apply. OpenCode is `unsupported` in commits A–C. |
| 2 | major | HEAD-fallback hole | **Accepted.** The restore source is tagged `ref`/`head-fallback`. A HEAD fallback is refused on any overlap (§A6), with a test. |
| 3 | major | Nested worktrees give false positives | **Accepted.** Overlap counts only within the same working tree; a `.git` entry between the paths breaks it. Implemented with filesystem checks instead of a `git rev-parse` per neighbour, which is cheaper and gives the same boundary. |
| 4 | major | Reverse race (queued turn start) | **Accepted.** `hasQueuedTurnStart` runs in the decider and again in the reactor via `threadBusyReason`. Residual: more than 2 minutes before a turn starts. Overlap with `settlement-signals` is named. |
| 5 | major | Hydrated projector handoff dropped | **Accepted.** `thread.reverted` carries authoritative `latestTurn`/`droppedTurnIds`, and the projector applies a boundary rule (§A5) with a hydrated-shape test. `delegation-guard-restart` is a semantic dependency. |
| 6 | major | Crash window after provider commit | **Accepted.** Durable phases in the lifecycle activity, startup `recover()` (§A9), and the residual is documented and assigned to `provider-effect-outbox`. |
| 7 | minor | `resumeDropsTurn` ignored | **Accepted, gated on V1.** It is passed for single user-turn drops only if the refusal surfaces during the boot probe; never persisted, never retried. |
| 8 | minor | Probe races `handleStreamExit`; old CLI not awaited | **Accepted.** A `probing` flag routes exits and error results into `probeFailure`; `awaitQueryExitMs` closes first and then awaits the stream fiber. Test: 3 queries and no exit events. |
| 9 | minor | ProviderService `activeTurnId` false-blocks Codex | **Accepted.** No ProviderService-level turn check; adapters own it. |
| 10 | minor | Duplication, case folding, integration harness | **Accepted.** Reuses `canonicalizeFilesystemPath`, `isCaseSensitiveFileSystem`, `isGitRepository`, `resolveThreadWorkspaceCwd`, `hasCheckpointRef` and the newly exposed `hasHeadCommit`. No new layer dependencies, so `OrchestrationEngineHarness.integration.ts` is untouched. |
| 11 | minor | Neighbour set misses session cwds and terminals | **Partially accepted.** Live provider-session cwds are included. Terminals are **rejected**: long-running dev servers would make revert unusable; this is covered by the confirm text and Risks §7.3. Deleted threads are documented. |
| 12 | minor | `pendingRevert` uncorrelated; contracts leak | **Accepted.** Pending state is a lifecycle activity keyed by the revert command id; only that id is updated. No `OrchestrationThread` field. |
| 13 | minor | Capability checked after recovery | **Accepted.** Checked from the binding's adapter before `resolveRoutableSession` (§A8), with a test. |
| 14 | minor | `files-failed` keeps useless refs | **Accepted.** Stale refs are deleted as usual. The detail tells the user the truth, and the test asserts the API-level "revert to K again" recovery. A UI affordance is a follow-up. |
| 15 | minor | `turnHeads` not durable | **Partially accepted.** The durable path is now the transcript (`getSessionMessages`); heads are in-memory only, for synthetic turns. The remaining gap is documented and left to `restart-continuation`. |
| 16 | minor | UX for refusing providers; mobile; proposals | **Accepted.** `supportsConversationRollback` is stamped from the adapter capability, with a pre-confirm guard on web and mobile and updated confirm text. Proposals: explicit decision to leave them pending and user-approval only (§6.11). |
| 17 | minor | Overlap bookkeeping, typed reason, split | **Accepted.** Overlaps rewritten (§9); `turn-finalization` is a W1 dependency; typed `reason` codes are in the activity payload; 4 stacked commits. A typed command-rejection code was **rejected**, because no client branches on it. |
| — | verdict | Codex `thread/rollback` rejected on 0.160.0 | **Verified independently.** A live JSON-RPC probe returned `-32600 unknown variant \`thread/rollback\``; `thread/revert` is recognized (only the bogus id failed); the schema was confirmed via `generate-json-schema`. |
