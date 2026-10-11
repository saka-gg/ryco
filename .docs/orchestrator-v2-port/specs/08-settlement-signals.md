# 08 · settlement-signals: PR close vs later activity, unknown PR state, pins and background work (bug 11)

| Field            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| id               | `settlement-signals`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| title            | A merged or closed PR settles a thread only if it closed at or after the user's last activity. An unknown PR state, a local pin, and live background agent work block automatic settlement. PR state changes stream to connected clients                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| wave             | 1 (parallel, isolated worktree). Two commits: **Phase A** (client-side classifier and the stream fix) is safe to ship on its own. **Phase B** adds the PR close time end to end                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| verdict          | **confirmed**. All five claims hold. One more defect was found: `worktree.sourceControlStateUpdated` never reaches connected clients (§1.6). Claims (3) and (5) are real, but the fix stays client-side by design (§3.4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| size             | **L**. Phase A is M. Phase B is M; most of it is plumbing through 4 forges and the persistence layer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| touched files    | **Phase A:** `packages/shared/src/threadSettlement.ts` · `packages/contracts/src/worktree.ts` · `packages/client-runtime/src/state/threads/types.ts` · `packages/client-runtime/src/state/threads/store.ts` · `packages/client-runtime/src/state/threads/threadInbox.ts` · `apps/server/src/orchestration/threadSettlementInput.ts` · `apps/server/src/ws/context/orchestrationStreams.ts` · tests: `packages/shared/src/threadSettlement.test.ts`, `packages/client-runtime/src/state/threads/threadInbox.test.ts`, `packages/client-runtime/src/state/threads/store.test.ts`, `apps/server/src/ws/context/orchestrationStreams.test.ts`. **Phase B:** `packages/contracts/src/orchestration.ts` · `apps/server/src/orchestration/pullRequestTerminalAt.ts` (new) · `apps/server/src/orchestration/decider.ts` · `apps/server/src/orchestration/projector.ts` · `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` · `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` · `apps/server/src/persistence/Layers/ProjectionWorktrees.ts` · `apps/server/src/persistence/Migrations.ts` · `apps/server/src/sourceControl/SourceControlProvider.ts` · `apps/server/src/sourceControl/refreshWorktreeSourceControlState.ts` · GitHub: `apps/server/src/sourceControl/GitHubCli.ts`, `gitHubPullRequests.ts`, `GitHubSourceControlProvider.ts` · Forgejo: `ForgejoSourceControlProvider.ts` · GitLab: `gitLabMergeRequests.ts`, `GitLabCli.ts`, `GitLabSourceControlProvider.ts` · Azure: `azureDevOpsPullRequests.ts`, `AzureDevOpsSourceControlProvider.ts` · tests: `apps/server/src/orchestration/pullRequestTerminalAt.test.ts` (new), `apps/server/src/persistence/Migrations/WorktreePrTerminalAtRepair.test.ts` (new), `refreshWorktreeSourceControlState.test.ts`, `ProjectionWorktrees.test.ts`, `ProjectionPipeline.worktrees.test.ts`, `projector.test.ts`, `ProjectionSnapshotQuery.test.ts`, `decider.settlement.test.ts`, and the provider tests for GitHub, Forgejo, GitLab, Azure and Bitbucket |
| migrations       | **No numbered migration.** A new startup repair, `repairProjectionWorktreePrTerminalAtColumn` in `Migrations.ts`, is guarded by PRAGMA and runs once. It adds `projection_worktrees.pr_terminal_at TEXT` and backfills merged and closed rows from `updated_at` in the same transaction. The pre-assigned **075 is not used** (§2, row 2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| contract changes | `Worktree.prTerminalAt` (`Schema.optional(Schema.NullOr(IsoDateTime))`, no decoding default; an absent field means the server predates it). `WorktreeSourceControlStateUpdatedPayload.prTerminalAt` and `WorktreeSourceControlStateUpdateCommand.prTerminalAt` are optional and use the same schema. Non-contract shared types: `ThreadSettlementInput` gains `pinned`, `backgroundLiveness`, `prNumber` and `prTerminalAt`; new `ThreadAutoSettlementBlocker` and `getThreadAutoSettlementBlocker`. `SidebarWorktreeSummary.prTerminalAt?` and `ThreadInboxLifecycle.autoSettlementBlocker`. Server-internal: `SourceControlProviderShape.getPullRequestState` gains an optional `terminalAt` in its result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| overlaps         | `delegation-guard-restart` (W1): `projector.ts`, different cases (`thread.message-sent` vs `worktree.*`), and `ProjectionSnapshotQuery.ts`, where `getCommandReadModel` is next to `listWorktreeRows`. `acp-message-ids` (W1): `projector.ts` `thread.message-sent`, a different case. `queue-hold-drain` (W1): possibly `threadInbox.ts` `settlementInput`/`buildThreadInbox` and `threadSettlement.ts` `canSettleThread`. `turn-finalization` (W1): semantic only. `usage-limits` (W2): `threadSettlement.ts` blockers. `delegation-lineage` (W2): `threadInbox.ts` `buildThreadInbox`. `rollback-correctness` (W2): `projector.ts`, a different case. `restart-continuation` (W3): semantic, `ThreadBackgroundLiveness`. Details in §10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

---

## 1. Problem (verified against the code)

1. **A merged or closed PR settles the thread even when the user kept working after the merge.**
   `packages/shared/src/threadSettlement.ts:176-184` (`getEffectiveSettlementTimestamp`) and `:202-207`
   (`classifyThreadSettlement`) settle any `prState` of `merged` or `closed`. Nothing records when the PR closed.
   `Worktree` has only `prState` and `prIsDraft` (`packages/contracts/src/worktree.ts:35-40`). `getPullRequestState`
   returns `{ state, isDraft }` (`apps/server/src/sourceControl/SourceControlProvider.ts:332-339`).
   The baseline test `threadSettlement.test.ts:159-163` asserts this behaviour.

   **The "Move to Active" bounce.** Moving the thread to Active sets `settledOverride: "active"`. The next user turn emits
   `thread.unsettled` with reason `activity` (`decider.ts:127-152`, used at `:1199`). The projector maps that to
   `settledOverride: null` (`projector.ts:553-560`). The merged-PR rule then settles the thread again immediately.

2. **An unknown PR state does not block.** `canUseInactivitySettlement` (`threadSettlement.ts:148-150`) treats
   `prState === null` as "no PR". A worktree is created with `prState: null` even when `prNumber` is set (`projector.ts:388`,
   `ProjectionPipeline.ts:1226`). That covers a `pr`-origin worktree before its first refresh, and any worktree whose refresh
   fails. Such a thread falls through to the inactivity rule.
3. **Pins don't block.** Pins live in the web `uiStateStore` (`apps/web/src/uiStateStore.ts:88`, `threadPinning.ts`).
   `buildThreadInbox` uses them only for sorting and the `pinned` flag (`threadInbox.ts:291,389,456`). `settlementInput`
   (`:186-220`) ignores them. On web a pinned row is drawn in the Pinned section but is still classified as settled
   (`inboxSidebarModel.ts:452-455`). Mobile has no pins: no caller passes `pinnedThreadKeys` to `apps/mobile/src/features/inbox/inboxModel.ts:214`.
4. **Background work doesn't block.** `ThreadSettlementInput` has no liveness field, and `settlementInput()` ignores
   `thread.backgroundLiveness` (`types.ts:251`). A thread whose turn ended while its subagents or workflows still run is auto-settled.
5. **The threshold is per device.** `sidebarAutoSettleAfterDays` is a _client_ setting (`packages/contracts/src/settings.ts:116`).
   It is stored in local storage on web (`hostedInboxPreferences.ts` for hosted) and in `apps/mobile/src/state/preferencesStore.ts:38`.
   The server's input passes `autoSettleAfterDays: null` (`apps/server/src/orchestration/threadSettlementInput.ts:33`).
   The server never auto-settles: AI Focus filters only the explicit `settled_override` (`ThreadPriorityCandidateQuery.ts:79`).
   So the impact is confined to how each device presents threads.
6. **New defect: PR state never reaches connected clients.** `toShellStreamEvent`
   (`apps/server/src/ws/context/orchestrationStreams.ts:222-292`) maps only `worktree.created`, `.archived`, `.metaUpdated` and
   `.restored` to `worktree-upserted` (`:254-257`). Its `default` case drops every event that is not a thread event (`:281-283`).
   The thread-detail stream forwards thread events only (`:577-580`). So the client reducer at
   `packages/client-runtime/src/state/threads/store.ts:2644` never runs for live clients. PR state, including the
   PR link from `gitRpc.ts:119-133`, arrives only with a full shell snapshot. That happens on a fresh subscribe, a non-resumable
   reconnect, or the AI-Focus priority snapshot (`:524-530`). A resumed reconnect replays through the same mapper and drops them again.
   Every fix above that depends on PR data needs this fixed first. Without it, fix (2) would leave every new PR worktree stuck as
   "unknown" until the next resnapshot.

Baselines: `threadSettlement.test.ts` is 28/28 green and `threadInbox.test.ts` is 17/17 green (run 2026-10-04).

---

## 2. Review resolution

| #   | Severity | Critique                                                                                                                                                                                                                     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | blocker  | `worktree.sourceControlStateUpdated` is dropped by `toShellStreamEvent`, so the client reducer is dead code and fix (2) would regress                                                                                        | **Accepted.** Verified at `orchestrationStreams.ts:254-257,281-283,577-580`. Phase A step A6 adds the case to the `worktree-upserted` group. The SQL row stays the source of truth through `getWorktreeShellById`. The mapper is extracted to a top-level export so it can be tested. Server and client tests are added (§6)                                                                                                                                                                                                                                                                          |
| 2   | major    | Pre-assigned 075 would land before 071–074. The Effect migrator skips ids at or below the latest applied one (`effect/dist/unstable/sql/Migrator.js:118-124`, verified), so 071–074 would be silently skipped on dogfood DBs | **Accepted, option (b).** No numbered migration. A PRAGMA-guarded startup repair follows `repairProjectionWorktreeTitleColumn` (`Migrations.ts:188-209`). It adds the column and backfills **only when it just added the column**, in one transaction. 075 is not consumed. **Program note for the integrator:** 071–074 still have the same hazard among themselves. They must land in ascending order, or use repairs as well                                                                                                                                                                       |
| 3   | major    | A background-work blocker can block forever. The reaper skips sessions with liveness (`ProviderSessionReaper.ts:91-100`). `MONITOR_TASK_TYPES` includes background shells                                                    | **Accepted.** Only `"working"` (live agent work) blocks. `"monitoring"` (watch loops and background shells such as dev servers, log tails and PR babysitters) never blocks. The edge case is corrected: `"working"` blocks for exactly as long as the row shows the _Working_ pill. That ends at task completion, `session.exited` (`ProviderRuntimeIngestion.ts:3052-3053`) or a server restart. A lost `task.completed` is a liveness bug and out of scope. No staleness cap: a cap at the inactivity boundary would cancel the blocker for exactly the case it exists for. Tests cover both values |
| 4   | minor    | The bounce is fixed only on the user-message path. `thread.session.set` (`decider.ts:1751-1776`) and request paths (`:2012`) also clear an `active` override without advancing the anchor                                    | **Accepted as documented residual behaviour (§8).** Clearing `active` on activity is deliberate. It lets a moved-to-Active thread auto-settle later. t3 behaves the same. No projector change                                                                                                                                                                                                                                                                                                                                                                                                         |
| 5   | minor    | Bitbucket rule contradicts the backfill                                                                                                                                                                                      | **Accepted, one rule.** `prTerminalAt` is the forge-reported close time when one is available. Otherwise it is the time Ryco first recorded that terminal state, which is an upper bound. The live fallback uses the refresh's `updatedAt` and the backfill uses `updated_at`; both are upper bounds. Bitbucket reports no time, so it uses the fallback. A Bitbucket provider test pins this down. `updated_on` is rejected because it moves on every later comment                                                                                                                                  |
| 6   | minor    | Test plan misses the read-model paths, the inbox timer, and the risk that binding `undefined` writes NULL                                                                                                                    | **Accepted.** Adds `ProjectionSnapshotQuery.test.ts` coverage (command read model, shell snapshot, `getWorktreeShellById`), a threadInbox timer test, `${row.prTerminalAt ?? null}` binding, and an `upsert({...existing})` round-trip test                                                                                                                                                                                                                                                                                                                                                           |
| 7   | minor    | Overlap list incomplete                                                                                                                                                                                                      | **Accepted.** §10 lists the `projector.ts` cases, the `getCommandReadModel`/`listWorktreeRows` adjacency and `orchestrationStreams.ts`. No other W1 brief names `toShellStreamEvent`; check again at merge                                                                                                                                                                                                                                                                                                                                                                                            |
| 8   | minor    | Upgrade effects: a one-time dispatch burst, invalidated undo receipts, and legacy threads moving back to Active                                                                                                              | **Accepted into Risks (§9).** The burst is accepted. Dispatch happens only when the resolved value differs, so it happens once per legacy terminal row and only on the forges that report a time                                                                                                                                                                                                                                                                                                                                                                                                      |
| 9   | minor    | Main worktree (`worktreePath: null`) PRs are never refreshed (`refreshWorktreeSourceControlState.ts:19`)                                                                                                                     | **Accepted as out of scope (§11).** This is pre-existing: an `open` link on main already blocks auto-settlement today. The follow-up is to fall back to the project `workspaceRoot`                                                                                                                                                                                                                                                                                                                                                                                                                   |

---

## 3. Approach

### 3.1 The automatic-settlement rule (mirrors t3 `ThreadSettlementService.ts:84-200`)

_Manual_ settle eligibility (`canSettleThread`, `ThreadSettlementBlocker`) is **unchanged**. That keeps the decider
(`decider.ts:77`, `:654`), `sidebarUndo`, snooze and the two UI `switch`es on `settlementBlocker` untouched. The new signals
gate only **automatic** settlement, through a separate `ThreadAutoSettlementBlocker`:

| Order | Condition                                                                                                                                 | Result                                                        |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 0     | excluded / `canSettleThread` blocked / explicit `settled` / explicit `active`                                                             | as today                                                      |
| 1     | `pinned`                                                                                                                                  | blocked: `"pinned"`                                           |
| 2     | `backgroundLiveness === "working"`                                                                                                        | blocked: `"background-work"`                                  |
| 3     | `prState === "open"`                                                                                                                      | blocked: `"pull-request-open"` (today's behaviour, now named) |
| 4     | `prState === null && prNumber !== null`                                                                                                   | blocked: `"pull-request-unknown"` (new, claim 2)              |
| 5     | `prState` merged/closed **and** `prTerminalAt === undefined` (server predates the field)                                                  | **legacy rule, unchanged**: settles with today's timestamp    |
| 6     | `prState` merged/closed **and** `prTerminalAt` valid **and** `prTerminalAt >= max(createdAt, latestUserMessageAt, latestTurnRequestedAt)` | settles at `newest(prTerminalAt, lastActivity)`               |
| 7     | otherwise (no PR, an issue-only worktree, or a terminal PR that closed before the user's last activity or has an unknown close time)      | inactivity rule (existing boundary)                           |

Row 6 is t3's `pullRequestSettles`. Row 7 is t3's fall-through to `autoSettleAfterDays`. After a "Move to Active"
followed by a new message, row 6 is false and row 7 applies, so the bounce is gone on the user-message path.

### 3.2 `prTerminalAt` semantics (one rule)

> When the PR reached its **current** merged/closed state: the forge-reported `mergedAt`/`closedAt` when available, else
> the time Ryco **first recorded** that terminal state (an upper bound on the true close time). `null` while the PR is open,
> unknown or absent. The field is **absent** on servers that predate it.

An upper bound leans toward settling. That is strictly better than today: wrong only between the real merge and Ryco's first
observation, and only on forges that report no time. Today it is always wrong. The resolver
(`apps/server/src/orchestration/pullRequestTerminalAt.ts`) is the only place this rule lives. The refresh helper, the
in-memory projector and the SQL pipeline all use it; the pipeline also uses it for legacy events that lack the field.

### 3.3 Mixed versions

- **New client, old server.** The key is absent, so the client applies row 5 (unchanged behaviour). Rows 1–4 still apply.
- **Old client, new server.** The old client's Struct decoding ignores the extra key, so its behaviour is unchanged.
- **Mobile cached snapshots** (`environmentSnapshotCodec.ts`) carry no key and fall back to legacy until the next live snapshot.
- **Phase A alone.** The server does not emit the key yet, so every client stays on row 5. That is why Phase A can ship alone.
  Phase B step B6 is the first place the server emits `prTerminalAt` (explicit `null` or a time).

### 3.4 Pins and the threshold stay client-side (recommendation: defer server state)

- **Pins (claim 3).** Implemented as a client-local auto-settle blocker. `buildThreadInbox` already receives
  `pinnedThreadKeys`, so this costs one field. Server-side pins would need a thread contract field, `thread.pin`/`thread.unpin`
  commands and events, decider/projector/pipeline work, a column, shell mapping, a migration of existing web pins across devices
  with conflict resolution, new mobile pin UI, and moving pin undo from the web `sidebarUndo` to server receipts. That is size L,
  for a feature only web has. **Defer.**
- **Threshold (claim 5).** Client-side settlement is a derived _view_, and nothing persists it. Devices disagree only on
  presentation, and AI Focus already ignores derived settlement. Making the threshold authoritative means a t3-style server
  sweep that writes `settled_override`, with settings, per-project overrides and undo semantics. **Defer** together with server pins as
  "server-authoritative settlement".

### 3.5 Background work

`"working"` blocks and `"monitoring"` does not (§2 row 3). The server's `threadSettlementInput` passes `null`. It serves only
manual settle and snooze eligibility, the read model has no liveness, and manual settle stays allowed.

---

## 4. Step-by-step changes

### Phase A (commit 1): classifier, inbox, client mapping, stream fix

**A1. `packages/shared/src/threadSettlement.ts`**

- Add to `ThreadSettlementInput`:
  ```ts
  /** Client-local pin. Servers and pin-less clients pass false. */
  readonly pinned: boolean;
  /** Shell background liveness. Only "working" blocks automatic settlement. */
  readonly backgroundLiveness: "working" | "monitoring" | null;
  readonly prNumber: number | null;
  /** See spec §3.2. `undefined` = server predates the field (legacy rule). */
  readonly prTerminalAt: string | null | undefined;
  ```
- Add the exported type and function:
  ```ts
  export type ThreadAutoSettlementBlocker =
    | "pinned"
    | "background-work"
    | "pull-request-open"
    | "pull-request-unknown";

  export function getThreadAutoSettlementBlocker(
    input: ThreadSettlementInput,
  ): ThreadAutoSettlementBlocker | null {
    if (input.pinned) return "pinned";
    if (input.backgroundLiveness === "working") return "background-work";
    if (input.prState === "open") return "pull-request-open";
    if (input.prState === null && input.prNumber !== null) return "pull-request-unknown";
    return null;
  }
  ```
- Add private helpers:
  ```ts
  function pullRequestUserAnchorMs(input: ThreadSettlementInput): number | null {
    return timestampMs(
      newestValidTimestamp([
        input.createdAt,
        input.latestUserMessageAt,
        input.latestTurnRequestedAt,
      ]),
    );
  }

  /** Settlement timestamp contributed by a merged/closed PR, or null when it is not a signal. */
  function pullRequestSettlementTimestamp(input: ThreadSettlementInput): string | null {
    if (input.prState !== "merged" && input.prState !== "closed") return null;
    if (input.prTerminalAt === undefined) {
      // Server predates prTerminalAt: keep the pre-existing rule byte-for-byte.
      return newestValidTimestamp([
        input.worktreeUpdatedAt,
        input.latestTurnCompletedAt,
        input.latestUserMessageAt,
        input.updatedAt,
        input.createdAt,
      ]);
    }
    const terminalMs = timestampMs(input.prTerminalAt);
    const anchorMs = pullRequestUserAnchorMs(input);
    if (terminalMs === null || anchorMs === null || terminalMs < anchorMs) return null;
    return newestValidTimestamp([input.prTerminalAt, getThreadLastActivityTimestamp(input)]);
  }
  ```
- **Delete** `canUseInactivitySettlement`.
- Rewrite `getEffectiveSettlementTimestamp`:
  ```ts
  if (input.settledOverride === "settled")
    return timestampMs(input.settledAt) === null ? null : input.settledAt;
  if (input.settledOverride !== null) return null;
  if (!canSettleThread(input).canSettle || getThreadAutoSettlementBlocker(input) !== null)
    return null;
  const pullRequestAt = pullRequestSettlementTimestamp(input);
  if (pullRequestAt !== null) return pullRequestAt;
  const boundaryMs = autoSettleBoundaryMs(input);
  if (boundaryMs === null || !Number.isFinite(input.nowMs) || input.nowMs < boundaryMs) return null;
  return new Date(boundaryMs).toISOString();
  ```
  This is a behaviour change: a merged-PR thread blocked by `canSettleThread` now returns `null` instead of a timestamp. Classification already
  gated it. The mobile row time (`inboxModel.ts:258`) then falls back to the thread timestamp, which is more accurate.
- Simplify `classifyThreadSettlement`. Keep the excluded, `canSettleThread`, explicit `settled` and explicit `active`
  branches, then `return getEffectiveSettlementTimestamp(input) === null ? "active" : "settled";`. Delete the separate PR branch.
- Rewrite `getNextThreadSettlementEvaluationAtMs`:
  ```ts
  if (input.settledOverride !== null || !Number.isFinite(input.nowMs)) return null;
  if (getThreadAutoSettlementBlocker(input) !== null) return null; // re-evaluated when that data changes
  const eligibility = canSettleThread(input);
  if (!eligibility.canSettle && eligibility.blocker !== "queued-turn") return null;
  const pullRequestSettles = pullRequestSettlementTimestamp(input) !== null;
  const autoSettleAtMs = pullRequestSettles ? null : autoSettleBoundaryMs(input);
  if (!pullRequestSettles && autoSettleAtMs === null) return null;
  // candidates: future autoSettleAtMs; queued-turn grace end (unchanged logic)
  ```
  A merged PR that closed before later activity now schedules the inactivity boundary. Today it returns `null` for any
  non-null `prState`.

**A2. `packages/contracts/src/worktree.ts`**: add to `Worktree`, after `issueState`:

```ts
/** When the PR reached its current merged/closed state (forge time, else first observation). Absent on older servers. */
prTerminalAt: Schema.optional(Schema.NullOr(IsoDateTime)),
```

Do **not** add a decoding default; absence is meaningful (§3.3). It is schema-only and has no runtime logic.

**A3. `packages/client-runtime/src/state/threads/types.ts`**: add `prTerminalAt?: string | null | undefined;` to
`SidebarWorktreeSummary` (`:258-283`), with a mixed-version doc comment.

**A4. `packages/client-runtime/src/state/threads/store.ts`**

- `mapWorktree` (`:296-326`): add `...(worktree.prTerminalAt !== undefined ? { prTerminalAt: worktree.prTerminalAt } : {})`.
  This keeps absent distinct from `null`.
- `sidebarWorktreesEqual` (`:635-664`): add `left.prTerminalAt === right.prTerminalAt`.
- The domain reducer case `worktree.sourceControlStateUpdated` (`:2644-2657`) is not on the live path; keep it for defence
  in depth. Its edit lands in Phase B (step B12), because the payload field only exists after B1.

**A5. `packages/client-runtime/src/state/threads/threadInbox.ts`**

- Change `settlementInput` (`:186-220`) to take `pinned: boolean` and add these fields:
  ```ts
  pinned: input.pinned,
  backgroundLiveness: input.thread.backgroundLiveness ?? null,
  prNumber: input.worktree?.prNumber ?? null,
  prTerminalAt: input.worktree === null ? null : input.worktree.prTerminalAt,
  ```
- In the `buildThreadInbox` loop (`:327-400`), compute `const pinned = pinnedKeys.has(key);` once. Pass it to `settlementInput` and
  reuse it for `entry.pinned`.
- Add `readonly autoSettlementBlocker: ThreadAutoSettlementBlocker | null;` to `ThreadInboxLifecycle`. Fill it with
  `getThreadAutoSettlementBlocker(policyInput)` for server threads and `null` for drafts (`:433-438`). This change exposes the
  value only; no UI uses it yet.

**A6. `apps/server/src/ws/context/orchestrationStreams.ts`**

- Move the `toShellStreamEvent` closure (`:222-292`) to a top-level export:
  ```ts
  export const toShellStreamEvent = (
    query: Pick<
      ProjectionSnapshotQueryShape,
      "getProjectShellById" | "getThreadShellById" | "getWorktreeShellById"
    >,
    event: OrchestrationEvent,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>> => {
    /* same switch */
  };
  ```
  Then, inside `makeOrchestrationStreamHelpers`, use `Stream.mapEffect((event) => toShellStreamEvent(projectionSnapshotQuery, event))` (`:398`).
- Add `case "worktree.sourceControlStateUpdated":` to the `worktree-upserted` group (`:254-257`). The upsert reads
  the SQL row through `getWorktreeShellById`, so the row stays the source of truth. A replay of an old event sends the current
  row, and `dedupeBySequence` still applies.

**A7. `apps/server/src/orchestration/threadSettlementInput.ts`**: add
`pinned: false`, `backgroundLiveness: null`, `prNumber: worktree?.prNumber ?? null`, `prTerminalAt: worktree?.prTerminalAt ?? null`.
Add a comment that server-side checks are manual settle and snooze eligibility only, and that pins and liveness never gate those.
`sidebarUndo.ts` needs no change, because it still calls `canSettleThread` only.

### Phase B (commit 2): PR close time end to end

**B1. `packages/contracts/src/orchestration.ts`**: add `prTerminalAt: Schema.optional(Schema.NullOr(IsoDateTime))` to
`WorktreeSourceControlStateUpdateCommand` (`:1582-1592`) and to `WorktreeSourceControlStateUpdatedPayload` (`:2265-2273`).
The command is in the client-dispatchable union too (`:1675`, `:1716`), so it has the same trust level as `prState`. That is
owner-only and adds no new authority.

**B2. New `apps/server/src/orchestration/pullRequestTerminalAt.ts`** (pure, no Effect):

```ts
export function resolvePullRequestTerminalAt(input: {
  readonly previousState: PullRequestState | null;
  readonly previousTerminalAt: string | null;
  readonly nextState: PullRequestState | null;
  readonly reportedTerminalAt: string | null; // forge mergedAt/closedAt, ISO
  readonly observedAt: string; // when this state is being recorded
}): string | null {
  if (input.nextState !== "merged" && input.nextState !== "closed") return null;
  if (isValidIso(input.reportedTerminalAt)) return input.reportedTerminalAt; // forge truth; corrects fallback/backfill
  if (input.previousState === input.nextState && isValidIso(input.previousTerminalAt)) {
    return input.previousTerminalAt; // keep the first observation
  }
  return input.observedAt; // upper bound: first time Ryco recorded this terminal state
}
```

`isValidIso` means non-empty and `Number.isFinite(Date.parse(value))`.

**B3. `apps/server/src/orchestration/decider.ts`** (`:1528-1547`, case `worktree.source-control-state.update`): add
`...(command.prTerminalAt !== undefined ? { prTerminalAt: command.prTerminalAt } : {})` to the payload. Nothing else changes.

**B4. `apps/server/src/orchestration/projector.ts`**

- `worktree.created` (`:361-410`): set `prTerminalAt: null` explicitly next to `prState: null`.
- `worktree.sourceControlStateUpdated` (`:435-452`): look up `existing` in `nextBase.worktrees`. Then set:
  ```ts
  prTerminalAt: payload.prTerminalAt !== undefined
    ? payload.prTerminalAt
    : resolvePullRequestTerminalAt({
        previousState: existing?.prState ?? null,
        previousTerminalAt: existing?.prTerminalAt ?? null,
        nextState: payload.prState, reportedTerminalAt: null, observedAt: payload.updatedAt,
      }),
  ```

**B5. `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`**: `worktree.created` (`:1213-1239`) sets `prTerminalAt: null`.
`worktree.sourceControlStateUpdated` (`:1264-1280`) uses the same expression as B4, with `existing.value`. Legacy events
replayed during catch-up or a rebuild derive their value through the resolver.

**B6. `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`**: add `pr_terminal_at AS "prTerminalAt"` to the
SELECTs in `listWorktreeRows` (`:636-668`) and `getWorktreeRowById` (`:670-702`). In `toWorktreeShell` (`:122-129`), set
`prTerminalAt: row.prTerminalAt ?? null` **explicitly**, so the new server always emits the key. Every snapshot path,
`getCommandReadModel` (`:2160`), the shell snapshots (`:1844`, `:2458`) and `getWorktreeShellById` (`:2883-2894`), goes
through these two queries and this mapper. Do not edit the `getCommandReadModel` `Effect.all` tuple.

**B7. `apps/server/src/persistence/Layers/ProjectionWorktrees.ts`**: in `upsertProjectionWorktreeRow` (`:58-135`), add
`pr_terminal_at` to the column list, bind `${row.prTerminalAt ?? null}`, and add `pr_terminal_at = excluded.pr_terminal_at` to the
`ON CONFLICT` update. Add `pr_terminal_at AS "prTerminalAt"` to `getProjectionWorktreeRow` (`:138`) and
`listProjectionWorktreeRows` (`:172`). In `toProjectionWorktree`, add `prTerminalAt: row.prTerminalAt ?? null`. Every
`upsert({...existing.value})` caller (`ProjectionPipeline.ts:1254,1269,1292`) reads through `getById`, so it round-trips the value.

**B8. `apps/server/src/persistence/Migrations.ts`**: add the repair and call it from `runMigrations` with
`if (toMigrationInclusive === undefined || toMigrationInclusive >= 37)`. 037 introduced `pr_state`, and
`ProjectionWorktrees.test.ts` runs migrations through 39 before using the repository, so it needs the column. Place the call
after the `>= 35` repair.

```ts
export const repairProjectionWorktreePrTerminalAtColumn = Effect.fn(
  "repairProjectionWorktreePrTerminalAtColumn",
)(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables =
    yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='projection_worktrees'`;
  if (tables.length === 0) return;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const columns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(projection_worktrees)`;
      if (columns.some((column) => column.name === "pr_terminal_at")) return;
      yield* sql`ALTER TABLE projection_worktrees ADD COLUMN pr_terminal_at TEXT`;
      // One-time: updated_at is the last time Ryco wrote the row, an upper bound on when it first
      // recorded the terminal state (spec §3.2). Runs only in the transaction that adds the column.
      yield* sql`UPDATE projection_worktrees SET pr_terminal_at = updated_at WHERE pr_state IN ('merged', 'closed')`;
      yield* Effect.log("Repaired projection_worktrees.pr_terminal_at column");
    }),
  );
});
```

Later numbered migrations into `projection_worktrees` are additive (030, 031, 037–039), so nothing rebuilds the table and drops the column.

**B9. `apps/server/src/sourceControl/SourceControlProvider.ts`** (`:332-339`): change the result type to
`{ readonly state: PullRequestState; readonly isDraft: boolean; readonly terminalAt?: DateTime.Utc | null }` and import
`type DateTime` from `effect`. The field is optional, so the registry pass-through (`SourceControlProviderRegistry.ts:320,576`)
and existing test stubs compile unchanged.

**B10. Forges** (each forge reports `terminalAt` only for `merged`/`closed`, and `null` otherwise):

- **GitHub.** Add `"closedAt"` to `GITHUB_PULL_REQUEST_SUMMARY_JSON_FIELDS` (`GitHubCli.ts:91-96`); `mergedAt` is already a core field. Add
  optional `mergedAt?`/`closedAt?: DateTime.Utc` to `NormalizedGitHubPullRequestRecord` (`gitHubPullRequests.ts:37-60`) and
  `GitHubPullRequestSummary` (`GitHubCli.ts:160-184`). Populate them in `normalizeGitHubPullRequestRecord` (`:340-380`) with
  `optionFromIsoDateTime` (`:252`); the schema already decodes both strings (`:93`, `:96`). In
  `GitHubSourceControlProvider.ts:1029-1036`, set `terminalAt = state === "merged" ? (mergedAt ?? closedAt) : state === "closed" ? closedAt : null`.
  Tests that format the field list from the constant (`GitManager.test.ts:583,634`, `GitHubCli.test.ts:28-31`) update automatically.
- **Forgejo.** `NormalizedForgejoPullRequestRecord` already has `closedAt`/`mergedAt` (`forgejoPullRequests.ts:74-75`). Map them in
  `ForgejoSourceControlProvider.ts:373-384`.
- **GitLab.** Add `merged_at`/`closed_at: Schema.optional(Schema.NullOr(Schema.String))` to `GitLabMergeRequestSchema`
  (`gitLabMergeRequests.ts:88-113`). Parse them with `parseGitLabTimestamp` in `normalizeGitLabMergeRequestRecord` (`:258`) into
  optional `mergedAt`/`closedAt` on the record (`:32`) and `GitLabMergeRequestSummary` (`GitLabCli.ts:48-69`). Map them in
  `GitLabSourceControlProvider.ts:347-355`.
- **Azure DevOps.** Add `...(closedAt ? { closedAt } : {})`, from `Option.getOrUndefined(raw.closedDate)`, to
  `normalizeAzureDevOpsPullRequestRecord` (`azureDevOpsPullRequests.ts:214-245`) and the record interface (`:121`). Map it in
  `AzureDevOpsSourceControlProvider.ts:364-368`. Azure's `closedDate` is the completion time for both outcomes.
- **Bitbucket.** No source change. It reports no `terminalAt`, so the fallback applies (§2 row 5).

**B11. `apps/server/src/sourceControl/refreshWorktreeSourceControlState.ts`**

- Compute `const observedAt = new Date().toISOString();` once and use it for both `updatedAt` and the fallback.
- When `pr !== null`, set `reportedTerminalAt = pr.terminalAt ? DateTime.formatIso(pr.terminalAt) : null`.
- `const nextPrTerminalAt = resolvePullRequestTerminalAt({ previousState: existing.prState ?? null, previousTerminalAt: existing.prTerminalAt ?? null, nextState: nextPrState, reportedTerminalAt, observedAt })`.
- Add `nextPrTerminalAt !== (existing.prTerminalAt ?? null)` to `changed`. Pass `prTerminalAt: nextPrTerminalAt` and
  `updatedAt: observedAt` in the dispatched command.
- `gitRpc.ts` (PR link with `prState: "open"`) stays untouched: the projector and pipeline derive `null` for an open state.

**B12. `packages/client-runtime/src/state/threads/store.ts`** (domain reducer `:2644-2657`): add
`...(event.payload.prTerminalAt !== undefined ? { prTerminalAt: event.payload.prTerminalAt } : {})`. If the field is
absent, the stored value is left alone. Live clients never reach this path; worktree state arrives through `worktree-upserted` (A6).

---

## 5. Contract and migration changes

- `packages/contracts`: three optional schema fields (§ header). They are backward and forward compatible: old decoders drop the
  key, and new decoders treat it as absent, which selects the legacy rule. There is no runtime logic in contracts.
- `packages/shared`: `ThreadSettlementInput` gains 4 required fields. There are exactly three constructors:
  `threadInbox.ts`, server `threadSettlementInput.ts`, and the `input()` helper in `threadSettlement.test.ts`.
  `ThreadSettlementBlocker` is **unchanged**, so `decider.ts:77`, `inboxSidebarModel.ts:357` and
  `threadHeaderModel.ts:77` compile untouched. There is no new shared subpath and no `packages/shared/package.json` change.
- SQLite: the repair from B8 runs instead of a numbered migration, and 075 is unused. On downgrade, an older binary ignores the column.
  It writes `NULL` into new rows, and its `ON CONFLICT` leaves the stored value alone. When the new binary runs again, the resolver
  corrects stale values on the next refresh (§8).

---

## 6. Tests (failing first where a bug)

**`packages/shared/src/threadSettlement.test.ts`.** Extend `input()` with `pinned: false, backgroundLiveness: null, prNumber: null, prTerminalAt: null`.

- _Rewrite_ `:159-163`, which asserts the bug, to "a merged/closed PR settles only when it closed at or after the user's last activity":
  - `prState: "merged"`, `prTerminalAt` = 11:00 (after the 10:00 message): `settled`, and the effective timestamp is 11:00.
  - `prTerminalAt` = 09:59:30 (before the 10:00 message): `active` with `autoSettleAfterDays: null`. With 7 days and `nowMs` past
    the boundary it is `settled` at the boundary timestamp.
  - The same two cases for `closed`.
- "Move to Active then a new message does not bounce back": `settledOverride: null`, `prTerminalAt` before `latestUserMessageAt`, gives `active`.
- "user anchor includes latestTurnRequestedAt and createdAt": a thread created after `prTerminalAt` stays `active`. A turn
  requested after `prTerminalAt` with no new message stays `active`.
- "legacy servers keep the pre-existing merged rule": `prTerminalAt: undefined` gives `settled` with today's timestamp. Migrate
  `:217-232` and the merged half of `:245-264` to `prTerminalAt: undefined`, so they keep pinning the legacy rule.
- "an invalid prTerminalAt falls back to inactivity".
- "an unknown PR blocks auto-settlement but not manual settlement": `prNumber: 12, prState: null`, 7 days, past the
  boundary. Expect `active`, `getThreadAutoSettlementBlocker` = `"pull-request-unknown"`,
  `getNextThreadSettlementEvaluationAtMs` = `null`, and `canSettleThread(...).canSettle === true`. Issue-only (`prNumber: null`) still settles.
- "pins block automatic settlement only": a pinned thread that is merged-after-activity, or past the inactivity boundary, is `active`.
  A pinned thread with `settledOverride: "settled"` is `settled`.
- "live agent work blocks, watch loops do not": `"working"` past the boundary is `active` with blocker
  `"background-work"`. `"monitoring"` is `settled`. `canSettleThread` is unaffected in both cases.
- `getNextThreadSettlementEvaluationAtMs`: a merged PR closed before later activity returns the inactivity boundary. A merged PR
  that settles while a queued turn is in grace returns the grace end. Pinned, working and unknown each return `null`.

**`packages/client-runtime/src/state/threads/threadInbox.test.ts`.** A pinned key gives an `active` entry with
`autoSettlementBlocker: "pinned"`. `backgroundLiveness: "working"` stays active and `"monitoring"` settles. A worktree with
`prNumber` and `prState: null` gives `"pull-request-unknown"`. A merged worktree with `prTerminalAt` before
`latestUserMessageAt` is active, and `nextSettlementEvaluationAtMs` equals the inactivity boundary (critique row 6). A merged worktree
**without** the key settles (legacy).

**`packages/client-runtime/src/state/threads/store.test.ts`.** `applyShellEvent` with `worktree-upserted` maps `prTerminalAt`.
An absent key stays absent, not `null`. An upsert that changes only `prTerminalAt` produces a new worktree object
(`sidebarWorktreesEqual`). In Phase B, `applyOrchestrationEvent(worktree.sourceControlStateUpdated)` carries it.

**`apps/server/src/ws/context/orchestrationStreams.test.ts`.** Call `toShellStreamEvent(stubQuery, event)` with a
`worktree.sourceControlStateUpdated` event. The stub returns a row with `prState: "merged"` and `prTerminalAt`. Expect
`Option.some({ kind: "worktree-upserted", sequence, worktree })` carrying both fields. That test fails before A6. Also cover:
`getWorktreeShellById` returns `none`, giving `Option.none()`. A non-thread, non-mapped event, giving `Option.none()`.

**`apps/server/src/orchestration/pullRequestTerminalAt.test.ts`** (new): open or null gives `null`. A reported time wins over a stored one.
The same terminal state keeps the stored time. A state change takes `observedAt`. A stored terminal state with a `null` time takes
`observedAt`. A transition from closed to open gives `null`. An invalid reported time falls back.

**`refreshWorktreeSourceControlState.test.ts`** (`it.effect`; assert relative to the dispatched `updatedAt`, because the helper uses `Date`):
(a) open to merged with forge `terminalAt` dispatches `prTerminalAt` = forge ISO. (b) open to merged without `terminalAt`
(Bitbucket-like) dispatches `prTerminalAt === updatedAt`. (c) stored merged with a backfilled time, forge reports a different time:
it dispatches the correction although `prState` did not change. (d) stored merged with a time, forge silent: no dispatch.
(e) merged to open dispatches `prTerminalAt: null`.

**`ProjectionWorktrees.test.ts`.** Round-trip `prTerminalAt` (a time and `null`). `upsert({...(yield* getById).value, title: "x"})`
keeps `prTerminalAt`; this is the NULL-wipe guard.

**`ProjectionPipeline.worktrees.test.ts`.** An event with `prTerminalAt` writes the column. A legacy event without the field, going
open to merged, writes `payload.updatedAt`. A legacy merged-to-merged event keeps the existing value. `worktree.created`
writes `NULL`.

**`projector.test.ts`.** The same three cases on the in-memory read model.

**`ProjectionSnapshotQuery.test.ts`.** Insert a worktree row with `pr_terminal_at`. Assert that `getCommandReadModel().worktrees`,
`getShellSnapshot().worktrees` and `getWorktreeShellById` all expose it. A row with `NULL` exposes `prTerminalAt: null`, with the
key present.

**`apps/server/src/persistence/Migrations/WorktreePrTerminalAtRepair.test.ts`** (new; pattern from `031_WorktreeTitles.test.ts`):

1. Run migrations to 29. Create `projection_worktrees` by hand with `pr_state` and without `pr_terminal_at`. Insert
   merged, closed, open and null rows.
2. Run the repair. Merged and closed rows get `updated_at`; the others stay `NULL`.
3. Set one merged row to `X` and run the repair again. It stays `X`, because the backfill does not re-run.
4. `runMigrations({ toMigrationInclusive: 39 })` on a fresh DB has the column.

**`decider.settlement.test.ts`.** `worktree.source-control-state.update` passes `prTerminalAt` through, and leaves it out when absent.
`thread.settle` succeeds while the worktree PR is `open` or unknown, because auto blockers do not gate manual settle.

**Provider tests.** GitHub: merged gives `terminalAt` = `mergedAt`; closed gives `closedAt`; open gives `null`.
Forgejo, GitLab and Azure: the same. **Bitbucket** (`BitbucketSourceControlProvider.test.ts`): a merged PR returns no
`terminalAt`, which documents the fallback.

**Unchanged and must stay green:** `sidebarUndo.test.ts` (server), `apps/web/src/sidebarUndo.test.ts`,
`apps/web/src/components/inboxSidebar/inboxSidebarModel.test.ts`, `apps/mobile/src/features/inbox/inboxModel.test.ts`,
`apps/mobile/src/features/threads/threadHeaderModel.test.ts`.

## 7. Validation (proportional, but cross-package because of the contract change)

```sh
bun run --cwd packages/shared test src/threadSettlement.test.ts
bun run --cwd packages/client-runtime test src/state/threads/threadInbox.test.ts src/state/threads/store.test.ts
bun run --cwd apps/server test src/ws/context/orchestrationStreams.test.ts src/orchestration/pullRequestTerminalAt.test.ts \
  src/sourceControl/refreshWorktreeSourceControlState.test.ts src/persistence/Layers/ProjectionWorktrees.test.ts \
  src/persistence/Migrations/WorktreePrTerminalAtRepair.test.ts src/orchestration/Layers/ProjectionPipeline.worktrees.test.ts \
  src/orchestration/projector.test.ts src/orchestration/Layers/ProjectionSnapshotQuery.test.ts \
  src/orchestration/decider.settlement.test.ts src/orchestration/sidebarUndo.test.ts \
  src/sourceControl/GitHubSourceControlProvider.test.ts src/sourceControl/GitHubCli.test.ts src/git/GitManager.test.ts \
  src/sourceControl/ForgejoSourceControlProvider.test.ts src/sourceControl/GitLabSourceControlProvider.test.ts \
  src/sourceControl/AzureDevOpsSourceControlProvider.test.ts src/sourceControl/BitbucketSourceControlProvider.test.ts \
  src/persistence/Migrations/037_WorktreeSourceControlState.test.ts src/persistence/Migrations/038_WorktreeWorkItems.test.ts
bun run --cwd apps/web test src/components/inboxSidebar/inboxSidebarModel.test.ts src/sidebarUndo.test.ts
bun run --cwd apps/mobile test src/features/inbox/inboxModel.test.ts src/features/threads/threadHeaderModel.test.ts
bun typecheck && bun lint && bun run fmt:check
```

Never run `bun test`. A full test, build or browser suite is not required: nothing changes in the UI layout or the PWA lifecycle.

---

## 8. Edge cases and residual behaviour

- **"Move to Active" bounce, residual.** This is fixed when the user's next message (or a requested turn) postdates the close. A
  `thread.session.set` to starting or running (`decider.ts:1751-1776`), or an approval or user-input request (`:2012`), also clears an
  explicit `active` override without moving the anchor. A session recovery after the merge with no new user turn therefore lets the
  merged-PR rule settle the thread again. This is deliberate and matches t3.
- **Turns started by Agent Control or delegated returns** advance `latestTurnRequestedAt`, so they count as activity. After such a turn
  a merged PR stops being a signal and the inactivity rule applies. This is the same as t3's `latestRunRequestedAt`.
- **Stuck `"working"` liveness** (a lost `task.completed`) keeps the thread Active for as long as the row shows _Working_. That ends
  at `session.exited` or a server restart (the registry is in memory). It is coherent with the visible status. Fixing liveness is out of scope.
- **Persistent unknown PR** (broken forge auth, or no provider for the remote) blocks auto-settlement indefinitely. Manual settle
  works, and the blocker is exposed as `autoSettlementBlocker` for a later UI hint.
- **Clock skew** between forge timestamps and local message timestamps matters only when the close and the message fall within the
  skew window. Accepted.
- **PR reopened** gives `prTerminalAt: null`, and the open blocker applies. Merged again takes the new forge time or a new observation.
- **Thread created after the merge** on a merged worktree: `createdAt` is after the close, so the PR is not a signal and the inactivity
  rule applies.
- **Old client or old server** (§3.3) keeps today's merged behaviour.
- **Downgrade then upgrade.** Old-binary writes can leave `pr_terminal_at` stale or `NULL` on a terminal row. The client then uses
  the inactivity fallback until the next refresh. The resolver then records the forge time, or the observation when the forge reports none.
- **Explicit settle on a pinned thread** stays settled, because explicit beats automatic. On web the row still sits in the Pinned section.
- **sidebarUndo.** Server receipts and manual eligibility are unchanged. A source-control dispatch inside the 30 s window still
  invalidates the receipt through worktree identity (`sidebarUndo.ts:136`). That is pre-existing behaviour.

## 9. Risks

- **One-time upgrade effects.** The backfill marks legacy merged and closed rows with `updated_at`. On the first refresh per project,
  every non-archived legacy terminal worktree on GitHub, Forgejo, GitLab or Azure dispatches one `worktree.sourceControlStateUpdated`
  to correct the time, and with A6 a shell upsert goes to each subscriber. Each dispatch invalidates any live (≤30 s) undo receipt
  for threads on that worktree. **Visible change:** legacy threads with user activity after the real merge move from Settled
  to Active. That is correct under the new rule. Recommendation: accept the one-time burst. Do not suppress corrections, or the inaccurate backfill
  would persist.
- **Accuracy of the fallback** depends on refresh cadence. Refresh runs only on user-driven source-control RPCs and PR worktree
  creation; nothing polls. For Bitbucket, and for any forge call that fails, the observed time can be late. That errs toward settling,
  which is never worse than today.
- **Behaviour changes that users will see:** pinned threads no longer appear settled. Threads with live subagent or workflow work no longer
  auto-settle. A PR worktree whose state was never fetched no longer settles after N days of inactivity.
- **NULL wipe.** Any future SELECT that feeds `ProjectionWorktrees.upsert` must include `pr_terminal_at`. The round-trip test guards
  the existing paths.
- **A program-level migration hazard** remains for 071–074 (§2 row 2); the integrator owns it.

## 10. Overlaps (same-wave conflict notes)

- **`delegation-guard-restart` (W1):** `projector.ts`. They edit `thread.message-sent` (`:672-701`, the cap at `:696`); this
  package edits `worktree.created` (`:361-410`) and `worktree.sourceControlStateUpdated` (`:435-452`). In `ProjectionSnapshotQuery.ts`
  they edit the `getCommandReadModel` `Effect.all` tuple (`~:2150-2300`) and add the user-message anchor queries (`~:726-760`); this
  package edits only the SQL text of `listWorktreeRows`, `getWorktreeRowById` and `toWorktreeShell`. These are different
  functions, so expect a trivial rebase. Their fix makes the server's `latestUserMessageAt` correct; this package's server path does not use the PR rules.
- **`acp-message-ids` (W1):** `projector.ts` `thread.message-sent`, a different case.
- **`queue-hold-drain` (W1):** possible textual overlap in `threadInbox.ts` (`settlementInput`, the `buildThreadInbox` inputs
  `localQueuedThreadKeys`) and `threadSettlement.ts` (`canSettleThread` or `hasQueuedTurnStart`), if they add a held-queue
  blocker. Merge order does not matter, but keep both fields.
- **`turn-finalization` (W1):** semantic only. Threads stuck on _Working_ block through `session-running`; their fix unblocks settlement.
- **`provider-compat`, `claude-meter-wake`, `reactor-errors-switch` (W1):** none. No `packages/shared/package.json` edit.
- **`usage-limits` (W2):** likely adds a "limited" blocker. It should extend `ThreadAutoSettlementBlocker` /
  `getThreadAutoSettlementBlocker` (automatic) or `ThreadSettlementBlocker` (manual) in `threadSettlement.ts`. Rebase onto this package.
- **`delegation-lineage` (W2):** likely filters child threads in `buildThreadInbox` (`threadInbox.ts`). This is next to the loop edited here.
- **`rollback-correctness` (W2):** the `projector.ts` revert path, a different case.
- **`restart-continuation` (W3):** semantic. If it persists or reconstructs background liveness, the `"background-work"` blocker
  follows automatically through the shell `backgroundLiveness`.
- **`toShellStreamEvent`** (`orchestrationStreams.ts`): no other brief names it. Re-check at merge.

## 11. Out of scope and follow-ups

- **Server-side pins and server-authoritative settlement and threshold** (§3.4). Deferred, with the cost recorded above.
- **Main-worktree PR refresh.** `refreshWorktreeSourceControlState.ts:19` returns early when `worktreePath === null`, so a PR linked
  to the main worktree (`gitRpc.ts:123`) stays `open` forever and blocks auto-settlement. That is pre-existing. Follow-up: use the
  project `workspaceRoot` as the cwd.
- **`worktree.manualPositionSet`** is dropped by `toShellStreamEvent` the same way, so worktree reordering does not stream. This is a one-line follow-up in
  the same `switch`; it is left out to keep this change focused.
- **Periodic PR polling**, to improve fallback accuracy.
- **UI for `autoSettlementBlocker`**, such as a tooltip "Pinned · PR state unknown · Agents still working". The web phone tier is frozen, so do not add it there.
- **Liveness staleness** after a lost `task.completed`.
- **Bitbucket `updated_on`** as a close time. It was rejected because it moves on later activity.
