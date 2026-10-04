/**
 * Delivers delegated-task returns to the chat that delegated them (delegation-returns).
 *
 * One ledger row per `returnToOrigin` child. A row is captured as a result (untrusted child
 * output) or a server-authored notice once the child reaches a terminal state, then joins one
 * batched wake: a queued `thread.turn.start` on the parent that (re)creates or resumes its
 * session. Wakes need the parent to be idle and in the delegation's scope; they survive the
 * parent advancing, a reaped session and a server restart.
 */
import {
  type AgentControlProposal,
  type AgentControlProposalId,
  type CommandId,
  type MessageId,
  type OrchestrationThreadShell,
  type ThreadId,
  type TurnId,
} from "@ryco/contracts";
import {
  QUEUED_TURN_START_GRACE_MS,
  queuedTurnIdleBlocker,
  type QueuedTurnIdleInput,
} from "@ryco/shared/threadSettlement";
import { Context, Duration, Effect, Layer, Option, Schedule, Semaphore } from "effect";
import {
  CompletionReturnRepository,
  DELEGATION_WAKE_MESSAGE_PREFIX,
  type CompletionReturnBatch,
  type CompletionReturnCapture,
  type CompletionReturnOutcome,
  type CompletionReturnRecord,
} from "../../persistence/Layers/AgentControlCompletionReturns.ts";
import { AgentControlProposalRepository } from "../../persistence/Services/AgentControlProposals.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationCommandApplication } from "../../orchestration/Services/OrchestrationCommandApplication.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { AgentControlPolicy } from "../Services/AgentControlPolicy.ts";
import { AgentControlProposalEvents } from "../Services/AgentControlProposalEvents.ts";
import {
  CAPTURE_EXPIRY_MS,
  COLD_WAKE_GRACE_MS,
  DELIVERY_EXPIRY_MS,
  MAX_COLD_WAKES_IN_FLIGHT,
  MAX_DELIVERY_ATTEMPTS,
  MAX_REPLAYS,
  buildDelegationReturnCommand,
  compareCodeUnits,
  renderCompletionNotice,
  renderCompletionReturn,
  selectWakeBatch,
  type CompletionReturnNoticeOutcome,
} from "../completionReturnMessages.ts";
import { publishCompletionReturns } from "../completionReturnPublish.ts";
import { agentControlRuntimeRank } from "./AgentControlActionValidator.ts";

export { renderCompletionReturn } from "../completionReturnMessages.ts";

const FAILED_PROPOSAL_STATUSES: ReadonlySet<AgentControlProposal["status"]> = new Set([
  "failed",
  "cancelled",
  "rejected",
  "expired",
]);

const DETAIL = {
  captured: "Captured. Waiting for the originating chat to become idle.",
  parentGone: "The originating chat was deleted or archived. No result will be returned.",
  parentWorktreeArchived:
    "The originating chat's worktree was archived. No result will be returned.",
  integrity:
    "Saved return authority does not match the original delegated request. Inspect the task manually.",
  childProject: "Child project scope changed. Inspect the initial task manually.",
  nested: "Waiting for this task's own delegated work.",
  disabled: "Agent Control is disabled; delivery resumes when it is re-enabled.",
  scope: "Waiting: the originating chat's permissions or workspace changed since delegation.",
  busy: "Waiting for the originating chat to become idle (queue delivery).",
  userStopped:
    "You stopped the delegating chat; this result was not returned automatically. Open the child.",
  cold: "Waiting for another chat's session to start.",
  deliveryExpired:
    "Not delivered within 24 hours (the originating chat stayed busy, out of scope or Agent Control was disabled). Open the child.",
  rejectedRetry: "The originating chat rejected the update; retrying with its current state.",
  rejectedRepeatedly:
    "Return was rejected repeatedly. Open the child and send its result manually.",
  uncertain:
    "Dispatch outcome is unknown. Check the parent for the result before sending it manually; automatic retry could duplicate it.",
  temporary: "Temporary storage or delivery check failure; retrying automatically.",
  payloadMissing: "Saved return payload is unavailable. Inspect the child manually.",
} as const;

const dispatchingDetail = (count: number) =>
  `Submitting ${count} task update(s) to the originating chat.`;

const deliveredDetail = (record: CompletionReturnRecord, others: number) =>
  record.capture?.kind === "notice"
    ? `Notice (${record.capture.outcome}) sent to the originating chat.`
    : others > 0
      ? `Result returned to the originating chat (batched with ${others} other task(s)). Provider processing is separate from this dispatch receipt.`
      : "Result returned to the originating chat. Provider processing is separate from this dispatch receipt.";

type CapturedRecord = CompletionReturnRecord & { readonly capture: CompletionReturnCapture };
const isCaptured = (record: CompletionReturnRecord): record is CapturedRecord =>
  record.capture !== undefined && record.capture !== null;

export const queuedTurnIdleInputFromShell = (
  shell: OrchestrationThreadShell,
  nowMs: number,
): QueuedTurnIdleInput => ({
  archivedAt: shell.archivedAt,
  sessionStatus: shell.session?.status ?? null,
  latestTurnState: shell.latestTurn?.state ?? null,
  latestTurnRequestedAt: shell.latestTurn?.requestedAt ?? null,
  latestUserMessageAt: shell.latestUserMessageAt,
  hasPendingApprovals: shell.hasPendingApprovals,
  hasPendingUserInput: shell.hasPendingUserInput,
  backgroundLiveness: shell.backgroundLiveness ?? null,
  nowMs,
});

/**
 * Upgrade pre-batching rows in memory. A legacy frozen command's text is exactly one rendered
 * section; a legacy dispatching row becomes a single-child batch with the legacy ids, so its
 * existing receipt settles it. Persisted with the row's next save.
 */
export function normalizeLegacyCompletionReturn(
  record: CompletionReturnRecord,
): CompletionReturnRecord {
  const legacy = record.command?.type === "thread.turn.start" ? record.command : null;
  if (!legacy || (record.status !== "ready" && record.status !== "dispatching")) return record;
  let next = record;
  if (!next.capture)
    next = {
      ...next,
      capture: {
        kind: "result",
        outcome: record.settled?.state === "error" ? "error" : "completed",
        capturedAt: record.updatedAt,
        section: legacy.message.text.slice(0, 60_000),
      },
    };
  if (record.status === "ready" && !record.batch) next = { ...next, command: null };
  if (record.status === "dispatching" && !record.batch)
    next = {
      ...next,
      batch: {
        commandId: legacy.commandId,
        messageId: legacy.message.messageId,
        anchorChildThreadId: record.childThreadId,
        childThreadIds: [record.childThreadId],
        attempt: 0,
        replays: 0,
        dispatchedAt: record.updatedAt,
        cold: false,
      },
    };
  return next;
}

interface ScanContext {
  readonly now: string;
  readonly nowMs: number;
  readonly settledCommands: Set<string>;
  /** Parent → oldest capturedAt among its ready rows seen this scan. */
  readonly candidates: Map<ThreadId, string>;
}

export const makeCompletionReturnDelivery = Effect.gen(function* () {
  const repository = yield* CompletionReturnRepository;
  const proposals = yield* AgentControlProposalRepository;
  const events = yield* AgentControlProposalEvents;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const projections = yield* ProjectionSnapshotQuery;
  const commands = yield* OrchestrationCommandApplication;
  const policy = yield* AgentControlPolicy;
  const providers = yield* ProviderService;
  const lock = yield* Semaphore.make(1);
  // All mutated only under `lock`.
  const pendingStartSeen = new Map<ThreadId, { messageId: string; firstSeenMs: number }>();
  const coldInFlight = new Map<ThreadId, { messageId: MessageId; sinceMs: number }>();
  /** Child → its own unbound delegation wake, first seen by this process (nested hold). */
  const ownWakeSeen = new Map<ThreadId, { messageId: MessageId; firstSeenMs: number }>();
  /**
   * Wake message ids this process applied → scan time of the apply. The reactor only acts on
   * live events, so this process's reactor owns those starts; a wake an earlier process
   * applied and never started died with it. Pruned after CAPTURE_EXPIRY_MS: no waiting row
   * is older than that, and a row only looks at wakes delivered after it was created.
   */
  const wakesAppliedHere = new Map<MessageId, number>();

  const publish = (proposalIds: Iterable<AgentControlProposalId>) =>
    Effect.forEach(
      new Set(proposalIds),
      (proposalId) => publishCompletionReturns({ repository, proposals, events }, proposalId),
      { discard: true },
    );
  const patch = (
    record: CompletionReturnRecord,
    fields: Partial<CompletionReturnRecord>,
    now: string,
  ): CompletionReturnRecord => ({
    ...record,
    ...fields,
    updatedAt: now,
    nextCheckAt: new Date(Date.parse(now) + 2000).toISOString(),
  });
  const visibleChange = (previous: CompletionReturnRecord, next: CompletionReturnRecord) =>
    previous.status !== next.status || previous.detail !== next.detail;
  const save = (
    record: CompletionReturnRecord,
    fields: Partial<CompletionReturnRecord>,
    now: string,
  ) =>
    Effect.gen(function* () {
      const next = patch(record, fields, now);
      if (!(yield* repository.save(record, next))) return false;
      if (visibleChange(record, next)) yield* publish([next.proposalId]);
      return true;
    });
  const saveAll = (
    pairs: ReadonlyArray<readonly [CompletionReturnRecord, CompletionReturnRecord]>,
  ) =>
    Effect.gen(function* () {
      if (pairs.length === 0) return true;
      if (!(yield* repository.saveAll(pairs))) return false;
      yield* publish(
        pairs
          .filter(([previous, next]) => visibleChange(previous, next))
          .map(([, n]) => n.proposalId),
      );
      return true;
    });
  const hold = (record: CompletionReturnRecord, now: string, detail?: string) =>
    save(record, detail === undefined ? {} : { detail }, now).pipe(Effect.asVoid);
  const holdAll = (rows: ReadonlyArray<CompletionReturnRecord>, now: string, detail?: string) =>
    Effect.forEach(rows, (row) => hold(row, now, detail), { discard: true });
  const finish = (
    record: CompletionReturnRecord,
    status: CompletionReturnRecord["status"],
    detail: string,
    now: string,
  ) => save(record, { status, detail }, now).pipe(Effect.asVoid);

  const readShell = (threadId: ThreadId) => projections.getThreadShellById(threadId);
  /** Parent-side terminal cancel reasons (no wake). */
  const parentCancelDetail = (parent: Option.Option<OrchestrationThreadShell>) =>
    Effect.gen(function* () {
      if (Option.isNone(parent) || parent.value.archivedAt !== null) return DETAIL.parentGone;
      const worktreeId = parent.value.worktreeId;
      if (worktreeId && (yield* repository.worktreeArchived(worktreeId)))
        return DETAIL.parentWorktreeArchived;
      return null;
    });
  const isWakeMessage = (messageId: string | null | undefined) =>
    messageId?.startsWith(DELEGATION_WAKE_MESSAGE_PREFIX) ?? false;
  const isWakeTurn = (threadId: ThreadId, turnId: TurnId) =>
    repository
      .turnInfo(threadId, turnId)
      .pipe(Effect.map((turn) => isWakeMessage(turn?.pendingMessageId)));
  /** A live provider session in this process. A failed read counts as live: never release on uncertainty. */
  const sessionLive = (threadId: ThreadId) =>
    providers.getSession(threadId).pipe(
      Effect.map(Option.isSome),
      Effect.catch(() => Effect.succeed(true)),
    );
  /** §3.4: a wake is cold when the parent has no live session; a failed read counts as cold. */
  const parentCold = (threadId: ThreadId) =>
    providers.getSession(threadId).pipe(
      Effect.map(Option.isNone),
      Effect.catch(() => Effect.succeed(true)),
    );
  const coldBudgetFull = () => coldInFlight.size >= MAX_COLD_WAKES_IN_FLIGHT;
  const inScope = (record: CompletionReturnRecord, parent: OrchestrationThreadShell) =>
    // An unattended, untrusted-content-triggered turn never runs with more privilege or in a
    // different checkout than the delegation had. Lowering privilege is fine.
    agentControlRuntimeRank[parent.runtimeMode] <=
      agentControlRuntimeRank[record.parentRuntimeMode] &&
    parent.worktreePath === record.parentWorktreePath;

  /** The delegating message of a row's parent turn, cached per delivery pass. */
  const delegatingMessage = (
    cache: Map<TurnId, MessageId | null>,
    record: CompletionReturnRecord,
  ) =>
    Effect.gen(function* () {
      const known = cache.get(record.parentTurnId);
      if (known !== undefined) return known;
      const messageId = yield* repository.turnMessageId(record.parentThreadId, record.parentTurnId);
      cache.set(record.parentTurnId, messageId);
      return messageId;
    });
  /**
   * Fill `sinceSequence` lazily with the delegating turn's own start, so a Stop pressed before
   * the child existed (an approval-gated request, say) still counts. Without a known start,
   * only wakes after the row's creation can be cohort turns, so the child's first event bounds
   * the scan just as well. Persisted with the row's next save.
   */
  const withStopBound = <R extends CompletionReturnRecord>(
    record: R,
    cache: Map<TurnId, MessageId | null>,
  ) =>
    Effect.gen(function* () {
      if (record.sinceSequence !== undefined && record.sinceSequence !== null) return record;
      const delegating = yield* delegatingMessage(cache, record);
      const start =
        delegating === null
          ? null
          : yield* repository.turnStartSequence(record.parentThreadId, delegating);
      const sinceSequence =
        start ?? (yield* repository.firstEventSequence(record.childThreadId)) ?? 0;
      return { ...record, sinceSequence };
    });
  /** §3.1 user stop, decided per row in SQL (no shared limit can hide a matching stop). */
  const userStoppedRows = (
    parentThreadId: ThreadId,
    rows: ReadonlyArray<CompletionReturnRecord>,
    cache: Map<TurnId, MessageId | null>,
  ) =>
    Effect.gen(function* () {
      const stopped = new Set<ThreadId>();
      for (const row of rows) {
        const delegatingMessageId = yield* delegatingMessage(cache, row);
        if (
          yield* repository.cohortUserStop({
            threadId: parentThreadId,
            sinceSequence: row.sinceSequence ?? 0,
            delegatingMessageId,
            wakesSince: row.createdAt,
          })
        )
          stopped.add(row.childThreadId);
      }
      return stopped;
    });

  /**
   * §3.1 parent idle: the shared queued-turn predicate plus no observed pending start. A
   * pending start blocks for at most QUEUED_TURN_START_GRACE_MS of this process's scan time,
   * so stale rows left by a restart stop blocking and client clock skew cannot open it early.
   */
  const parentIdle = (parent: OrchestrationThreadShell, nowMs: number) =>
    Effect.gen(function* () {
      const pending = yield* repository.pendingTurnStart(parent.id);
      let pendingBlocks = false;
      if (pending && !pending.startFailed) {
        const seen = pendingStartSeen.get(parent.id);
        let firstSeenMs = nowMs;
        if (seen?.messageId === pending.messageId) firstSeenMs = seen.firstSeenMs;
        else pendingStartSeen.set(parent.id, { messageId: pending.messageId, firstSeenMs });
        pendingBlocks = nowMs - firstSeenMs < QUEUED_TURN_START_GRACE_MS;
      } else {
        pendingStartSeen.delete(parent.id);
      }
      if (pendingBlocks) return false;
      return queuedTurnIdleBlocker(queuedTurnIdleInputFromShell(parent, nowMs)) === null;
    });

  const capture = (
    record: CompletionReturnRecord,
    kind: CompletionReturnCapture["kind"],
    outcome: CompletionReturnOutcome,
    section: string,
    ctx: ScanContext,
  ) =>
    Effect.gen(function* () {
      const saved = yield* save(
        record,
        {
          status: "ready",
          capture: { kind, outcome, capturedAt: ctx.now, section: section.slice(0, 60_000) },
          command: null,
          detail: DETAIL.captured,
        },
        ctx.now,
      );
      if (saved) noteCandidate(ctx, record.parentThreadId, ctx.now);
    });
  const notice = (
    record: CompletionReturnRecord,
    outcome: CompletionReturnNoticeOutcome,
    ctx: ScanContext,
  ) => capture(record, "notice", outcome, renderCompletionNotice(record, outcome), ctx);
  const noteCandidate = (ctx: ScanContext, parentThreadId: ThreadId, capturedAt: string) => {
    const known = ctx.candidates.get(parentThreadId);
    if (known === undefined || capturedAt < known) ctx.candidates.set(parentThreadId, capturedAt);
  };

  // ── dispatch settlement ────────────────────────────────────────────────
  const settleBatch = (
    commandId: CommandId,
    ctx: ScanContext,
    options: {
      readonly replay: boolean;
      /** The batch command was applied during this scan, so an accepted wake starts now. */
      readonly applied: boolean;
      readonly trigger?: CompletionReturnRecord;
    },
  ) =>
    Effect.gen(function* () {
      const now = ctx.now;
      let replay = options.replay;
      let applied = options.applied;
      let trigger = options.trigger;
      while (true) {
        const listed = (yield* repository.listBatch(commandId)).map(
          normalizeLegacyCompletionReturn,
        );
        const extra = trigger;
        const members =
          extra && !listed.some((row) => row.childThreadId === extra.childThreadId)
            ? [...listed, extra]
            : listed;
        const rows = members.filter(
          (row) => row.status === "dispatching" && row.batch?.commandId === commandId,
        );
        const batch = rows[0]?.batch;
        if (!batch) return;
        const receipt = yield* receipts.getByCommandId({ commandId });
        if (Option.isSome(receipt)) {
          if (receipt.value.status === "accepted") {
            const others = batch.childThreadIds.length - 1;
            // The frozen command only serves replays, which end here: drop it so delivered
            // rows stay small.
            const saved = yield* saveAll(
              rows.map(
                (row) =>
                  [
                    row,
                    patch(
                      row,
                      { status: "delivered", detail: deliveredDetail(row, others), command: null },
                      now,
                    ),
                  ] as const,
              ),
            );
            // The cold slot's grace runs from the apply that started the wake: a replay or
            // a late settle must not inherit the original claim time.
            if (saved && batch.cold)
              coldInFlight.set(rows[0]!.parentThreadId, {
                messageId: batch.messageId,
                sinceMs: applied ? ctx.nowMs : Date.parse(batch.dispatchedAt),
              });
            return;
          }
          // Every member moves past the batch attempt, so any later batch with this anchor has
          // a fresh id. Blocking counts only the rejections a row itself took part in.
          const attempts = batch.attempt + 1;
          yield* saveAll(
            rows.map((row) => {
              const rejections = (row.rejections ?? 0) + 1;
              return [
                row,
                patch(
                  row,
                  {
                    ...(rejections >= MAX_DELIVERY_ATTEMPTS
                      ? { status: "blocked" as const, detail: DETAIL.rejectedRepeatedly }
                      : { status: "ready" as const, detail: DETAIL.rejectedRetry }),
                    batch: null,
                    command: null,
                    deliveryAttempts: attempts,
                    rejections,
                  },
                  now,
                ),
              ] as const;
            }),
          );
          return;
        }
        // No receipt: the command was not applied (its receipt commits with its events), so
        // replaying the frozen command with the same ids is safe.
        const anchor = rows.find((row) => row.childThreadId === batch.anchorChildThreadId);
        const frozen = anchor?.command?.type === "thread.turn.start" ? anchor.command : null;
        if (!frozen || batch.replays >= MAX_REPLAYS) {
          yield* saveAll(
            rows.map(
              (row) =>
                [row, patch(row, { status: "uncertain", detail: DETAIL.uncertain }, now)] as const,
            ),
          );
          return;
        }
        if (!replay) return yield* holdAll(rows, now);
        const parent = yield* readShell(rows[0]!.parentThreadId);
        const cancel = yield* parentCancelDetail(parent);
        if (cancel || Option.isNone(parent)) {
          yield* saveAll(
            rows.map(
              (row) =>
                [
                  row,
                  patch(row, { status: "cancelled", detail: cancel ?? DETAIL.parentGone }, now),
                ] as const,
            ),
          );
          return;
        }
        if (!(yield* policy.isEnabled) || !(yield* parentIdle(parent.value, ctx.nowMs)))
          return yield* holdAll(rows, now);
        // A replay re-joins the wake, so it passes the same user-stop and scope checks as a
        // new batch. The frozen command was never applied (no receipt), so releasing the
        // rows to `ready` cannot duplicate it: user-stopped rows end, the rest re-batch.
        const cache = new Map<TurnId, MessageId | null>();
        const bounded: CompletionReturnRecord[] = [];
        for (const row of rows) bounded.push(yield* withStopBound(row, cache));
        const stopped = yield* userStoppedRows(parent.value.id, bounded, cache);
        if (stopped.size > 0 || bounded.some((row) => !inScope(row, parent.value))) {
          yield* saveAll(
            bounded.map(
              (row) =>
                [
                  row,
                  patch(
                    row,
                    {
                      ...(stopped.has(row.childThreadId)
                        ? { status: "cancelled" as const, detail: DETAIL.userStopped }
                        : { status: "ready" as const, detail: DETAIL.captured }),
                      batch: null,
                      command: null,
                    },
                    now,
                  ),
                ] as const,
            ),
          );
          return;
        }
        // §3.4: a replay that cold-starts the parent counts against the same budget.
        const cold = yield* parentCold(parent.value.id);
        if (cold && coldBudgetFull()) return yield* holdAll(bounded, now, DETAIL.cold);
        const replayed: CompletionReturnBatch = { ...batch, replays: batch.replays + 1, cold };
        if (
          !(yield* saveAll(
            bounded.map((row) => [row, patch(row, { batch: replayed }, now)] as const),
          ))
        )
          return;
        wakesAppliedHere.set(frozen.message.messageId, ctx.nowMs);
        yield* commands.apply(frozen).pipe(Effect.catch(() => Effect.void));
        replay = false;
        applied = true;
        trigger = undefined;
      }
    });

  // ── capture ────────────────────────────────────────────────────────────
  const integrityMatches = (proposal: AgentControlProposal, record: CompletionReturnRecord) => {
    const origin = proposal.principal;
    return (
      proposal.plan.kind === "createThreads" &&
      proposal.plan.entries.some((entry) => entry.returnToOrigin) &&
      origin.kind === "provider-session" &&
      origin.threadId === record.parentThreadId &&
      origin.turnId === record.parentTurnId &&
      origin.runtimeSessionId === record.parentRuntimeSessionId &&
      origin.providerInstanceId === record.parentProviderInstanceId
    );
  };

  const advanceUnsettled = (
    record: CompletionReturnRecord,
    child: OrchestrationThreadShell,
    ctx: ScanContext,
  ) =>
    Effect.gen(function* () {
      if (yield* repository.startFailed(record.childThreadId, record.initialMessageId))
        return yield* notice(record, "start-failed", ctx);
      const initial = yield* repository.initialTurnId(record);
      const latestTurnId = child.latestTurn?.turnId ?? null;
      if (
        initial &&
        latestTurnId &&
        latestTurnId !== initial &&
        !(yield* isWakeTurn(child.id, latestTurnId))
      )
        return yield* notice(record, "advanced", ctx);
      const childBusy = child.session?.status === "running" || child.session?.status === "starting";
      if (!childBusy) {
        const sessionEnded =
          child.session?.status === "error" || child.session?.status === "stopped";
        const initialState = initial
          ? ((yield* repository.turnInfo(child.id, initial))?.state ?? null)
          : null;
        // Includes children interrupted by startup reconciliation; they are not resumed.
        if (sessionEnded || initialState === "interrupted" || initialState === "error")
          return yield* notice(record, "stopped", ctx);
      }
      // Never infer completion from a message/checkpoint; wait for ingestion's ack.
      return yield* hold(record, ctx.now);
    });

  /**
   * The child's own newest delegation wake (delivered after `record` began), when `settled`
   * does not reflect it yet:
   * - `pending`: delivered but not bound yet, and its start can still happen;
   * - `stopped`: it failed to start, or it is orphaned. The child will not process those
   *   results, so waiting is pointless;
   * - `none`: no such wake, or it bound (the turn checks cover it).
   *
   * A wake this process applied stays `pending` until it binds or fails: its start may sit
   * behind a slow reactor, worktree restore or provider start, and capture expiry bounds the
   * wait. Only a wake an earlier process applied can be orphaned (its reactor work died with
   * that process): once it stayed unbound for the queued-start grace of this process's scan
   * time while the child has no live or starting session.
   */
  const ownWakeState = (
    record: CompletionReturnRecord,
    child: OrchestrationThreadShell,
    ctx: ScanContext,
  ) =>
    Effect.gen(function* () {
      const messageId = yield* repository.latestDeliveredWake(child.id, record.createdAt);
      const state =
        messageId === null ? "absent" : yield* repository.wakeStartState(child.id, messageId);
      if (messageId === null || state === "bound" || state === "failed") {
        ownWakeSeen.delete(child.id);
        return state === "failed" ? ("stopped" as const) : ("none" as const);
      }
      if (wakesAppliedHere.has(messageId)) return "pending" as const;
      const seen = ownWakeSeen.get(child.id);
      const firstSeenMs = seen?.messageId === messageId ? seen.firstSeenMs : ctx.nowMs;
      if (seen?.messageId !== messageId) ownWakeSeen.set(child.id, { messageId, firstSeenMs });
      const childStarting =
        child.session?.status === "running" || child.session?.status === "starting";
      if (
        ctx.nowMs - firstSeenMs < QUEUED_TURN_START_GRACE_MS ||
        childStarting ||
        (yield* sessionLive(child.id))
      )
        return "pending" as const;
      ownWakeSeen.delete(child.id);
      return "stopped" as const;
    });

  const advanceSettled = (
    record: CompletionReturnRecord & {
      readonly settled: NonNullable<CompletionReturnRecord["settled"]>;
    },
    child: OrchestrationThreadShell,
    ctx: ScanContext,
  ) =>
    Effect.gen(function* () {
      const settled = record.settled;
      if (settled.state === "interrupted") return yield* notice(record, "interrupted", ctx);
      const latestTurnId = child.latestTurn?.turnId ?? null;
      if (latestTurnId !== null && latestTurnId !== settled.turnId) {
        const latest = yield* repository.turnInfo(child.id, latestTurnId);
        // Someone else's follow-up is not returned (§7), even when a later wake of the
        // child's own hides it.
        if (
          !isWakeMessage(latest?.pendingMessageId) ||
          (yield* repository.nonWakeTurnBetween(child.id, settled.turnId, null))
        )
          return yield* notice(record, "advanced", ctx);
        // Nested delegation: the child is working through its own delegated results, and
        // ingestion moves `settled` to the wake turn when it ends. A wake that ended without
        // that observation (startup reconciliation interrupted it, or its provider died)
        // never gets one once no provider session is left. That ends the child's work only
        // when nothing can wake it again: none of its own returns is outstanding and no newer
        // own wake is still pending.
        if (
          (latest?.state === "interrupted" || latest?.state === "error") &&
          !(yield* sessionLive(child.id)) &&
          !(yield* repository.hasOutstandingDelegations(child.id)) &&
          (yield* ownWakeState(record, child, ctx)) !== "pending"
        )
          return yield* notice(record, "stopped", ctx);
        return yield* hold(record, ctx.now, DETAIL.nested);
      }
      // Nested delegation: return the child's output after its own wakes, not "I delegated".
      if (yield* repository.hasOutstandingDelegations(child.id))
        return yield* hold(record, ctx.now, DETAIL.nested);
      const childBusy = child.session?.status === "running" || child.session?.status === "starting";
      const backgroundBusy =
        settled.backgroundPending || Boolean(child.backgroundLiveness) || childBusy;
      // Background work cannot outlive the provider session (this covers a restart).
      if (backgroundBusy && (yield* sessionLive(child.id))) return yield* hold(record, ctx.now);
      const output = yield* repository.output(child.id, settled.turnId);
      if (output.streaming > 0) return yield* hold(record, ctx.now);
      // Checked last, right before capture: a row held for background work or streaming
      // output does not re-read the delivered ledger every scan.
      const ownWake = yield* ownWakeState(record, child, ctx);
      if (ownWake === "stopped") return yield* notice(record, "stopped", ctx);
      if (ownWake === "pending") return yield* hold(record, ctx.now, DETAIL.nested);
      return yield* capture(
        record,
        "result",
        settled.state,
        renderCompletionReturn(record, output.text, { backgroundEnded: backgroundBusy }),
        ctx,
      );
    });

  const advanceWaiting = (record: CompletionReturnRecord, ctx: ScanContext) =>
    Effect.gen(function* () {
      const now = ctx.now;
      const cancel = yield* parentCancelDetail(yield* readShell(record.parentThreadId));
      if (cancel) return yield* finish(record, "cancelled", cancel, now);
      const proposal = yield* proposals.getById({ proposalId: record.proposalId });
      // Integrity first: never wake a chat a mismatched row merely claims to belong to.
      if (Option.isSome(proposal) && !integrityMatches(proposal.value, record))
        return yield* finish(record, "blocked", DETAIL.integrity, now);
      if (ctx.nowMs - Date.parse(record.createdAt) > CAPTURE_EXPIRY_MS)
        return yield* notice(record, "expired", ctx);
      if (Option.isNone(proposal) || FAILED_PROPOSAL_STATUSES.has(proposal.value.status))
        return yield* notice(record, "request-failed", ctx);
      if (proposal.value.status !== "completed") return yield* hold(record, now);
      const child = yield* readShell(record.childThreadId);
      if (Option.isNone(child) || child.value.archivedAt !== null)
        return yield* notice(record, "archived", ctx);
      if (child.value.projectId !== record.projectId)
        return yield* finish(record, "blocked", DETAIL.childProject, now);
      const settled = record.settled;
      return settled
        ? yield* advanceSettled({ ...record, settled }, child.value, ctx)
        : yield* advanceUnsettled(record, child.value, ctx);
    });

  const checkReady = (record: CompletionReturnRecord, ctx: ScanContext) =>
    Effect.gen(function* () {
      const cancel = yield* parentCancelDetail(yield* readShell(record.parentThreadId));
      if (cancel) return yield* finish(record, "cancelled", cancel, ctx.now);
      if (!isCaptured(record))
        return yield* finish(record, "failed", DETAIL.payloadMissing, ctx.now);
      if (ctx.nowMs - Date.parse(record.capture.capturedAt) > DELIVERY_EXPIRY_MS)
        return yield* finish(record, "failed", DETAIL.deliveryExpired, ctx.now);
      noteCandidate(ctx, record.parentThreadId, record.capture.capturedAt);
    });

  const processDue = (raw: CompletionReturnRecord, ctx: ScanContext) =>
    Effect.gen(function* () {
      const record = normalizeLegacyCompletionReturn(raw);
      if (record.status === "dispatching") {
        if (!record.batch) return yield* finish(record, "uncertain", DETAIL.uncertain, ctx.now);
        if (ctx.settledCommands.has(record.batch.commandId)) return;
        ctx.settledCommands.add(record.batch.commandId);
        return yield* settleBatch(record.batch.commandId, ctx, {
          replay: true,
          applied: false,
          trigger: record,
        });
      }
      if (record.status === "waiting") return yield* advanceWaiting(record, ctx);
      if (record.status === "ready") return yield* checkReady(record, ctx);
    });

  // ── delivery ───────────────────────────────────────────────────────────
  const deliverParent = (parentThreadId: ThreadId, ctx: ScanContext) =>
    Effect.gen(function* () {
      const now = ctx.now;
      const rows = (yield* repository.listReadyForParent(parentThreadId))
        .map(normalizeLegacyCompletionReturn)
        .filter(isCaptured);
      if (rows.length === 0) return;
      const parent = yield* readShell(parentThreadId);
      const cancel = yield* parentCancelDetail(parent);
      if (cancel || Option.isNone(parent)) {
        for (const row of rows) yield* finish(row, "cancelled", cancel ?? DETAIL.parentGone, now);
        return;
      }
      if (!(yield* policy.isEnabled)) return yield* holdAll(rows, now, DETAIL.disabled);
      const scoped = rows.filter((row) => inScope(row, parent.value));
      yield* holdAll(
        rows.filter((row) => !inScope(row, parent.value)),
        now,
        DETAIL.scope,
      );
      if (scoped.length === 0) return;
      if (!(yield* parentIdle(parent.value, ctx.nowMs)))
        return yield* holdAll(scoped, now, DETAIL.busy);

      // The user-stop decision is persisted as a terminal status, so later event retention
      // cannot undo it. sinceSequence only bounds the scan and is persisted lazily.
      const cache = new Map<TurnId, MessageId | null>();
      const bounded: CapturedRecord[] = [];
      for (const row of scoped) bounded.push(yield* withStopBound(row, cache));
      const stopped = yield* userStoppedRows(parentThreadId, bounded, cache);
      for (const row of bounded)
        if (stopped.has(row.childThreadId))
          yield* finish(row, "cancelled", DETAIL.userStopped, now);
      const remaining = bounded.filter((row) => !stopped.has(row.childThreadId));
      if (remaining.length === 0) return;

      const cold = yield* parentCold(parentThreadId);
      if (cold && coldBudgetFull()) return yield* holdAll(remaining, now, DETAIL.cold);

      const members = selectWakeBatch(remaining);
      const anchor = members
        .map((row) => row.childThreadId)
        .reduce((min, id) => (compareCodeUnits(id, min) < 0 ? id : min));
      const attempt = Math.max(...members.map((row) => row.deliveryAttempts ?? 0));
      const command = buildDelegationReturnCommand({
        parent: parent.value,
        latestUserMessageId: yield* repository.latestUserMessageId(parentThreadId),
        sections: members.map((row) => row.capture.section),
        anchorChildThreadId: anchor,
        attempt,
        now,
      });
      const batch: CompletionReturnBatch = {
        commandId: command.commandId,
        messageId: command.message.messageId,
        anchorChildThreadId: anchor,
        childThreadIds: members.map((row) => row.childThreadId),
        attempt,
        replays: 0,
        dispatchedAt: now,
        cold,
      };
      const claimed = yield* repository.claimBatch(
        members.map(
          (row) =>
            [
              row,
              patch(
                row,
                {
                  status: "dispatching",
                  batch,
                  command: row.childThreadId === anchor ? command : null,
                  detail: dispatchingDetail(members.length),
                },
                now,
              ),
            ] as const,
        ),
      );
      // A concurrent acknowledgement or cancel won; the next scan re-reads.
      if (!claimed) return;
      yield* publish(members.map((row) => row.proposalId));
      wakesAppliedHere.set(command.message.messageId, ctx.nowMs);
      yield* commands.apply(command).pipe(Effect.catch(() => Effect.void));
      yield* settleBatch(command.commandId, ctx, { replay: false, applied: true });
    });

  const releaseColdSlots = (nowMs: number) =>
    Effect.forEach(
      [...coldInFlight],
      ([parentThreadId, entry]) =>
        Effect.gen(function* () {
          if (nowMs - entry.sinceMs >= COLD_WAKE_GRACE_MS) {
            coldInFlight.delete(parentThreadId);
            return;
          }
          const state = yield* repository.wakeStartState(parentThreadId, entry.messageId);
          if (state === "bound" || state === "failed") coldInFlight.delete(parentThreadId);
        }),
      { discard: true },
    );

  const scan = (now = new Date().toISOString()) =>
    lock.withPermit(
      Effect.gen(function* () {
        const ctx: ScanContext = {
          now,
          nowMs: Date.parse(now),
          settledCommands: new Set(),
          candidates: new Map(),
        };
        yield* releaseColdSlots(ctx.nowMs);
        for (const [messageId, appliedMs] of wakesAppliedHere)
          if (ctx.nowMs - appliedMs > CAPTURE_EXPIRY_MS) wakesAppliedHere.delete(messageId);
        for (const record of yield* repository.listDue(now)) {
          yield* processDue(record, ctx).pipe(
            Effect.catch(() =>
              // Retry storage/projection failures without exposing raw causes or
              // overwriting a newer acknowledgement / dispatch claim.
              save(record, { detail: DETAIL.temporary }, now).pipe(
                Effect.asVoid,
                Effect.catch(() => Effect.void),
              ),
            ),
          );
        }
        const parents = [...ctx.candidates].toSorted(
          ([leftId, left], [rightId, right]) =>
            compareCodeUnits(left, right) || compareCodeUnits(leftId, rightId),
        );
        for (const [parentThreadId] of parents) {
          // One parent's failure never starves the others.
          yield* deliverParent(parentThreadId, ctx).pipe(
            Effect.catch(() =>
              repository.listReadyForParent(parentThreadId).pipe(
                Effect.flatMap((rows) => holdAll(rows, now, DETAIL.temporary)),
                Effect.catch(() => Effect.void),
              ),
            ),
          );
        }
      }),
    );
  return { scan };
});
export class CompletionReturnDelivery extends Context.Service<
  CompletionReturnDelivery,
  Effect.Success<typeof makeCompletionReturnDelivery>
>()("ryco/agentControl/CompletionReturnDelivery") {}
export const CompletionReturnDeliveryLive = Layer.effect(
  CompletionReturnDelivery,
  Effect.gen(function* () {
    const delivery = yield* makeCompletionReturnDelivery;
    const startup = yield* ServerRuntimeStartup;
    yield* Effect.forkScoped(
      startup.awaitCommandReady.pipe(
        Effect.andThen(
          Effect.suspend(() => delivery.scan()).pipe(
            Effect.catch(() => Effect.logWarning("Completion return recovery will retry.")),
            Effect.repeat(Schedule.spaced(Duration.seconds(2))),
          ),
        ),
      ),
    );
    return delivery;
  }),
);
