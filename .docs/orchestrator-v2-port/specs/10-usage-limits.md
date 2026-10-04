# 10 · usage-limits: a durable "Limited" thread state, with resume or snooze at reset

| Field | Value |
| --- | --- |
| id | `usage-limits` |
| title | Detect Claude and Codex usage-limit stops with their reset time. Record a durable, projected per-thread `usageLimit`. Show "Limited" in the inbox and a Resume now / Resume at reset / Snooze until reset banner. Hold the client queue while limited. An opt-in server worker resumes or snoozes at reset, idempotently and with a guard. |
| wave | 2 (parallel, isolated worktree). Rebases on all of Wave 1, especially `queue-hold-drain`, `claude-meter-wake`, `turn-finalization` and `delegation-guard-restart` |
| verdict | **feature**. The gap is real and slightly worse than the brief says (§1). `account.rate-limits.updated` has no consumer. There is no `usage_limit` class. Every Codex terminal error is `provider_error`. A Claude limit result with `subtype:"success"` is reported as a **completed** turn with no error at all |
| size | **L** |
| touched files | **Contracts:** `packages/contracts/src/providerRuntime.ts` · `packages/contracts/src/orchestration.ts` · `packages/contracts/src/settings.ts` · `packages/contracts/src/environment.ts`. **Shared:** `packages/shared/src/usageLimit.ts` (new) · `packages/shared/package.json` (export). **Server, provider:** `apps/server/src/provider/usageLimitReset.ts` (new) · `apps/server/src/provider/Layers/claudeUsageLimits.ts` (new) · `apps/server/src/provider/Layers/ClaudeAdapter.ts` · `apps/server/src/provider/Layers/codexUsageLimits.ts` (new) · `apps/server/src/provider/Layers/CodexAdapter.ts` · `apps/server/src/provider/Layers/CopilotAdapter.mapEvent.ts`. **Server, orchestration:** `apps/server/src/orchestration/decider.ts` · `apps/server/src/orchestration/projector.ts` · `apps/server/src/orchestration/Schemas.ts` · `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` (aggregate routing switch only) · `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` · `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` · `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` · `apps/server/src/orchestration/threadContinuation.ts` (new) · `apps/server/src/orchestration/Layers/UsageLimitRecovery.ts` (new) · `apps/server/src/orchestration/Services/UsageLimitRecovery.ts` (new) · `apps/server/src/server.ts` (layer wiring). **Server, persistence:** `apps/server/src/persistence/Migrations/074_ProjectionThreadsUsageLimit.ts` (new) · `apps/server/src/persistence/Migrations.ts` · `apps/server/src/persistence/Services/ProjectionThreads.ts` · `apps/server/src/persistence/Layers/ProjectionThreads.ts`. **Server, other:** `apps/server/src/environment/Layers/ServerEnvironment.ts`. **Client runtime:** `packages/client-runtime/src/state/threads/usageLimit.ts` (new) · `packages/client-runtime/src/state/threads/index.ts` (export) · `packages/client-runtime/src/state/threads/types.ts` · `packages/client-runtime/src/state/threads/store.ts` (shell/summary mapping and equality only) · `packages/client-runtime/src/state/threads/threadInbox.ts` (export one eligibility helper) · `packages/client-runtime/src/state/composer/sendEngine.ts` · `packages/client-runtime/src/state/composer/usageLimitResume.ts` (new) · `packages/client-runtime/src/state/composer/index.ts` (export) · the queue-hold predicate module created by `queue-hold-drain` (one new reason). **Web:** `apps/web/src/components/chat/usageLimitBanner.tsx` (new) · `apps/web/src/components/ChatView.tsx` · `apps/web/src/components/inboxSidebar/inboxSidebarModel.ts` · `apps/web/src/components/inboxSidebar/inboxRowPresentation.ts` · `apps/web/src/components/inboxSidebar/InboxThreadRow.tsx` (glyph only) · `apps/web/src/components/Sidebar.logic.ts` · `apps/web/src/components/settings/UsageLimitSettings.tsx` (new) · `apps/web/src/components/settings/SettingsPanels.tsx` · `apps/web/src/components/settings/settingsRestore.ts`. **Mobile:** `apps/mobile/src/state/use-thread-outbox-drain.ts` · `apps/mobile/src/features/inbox/inboxModel.ts`. **Tests:** see §6 |
| migrations | **074** `ProjectionThreadsUsageLimit`: adds `projection_threads.usage_limit_json TEXT` and a partial index. Idempotent, plus a post-migrator repair `repairProjectionThreadUsageLimitColumn()`. This is required because the pre-assigned 075 (`settlement-signals`, W1) lands first (see §5.3) |
| contract changes | **`providerRuntime.ts`:**<br>• `RuntimeErrorClass` gains `"usage_limit"`.<br>• `RuntimeErrorPayload.resetAt?: IsoDateTime \| null`.<br>• `AccountRateLimitsUpdatedPayload.usageLimitState?: { exhausted, resetAt }`.<br><br>**`orchestration.ts`:**<br>• New schemas: `ThreadUsageLimitId`, `ThreadUsageLimit`, `UsageLimitResumeGuard`.<br>• Optional `usageLimit` on `OrchestrationThread` and `OrchestrationThreadShell`.<br>• Optional `usageLimitResumeGuard` on `ThreadTurnStartCommand` and `ClientThreadTurnStartCommand`.<br>• New **internal-only** command `thread.usage-limit.record`.<br>• New **client** command `thread.usage-limit.configure`.<br>• New events `thread.usage-limit-set` and `thread.usage-limit-cleared`. Neither is a thread-detail event, so neither is forwarded on `subscribeThread`.<br><br>**`settings.ts`:** `ServerSettings.autoResumeLimitedThreads` and `snoozeLimitedThreads` (both default `false`), plus their patch keys.<br><br>**`environment.ts`:** `ExecutionEnvironmentCapabilities.usageLimitRecovery` (`optionalKey`).<br><br>**New subpath:** `@ryco/shared/usageLimit`.<br><br>**Client-runtime API:** `CommitSendTurnDispatchInput` gains optional `commandId` and `usageLimitResumeGuard`.<br><br>**Server-internal:** `ProjectionThreadRepository.listUsageLimitedThreadIds` and a new `UsageLimitRecovery` service |
| overlaps | See §5 for function-level detail.<br><br>**W1 (lands first):**<br>• `queue-hold-drain`: semantic contract plus the hold predicate, the ChatView drain effect and the mobile `readThreadDeliveryState`.<br>• `claude-meter-wake`: the ClaudeAdapter synthetic-turn path. Semantic dependency.<br>• `turn-finalization`: ProviderRuntimeIngestion `processRuntimeEvent`, decider `thread.session.set`.<br>• `acp-message-ids`: ProviderRuntimeIngestion, projector. Same files, different functions.<br>• `delegation-guard-restart`: the ProjectionSnapshotQuery `getCommandReadModel` thread literal.<br>• `settlement-signals`: `threadInbox.ts` `settlementInput`, and migration number 075.<br><br>**W2 (same wave):**<br>• `rollback-correctness`: decider `thread.checkpoint.revert`.<br>• `delegation-returns`: decider `thread.turn.start`, the CompletionReturnDelivery hand-off and ownership of `threadContinuation.ts`.<br>• `delegation-lineage`: thread shell schema and `projection_threads` column lists.<br>• `claude-steering`: ClaudeAdapter state interfaces.<br><br>**W3:**<br>• `restart-continuation`: reuses `buildThreadContinuationTurnStart` and must skip limited threads.<br>• `provider-effect-outbox`: none beyond the engine path.<br>• `reactor-concurrency`: none.<br><br>**No overlap:** `reactor-errors-switch`, `provider-compat` |

---

## 0. Review resolution

The adversarial review raised 1 blocker, 9 majors and 9 minors. I re-verified each one against the code before deciding.

| # | Severity | Issue (short) | Decision | One-line reason |
| --- | --- | --- | --- | --- |
| B1 | blocker | Time-of-check race lets a double resume through: the decider only rejects `running && activeTurnId` | **Accept** | Verified at `decider.ts:997-1006`. The projector only advances `latestTurn` on `session-set running` (`projector.ts:731-753`), so the session stays `error` after an accepted turn.start. Fix: `usageLimitResumeGuard {limitId, origin}`, checked in the decider. Every accepted turn.start clears the limit in the same decision, and the worker and Resume now share one deterministic commandId (§3.6, §3.9). |
| M1 | major | Recording before `session.set` aborts the error branch on a no-op | **Accept** | The record is dispatched **after** `session.set` and the buffer clear. It is wrapped in `catchCause`, which rethrows interrupts. It uses a deterministic commandId (`usage-limit-record:<limitId>`), so engine receipt dedupe absorbs duplicates instead of decider invariants. It is pre-checked against the shell (§3.7). |
| M2 | major | The mobile outbox drain still sends into the limit | **Accept** | Verified at `use-thread-outbox-drain.ts:81-122`, where `threadBusy` ignores limits. One shared predicate, `isUsageLimitQueueHeld`, is consumed by queue-hold-drain's hold predicate, the ChatView drain and the mobile gate. A release timer covers both (§3.12, §3.15). |
| M3 | major | Resume now and the worker bypass the send engine and the Claude cost review | **Accept (split)** | Resume now goes through `commitSendTurnDispatch`, so `reviewClaudeResumeBeforeSend`, `assertMutationReady` and readiness all apply (§3.11). The worker cannot run the client review, so its cost is disclosed explicitly in the setting copy and under Risks. The setting is off by default, and per-thread opt-in is a deliberate user click. |
| M4 | major | The delegated-return edge case is wrong | **Accept** | Verified at `CompletionReturnDelivery.ts:219-230`: a limited parent (session `error`) gets its return **cancelled**. A limited child is marked failed at `:274-283`. Corrected in §4. Hand-off requirements to `delegation-returns` are in §5.2. By default the worker does not auto-resume a child whose return record is already terminal. |
| M5 | major | Auto-resume drifts from the setting (armed at record time) | **Accept** | `null` means "follow the node setting". `true` or `false` is an explicit per-thread override. Ingestion always records `null`. The worker computes `limit.autoResume ?? settings.autoResumeLimitedThreads` on every sweep (§3.13). |
| M6 | major | The Claude reset time is lost when `rate_limit_event` arrives before turnState, and results with no turnState record limits | **Accept** | Rejected windows live on the **session context**, because they are account-scoped and allowed events clear them. Only the warning dedupe is per-turn. A limit is classified only when `context.turnState` exists. The synthetic-turn path belongs to `claude-meter-wake` (W1) (§3.3). |
| M7 | major | An unknown Codex literal drops `turn/completed`, so the turn hangs | **Accept** | Verified: strict `Schema.is` at `CodexAdapter.ts:249-254` and `:1242-1245`, and a closed literal union at `schema.gen.ts:26773-26777`. `turn/completed` gets a structural fallback, and the tracker reads `codexErrorInfo` structurally (§3.4). |
| M8 | major | The overlap with queue-hold-drain's sticky hold is unnamed | **Accept** | §5.1 defines the contract. Any failure or interrupt hold is keyed to the failed turn id and releases when a newer turn starts. The usage-limit reason is derived, never sticky. A cross-package test is included. |
| m1 | minor | Transient 429 becomes a durable Limited state | **Accept** | The durable state requires `terminal_reason:"blocking_limit"` or a rejected `rate_limit_event` window. A bare 429 or `assistant.error:"rate_limit"` is left unchanged. |
| m2 | minor | The hold never releases after the reset when not armed | **Accept (settings-free variant)** | The hold lasts while `resetAt == null \|\| now < resetAt + 2 min`. That is long enough for an armed worker (reset + 30 s) to start first, and needs no settings on mobile. The label switches to "Limit reset". |
| m3 | minor | Worker error handling cannot match the errors it expects | **Accept** | Errors are classified through `OrchestrationDispatchCommandError.cause`. An id is marked attempted only after an accepted dispatch or an invariant/previously-rejected result. Transient failures get a bounded retry. Each sweep is wrapped in `catchCause`, which rethrows interrupts. |
| m4 | minor | Codex `resetAt` is null after any fresh session | **Accept** | Once per limit, the worker runs `ProviderRegistry.refreshInstance`, which reuses the existing usage probes (`account/rateLimits/read` and the Claude OAuth usage API). It computes `resetAt` with the shared helper and fills it through the same record command. |
| m5 | minor | Version skew is not gated | **Accept** | The `usageLimitRecovery` capability gates the settings section and the schedule and snooze actions. The banner gates itself, because only new servers send `usageLimit`. |
| m6 | minor | Snooze eligibility diverges from the inbox | **Accept** | `threadInbox.ts` exports `deriveThreadSnoozeEligibility`, which wraps the private `settlementInput` and `canSnoozeThread` with local-queue state. The banner uses it. |
| m7 | minor | Stale limits after revert, unarchive or provider switch | **Accept** | The decider clears the limit on `thread.checkpoint.revert`, `thread.archive`, any accepted `thread.turn.start`, and `thread.session.set running` for a different turn. A limit only applies while `thread.modelSelection.instanceId === usageLimit.providerInstanceId`. Revert overlaps with `rollback-correctness`, named in §5.2. |
| m8 | minor | UX and load details | **Accept** | Auto resumes append a decider activity, "Resumed automatically after the usage limit reset". The warning copy is "Claude usage limit reached.". The worker resumes at most one thread per provider instance per sweep and enforces a 24 h lateness cap. The setting copy says limits are account-wide. |
| m9 | minor | Missing tests | **Accept** | Every listed case is in §6. |

**Disputed evidence, checked independently.**
- (a) The review says a limited parent's return is cancelled, not delivered. **Confirmed** at `CompletionReturnDelivery.ts:219-230`.
- (b) The review says the unknown-literal handling covered only `error`. **Confirmed**. `turn/completed` returns `[]` when strict decoding fails (`CodexAdapter.ts:1242-1245`), and `agentControl.retireTurn` is then skipped too (`:1997-2002`).
- (c) Effect `Migrator` skips ids at or below the latest applied. **Confirmed** at `node_modules/.bun/effect@4.0.0-beta.107/.../Migrator.ts:248-251`. This has a consequence for this package, covered in §5.3.

---

## 1. Problem (verified against the code)

1. **There is no error class or reset field in the runtime contract.**
   - `RuntimeErrorClass` (`packages/contracts/src/providerRuntime.ts:101-107`) has no `usage_limit`.
   - `RuntimeErrorPayload` (`:839-843`) has only `message`, `class` and `detail`.
   - `AccountRateLimitsUpdatedPayload` (`:769-771`) is `{ rateLimits: Unknown }`.
2. **Claude.**
   - `turnStatusFromResult` (`ClaudeAdapter.ts:1268-1271`) returns `"completed"` for any `subtype:"success"`. `handleResultMessage` (`:3161-3168`) only emits a runtime error when the status is `failed`.
   - So a limit stop delivered as `subtype:"success", is_error:true, terminal_reason:"blocking_limit"` becomes a normal completed turn with no error.
   - `emitRuntimeError` hardcodes `class:"provider_error"` (`:2077`).
   - `rate_limit_event` is forwarded as `account.rate-limits.updated` (`:3944-3951`) and nothing consumes it. The SDK (0.3.263) types `SDKRateLimitInfo { status, resetsAt (epoch s), rateLimitType, overageStatus, … }` and `terminal_reason: 'blocking_limit' | …` (`sdk.d.ts:4937-4950`, `:8559`).
   - The telemetry `base` only carries a `turnId` if `context.turnState` exists (`:3888`).
   - Synthetic wake turns are created lazily on the first assistant frame (`:3049-3072`), so a rejected window can arrive before any turn exists.
   - `handleResultMessage` skips prompt correlation when `turnState` is undefined (`:3138-3158`).
3. **Codex.**
   - The `error` notification maps every `willRetry:false` error to `runtime.error {class:"provider_error"}` (`CodexAdapter.ts:1721-1735`).
   - `readPayload` is a strict `Schema.is` (`:249-254`).
   - The pinned schema's `CodexErrorInfo` has `"usageLimitExceeded"` and no `"rateLimitExceeded"` (`schema.gen.ts:12531-12557`). `TurnError.codexErrorInfo` is a closed union (`:26773-26777`).
   - `turn/completed` returns `[]` if strict decoding fails (`:1242-1245`).
   - `account/rateLimits/updated` is a *sparse* rolling snapshot ("merge … nullable metadata does not clear", `:36681-36688`), forwarded unparsed (`:1598-1609`).
   - Mapping runs per session inside the event fiber (`:1977-1985`), so per-session state is possible.
4. **Orchestration.**
   - `OrchestrationSessionStatus` has no Limited value (`orchestration.ts:743-751`). A limit ends as session `error` at best (`ProviderRuntimeIngestion.ts:2900-2932`, `:2443-2446`).
   - For Claude, the later `turn.completed state:"completed"` sets the session back to `ready` with `lastError: null` (`:2443-2459`). Session status therefore **cannot** carry a durable Limited state.
   - No consumer reads `account.rate-limits.updated` (grep: only the two adapters).
5. **Client.**
   - The ChatView drain (`ChatView.tsx:3936-3970`) and the mobile outbox gate (`use-thread-outbox-drain.ts:81-122`) never consider limits. `derivePhase` maps `error` to `"ready"` (`session-logic.ts:2306-2311`).
   - A send only queues while `phase === "running"` (`ChatView.tsx:3893`). So only messages queued **during** the limited turn are at risk, and they drain into the limit one after another.
   - The inbox has no Limited state (`inboxSidebarModel.ts:28-36`, `:229-252`, `ACTIVE_PRIORITY` `:207-214`). Mobile has the same gap (`apps/mobile/src/features/inbox/inboxModel.ts:140-160`).
6. **Existing building blocks.**
   - Reset data is already fetched for the usage page: `parseClaudeUsageRateLimits` (`ClaudeUsage.ts:234-266`, percent and epoch seconds) and `parseCodexRateLimits` / `account/rateLimits/read` (`CodexProvider.ts:194-230`, `:380-386`). Both are exposed per instance as `ServerProvider.rateLimits` through `ProviderRegistry.refreshInstance` (`ProviderRegistry.ts:53-55`).
   - Thread snooze exists: `thread.snooze`, plus `canSnoozeThread` and `isThreadSnoozed` (`packages/shared/src/threadSnooze.ts:20-48`). Snooze is timestamp-derived, so no wake timer is needed.
   - Turn-start guards have precedent in `claudeResumeGuard` and `delegationReturnGuard` (`orchestration.ts:1383-1401`, decider `:982-1032`).
   - Engine receipts dedupe by commandId (`OrchestrationEngine.ts:215-227`).
   - Polling workers have precedent in `CompletionReturnDeliveryLive` (`CompletionReturnDelivery.ts:458-475`).

---

## 2. Approach

**Detection** happens in the adapters, where the provider knowledge lives.
- Each adapter emits `runtime.error {class:"usage_limit", resetAt}` bound to the limited turn's `turnId`, followed by a failed `turn.completed`.
- Rate-limit updates carry a normalised `usageLimitState {exhausted, resetAt}` so ingestion stays provider-agnostic.

**The durable state** is a new optional `ThreadUsageLimit` on the thread aggregate. It is event-sourced through `thread.usage-limit-set` and `thread.usage-limit-cleared`, persisted in `projection_threads.usage_limit_json` (migration 074), and projected on the shell.
- Session status stays `error`, so old clients degrade to "Error".
- "Limited" is derived as `usageLimit != null && modelSelection.instanceId === usageLimit.providerInstanceId`.

**Clearing** happens deterministically in the decider:
- on any accepted `thread.turn.start`
- on `thread.session.set` to running for a different turn
- on `thread.archive`
- on `thread.checkpoint.revert`

**Resume** has two entry points and one identity:
- Resume now: client, through the shared send engine.
- Auto-resume: the server worker.

Both send `"Continue where you left off."` with the same commandId and messageId (`usage-limit-resume:<limitId>`) and `usageLimitResumeGuard`. The decider accepts at most one turn per limit.

**The hold** is a derived, settings-free predicate shared by every drain. It releases at `resetAt + 2 min`.

**The worker** is opt-in. It sweeps persisted limits every 30 s and does three things:
- fills a missing `resetAt` from the provider usage probe
- snoozes until reset if `snoozeLimitedThreads` is on
- auto-resumes at `resetAt + 30 s` if the effective auto-resume is on, at most one resume per instance per sweep, and never more than 24 h late

The invariants are pure functions in `@ryco/shared/usageLimit`, so server, web and mobile share one policy.

---

## 3. Step-by-step changes

### 3.1 Contracts

**`packages/contracts/src/providerRuntime.ts`**
- `RuntimeErrorClass`: add `"usage_limit"`.
- `RuntimeErrorPayload`: add `resetAt: Schema.optional(Schema.NullOr(IsoDateTime))`. It is only meaningful for `usage_limit`: `null` means a limit with an unknown reset, and absent means not applicable.
- `AccountRateLimitsUpdatedPayload`: add `usageLimitState: Schema.optional(Schema.Struct({ exhausted: Schema.Boolean, resetAt: Schema.NullOr(IsoDateTime) }))`.
  - `exhausted` means at least one window is currently rejected or at ≥100%.
  - `resetAt` is the time by which *all* exhausted windows reset, or `null` if any is unknown.

**`packages/contracts/src/orchestration.ts`**
- Next to `ClaudeResumeGuard`, add:

```ts
export const ThreadUsageLimitId = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
export const ThreadUsageLimit = Schema.Struct({
  limitId: ThreadUsageLimitId,          // "usage-limit:<threadId>:<turnId>"
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  turnId: TurnId,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  limitedAt: IsoDateTime,
  resetAt: Schema.NullOr(IsoDateTime),
  /** null follows ServerSettings.autoResumeLimitedThreads; a boolean is an explicit per-thread override. */
  autoResume: Schema.NullOr(Schema.Boolean),
  updatedAt: IsoDateTime,
});
export const UsageLimitResumeGuard = Schema.Struct({
  limitId: ThreadUsageLimitId,
  origin: Schema.Literals(["auto", "manual"]),
});
```

- `OrchestrationThread` and `OrchestrationThreadShell`: add `usageLimit: Schema.optional(Schema.NullOr(ThreadUsageLimit))`. It is optional so mixed-version snapshots decode. Old clients strip the unknown key.
- `ThreadTurnStartCommand` and `ClientThreadTurnStartCommand`: add `usageLimitResumeGuard: Schema.optional(UsageLimitResumeGuard)`. Do **not** add it to `ThreadTurnStartRequestedPayload`, because the reactor does not need it.
- Add an internal command `ThreadUsageLimitRecordCommand`. Put it in the internal `OrchestrationCommand` union only, never in `ClientOrchestrationCommand` or `DispatchableClientOrchestrationCommand`, so clients cannot forge limits:

```ts
{ type: "thread.usage-limit.record", commandId, threadId, limitId, provider, providerInstanceId,
  turnId, message, resetAt: NullOr(IsoDateTime), createdAt }
```

- Add a client command `ThreadUsageLimitConfigureCommand`. Put it in both client unions:

```ts
{ type: "thread.usage-limit.configure", commandId, threadId, limitId, autoResume: NullOr(Boolean), createdAt }
```

- Add events to `OrchestrationEventType` and to the `OrchestrationEvent` union:
  - `thread.usage-limit-set` with `ThreadUsageLimitSetPayload { threadId, usageLimit: ThreadUsageLimit }`
  - `thread.usage-limit-cleared` with `ThreadUsageLimitClearedPayload { threadId, limitId, reason: Literals(["turn-started","archived","reverted"]), updatedAt }`
- Do **not** add either event to `isThreadDetailEvent` (`apps/server/src/ws/context/orchestrationEvents.ts`). Clients receive the state only through `thread-upserted` shells and detail snapshots, so old clients never see an unknown event.

**`packages/contracts/src/settings.ts`**
- `ServerSettings`:
  - `autoResumeLimitedThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)))`
  - `snoozeLimitedThreads: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false)))`
- `ServerSettingsPatch`: add both keys as `optionalKey(Schema.Boolean)`. `isServerSettingKey` derives ownership automatically (`packages/shared/src/settingsOwnership.ts:8`).

**`packages/contracts/src/environment.ts`**
- `ExecutionEnvironmentCapabilities`: add `usageLimitRecovery: Schema.optionalKey(Schema.Boolean)`.

### 3.2 Shared policy: `packages/shared/src/usageLimit.ts` (new), exported as `./usageLimit`

All functions here are pure. They import only brands and types from `@ryco/contracts`.

```ts
export const USAGE_LIMIT_RESUME_MESSAGE = "Continue where you left off.";
export const USAGE_LIMIT_RESUME_GRACE_MS = 30_000;                 // resume 30 s after reset (clock skew)
export const USAGE_LIMIT_HOLD_RELEASE_MS = 2 * 60_000;             // client queue hold ends 2 min after reset
export const USAGE_LIMIT_AUTO_RESUME_MAX_LATENESS_MS = 24 * 3_600_000;

export function usageLimitIdForTurn(threadId: ThreadId, turnId: TurnId): string;   // "usage-limit:<t>:<turn>"
export function usageLimitRecordCommandId(limitId: string): CommandId;             // "usage-limit-record:<id>"
export function usageLimitResetFillCommandId(limitId: string): CommandId;          // "usage-limit-reset:<id>"
export function usageLimitSnoozeCommandId(limitId: string, resetAt: string): CommandId; // "usage-limit-snooze:<id>:<ms>"
export function usageLimitResumeIds(limitId: string): { commandId: CommandId; messageId: MessageId }; // both "usage-limit-resume:<id>"

/** The limit only gates the thread while it still targets the limited instance. */
export function applicableUsageLimit(thread: { usageLimit?: ThreadUsageLimit | null; modelSelection?: { instanceId: string } | undefined }): ThreadUsageLimit | null;
export function effectiveUsageLimitAutoResume(limit: ThreadUsageLimit, nodeSetting: boolean): boolean;
export type UsageLimitPhase = "limited" | "reset";                  // limited: resetAt null || now < resetAt
export function usageLimitPhase(limit: ThreadUsageLimit, nowMs: number): UsageLimitPhase;
export function isUsageLimitQueueHeld(thread, nowMs: number): boolean; // applicable && (resetAt null || now < resetAt + HOLD_RELEASE)
export function usageLimitHoldReleaseAtMs(thread, nowMs: number): number | null; // null = no release time (unknown reset) or not held
export function isUsageLimitResetFresh(limit: ThreadUsageLimit): boolean; // resetAt !== null && resetAt > limitedAt
/** Server worker eligibility; every reason is returned for logs and tests. */
export function usageLimitAutoResumeBlocker(input: {
  thread: Pick<OrchestrationThreadShell, "usageLimit" | "modelSelection" | "archivedAt" | "deletedAt"?
    | "settledOverride" | "snoozedUntil" | "hasPendingApprovals" | "hasPendingUserInput" | "session" | "latestTurn">;
  nodeSetting: boolean; nowMs: number;
}): null | "not-limited" | "instance-mismatch" | "not-armed" | "reset-unknown" | "reset-stale"
       | "before-reset" | "too-late" | "archived" | "settled" | "snoozed" | "pending-request" | "busy";
```

- `"reset-stale"` means `resetAt <= limitedAt`, the t3 rule: an already-expired window cannot start a retry loop.
- `"busy"` means the session is `running` or `starting`, or `latestTurn.state === "running"`.

Register `"./usageLimit": { "types": "./src/usageLimit.ts", "import": "./src/usageLimit.ts" }` in `packages/shared/package.json`.

### 3.3 Claude detection

**`apps/server/src/provider/usageLimitReset.ts`** (new, pure; shared by Claude, Codex and the worker):

```ts
export interface UsageWindowObservation { readonly exhausted: boolean; readonly resetAtMs: number | null }
/** All exhausted windows must reset before work can continue; null when any is unknown. */
export function usageLimitStateFromWindows(windows, nowMs?): { exhausted: boolean; resetAt: string | null };
export function usageLimitStateFromServerRateLimits(r: ServerProviderRateLimits, nowMs): { exhausted; resetAt };
```

`usageLimitStateFromServerRateLimits` reads `primary`, `secondary` and `tertiary`, treats `usedPercent >= 100` as exhausted, converts epoch seconds to ms, and drops resets at or before `nowMs`.

**`apps/server/src/provider/Layers/claudeUsageLimits.ts`** (new, pure):
- `applyClaudeRateLimitInfo(windows: Map<string, string | null>, info: SDKRateLimitInfo): { blocked: boolean; key: string; limitType: string; resetAt: string | null }`
  - `limitType = info.rateLimitType ?? "unknown"`.
  - `overageAllowed` is true when `overageStatus` is `allowed`/`allowed_warning`, or `isUsingOverage`, or `overageInUse`.
  - **blocked** is `status === "rejected" && !overageAllowed`. It sets `windows[limitType] = resetsAt ? iso(resetsAt*1000) : null`, ignoring non-finite values and values `>= 8.64e15`.
  - An allowed event, an `allowed_warning` event or `overageAllowed` deletes `windows[limitType]`.
  - `key = ${limitType}:${info.resetsAt ?? "unknown"}`.
- `claudeUsageLimitState(windows, nowMs)` delegates to `usageLimitStateFromWindows`, dropping entries whose known reset is ≤ now.
- `classifyClaudeUsageLimitResult({ result, windows, nowMs }): null | { message: string; resetAt: string | null }` returns non-null **only** when one of these holds:
  - `result.terminal_reason === "blocking_limit"`, or
  - all of the following:
    - at least one window is unexpired (`claudeUsageLimitState(...).exhausted`)
    - `resultIsError`, meaning `subtype !== "success" || is_error === true`
    - `terminal_reason` is `undefined`, `null` or `"api_error"`
    - for `subtype:"success"`, `api_error_status` is `null`, `undefined` or `429`

  A bare 429 without a rejected window, or `assistant.error === "rate_limit"` alone, stays non-limited. The classifier never runs for interrupted or cancelled results.
  - `message`: for `success`, the first non-empty trimmed `result`; otherwise `errors[0]`. Truncate to 500 characters. Fallback: `"Claude usage limit reached."`
  - `resetAt` is `claudeUsageLimitState(...).resetAt`.

**`apps/server/src/provider/Layers/ClaudeAdapter.ts`**
- `ClaudeSessionContext` (`:233+`): add `readonly rejectedRateLimitWindows: Map<string, string | null>` and initialise it to `new Map()` where the context is built (`~:4764`). This state is account-scoped and session-lifetime.
- `ClaudeTurnState` (`:159-172`): add an optional mutable `announcedUsageLimitKeys?: Set<string>`, created lazily. Turn construction sites are **not** touched (`:3054`, `:4910`), to minimise conflicts with `claude-meter-wake` and `claude-steering`.
- `emitRuntimeError` (`:2058-2081`): add a 4th optional parameter `options?: { readonly class?: RuntimeErrorClass; readonly resetAt?: string | null }`. The default class stays `provider_error`, and `resetAt` is spread only when it is defined. The existing four callers are unchanged.
- `handleSdkTelemetryMessage` `rate_limit_event` branch (`:3944-3951`):
  1. `const t = applyClaudeRateLimitInfo(context.rejectedRateLimitWindows, message.rate_limit_info)`, skipped when `rate_limit_info` is missing.
  2. Emit `account.rate-limits.updated` with `{ rateLimits: message, usageLimitState: claudeUsageLimitState(context.rejectedRateLimitWindows, nowMs) }`.
  3. If `t.blocked && context.turnState`, and the key is not yet in `turnState.announcedUsageLimitKeys`, add it and call `emitRuntimeWarning(context, "Claude usage limit reached.", { usageLimit: { limitType: t.limitType, resetAt: t.resetAt } })`. The copy no longer says "paused".
- `handleResultMessage` (`:3130-3168`): after the existing correlation guard, and before `turnStatusFromResult`:

```ts
const baseStatus = turnStatusFromResult(message);
const limit = context.turnState && baseStatus !== "interrupted" && baseStatus !== "cancelled"
  ? classifyClaudeUsageLimitResult({ result: message, windows: context.rejectedRateLimitWindows, nowMs })
  : null;
if (limit) {
  yield* emitRuntimeError(context, limit.message, undefined, { class: "usage_limit", resetAt: limit.resetAt });
  yield* completeTurn(context, "failed", limit.message, message);
  return;
}
```

  The rest of the function is unchanged. Results without `turnState` keep today's behaviour exactly: no `usage_limit`, so a stale or late result can never record Limited.

### 3.4 Codex detection

**`apps/server/src/provider/Layers/codexUsageLimits.ts`** (new):
- `mergeCodexRateLimitSnapshot(previous, update)` performs a sparse merge. A field present in `update` overrides the previous value, and `null` or absent never clears it. It is structural, so unknown fields are tolerated.
- `codexUsageLimitState(snapshot, nowMs)` maps `primary` and `secondary` to `{exhausted: usedPercent >= 100, resetAtMs: resetsAt*1000}`, then calls `usageLimitStateFromWindows`.
- `codexErrorInfoCode(info: unknown): string | undefined` returns the string itself, or the single key of an object (`httpConnectionFailed` and similar).
- `isCodexUsageLimitError(code, state)`:
  - `"usageLimitExceeded"` → true
  - `"rateLimitExceeded"`, which is not in the pinned schema, → true only if `state.exhausted`, to avoid transient 429s
  - anything else → false
- `makeCodexUsageLimitTracker()` holds per-session state `{ snapshot, announcedTurnIds: Set<string> }` and exposes `annotate(event: ProviderEvent, mapped: ReadonlyArray<ProviderRuntimeEvent>): ReadonlyArray<ProviderRuntimeEvent>`:
  - **`account/rateLimits/updated`**: merge `event.payload.rateLimits` structurally, then attach `usageLimitState` to the mapped `account.rate-limits.updated`.
  - **`error`**: read `payload.error.codexErrorInfo` structurally from `event.payload`, so strict decoding is not required. Only act when `payload.willRetry !== true`. If `isCodexUsageLimitError`, rewrite the mapped `runtime.error` to `class:"usage_limit"` with `resetAt: state.exhausted ? state.resetAt : null`, and add `event.turnId` to `announcedTurnIds`.
  - **`turn/completed`**:
    - If the mapped list contains a failed `turn.completed` whose structural `turn.error.codexErrorInfo` is a usage-limit code, and the turn is not yet announced, **prepend** a synthesized `runtime.error {class:"usage_limit", message: turn.error.message ?? "Codex usage limit reached.", resetAt}` with the same base and an event id derived from the original plus `":usage-limit"`.
    - Then remove the turn id from `announcedTurnIds`.

**`apps/server/src/provider/Layers/CodexAdapter.ts`**
- `mapToRuntimeEvents` `turn/completed` (`:1242-1257`): if `readPayload` fails, fall back to `readTurnCompletedStructurally(event.payload)`. It requires `turn.status` to be a string, maps it through the same switch as `toTurnStatus` (an unknown status becomes `"failed"` when `turn.error` is present, otherwise `"completed"`), and takes `errorMessage = trimText(turn.error?.message)`. It returns `[]` only if `turn` is not an object. This keeps `turn.completed`, and with it `agentControl.retireTurn` (`:1997-2002`), alive when Codex adds new error literals.
- Per-session event fiber (`:1977-1985`): create `const usageLimits = makeCodexUsageLimitTracker()` next to `eventFiber`, and map through `usageLimits.annotate(event, mapToRuntimeEvents(event, event.threadId))` before `stampRuntimeEvent`.
- The `error` branch (`:1721-1735`) is unchanged. The tracker rewrites its output.

### 3.5 Copilot (best effort)

`apps/server/src/provider/Layers/CopilotAdapter.mapEvent.ts` `session.error` (`:309-325`): set `class:"usage_limit"`, `resetAt:null` when either of these holds:
- `event.data.errorType === "quota"` and `errorCode` is `"quota_exceeded"` or `"session_quota_exceeded"`
- `errorType === "rate_limit"` and `errorCode === "user_weekly_rate_limited"`

Everything else stays `provider_error`.

OpenCode, Cursor/ACP and Grok are out of scope (§7). Their only signal is an ambiguous HTTP 429.

### 3.6 Decider, projector and projections

**`apps/server/src/orchestration/decider.ts`**

- **New `case "thread.usage-limit.record"`**
  - `requireThread`. If `archivedAt !== null` or `deletedAt !== null`, fail with an invariant ("Thread is archived or deleted").
  - If `session?.status === "running" && session.activeTurnId !== null && session.activeTurnId !== command.turnId`, fail with an invariant ("A newer turn is running; stale usage limit").
  - If `existing?.limitId === command.limitId`:
    - when `existing.resetAt === null && command.resetAt !== null`, emit `thread.usage-limit-set` with `{...existing, resetAt: command.resetAt, updatedAt: command.createdAt}`. This is the fill path.
    - otherwise fail with an invariant ("already recorded"). This is unreachable in practice because of commandId dedupe.
  - Otherwise emit `thread.usage-limit-set` with a fresh limit: `limitedAt` and `updatedAt` set to `command.createdAt`, and `autoResume: null`.
- **New `case "thread.usage-limit.configure"`**: `requireThread`. Fail with an invariant unless `thread.usageLimit?.limitId === command.limitId` ("The usage limit changed. Refresh and try again."). Otherwise emit set with `autoResume: command.autoResume` and `updatedAt: nowIso()`.
- **`case "thread.turn.start"`** (`:970-1237`)
  - After the existing `running && activeTurnId` check (`:997-1006`), add the guard check. If `command.usageLimitResumeGuard` is set, fail with an invariant ("This usage-limit resume is stale: the thread was resumed, changed, or is busy.") unless all of the following hold:
    - `targetThread.usageLimit?.limitId === guard.limitId`
    - `targetThread.archivedAt === null`
    - `targetThread.session?.status` is not `running` or `starting`
    - `targetThread.latestTurn?.state !== "running"`
    - `(command.modelSelection ?? targetThread.modelSelection).instanceId === targetThread.usageLimit.providerInstanceId`
  - Then, for **every** accepted turn.start where `targetThread.usageLimit != null`, put a `thread.usage-limit-cleared {reason:"turn-started", limitId, updatedAt: command.createdAt}` event first in the returned list. That is ahead of the unsettled event and `turnEvents`. The engine projects it onto the command read model before the next command (`OrchestrationEngine.ts:445`), so a second guarded resume is rejected.
  - If `guard?.origin === "auto"`, also append a `thread.activity-appended` with:
    - id `usage-limit-resumed:<commandId>`
    - `kind: "usage-limit.resumed"`, `tone: "info"`
    - `summary: "Resumed automatically after the usage limit reset"`
    - `payload: { limitId, resetAt }`
    - `turnId: null`
- **`case "thread.archive"`** (`:535-561`): if `usageLimit != null`, return `[archivedEvent, clearedEvent(reason:"archived")]`.
- **`case "thread.checkpoint.revert"`** (`:1414-1434`): if `usageLimit != null`, append `clearedEvent(reason:"reverted")`. **This overlaps with `rollback-correctness`** (§5.2).
- **`case "thread.session.set"`** (`:1720-1757`): if `command.session.status === "running"`, `command.session.activeTurnId !== null` and `thread.usageLimit?.turnId !== command.session.activeTurnId`, prepend `clearedEvent(reason:"turn-started")`. A newer turn is running, for example a provider wake turn or a send that raced the record, so the limit is stale. Compose this with the existing unsettled and wake returns without changing their order.

**`apps/server/src/orchestration/projector.ts`**
- `thread.usage-limit-set` sets `usageLimit: payload.usageLimit` and `updatedAt: payload.usageLimit.updatedAt`.
- `thread.usage-limit-cleared` sets `usageLimit: null` and `updatedAt` **only if** `thread.usageLimit?.limitId === payload.limitId`.
- Decode both with the new payload schemas, re-exported from `orchestration/Schemas.ts`.

**`apps/server/src/orchestration/Layers/OrchestrationEngine.ts`**: add both command types to the `thread` aggregate routing switch (`:100-140`). This switch is exhaustive.

**`apps/server/src/orchestration/Layers/ProjectionPipeline.ts`**
- `ORCHESTRATION_EVENT_PROJECTORS` (`:94+`): route both events to `[threads]`.
- Thread projector: add both cases using `getById` and `upsert({...row, usageLimit, updatedAt})`. The cleared case applies only when the `limitId` matches.
- `thread.created` (`~:777`): `usageLimit: null`.

**Persistence**
- `apps/server/src/persistence/Services/ProjectionThreads.ts`:
  - `ProjectionThread` gains `usageLimit: Schema.optional(Schema.NullOr(ThreadUsageLimit))`.
  - The repository gains `listUsageLimitedThreadIds: () => Effect<ReadonlyArray<ThreadId>, ProjectionRepositoryError>`.
- `apps/server/src/persistence/Layers/ProjectionThreads.ts`:
  - Row schema: `usageLimit: Schema.NullOr(Schema.fromJsonString(ThreadUsageLimit))`, following the `goal_json` precedent (`:22`).
  - Add `usage_limit_json` to the INSERT column list, the VALUES (`row.usageLimit == null ? null : JSON.stringify(row.usageLimit)`), the upsert `SET`, and both SELECTs.
  - `listUsageLimitedThreadIds`: `SELECT thread_id FROM projection_threads WHERE usage_limit_json IS NOT NULL AND deleted_at IS NULL AND archived_at IS NULL ORDER BY updated_at ASC, thread_id ASC LIMIT 500`.
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`:
  - `ProjectionThreadDbRowSchema` (`:103-109`) gains the same JSON field.
  - Both thread SELECTs (`:617`, `:1070`) gain `usage_limit_json AS "usageLimit"`.
  - Every thread or shell literal built from a row (`:1812`, `:2107`, `:2402`, `:2596`, `:2863`) gains `usageLimit: row.usageLimit ?? null`. This includes `getCommandReadModel`, which is what lets the decider guard survive a restart.

**Migration 074**: `apps/server/src/persistence/Migrations/074_ProjectionThreadsUsageLimit.ts`.

```ts
export const ensureProjectionThreadUsageLimitColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='projection_threads'`;
  if (tables.length === 0) return;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some((c) => c.name === "usage_limit_json"))
    yield* sql`ALTER TABLE projection_threads ADD COLUMN usage_limit_json TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_threads_usage_limited
             ON projection_threads(thread_id) WHERE usage_limit_json IS NOT NULL`;
});
export default ensureProjectionThreadUsageLimitColumn;
```

In `Migrations.ts`:
- Import it as `Migration0074` and register `[74, "ProjectionThreadsUsageLimit", Migration0074]` after `[70, …]`.
- Add `repairProjectionThreadUsageLimitColumn` after the migrator, run when `toMigrationInclusive === undefined || toMigrationInclusive >= 74`. It reuses `ensureProjectionThreadUsageLimitColumn` and logs when it repairs. This follows the existing repair pattern (`Migrations.ts:240-258`) and handles databases where 075 was applied first (§5.3).

No backfill is needed: no historical limits exist, and future events project normally.

### 3.7 Ingestion: `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`

- **Activity mapping** (`:603-617`): for `runtime.error` with `class === "usage_limit"`, use `summary: "Usage limit reached"` and `payload: { message, class: "usage_limit", resetAt: event.payload.resetAt ?? null }`. The kind stays `runtime.error`, so client renderers are unchanged.
- **The `runtime.error` branch** (`:2900-2932`): **after** the existing `thread.session.set` dispatch and `clearSubagentMessageBuffersForThread`:

```ts
if (event.payload.class === "usage_limit" && shouldApplyRuntimeError && eventTurnId !== undefined) {
  const instanceId = event.providerInstanceId ?? thread.session?.providerInstanceId;
  const limitId = usageLimitIdForTurn(thread.id, eventTurnId);
  if (instanceId !== undefined && thread.usageLimit?.limitId !== limitId) {
    yield* orchestrationEngine.dispatch({
      type: "thread.usage-limit.record",
      commandId: usageLimitRecordCommandId(limitId),
      threadId: thread.id, limitId, provider: event.provider, providerInstanceId: instanceId,
      turnId: eventTurnId, message: truncate(event.payload.message, 1_000),
      resetAt: event.payload.resetAt ?? null, createdAt: now,
    }).pipe(Effect.catchCause((cause) => Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause)
      : Effect.logDebug("provider runtime ingestion skipped usage-limit record", { threadId: thread.id, cause: Cause.pretty(cause) })));
  }
}
```

  A failed or duplicate record can therefore never skip `session.set`, `lastError` or the buffer clear. A duplicate `commandId` resolves through receipt dedupe (`OrchestrationEngine.ts:215-221`) with no invariant and no reconcile.
- **New branch for `event.type === "account.rate-limits.updated"`**: it applies only when all of these hold:
  - `event.payload.usageLimitState?.exhausted === true`
  - `resetAt !== null`
  - `thread.usageLimit?.resetAt === null`
  - `thread.usageLimit.providerInstanceId === (event.providerInstanceId ?? thread.session?.providerInstanceId)`
  - `Date.parse(resetAt) > Date.parse(thread.usageLimit.limitedAt)`

  It dispatches `thread.usage-limit.record` with the same `limitId`, `turnId`, provider fields and `message`, the new `resetAt`, and `commandId: usageLimitResetFillCommandId(limitId)`. It uses the same `catchCause` wrapper.

### 3.8 Shared continuation builder: `apps/server/src/orchestration/threadContinuation.ts` (new; **this package owns the file**)

```ts
export function buildThreadContinuationTurnStart(
  thread: Pick<OrchestrationThreadShell, "id" | "modelSelection" | "runtimeMode" | "interactionMode" | "tokenMode">,
  input: { readonly commandId: CommandId; readonly messageId: MessageId; readonly text: string; readonly createdAt: string;
           readonly guards?: Pick<ClientThreadTurnStartCommand, "usageLimitResumeGuard" | "delegationReturnGuard"> },
): ClientThreadTurnStartCommand
```

It returns `{ type:"thread.turn.start", commandId, threadId: thread.id, message:{messageId, role:"user", text, attachments:[]}, modelSelection: thread.modelSelection, runtimeMode, interactionMode, …(tokenMode), …guards, createdAt }`.

`delegation-returns` (W2) and `restart-continuation` (W3) consume it (§5.2). If `delegation-returns` merges first with an equivalent builder, adopt theirs instead of adding a second one.

### 3.9 Worker: `apps/server/src/orchestration/Services/UsageLimitRecovery.ts` and `Layers/UsageLimitRecovery.ts` (new)

The decision logic is a **pure planner**, exported for tests:

```ts
export type UsageLimitRecoveryAction =
  | { kind: "fill-reset"; threadId; limitId; providerInstanceId }
  | { kind: "snooze"; threadId; command: ThreadSnoozeCommand }
  | { kind: "resume"; threadId; command: ClientThreadTurnStartCommand };
export function planUsageLimitRecovery(input: {
  candidates: ReadonlyArray<{ thread: OrchestrationThreadShell; delegatedReturnTerminal: boolean }>;
  settings: { autoResumeLimitedThreads: boolean; snoozeLimitedThreads: boolean };
  enabledInstanceIds: ReadonlySet<ProviderInstanceId>;
  attempted: ReadonlySet<string>;          // command ids already settled this process
  nowMs: number;
}): ReadonlyArray<UsageLimitRecoveryAction>;
```

Planner rules, applied in `limitedAt` ascending order:

1. **Skip** a candidate if `applicableUsageLimit(thread)` is null.
2. **Fill reset** when all of these hold:
   - `limit.resetAt === null`
   - `nowMs - limitedAt < 6 h`
   - `usageLimitResetFillCommandId(limitId)` is not in `attempted`
   - this is the first fill for this instance in the current sweep

   The layer then runs `providerRegistry.refreshInstance(instanceId)`, picks the snapshot with that `instanceId`, and calls `usageLimitStateFromServerRateLimits(snapshot.rateLimits, nowMs)`. If the result is `exhausted && resetAt > limitedAt`, it dispatches `thread.usage-limit.record` with the fill commandId through `OrchestrationEngineService.dispatch`, because this command is internal-only and not reachable through `apply`. The fill id is marked attempted either way: one probe per limit per process.
3. **Snooze** when all of these hold:
   - `settings.snoozeLimitedThreads`
   - `resetAt` is known and greater than `now + 60 s`
   - `!(snoozedUntil && Date.parse(snoozedUntil) > nowMs)`
   - `archivedAt === null`
   - `settledOverride !== "settled"`
   - the command id is not attempted

   The action is `thread.snooze {snoozedUntil: resetAt, commandId: usageLimitSnoozeCommandId(limitId, resetAt)}`. The decider's `canSnoozeThread` remains authoritative. A deterministic id means a user's later unsnooze is never undone, because the replay dedupes.
4. **Resume** when all of these hold:
   - `usageLimitAutoResumeBlocker({ thread, nodeSetting: settings.autoResumeLimitedThreads, nowMs }) === null`
   - `!delegatedReturnTerminal`
   - `enabledInstanceIds.has(limit.providerInstanceId)`
   - the resume id is not attempted
   - this is the **first resume for this instance in the current sweep** (stagger)

   The action is `buildThreadContinuationTurnStart(thread, { …usageLimitResumeIds(limitId), text: USAGE_LIMIT_RESUME_MESSAGE, createdAt: now, guards: { usageLimitResumeGuard: { limitId, origin: "auto" } } })`.

Layer (`makeUsageLimitRecovery`) dependencies:
- `ProjectionThreadRepository` (`listUsageLimitedThreadIds`)
- `ProjectionSnapshotQuery` (`getThreadShellById`)
- `CompletionReturnRepository.get(threadId)`. `delegatedReturnTerminal` is true when a record exists with a status outside `waiting`, `ready` and `dispatching`.
- `ServerSettingsService.getSettings`
- `ProviderRegistry` (`getProviders` for enabled instance ids, `refreshInstance` for fills)
- `OrchestrationCommandApplication.apply` for snooze and resume
- `OrchestrationEngineService.dispatch` for fills

`attempted` is process-local:
- A dispatch **result** is classified through `error.cause`. `OrchestrationCommandApplication` wraps every engine error in `OrchestrationDispatchCommandError` (`OrchestrationCommandApplication.ts:24-30`).
  - An accepted result, `OrchestrationCommandInvariantError` or `OrchestrationCommandPreviouslyRejectedError` marks the id attempted.
  - Any other error increments a per-id counter and stays retryable up to 5 times, then is marked attempted with a warning.
- Each sweep runs under `Effect.catchCause` that rethrows interrupts (`Cause.hasInterruptsOnly`) and logs everything else. A defect can therefore never end the loop, unlike `CompletionReturnDelivery`'s `Effect.catch`.

Live layer: `Effect.forkScoped(startup.awaitCommandReady.pipe(Effect.andThen(Effect.suspend(() => recovery.sweep()).pipe(Effect.repeat(Schedule.spaced(Duration.seconds(30)))))))`.

**`apps/server/src/server.ts`**: add `UsageLimitRecoveryLive.pipe(Layer.provideMerge(ServerRuntimeStartupLive), Layer.provideMerge(OrchestrationCommandApplicationLive))` to the `RuntimeServicesLive` `mergeAll`, next to `CompletionReturnDeliveryLive` (`:495-498`).

**`apps/server/src/environment/Layers/ServerEnvironment.ts`** (`:88-101`): `usageLimitRecovery: true`.

**Agent Control is untouched.** `settingsControl.ts`'s explicit allowlist (`:12-71`) must **not** gain either new key. Agent Control's action vocabulary gains no `thread.usage-limit.*` action and cannot set `usageLimitResumeGuard`. A test asserts this (§6).

### 3.10 Client runtime state: `packages/client-runtime/src/state/threads/usageLimit.ts` (new)

- Re-export the shared predicates and add presentation models:
  - `deriveUsageLimitStatus(thread, nowMs): null | { label: "Limited" | "Limit reset"; resetAt: string | null; phase }` for inbox labels and the sidebar pill.
  - `deriveUsageLimitBanner({ thread, nodeAutoResume: boolean | null, recoverySupported: boolean, snoozeEligibility: { canSnooze: boolean }, snoozeSupported: boolean, dispatchAllowed: boolean, nowMs })` returns `null` or:
    - `title`: `"<Provider> usage limit reached"`, or `"Usage limit reset"` after the reset
    - `description` kind: `resets-at`, `resuming-at-reset`, `unknown-reset` or `reset-passed`
    - `actions`:
      - `resumeNow: boolean`
      - `autoResume: null | { scheduled: boolean }`. It is shown only when `recoverySupported`, `resetAt` is fresh and `> now`. `scheduled = effectiveUsageLimitAutoResume(limit, nodeAutoResume ?? false)`. When `nodeAutoResume` is unknown, use only the explicit override.
      - `snoozeUntilReset: boolean`. It requires `recoverySupported && snoozeSupported && snoozeEligibility.canSnooze && resetAt > now && snoozedUntil !== resetAt`.
- `types.ts`: `ThreadShell` and `SidebarThreadSummary` gain `usageLimit?: ThreadUsageLimit | null | undefined`.
- `store.ts`:
  - Map `usageLimit: thread.usageLimit ?? null` in both shell/summary builders (`~:387` and `~:416`, from `OrchestrationThread` and from `OrchestrationThreadShell`).
  - Include it in the shell and summary equality functions (`~:566`, `~:623`) so memoised rows update.
  - The cache demotion (`:3212`) may keep it. It is last-known state, and offline rows render as "offline" anyway.
- `threadInbox.ts`: export `deriveThreadSnoozeEligibility(input)`, a wrapper over the private `settlementInput` and `canSnoozeThread` (`:186-218`). `buildThreadInbox` uses it internally, with no behaviour change.

### 3.11 Resume now through the shared send engine

**`packages/client-runtime/src/state/composer/sendEngine.ts`**: `CommitSendTurnDispatchInput` (`:223-258`) gains:
- `readonly commandId?: CommandId`, which overrides the default `composer-send:${threadId}:${messageId}` id
- `readonly usageLimitResumeGuard?: UsageLimitResumeGuard`, spread into the `thread.turn.start`

Nothing else changes. `reviewClaudeResumeBeforeSend` still runs first, then `revalidateClaudeResumeBeforeCommit`, then `assertMutationReady`.

**`packages/client-runtime/src/state/composer/usageLimitResume.ts`** (new): `buildUsageLimitResumeDispatch({ api, thread, claudeCacheReview, assertMutationReady, createdAt, newCommandId })` returns a `CommitSendTurnDispatchInput` with:
- `messageId` and `commandId` from `usageLimitResumeIds(limit.limitId)`
- `outgoingMessageText: USAGE_LIMIT_RESUME_MESSAGE`, `turnAttachments: []`
- `modelSelection: thread.modelSelection`, which is the thread's, not the composer's staged selection
- thread runtime, interaction and token modes
- `isFirstMessage: false`, `isServerThread: true`, `title: ""`, `bootstrap: undefined`, `sourceControlContexts: []`
- no-op `beginLocalDispatch` and `persistThreadSettingsForNextTurn`
- `providerDriver` from the thread's session
- `usageLimitResumeGuard: { limitId, origin: "manual" }`

This mirrors the mobile drain precedent (`use-thread-outbox-drain.ts:40-76`). A shared commandId means a worker resume and a click converge on one engine receipt. A user-typed message first clears the limit, so a later click is rejected by the guard and the banner is gone anyway.

### 3.12 Queue hold (see §5.1 for the contract with `queue-hold-drain`)

- In queue-hold-drain's shared hold predicate, add reason `"usage-limit"` when `isUsageLimitQueueHeld(thread, nowMs)`. Expose `usageLimitHoldReleaseAtMs` so drains can schedule a wake.
- **Web** (`ChatView.tsx:3936-3970`): the drain effect consults the shared predicate, which includes the new reason, through queue-hold-drain's integration. Add a single `setTimeout` wake at `usageLimitHoldReleaseAtMs` (capped at 2^31−1 ms) that bumps local state, so the effect re-runs when the hold expires.
- **Mobile**: see §3.15.

### 3.13 Web banner, settings and inbox

**`apps/web/src/components/chat/usageLimitBanner.tsx`** (new): `useUsageLimitBannerItem({ thread, environmentId, serverConfig, dispatchAllowed, snoozeEligibility, onResumeNow, onConfigure, onSnooze }): ComposerBannerStackItem | null`.
- It consumes `deriveUsageLimitBanner`.
- `variant: "warning"`, gauge icon.
- `id: usage-limit:<limitId>`, so a new limit re-renders.
- It re-renders at `resetAt` with a timeout, like t3's `RecoveryActions`.
- Buttons, all `size="xs"`:
  - **Resume now** calls `commitSendTurnDispatch(buildUsageLimitResumeDispatch(...))` with `claudeCacheReviewPresentation` and `captureReviewedSendReadiness(...)`, the same as `executeChatSendTurn.ts:521-555`.
  - **Resume at reset** / **Cancel auto-resume** dispatches `thread.usage-limit.configure {limitId, autoResume: !scheduled}`.
  - **Snooze until reset** dispatches `thread.snooze {snoozedUntil: resetAt}`.
- Pending and error state is inline (`role="alert"`). Copy, formatting the time in the local timezone:
  - `resets-at`: "Resets Thu 15:40"
  - `resuming-at-reset`: "Resets Thu 15:40 · resumes automatically"
  - `unknown-reset`: "Reset time unknown. Resume when your limit resets."
  - `reset-passed`: "Resume to continue this thread."

**`apps/web/src/components/ChatView.tsx`**
- `composerBannerItems` (`:1400-1480`): push the usage-limit item first when it is non-null **and** `presentationTier !== "phone"`. The web phone tier is frozen.
- Read `nodeAutoResume` from `serverConfig?.settings.autoResumeLimitedThreads` and `recoverySupported` from `serverConfig?.environment.capabilities.usageLimitRecovery === true`.
- `ThreadErrorBanner` (`:4764`): pass `error={applicableUsageLimit(threadShell) ? null : activeThread.error}`. This avoids a duplicate persistent "Thread error" toast.
- The drain effect changes are in §3.12.

**`apps/web/src/components/settings/UsageLimitSettings.tsx`** (new), following `WorktreeSubmoduleSettings.tsx`:
- A `SettingsSection title="Usage limits" owner="node"` with two `SettingsRow` switches, each with a reset button. Both are disabled unless `config.environment.capabilities.usageLimitRecovery === true` and the editing scope can mutate the node.
- **Auto-resume limited threads**: "When a provider usage limit stops a thread, send 'Continue where you left off.' at the reported reset time. Limits apply to the whole provider account, and every resumed thread re-reads its conversation (on long Claude threads this rebuilds the prompt cache at full input cost). Each thread can cancel its scheduled resume."
- **Snooze limited threads**: "Snooze usage-limit stops until the reported reset time. Combine with auto-resume to continue when they wake."
- Mount it in `SettingsPanels.tsx` after "Provider updates" (`:657`) as `{!isPhoneTier && <UsageLimitSettings />}`.
- `settingsRestore.ts`: add the labels `autoResumeLimitedThreads: "Auto-resume limited threads"` and `snoozeLimitedThreads: "Snooze limited threads"`.

**Inbox: `inboxSidebarModel.ts`, `inboxRowPresentation.ts`, `InboxThreadRow.tsx`**
- `InboxSidebarThreadState` gains `"limited"`.
- `resolveThreadState` returns `"limited"` when `deriveUsageLimitStatus(thread, nowMs)` is non-null. This check comes after needs-input, delivery-unknown and working (a running resumed turn wins), and **before** the `error` check (`:248`). `nowMs` is passed through `buildInboxSidebarModel`. `resolveInboxThreadStatus` uses `Date.now()`.
- `ACTIVE_PRIORITY`: `limited: 1`, the same rank as `error`. `sectionKey` puts it in `"active"`.
- `statusLabel`: `"Limited"` or `"Limit reset"`, taken from the status.
- `resolveInboxGlyph`: `"limited"` → new `InboxGlyphKind "limited"`, rendered in `InboxThreadRow.tsx` as an amber, static gauge glyph.
- `resolveInboxStateLine`: `{kind:"status", text: "Resets Thu 15:40" | "Reset time unknown" | "Limit reset · resume to continue"}`.
- `inboxGlyphHint`: `${label} · ${state line}`.

**`Sidebar.logic.ts` `resolveThreadStatusPill`** (`:568+`): if the thread has an applicable limit and is not working, return `{label:"Limited", amber classes, pulse:false}`. This goes before the plan-ready and idle branches.

### 3.14 Mobile labels: `apps/mobile/src/features/inbox/inboxModel.ts`

`InboxThreadState` gains `"limited"`. `threadState` (`:140-160`) returns it before the `error` check, using `deriveUsageLimitStatus` from client-runtime. This uses the same predicate as web, so there is no fork. `statusLabel` gains `"Limited"`. The mobile banner and actions are a follow-up (§7).

### 3.15 Mobile outbox hold: `apps/mobile/src/state/use-thread-outbox-drain.ts`

- `readThreadDeliveryState` (`:81-122`): extend queue-hold-drain's hold gate with `isUsageLimitQueueHeld(summary ?? thread, Date.now())`. If queue-hold-drain added no separate field, OR it into `threadBusy`.
- After each `runOutboxDrain` pass, compute the earliest `usageLimitHoldReleaseAtMs` across threads with queued messages. Keep **one** `setTimeout(runOutboxDrain)` for that time, replacing it on each pass.

---

## 4. Edge cases

**Two resumes race** (worker vs click, two tabs, web plus mobile).
- Both use commandId `usage-limit-resume:<limitId>`. The second is a receipt duplicate that returns the existing sequence, which is idempotent.
- If the user typed a message, or anything else started a turn first, the limit is already cleared. The guarded resume gets an invariant rejection and a rejected receipt, and the worker marks it attempted.

**Double record.**
- A duplicate `runtime.error`, a Codex `error` plus a synthesized error for the same turn (suppressed by `announcedTurnIds`), or a history replay all reuse `usage-limit-record:<limitId>`, so the engine dedupes them.
- The `resetAt` fill has its own id and is applied at most once.

**Record arrives after a new turn started** (the user sent a message while the error was in flight).
- The decider rejects the record if a different turn is running.
- If the new turn starts after the record, `thread.session.set running` for another turn clears it.

**Claude wake turn** (CLI notification) after a limit.
- The rejected window is still in the session map, so a limited synthetic turn classifies with `resetAt`.
- A synthetic turn that runs clears the old limit through the session.set rule.

**Claude stale rejected window with a null reset.** It persists until an allowed event arrives. Classification also requires an error result, so the only false positive is a later `api_error` result while the CLI still reports the window as rejected. That is an acceptable worst case: Limited with reset unknown, resolved by a manual resume.

**Reset unknown (`resetAt: null`).**
- There is no auto-resume or snooze, and the queue is held.
- The banner offers Resume now. The worker tries one registry probe within 6 h to fill the reset.

**Stale reset** (`resetAt <= limitedAt`). There is no auto-resume (`reset-stale`) and the hold releases immediately (`now >= resetAt + 2 min` within minutes). This prevents a retry loop.

**Server offline at reset.**
- After startup, the worker resumes if within 24 h of `resetAt`. Otherwise the thread shows "Limit reset".
- The client hold already released at reset + 2 min. If a queued message drained first, it cleared the limit, so the worker skips.

**Settings toggled while limited.** With `autoResume: null`, the next sweep follows the new node setting. An explicit per-thread override wins either way.

**Provider switch.** Changing `modelSelection` to another instance makes the limit non-applicable: no Limited label, no hold, no auto-resume. It is kept for switching back. Any turn start clears it.

**Archive, unarchive and undo.**
- Archive clears the limit. Unarchiving later never auto-resumes.
- A sidebar *undo* of an archive restores `archivedAt` only, not Limited. The timeline still shows the error and the user can resume manually.

**Checkpoint revert** clears the limit, so there is never a "continue" into a reverted conversation.

**Snooze.**
- "Snooze until reset" sets `snoozedUntil = resetAt`, which expires by timestamp. The worker skips resume while an explicit later snooze is still active.
- Snooze is blocked while local queued messages exist, the same as the inbox (`local-queue`).
- A server-side snooze ignores the local queue (`hasLocalQueuedMessage:false` at `threadSettlementInput.ts:27`), as server snoozes do today.

**Delegation.**
- **A limited parent** has session `error`, so `CompletionReturnDelivery` *cancels* the child's return today (`:219-230`). This package does not change that. The required fix is in `delegation-returns` (§5.2).
- **A limited child** is marked `failed` by delivery (`:274-283`). Its record is then terminal, so the worker never auto-resumes it (`delegatedReturnTerminal`). The user can still resume it manually; the result is not returned automatically.

**Claude cost review on Resume now.**
- "Continue" works. "Compact" requires session `ready` (`claudeCacheReview.ts:155-164`), and a limited session is `error`, so it fails with the existing "Claude must be ready before compacting" message. The draft is retained. This is accepted for v1.
- The worker never runs the review. That cost is disclosed in the setting copy.

**Account-wide limits.**
- Only the thread that hit the limit is marked. Other threads on the same account fail on their next turn and are marked then.
- Auto-resumes are staggered to one per instance per 30 s sweep.

**Hosted, relay and viewer roles.** Banner actions use the existing dispatch path and its mutation readiness checks, and are disabled when `dispatchCapability.allowed` is false. There is no new auth path.

**Old client against a new server.** The old client strips `usageLimit` and sees session `error`, labelled "Error". New events are never forwarded on the thread stream.

**New client against an old server.**
- `usageLimit` is absent, so there is no banner and no Limited label.
- The settings section is disabled because the capability is missing. An old server would otherwise silently strip the patch keys.

---

## 5. Overlaps and cross-package contracts

### 5.1 `queue-hold-drain` (W1, lands first): the hold contract

1. `queue-hold-drain` owns **one** pure hold predicate in `packages/client-runtime`. Every drain consults it: the web ChatView flush effect, any client-runtime global drain it adds, and the mobile outbox gate (`readThreadDeliveryState`). This package adds the reason `"usage-limit"` = `isUsageLimitQueueHeld(thread, nowMs)` and the helper `usageLimitHoldReleaseAtMs` for scheduling a wake.
2. The usage-limit reason is **derived** from projected state and is never sticky.
3. A failure or interrupt hold owned by `queue-hold-drain` must not strand the queue after a usage-limit resume. Either:
   - (a) it is keyed to the failed or interrupted `turnId` and releases automatically once `latestTurn.turnId` advances to a newer turn, or
   - (b) it ignores failures where `thread.usageLimit?.turnId === failedTurnId`.

   If `queue-hold-drain` shipped a sticky failure hold, this package switches it to rule (a) in its own PR and adds the cross-package test (§6).
4. Names may differ from queue-hold-drain's final API. The invariants above are binding.

Functions touched in common: queue-hold-drain's predicate module, the `ChatView.tsx` flush `useEffect`, `use-thread-outbox-drain.ts` `readThreadDeliveryState` and `runOutboxDrain`.

### 5.2 Other packages

**`delegation-returns` (W2, same wave).** It edits decider `thread.turn.start`, where this package adds the guard block and the cleared event after the running check. It also edits `CompletionReturnDelivery`, which this package does not edit. Hand-off requirements:
- Treat `applicableUsageLimit(parent) != null` as **wait** (save and retry), not cancel.
- Treat the parent's usage-limit resume turn (`message.id` starts with `usage-limit-resume:`) as a trusted continuation, so `completionReturnOriginMatches` (`:28-39`) does not block when `latestTurn` advances.
- Optionally treat a limited child as waiting instead of failed. In that case the worker's `delegatedReturnTerminal` check lets it auto-resume and later deliver.
- Build turn.starts with `buildThreadContinuationTurnStart` (§3.8). This package owns the file. If `delegation-returns` lands first with its own builder, this package adopts it.

**`rollback-correctness` (W2).**
- Decider `thread.checkpoint.revert`: they add admission checks, and this package appends one cleared event to the return value. The second to land rebases, and the conflict is mechanical.
- ClaudeAdapter `rollbackThread` and CodexAdapter or CodexSessionRuntime revert are different functions from the ones this package edits.

**`delegation-lineage` (W2).** Both packages add one optional field to `OrchestrationThreadShell` and `OrchestrationThread` and one column each to the `projection_threads` INSERT, UPSERT and SELECT lists in `ProjectionThreads.ts` and `ProjectionSnapshotQuery.ts`, plus `Migrations.ts` entries (071 vs 074). Keep both; the merge is mechanical.

**`claude-steering` (W2).** It edits the `ClaudeSessionContext` and `ClaudeTurnState` interfaces and possibly `emitRuntimeError` callers. This package's additions are new optional fields and a backward-compatible 4th parameter.

**`claude-meter-wake` (W1).** It owns the synthetic-turn creation in `handleAssistantMessage` (`~:3049`) and `completeTurn`. This package does not edit either. It relies on synthetic turns having a `turnState`, so that the session-scoped window map classifies them.

**`turn-finalization` (W1).**
- It owns `turn.completed` lifecycle handling in `ProviderRuntimeIngestion.processRuntimeEvent` and possibly decider `thread.session.set` and Claude failure status mapping. This package edits only the `runtime.error` branch, a new `account.rate-limits.updated` branch, the activity mapping, and one prepended event in `thread.session.set`.
- If turn-finalization changes `turnStatusFromResult` for `is_error` results, the usage-limit early return in `handleResultMessage` must stay ahead of it.

**`acp-message-ids` (W1).** Same files (`ProviderRuntimeIngestion.ts`, `projector.ts`), different functions.

**`delegation-guard-restart` (W1).** It edits `ProjectionSnapshotQuery.getCommandReadModel`. This package adds `usageLimit` to the same thread object literal.

**`settlement-signals` (W1).** It edits `threadSettlement.ts` and `threadInbox.ts`. This package only reads `canSnoozeThread` and wraps the private `settlementInput` in a new export. It also holds migration number 075 (§5.3).

**`restart-continuation` (W3).**
- Limited threads are not `running` at shutdown, so they must be excluded from restart continuation, which must also not clear `usageLimit`.
- Reuse `buildThreadContinuationTurnStart`.

**`provider-effect-outbox` (W3).** Worker resumes and snoozes go through the engine like any client command, so the outbox covers them with no special case.

**No overlap:** `reactor-errors-switch` (ProviderCommandReactor is untouched), `reactor-concurrency`, `provider-compat` (no `ServerProvider` fields added).

### 5.3 Migration-number hazard (must be raised with the coordinator)

The pre-assigned **075** (`settlement-signals`) lands in **W1**, before 071, 074 (W2) and 072, 073 (W3). Effect's `Migrator` skips every id at or below the latest applied (`Migrator.ts:248-251`). So any database that ran a W1 build will **silently skip 074**, and also 071, 072 and 073. That includes the dogfood environment, which runs from this repo.

This package handles it for itself:
- Migration 074 is idempotent.
- `repairProjectionThreadUsageLimitColumn()` runs unconditionally after the migrator, in the existing repair slot.

The coordinator must require the same idempotent migration plus post-migrator repair for 071, 072 and 073, or renumber them above 075.

---

## 6. Tests

Run each focused file with `bun run --cwd <pkg> test <file>`. Never use `bun test`.

### 6.1 Failing first (current behaviour is wrong)

- **`apps/server/src/provider/Layers/CodexAdapter.test.ts`**: `turn/completed` with `turn.error.codexErrorInfo: "rateLimitExceeded"` (a literal not in the pinned schema) and `status:"failed"` still emits `turn.completed {state:"failed"}` and `agentControl.retireTurn`. Today it emits nothing.
- **`apps/server/src/provider/Layers/ClaudeAdapter.test.ts`**: a user turn ends with `result {subtype:"success", is_error:true, terminal_reason:"blocking_limit"}`. Expect `runtime.error {class:"usage_limit", turnId}` followed by `turn.completed {state:"failed"}`. Today it emits a completed turn and no error.

### 6.2 Contracts

- **`packages/contracts/src/providerRuntime.test.ts`**:
  - `runtime.error` with `class:"usage_limit"` and `resetAt` decodes.
  - The legacy payload without `resetAt` decodes.
  - `account.rate-limits.updated` with `usageLimitState` decodes.
- **`packages/contracts/src/orchestration.test.ts`**:
  - A shell without `usageLimit` decodes.
  - `ClientThreadTurnStartCommand` with `usageLimitResumeGuard` decodes.
  - `thread.usage-limit.configure` is a `ClientOrchestrationCommand`.
  - **`thread.usage-limit.record` fails to decode as a `ClientOrchestrationCommand`** (clients cannot forge limits).
- **`packages/contracts/src/settings.test.ts`**: both new settings default to `false`, and their patch keys are accepted.
- **`packages/contracts/src/environment.test.ts`**: `usageLimitRecovery` is optional.

### 6.3 Shared policy

**`packages/shared/src/usageLimit.test.ts`** (new):
- Ids are deterministic.
- `effectiveUsageLimitAutoResume`: `null` follows the setting in both directions, and an override wins.
- `applicableUsageLimit` with an instance mismatch returns `null`.
- `isUsageLimitQueueHeld` and `usageLimitHoldReleaseAtMs` with:
  - an unknown reset (held, `null` release)
  - before the reset
  - between the reset and the reset + 2 min
  - after the reset + 2 min (released)
- Each `usageLimitAutoResumeBlocker` reason: not-armed, reset-unknown, reset-stale, before-reset (including the 30 s grace), too-late (> 24 h), archived, settled, snoozed later, pending approval or input, busy, instance-mismatch. Also the eligible case.

### 6.4 Server: provider

- **`apps/server/src/provider/usageLimitReset.test.ts`** (new):
  - All exhausted windows need a reset, and the latest one wins.
  - One unknown reset gives `null`.
  - No exhausted window gives `exhausted:false`.
  - Resets at or before now are dropped.
  - `ServerProviderRateLimits` with the Claude 5 h and 7 d shape and the Codex primary and secondary shape.
- **`apps/server/src/provider/Layers/claudeUsageLimits.test.ts`** (new):
  - blocked, allowed and overage-allowed transitions
  - `blocking_limit` gives limited, both with and without windows (reset `null`)
  - a rejected window plus an error result gives limited
  - **429 success without a rejected window gives not limited**
  - an `api_error` result with a rejected window gives limited
  - `terminal_reason:"prompt_too_long"` with a window gives not limited
  - expired windows are ignored
  - message fallback
- **`ClaudeAdapter.test.ts`**, in addition to §6.1:
  - (a) A prior `rate_limit_event {status:"rejected", resetsAt}` gives the error `resetAt === iso(resetsAt)`.
  - (b) **A `rate_limit_event` arrives before a CLI wake's first assistant frame.** Then the synthetic turn's `blocking_limit` result carries that `resetAt`.
  - (c) **A result with no `turnState` and `blocking_limit`** emits no `usage_limit` runtime.error, so today's path is unchanged.
  - (d) A rejected event during a turn emits exactly one `runtime.warning` "Claude usage limit reached." for repeated identical frames. `account.rate-limits.updated` carries `usageLimitState`.
  - (e) An allowed event clears the window, so a later `api_error` result is not limited.
- **`apps/server/src/provider/Layers/codexUsageLimits.test.ts`** (new):
  - The sparse merge never clears on `null`.
  - The reset rules.
  - `codexErrorInfoCode` handles a string, an object and junk.
  - The tracker sets `usage_limit` on `error` with `resetAt`.
  - A synthesized error is prepended to a failed `turn/completed` when no error came before it.
  - There is no duplicate after an `error`.
  - `rateLimitExceeded` is limited only with an exhausted snapshot.
- **`CodexAdapter.test.ts`**, in addition to §6.1:
  - `account/rateLimits/updated {primary:{usedPercent:100, resetsAt}}` followed by `error {codexErrorInfo:"usageLimitExceeded", willRetry:false}` gives `runtime.error {class:"usage_limit", resetAt}`.
  - A non-limit `error` stays `provider_error`.
- **`apps/server/src/provider/Layers/CopilotAdapter.mapEvent.test.ts`**:
  - `session.error {errorType:"quota", errorCode:"quota_exceeded"}` gives `usage_limit`.
  - `errorType:"rate_limit", errorCode:"rate_limited"` gives `provider_error`.

### 6.5 Server: orchestration

- **`apps/server/src/orchestration/decider.usageLimit.test.ts`** (new):
  - A record creates the limit with `autoResume:null`.
  - A fill only goes from `null` to a value.
  - The same `limitId` without a fill is an invariant.
  - The record is rejected when archived or when another turn is running.
  - Configure requires a matching `limitId`.
  - Any `thread.turn.start` prepends the cleared event.
  - **Guarded resume:**
    - A first guarded turn.start is accepted.
    - A **second guarded turn.start (different commandId, same limitId) is rejected**.
    - **An unguarded user turn.start followed by a guarded one: the guarded one is rejected.**
    - The guard is rejected while the session is `starting` or `running`, and on an instance mismatch.
    - The auto origin appends the `usage-limit.resumed` activity.
  - Archive, revert and `session.set running` for another turn each clear the limit. `session.set running` for the same turn does not.
- **`apps/server/src/orchestration/projector.test.ts`**:
  - set and cleared apply.
  - A cleared event with a non-matching `limitId` is ignored.
- **`apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`** and **`ProjectionSnapshotQuery.test.ts`**:
  - The `usageLimit` round-trip appears in the shell, the detail and `getCommandReadModel`.
  - After a simulated restart, the hydrated command model enforces the guard.
- **`apps/server/src/persistence/Layers/ProjectionThreads.test.ts`**:
  - `usage_limit_json` round-trips.
  - **`listUsageLimitedThreadIds` excludes archived, deleted and cleared threads.**
- **`apps/server/src/persistence/Migrations/074_ProjectionThreadsUsageLimit.test.ts`** (new):
  - The migration adds the column and index.
  - Running it twice is a no-op.
  - **The repair adds the column when `effect_sql_migrations` already records 075 and 074 was skipped.**
- **`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`**:
  - A `usage_limit` runtime.error records exactly one limit, and the duplicate event is deduped.
  - **The record is rejected (thread archived, so an invariant). The session still ends `error` with `lastError` set, and subagent buffers are cleared.**
  - A class `provider_error` records nothing.
  - `account.rate-limits.updated` with `usageLimitState` fills `resetAt` once and ignores another instance.
  - The activity summary is "Usage limit reached".
- **`apps/server/src/orchestration/Layers/UsageLimitRecovery.test.ts`** (new):
  - **Planner (pure):**
    - Toggling the node setting on and off while a limit is pending arms and disarms it. An override wins.
    - Stagger: two limited threads on one instance give one resume per sweep.
    - The snooze command is deterministic.
    - The fill is planned once.
    - A terminal delegated child is skipped.
    - A disabled instance is skipped.
  - **Layer test** with an in-memory engine:
    - **An interleaved user send between plan and dispatch makes the guarded resume rejected.** It is marked attempted and is not retried.
    - A transient dispatch error (cause not invariant) is retried up to 5 times.
    - A defect inside a sweep does not stop the next sweep. Use `it.live` with short intervals, or call `sweep()` directly under TestClock.
    - **End to end through `listUsageLimitedThreadIds`**: archived, deleted and settled threads are never resumed.
- **`apps/server/src/agentControl/settingsControl.test.ts`** (new):
  - Neither `autoResumeLimitedThreads` nor `snoozeLimitedThreads` appears in `agentControlSettingsSummary(...).settings[].kind`.
  - `AgentControlMcpSettingsChangeRequest` cannot decode either key.

### 6.6 Client runtime, web and mobile

- **`packages/client-runtime/src/state/threads/usageLimit.test.ts`** (new):
  - The banner model's action matrix (capability, reset fresh or past, snooze eligibility, dispatch disabled).
  - The status label switches from "Limited" to "Limit reset".
- **`packages/client-runtime/src/state/composer/sendEngine.test.ts`**:
  - The `commandId` override and the guard pass through.
  - The Claude review still runs, and a cancel prevents dispatch.
- **`packages/client-runtime/src/state/composer/usageLimitResume.test.ts`** (new):
  - The thread's model selection is used, not the composer's.
  - The ids are deterministic and the guard origin is `manual`.
- **`packages/client-runtime/src/state/threads/threadInbox.test.ts`**: `deriveThreadSnoozeEligibility` is blocked by a local queue.
- **`packages/client-runtime/src/state/threads/store.test.ts`**: a shell upsert that changes only `usageLimit` updates the summary, so the equality check sees it.
- **Cross-package hold test**, in queue-hold-drain's predicate test file:
  - Limited, with queued messages: held.
  - Worker resume, so `latestTurn` advances and the turn is running: still held, because the thread is busy.
  - The resumed turn completes: drains.
  - Also: unarmed, and the reset + 2 min passes: drains.
- **`apps/web/src/components/inboxSidebar/inboxSidebarModel.test.ts`**:
  - The limited state, its section and its priority relative to error and working.
  - An instance mismatch falls back to "Error".
  - The label after the reset.
- **`apps/web/src/components/inboxSidebar/inboxRowPresentation.test.ts`**: glyph, state line and hint for `limited`.
- **`apps/web/src/components/Sidebar.logic.test.ts`**: the "Limited" pill.
- **`apps/web/src/components/settings/settingsRestore.test.ts`**: the new labels restore to `false`.
- **`apps/mobile/src/state/use-thread-outbox-drain.test.ts`**:
  - **`readThreadDeliveryState` reports held while limited.**
  - It reports not held after the reset + 2 min.
  - The release-time computation schedules the wake.
- **`apps/mobile/src/features/inbox/inboxModel.test.ts`**: the "Limited" label comes before "Error".

**Proportional validation for this L, cross-package change:** run the focused files above, then `bun typecheck`, which is required because of the contract union growth and the exhaustive switches. Then run `bun run test` for `@ryco/contracts`, `@ryco/shared`, `@ryco/client-runtime`, `ryco-cli` (server) and `@ryco/web`, plus `bun lint` and `bun run fmt:check`. A full `bun run build` is not required unless typecheck shows bundling issues.

---

## 7. Out of scope

- **Mobile banner and actions** (Resume now / Resume at reset / Snooze). The shared `deriveUsageLimitBanner` and `buildUsageLimitResumeDispatch` are ready. This is a separate mobile UI change, kept out because mobile has no component tests.
- **Web phone tier.** It is frozen. The banner and settings section are gated off it.
- **OpenCode, Cursor/ACP and Grok** usage-limit mapping. Their only signal is an ambiguous HTTP 429.
- **A server-owned queue**, and resuming with the queued head instead of "continue".
- **Changing the `CompletionReturnDelivery` behaviour** for limited parents and children. That belongs to `delegation-returns` (§5.2).
- **A "limited" OS notification kind.** It stays "failed".
- **Usage-limited as a settlement blocker.** Agent Control read tools exposing `usageLimit`.
- **Claude `api_retry` 429 handling, and other `is_error` success results** that are not limits. These belong to `turn-finalization` if anywhere.
- **Parsing reset times out of provider error text.**
- **Relaxing Claude "compact" review for `error` sessions.**
