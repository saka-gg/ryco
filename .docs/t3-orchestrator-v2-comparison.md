# t3code Orchestrator V2 vs Ryco

Read-only comparison, 2026-10-03.

- **t3code:** `pingdotgg/t3code` at `f391794`. That is the `v0.0.46-nightly.20261003.2610` release plus about 30 fixes from the following day.
- **Ryco:** at `7968f99b8`.
- **Paths:** paths starting with `t3:` are relative to the t3code repo root. All other paths are Ryco repo-relative.

Confidence labels used below:

- **verified**: confirmed by reading the code during this review.
- **likely**: found by tracing the code. Write a failing test before fixing.

## Context

- **Size:** V2 was one 380k-line PR (`#2829`). It brings a new database (`statev2.sqlite`, a one-way copy of V1), a new wire protocol (V1 clients are refused), and a rewrite of every adapter.
- **Stability:** t3 shipped about 30 fixes in the first 24 hours, for example "runs no longer get stuck" (#15048), "threads stay working while Claude starts a wake turn" (#15055) and "working timers no longer reset on every background wake" (#15029).
- **Recommendation:** port **ideas and specific mechanisms**, not code. Ryco has diverged too far (Agent Control, Hub/relay, inbox, chunked persistence) for a rebase onto V2 to make sense.

## TL;DR

Ryco is **ahead on safety**:

- approval-gated Agent Control
- worktree-escalation guard
- child output labelled as untrusted
- capped persisted payloads
- Copilot support
- Cursor kept out of the server process

Ryco also has a better context-handoff document and per-task Claude stop.

Ryco is **behind on run mechanics**:

- the queue is client-side
- no usage-limit handling
- no fork or merge-back
- steering only works on Codex
- delegated child results are not batched into one parent wake
- no continue-after-restart
- no OpenCode 2 and no Pi

The comparison also turned up **real correctness bugs** in Ryco (section 1). Those are the cheapest, highest-value work.

---

## 1. Fix now: bugs found by the comparison

| #   | Problem                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Evidence                                                                                                                                                                   | t3 reference                                                                                                                                        | Effort | Confidence                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------ |
| 1   | **Claude rollback leaves the conversation intact.** A checkpoint revert restores the files. `rollbackThread` only trims Ryco's in-memory `context.turns`. The live SDK query is never closed, and `resumeSessionAt` still points at `lastAssistantUuid`, the newest message. So Claude still remembers the reverted turns.                                                                                                                                                | `apps/server/src/provider/Layers/ClaudeAdapter.ts:5110-5117`, `:1830`; caller `apps/server/src/orchestration/Layers/CheckpointReactor.ts:765`                              | Close the query, then resume at the target message: `t3:apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts:7514-7606`                     | M      | verified                             |
| 2   | **Revert has no safety rails.** Files are restored before the provider rollback, so a failed provider rollback leaves files and conversation out of step. The revert command does not check that the thread is idle or that its workspace is isolated, so a thread working in the project root can wipe other threads' edits. Copilot, Grok and ACP rollback do nothing or return an error. Codex still uses the deprecated `thread/rollback`.                            | `CheckpointReactor.ts:745-768`, `orchestration/decider.ts:1414`, `Layers/CopilotAdapter.session.ts:674`, `Layers/AcpAdapter.ts:1024`, `Layers/CodexSessionRuntime.ts:2272` | `t3:.../CheckpointRollbackService.ts:200-265` (provider rollback first, file restore optional), `CheckpointRestoreSafety.ts`, Codex `thread/revert` | M      | likely                               |
| 3   | **Queued messages only send while that thread is on screen.** The only drain is a `useEffect` inside `ChatView`.                                                                                                                                                                                                                                                                                                                                                          | `apps/web/src/components/ChatView.tsx:3925-3970`                                                                                                                           | Server-owned queue. Short-term fix: a client-runtime drain like mobile's `use-thread-outbox-drain.ts`                                               | S      | verified                             |
| 4   | **Stop, failures and usage limits don't pause the queue.** None of the drain guards check for interrupted, error or limit, and `derivePhase` maps error to "ready". After Stop the next queued message sends at once. After a usage limit, every queued message fails in turn.                                                                                                                                                                                            | `ChatView.tsx:3933-3940`, `packages/client-runtime/.../session-logic.ts:2306`                                                                                              | `queueHeld`, `holdQueue` on interrupt: `t3:.../Orchestrator.ts:1180-1240`, `:7946-7960`                                                             | S      | verified (guards) / likely (cascade) |
| 5   | **Threads can stay on "Working" forever.** The projected turn only leaves `running` on a final assistant message, a turn-diff-completed event or an interrupt. Turn-diff-completed comes from checkpoint capture, which skips non-git folders and on failure only adds an activity. A turn that fails without final text in a non-git folder, or whose capture fails or is lost in a crash, never finishes. Startup reconciliation only checks the session, not the turn. | `orchestration/Layers/ProjectionPipeline.ts:1717-1720`, `:1797-1882`; `CheckpointReactor.ts:254`, `:850-866`; `serverRuntimeStartup.ts:619-626`                            | Run finalization separate from checkpoints: `t3:.../RunFinalizationService.ts`                                                                      | S–M    | likely                               |
| 6   | **ACP assistant messages can collide after a restart.** The ACP item id is `assistant:<sessionId>:segment:<n>`. The counter `n` restarts at 0 for each runtime, and the same session id is reused on resume. So the first reply after a restart reuses the id of the first reply ever sent. The message upsert also overwrites `thread_id` when ids conflict.                                                                                                             | `provider/acp/AcpSessionRuntime.ts:172`, `:780`; `ProviderRuntimeIngestion.ts:389-397`; `persistence/Layers/ProjectionThreadMessages.ts:90-96`                             | Thread-scoped id minting: `t3:.../IdAllocator.ts`                                                                                                   | S–M    | likely (id scheme verified)          |
| 7   | **Delegated results are rejected after a restart.** At startup the in-memory model loads only each thread's first user message. The decider's delegated-result guard compares the parent's last user message against the true latest message read by `CompletionReturnDelivery`. So after a restart, returns to any parent with two or more user messages fail.                                                                                                           | `ProjectionSnapshotQuery.ts:730-760`, `decider.ts:1009-1016`, `agentControl/Layers/CompletionReturnDelivery.ts:338`, `:410`                                                | n/a                                                                                                                                                 | S      | likely                               |
| 8   | **The context meter looks full after Claude compaction.** At the `compact_boundary`, Ryco throws away the last known usage and ignores `post_tokens`. If the turn then ends without main-loop usage, Ryco falls back to cumulative `result.usage`.                                                                                                                                                                                                                        | `ClaudeAdapter.ts:3465-3470`, `:2240-2270`                                                                                                                                 | `t3:.../ClaudeAdapterV2.ts:5567-5600`                                                                                                               | S      | likely                               |
| 9   | **Changing an ACP registry model silently loses the conversation.** With `sessionModelSwitch: "unsupported"`, Ryco restarts the session without a resume cursor and without a context handoff.                                                                                                                                                                                                                                                                            | `ProviderCommandReactor.ts:698-719`, `Drivers/AcpRegistryDriver.ts:186`                                                                                                    | `t3:.../ProviderSessionTransitionPolicy.ts`                                                                                                         | S      | likely                               |
| 10  | **OpenCode 2.x is not blocked.** Ryco's client library is 1.x only (`@opencode-ai/sdk ^1.18.29`), and nothing marks 2.x as incompatible. Users who upgrade get an unexplained failure.                                                                                                                                                                                                                                                                                    | `provider/opencodeRuntime.ts:44`                                                                                                                                           | Compatibility statuses (supported, graceful, unsupported, broken): `t3:apps/server/src/provider/providerCompatibility.ts`                           | S      | likely                               |
| 11  | **Settlement happens on the wrong signals.** A merged or closed PR settles the thread even when the user kept working after the merge (no date comparison). Pins are stored per client and don't block settlement. A missing PR snapshot doesn't block either.                                                                                                                                                                                                            | `packages/shared/src/threadSettlement.ts:172-210`, `apps/web/src/threadPinning.ts`                                                                                         | `t3:.../ThreadSettlementService.ts:84-200`                                                                                                          | S–M    | likely                               |
| 12  | **Users see raw Effect error dumps.** Non-provider failures in the reactor surface `Cause.pretty` text.                                                                                                                                                                                                                                                                                                                                                                   | `ProviderCommandReactor.ts:319-328`                                                                                                                                        | `t3:.../UserFacingErrors.ts`                                                                                                                        | S      | likely                               |
| 13  | **One slow thread blocks every other thread.** The provider command reactor is a single serial worker that waits on session start with no timeout. A cold start or hang on one thread delays Stop and approvals everywhere. The reaper also skips threads with an active turn, so a hung provider is never reaped.                                                                                                                                                        | `ProviderCommandReactor.ts:927`, `:1803`; `ProviderSessionReaper.ts:82`                                                                                                    | Per-thread lock: `t3:.../KeyedSerialExecutor.ts` (55 lines)                                                                                         | S–M    | likely                               |

## 2. Worth adding

These are ranked by value per effort.

| Rank | Feature                                            | What t3 V2 does                                                                                                                                                                                                                                                                                         | Ryco today                                                                                                                                                                                                                                                                                                                      | Proposal                                                                                                                                                                                                                                              | Effort |
| ---- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1    | **Usage limits**                                   | A "Limited" thread state. Claude and Codex usage-limit stops are detected with their reset time. A worker sweeps persisted state to auto-resume or snooze until reset, controlled by `autoResumeLimitedThreads` and `snoozeLimitedThreads`.                                                             | Missing. Claude and Codex `account.rate-limits.updated` events are emitted but unused (`ClaudeAdapter.ts:3944`, `CodexAdapter.ts:1604`). There is no `usage_limit` error class (`contracts/providerRuntime.ts:101`). Reset times already exist for the usage page (`ClaudeUsage.ts:215-262`), and thread snooze already exists. | Add a `usage_limit` error class with `resetAt`, a sidebar status, a resume/snooze banner, and a sweep worker.                                                                                                                                         | M      |
| 2    | **Steering beyond Codex, and a follow-up setting** | Claude pushes the message into the live session with `priority:"now"`. A per-message steer-or-queue choice defaults to the setting in Settings → General, and `Cmd/Ctrl+Enter` does the opposite. A steer that arrives after the turn ends becomes a new turn.                                          | Only Codex declares support (`CodexProvider.ts:32`), and `ProviderService.ts:1273` rejects steering for everything else. Steering takes two steps: queue the message, then click Steer on it. Ryco's Claude SDK (0.3.263) already supports `priority`.                                                                          | Add a Claude `steerTurn`, then the setting and the modifier key.                                                                                                                                                                                      | M      |
| 3    | **Better delegation returns**                      | `delegate_task`: child results are batched into one parent wake. Delivery goes through the continuation service (steer if supported, otherwise queue). Finished children are recovered after a restart. `mode=wait` upgrades to an async wake when it times out. Tools `task_status` and `task_cancel`. | `CompletionReturnDelivery` polls every 2 s and starts one parent turn per child. Only the child's first run is returned. A return is blocked if the parent has moved to a new turn or the live `runtimeSessionId` changed. Injected instructions tell agents to poll `ryco_wait_threads`.                                       | Batch sibling returns, relax the exact-turn and same-session check to "queue on the parent thread", tell agents to end their turn instead of polling, and add task status, cancel and wait. **Keep the untrusted-result labelling.**                  | M–L    |
| 4    | **Server-side parent/child links (lineage)**       | `lineage { parentThreadId, relationshipToParent, rootThreadId }` on threads. Children are hidden from the sidebar and shown inside the parent with `ProviderSubagentBar` and `V2SubagentGroup`.                                                                                                         | No lineage field. "Managed by" is inferred on the client from proposal history (`client-runtime/src/state/agentControl/logic.ts:252-310`). Children show as ordinary sidebar threads.                                                                                                                                           | Set lineage in `AgentControlExecution` `createThreads`, group children under the parent, and add a Lineage item to the overview rail.                                                                                                                 | M      |
| 5    | **Continue after restart**                         | Opt-in `continueThreadsAfterServerUpdate`. Running threads are snapshotted at shutdown and sent "continue" afterwards, and the agent is told which background work died (`RestartContinuation.ts`, `RestartBackgroundNote.ts`).                                                                         | `serverRuntimeStartup.ts:555-720` sets the error "Send a new message to continue". Background liveness is in memory only (`ThreadBackgroundLiveness.ts`).                                                                                                                                                                       | Port behind a setting, with deterministic command ids.                                                                                                                                                                                                | M      |
| 6    | **Durable provider side effects**                  | Effect outbox with leases. After a crash, unsafe effects (turn start, interrupt, steer, request response) are cancelled with a message, and safe ones are requeued.                                                                                                                                     | `ProviderCommandReactor` only reacts to live in-memory events. If the server dies between commit and provider call, the message is saved but no turn runs and no error is shown.                                                                                                                                                | Generalize the Agent Control operation store (`agentControl/Services/AgentControlOperationStore.ts`) into a provider-effect outbox.                                                                                                                   | M–L    |
| 7    | **Context handoff cost and recovery**              | Token budget of 16k by default (64KB max), minus current usage and a reserve. Omitted items are listed with a pointer to `t3_thread_read`.                                                                                                                                                              | Richer document (plans, tools, checkpoints, subagents) plus an inspection UI. But the budget is 35% of the window, up to 1.4M characters (`packages/shared/src/contextWindow.ts:55-70`), and the agent is never told how to recover what was cut.                                                                               | Cap the budget against the target model's window, and add an "omitted entries — use `ryco_read_thread`" footer.                                                                                                                                       | S      |
| 8    | **Smarter session transitions**                    | One policy function chooses between reuse, in-session model switch, restart-and-resume, or a new session with handoff. A same-driver account switch resumes the native session. Switching back to a provider sends only the messages it missed.                                                         | Inline logic in `ProviderCommandReactor.ts:680-760`. Every instance change is a lossy handoff (`packages/shared/src/model.ts:366`).                                                                                                                                                                                             | Extract a pure transition policy and add cross-account resume.                                                                                                                                                                                        | M      |
| 9    | **Codex background terminals**                     | Stop terminates them (`thread/backgroundTerminals/terminate`), and completion wakes the agent with a summary such as "Command x finished (exit 1)".                                                                                                                                                     | Stop only interrupts collab child turns. Background terminals keep running and never wake the agent.                                                                                                                                                                                                                            | Port, reusing the continuation delivery from rank 3.                                                                                                                                                                                                  | M      |
| 10   | **Scheduled tasks you can leave running**          | Every N minutes or a time of day on chosen weekdays (server time zone). Run now. Post into an existing thread. No overlapping runs, missed slots skipped.                                                                                                                                               | Safer: revision guards, plan digests, missed runs merged. But **every run** needs approval and run proposals expire after 15 minutes, so overnight runs almost always expire. Only "once" or an interval of at least 15 minutes.                                                                                                | Approve a schedule once and let low-privilege runs (worktree, approval-required mode) execute. Keep per-run approval for full-access, local and external-integration runs. Add time-of-day + weekday schedules, run now, and existing-thread targets. | M      |
| 11   | **Agent Control for Grok and ACP registry agents** | MCP over an ACP stdio bridge for every ACP agent.                                                                                                                                                                                                                                                       | `ProviderInjection.ts:74-80` refuses them, but Ryco already has an ACP stdio proxy (`installAgentControlAcp`, `:227-275`).                                                                                                                                                                                                      | Enable it after an isolation re-check.                                                                                                                                                                                                                | S      |
| 12   | **Client-side event batching**                     | Each received batch is applied with one state write.                                                                                                                                                                                                                                                    | Thread events are applied one at a time (`client-runtime/src/connection/supervision.ts:376`, `:423` → `apps/web/src/environments/runtime/service.ts:710`), even though `applyOrchestrationEvents` accepts batches.                                                                                                              | Buffer per chunk or microtask.                                                                                                                                                                                                                        | S      |

### Larger features (L)

- **Thread fork + merge-back.**
  - t3: fork from any finished run, using the provider's native fork where available (Codex `thread/fork`, Claude `forkSession upToMessageId`, Pi, OpenCode 2), otherwise a portable copy of the context. Merge-back sends the fork's changes since the fork point into the parent's next run.
  - Ryco: no fork at all. Building blocks exist: `apps/server/src/imports/claudeNativeFork.ts` already calls `forkSession`, and the context handoff can serve as the portable fallback.
  - Depends on lineage (rank 4).
- **Server-side durable queue.**
  - Queue entries become thread events (add, edit, reorder, remove, held), with attachments uploaded first. The reactor drains the queue when a turn settles and holds it on restart, limit or Stop.
  - Fixes queue loss on reload, off-screen drain (bug 3) and cross-device editing.
  - The short-term fixes for bugs 3 and 4 should go first.
- **PR watch → wake.**
  - t3 (#15057): polls every minute, 4 PRs at a time. Wakes on failed checks, required checks passing, new review comments and merge conflicts, at most 10 wakes, and stops after 15 failed reads.
  - Build on Ryco's `sourceControl/*` and the delivery mechanism from rank 3. Treat PR comment text as untrusted.
- **`@thread` / drag-a-thread context.**
  - t3: `ThreadContextRecord`, a chip in the composer, drag from the sidebar. Read access is granted **only for threads the user attached**; references written by an agent don't widen access.
  - Ryco: composer triggers are only path, slash-command, skill and source-control (`client-runtime/src/state/composer/logic.ts:5`). Dragging a thread only works for split panes.
- **OpenCode 2 adapter.**
  - About 4k lines.
  - New: `provider/opencode2/*`, a version probe (1.x vs 2.x), `Layers/OpenCode2Adapter.ts`. `OpenCodeDriver` picks the version.
  - Keep the current adapter as the 1.x path.
- **Pi adapter.**
  - About 4–5k lines.
  - `PiRpc.ts` ports almost as-is. Extension dialogs map to `respondToRequest` and `respondToUserInput`; rollback uses Pi's fork.
  - Agent Control reaches Pi through an injected extension.
- **Threads without a project.**
  - t3 creates a "Scratch" project on demand. Ryco requires `projectId`.
- **Event log compaction.**
  - Delete streaming delta events once a message is final (t3 `ProjectionMaintenance.ts:209-330`).
  - Relates to the pending `orchestration_events` retention decision.

### Smaller UI items

- **Sidebar statuses.** t3 has Working / Waiting / Approval / Input / Limited / Failed / Woke / Done, plus an optional Working shelf. Ryco's inbox puts "Active now" above "Needs input" (`inboxSidebarModel.ts:575`), the opposite of "out of the way until they need you". Add "Limited" with rank 1.
- **Title regeneration.** t3 tracks an in-flight regeneration in the contract. Ryco only generates a title on the first turn.
- **Mobile agents sheet.** Build on `deriveAgentPanelModel` (`client-runtime/src/state/session/subagentRuntime.ts:866`). Ryco mobile shows no subagents today.
- **Durable subagent records.** A subagent tab disappears once its activities fall out of the loaded window (`ThreadWorkspacePanel.tsx:175`). Store a small subagent record on the server.

## 3. Where Ryco is ahead: keep, don't copy t3

- **Agent Control safety.**
  - Off by default, opt-in.
  - Risky actions become proposals that only the user can accept, over a user-only RPC.
  - Exact-turn binding.
  - **Worktree-escalation guard** (`AgentControlActionValidator.ts:296-333`).
  - t3 grants the orchestration capability to every thread (`ProviderSessionManager.ts:440`), and `schedule_task` needs no approval.
- **Child output labelled untrusted** (JSON-escaped, capped at 8k characters).
- **Per-run approval for risky automations.** Relax it only for low-privilege runs.
- **ACP registry install safety.** Prebuilt binaries only, with a sha256 check, a download-host allowlist and size caps. t3 also runs `npx`/`uvx`. Port its sign-in flow, not the installer.
- **Cursor over ACP.** `@cursor/sdk` runs inside the server process (t3 had to add a process-wide `unhandledRejection` filter) and has no per-tool approvals, questions, rollback or fork.
- **Copilot**, which t3 doesn't support.
- **Persistence.**
  - Ryco caps data when saving it (`activityDataCap.ts`); t3 only truncates for transport.
  - Ryco persists text deltas as appended chunks (migration 060); t3 writes full-text snapshots.
- **Per-task Claude stop.** t3 can only stop the whole turn.
- **Simpler engine.** One global serial engine, so the out-of-order publish bug t3 fixed in #15048 can't happen here.
- **Context handoff document.** Richer content, digests and an inspection UI.
- **AI prioritization.** Focus section via `threadPriority/`.
- **External-agent MCP server.** `ryco_create_task` and friends for outside agents; t3 has no equivalent.

## 4. Skip or defer

- **Cursor SDK migration.** Different tradeoff; skip. At most borrow skills discovery (`t3:.../Drivers/CursorSkills.ts`).
- **Antigravity.** t3 supports exactly version 1.1.1; defer.
- **t3's per-thread engine locks and publish lane.** Unnecessary with Ryco's serial engine. Slim down the in-memory read model instead: `projector.ts` copies the thread list on every event and keeps 2000 full messages per thread.
- **Native subagents as full child threads.** High risk. The durable subagent record plus lineage covers most of the value.
- **OpenCode MCP injection.** Skip unless OpenCode runs one server per thread. Ryco's isolation concern is valid; t3 only does it when t3 spawned the OpenCode server itself.
- **History paging changes.** Ryco's 150-item windows are at parity.

## 5. Per-area detail

### 5.1 Core architecture

| Area                           | t3 V2                                                                                                                                                    | Ryco                                                                                                 | Verdict                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Data model                     | Thread → run → attempts → nodes, plus turn items, provider sessions and turns, runtime requests. `t3:packages/contracts/src/orchestrationV2.ts:446-630`. | Event-sourced thread aggregate (decider and projector) plus projection tables.                       | Different. V2's explicit run state is what makes queue, Limited and finalization easy. |
| Command flow                   | Per-thread lock → receipt → plan → one SQLite transaction (events + projections + receipt + outbox) → publish in order.                                  | One global queue: decide, append, project and receipt in one transaction, publish inside the worker. | Ryco is simpler and safe.                                                              |
| Side effects                   | Outbox with leases.                                                                                                                                      | Live in-memory reactors.                                                                             | Behind (section 2, rank 6).                                                            |
| Delta batching                 | 50 ms coalescer, full-text snapshots.                                                                                                                    | 32 ms / 4 KB, appended chunks.                                                                       | Parity; Ryco writes less.                                                              |
| Live stream                    | 1000 items / 8 MB per subscriber, resync on overflow.                                                                                                    | 1000 events / 4 MB, resync on overflow, progress frames coalesced.                                   | Parity on the server. Client behind (section 2, rank 12).                              |
| History paging                 | Pages aligned to user turns.                                                                                                                             | 150 messages + 150 activities, separate cursors.                                                     | Parity.                                                                                |
| Message ids                    | Central `IdAllocator`.                                                                                                                                   | Derived from provider ids.                                                                           | Behind (bug 6).                                                                        |
| Pending requests after restart | Marked `not_resumable` with a message.                                                                                                                   | Cleared at startup, session set to error.                                                            | Parity.                                                                                |
| Event log growth               | Deletes superseded events.                                                                                                                               | Never deletes.                                                                                       | Behind.                                                                                |

### 5.2 Agents managing agents: MCP tools

| Capability                | t3                                                                      | Ryco (\* = needs approval)                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Child task                | `delegate_task`, `task_status`, `task_cancel`                           | `ryco_create_threads{returnToOrigin}` + `ryco_read/wait_for_control_request`                                                   |
| Read and drive threads    | `t3_thread_list/read/search/send/wait/interrupt`                        | `ryco_list/read/search_threads`, `inspect_thread`, `read_thread_diff/file`, `send_message`, `wait_threads`, `interrupt_thread` |
| Metadata                  | rename, regenerate title, link PR, pin/snooze/settle/archive, configure | `ryco_update_thread` (title, model, modes, goal; archive and runtime mode\*)                                                   |
| Queue                     | `t3_queue_list/read/edit/cancel/reorder/promote_to_steer`               | none                                                                                                                           |
| Questions                 | `t3_pending_request_list/read/respond` (never permissions)              | none                                                                                                                           |
| Fork                      | `t3_thread_fork/merge_back/transfers`                                   | none                                                                                                                           |
| Schedules                 | `schedule_task`, list, update, delete, run now (no approval)            | `ryco_list/read_automation(s)`, runs, `propose_automation_*`\*                                                                 |
| Projects and worktrees    | full project CRUD + clone, `t3_worktree_handoff/status/list`            | read + `propose_project_*`\*, workspace lifecycle\*                                                                            |
| PRs                       | link, unlink, list, watch, unwatch                                      | none                                                                                                                           |
| Preview, browser, devices | 14 `preview_*` tools, `device_*`                                        | `ryco_browser`, `ryco_computer`, device read tools + 9 `propose_device_*`\*                                                    |
| Outside agents            | none                                                                    | external Agent Control MCP (`ryco_create_task`, etc.)                                                                          |

Worth adding to Ryco:

- **Answer a child's question.** A manager can answer user-input requests only, never approvals.
- **Task status, cancel and wait.**
- **Queue tools**, once the queue lives on the server.
- **Fork tools**, once fork exists.
- **`worktree_handoff`.** `thread.attach-to-worktree` already exists internally.
- **PR link and watch.**

### 5.3 Provider capability matrix

| Provider     | t3 V2: resume / fork / rollback / steer         | Ryco: resume / fork / rollback / steer                                 |
| ------------ | ----------------------------------------------- | ---------------------------------------------------------------------- |
| Codex        | ✓ / ✓ / ✓ / ✓                                   | ✓ / ✗ / ✓ (deprecated API) / ✓                                         |
| Claude       | ✓ / ✓ native / ✓ resume-at-target / ✓           | ✓ / ✗ / **trims Ryco's list only, provider keeps history (bug 1)** / ✗ |
| Cursor       | ✓ SDK / ✗ / ✗ / restarts turn                   | ✓ ACP / ✗ / Ryco's list only / ✗                                       |
| OpenCode 1.x | ✓ / ✓ / ✓ / ✓                                   | ✓ / ✗ / ✓ `session.revert` / ✗                                         |
| OpenCode 2   | ✓ / ✓ / ✓ / ✓                                   | missing                                                                |
| Pi           | ✓ / ✓ / ✓ via fork / ✓                          | missing                                                                |
| Grok         | ✓ / ✗ / handoff / restarts turn                 | ✓ / ✗ / error / ✗                                                      |
| ACP Registry | per agent / per agent / handoff / restarts turn | per agent / ✗ / error / ✗                                              |
| Antigravity  | 1.1.1 only                                      | missing                                                                |
| Copilot      | missing                                         | ✓ / ✗ / does nothing / ✗                                               |

**ACP Registry comparison.**

- **Ryco has:** search, install, list auth methods and authenticate, limited to methods the agent handles itself.
- **t3 adds:**
  - browser sign-in links sent to any connected device
  - terminal sign-in inside a thread terminal
  - one credential shared across instances of the same agent
  - logout and uninstall
  - session list, import and delete
  - bring-your-own-key config
  - Devin-specific fixes
- **Worth porting:** browser sign-in links, logout and uninstall.

**Version advisories.**

- **t3:** four-status compatibility ranges keyed to the app version, remotely overridable via `model-manifest.json` `compatibility[]`. It also rates the latest available version before an update.
- **Ryco:** "behind latest" plus a few hard minimums.

### 5.4 Fixes t3 shipped after the release, and whether Ryco has the same problem

| t3 fix                                                                   | In Ryco?                                                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| #15048 runs stuck: out-of-order publish                                  | No (serial engine).                                                                                                                         |
| #15048 runs stuck: swallowed projection-read errors                      | **Yes.** The early reads at `ProviderCommandReactor.ts:1124`, `:1142` sit outside the failure handler, so the turn silently doesn't start.  |
| #15055 thread looks idle while Claude starts a wake turn                 | **Likely.** The synthetic turn is created only on the first assistant frame (`ClaudeAdapter.ts:3049`), so the queue can send into that gap. |
| #15029 working timer resets on every background wake                     | Likely. The timer is per turn and each wake is a new turn. Low priority.                                                                    |
| #15114 a dev server left running makes the thread look like it's waiting | By design. Background shells count as "monitoring" (`ThreadBackgroundLiveness.ts:12-32`). Revisit the label.                                |
| #14910 unseen completion with a shell left running                       | Partly handled. The monitoring case is untested.                                                                                            |

## 6. Suggested order

1. **Quick correctness pass.** All S, independent, each with a failing test first:
   - queue hold and global drain (bugs 3–4)
   - explicit turn finalization and startup reconcile (5)
   - delegated-result guard after restart (7)
   - compaction meter (8)
   - ACP model switch context loss (9)
   - OpenCode 2.x guard (10)
   - user-facing errors (12)
2. **Rollback correctness (bugs 1–2).** Claude resume-at-target, provider rollback before files, admission checks, Codex `thread/revert`.
3. **Usage-limit state with resume and snooze at reset.**
4. **Claude steering, then the follow-up setting and modifier key.**
5. **Delegation:** lineage, batched returns, task status and wait, answering children's questions.
6. **Reliability:** per-thread reactor concurrency with timeouts, then the provider-effect outbox, then continue-after-restart.
7. **Larger features:** fork and merge-back, then the server-side queue, then PR watch, then `@thread` context.
8. **Providers:** OpenCode 2, then Pi.
