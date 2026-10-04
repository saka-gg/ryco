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
  DELEGATION_WAKE_COMMAND_PREFIX,
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
  // Both mutated only under `lock`.
  const pendingStartSeen = new Map<ThreadId, { messageId: string; firstSeenMs: number }>();
  const coldInFlight = new Map<ThreadId, { messageId: MessageId; sinceMs: number }>();

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
  const isWakeTurn = (threadId: ThreadId, turnId: TurnId) =>
    repository
      .turnInfo(threadId, turnId)
      .pipe(
        Effect.map(
          (turn) => turn?.pendingMessageId?.startsWith(DELEGATION_WAKE_MESSAGE_PREFIX) ?? false,
        ),
      );

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
    options: { readonly replay: boolean; readonly trigger?: CompletionReturnRecord },
  ) =>
    Effect.gen(function* () {
      const now = ctx.now;
      let replay = options.replay;
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
            const saved = yield* saveAll(
              rows.map(
                (row) =>
                  [
                    row,
                    patch(row, { status: "delivered", detail: deliveredDetail(row, others) }, now),
                  ] as const,
              ),
            );
            if (saved && batch.cold)
              coldInFlight.set(rows[0]!.parentThreadId, {
                messageId: batch.messageId,
                sinceMs: Date.parse(batch.dispatchedAt),
              });
            return;
          }
          const attempts = batch.attempt + 1;
          yield* saveAll(
            rows.map(
              (row) =>
                [
                  row,
                  patch(
                    row,
                    {
                      ...(attempts >= MAX_DELIVERY_ATTEMPTS
                        ? { status: "blocked" as const, detail: DETAIL.rejectedRepeatedly }
                        : { status: "ready" as const, detail: DETAIL.rejectedRetry }),
                      batch: null,
                      command: null,
                      deliveryAttempts: attempts,
                    },
                    now,
                  ),
                ] as const,
            ),
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
        const replayed: CompletionReturnBatch = { ...batch, replays: batch.replays + 1 };
        if (
          !(yield* saveAll(rows.map((row) => [row, patch(row, { batch: replayed }, now)] as const)))
        )
          return;
        yield* commands.apply(frozen).pipe(Effect.catch(() => Effect.void));
        replay = false;
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
      const latestIsOther = latestTurnId !== null && latestTurnId !== settled.turnId;
      const latestIsWake = latestIsOther && (yield* isWakeTurn(child.id, latestTurnId));
      const pending = yield* repository.pendingTurnStart(child.id);
      const pendingWake =
        pending !== null &&
        !pending.startFailed &&
        pending.messageId.startsWith(DELEGATION_WAKE_MESSAGE_PREFIX);
      // Nested delegation: return the child's output after its own wakes, not "I delegated".
      if (latestIsWake || pendingWake || (yield* repository.hasOutstandingDelegations(child.id)))
        return yield* hold(record, ctx.now, DETAIL.nested);
      if (latestIsOther) return yield* notice(record, "advanced", ctx);
      const childBusy = child.session?.status === "running" || child.session?.status === "starting";
      const backgroundBusy =
        settled.backgroundPending || Boolean(child.backgroundLiveness) || childBusy;
      if (backgroundBusy) {
        // Background work cannot outlive the provider session (this covers a restart). A
        // failed read counts as live: never release on uncertainty.
        const live = yield* providers.getSession(child.id).pipe(
          Effect.map(Option.isSome),
          Effect.catch(() => Effect.succeed(true)),
        );
        if (live) return yield* hold(record, ctx.now);
      }
      const output = yield* repository.output(child.id, settled.turnId);
      if (output.streaming > 0) return yield* hold(record, ctx.now);
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
        return yield* settleBatch(record.batch.commandId, ctx, { replay: true, trigger: record });
      }
      if (record.status === "waiting") return yield* advanceWaiting(record, ctx);
      if (record.status === "ready") return yield* checkReady(record, ctx);
    });

  // ── delivery ───────────────────────────────────────────────────────────
  const inScope = (record: CompletionReturnRecord, parent: OrchestrationThreadShell) =>
    // An unattended, untrusted-content-triggered turn never runs with more privilege or in a
    // different checkout than the delegation had. Lowering privilege is fine.
    agentControlRuntimeRank[parent.runtimeMode] <=
      agentControlRuntimeRank[record.parentRuntimeMode] &&
    parent.worktreePath === record.parentWorktreePath;

  const userStopped = (parentThreadId: ThreadId, rows: ReadonlyArray<CapturedRecord>) =>
    Effect.gen(function* () {
      const stopped = new Set<ThreadId>();
      if (rows.length === 0) return stopped;
      const since = Math.min(...rows.map((row) => row.sinceSequence ?? 0));
      const stops = yield* repository.userStopAttributions(parentThreadId, since);
      if (stops.length === 0) return stopped;
      const delegatingMessages = new Map<TurnId, MessageId | null>();
      for (const row of rows) {
        let delegating = delegatingMessages.get(row.parentTurnId);
        if (delegating === undefined) {
          delegating = yield* repository.turnMessageId(parentThreadId, row.parentTurnId);
          delegatingMessages.set(row.parentTurnId, delegating);
        }
        const rowSince = row.sinceSequence ?? 0;
        if (
          stops.some(
            (stop) =>
              stop.stopSequence > rowSince &&
              ((delegating !== null && stop.startMessageId === delegating) ||
                (stop.startCommandId?.startsWith(DELEGATION_WAKE_COMMAND_PREFIX) === true &&
                  stop.startOccurredAt >= row.createdAt)),
          )
        )
          stopped.add(row.childThreadId);
      }
      return stopped;
    });

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
      const bounded: CapturedRecord[] = [];
      for (const row of scoped)
        bounded.push(
          row.sinceSequence === undefined || row.sinceSequence === null
            ? {
                ...row,
                sinceSequence: (yield* repository.firstEventSequence(row.childThreadId)) ?? 0,
              }
            : row,
        );
      const stopped = yield* userStopped(parentThreadId, bounded);
      for (const row of bounded)
        if (stopped.has(row.childThreadId))
          yield* finish(row, "cancelled", DETAIL.userStopped, now);
      const remaining = bounded.filter((row) => !stopped.has(row.childThreadId));
      if (remaining.length === 0) return;

      const cold = yield* providers.getSession(parentThreadId).pipe(
        Effect.map(Option.isNone),
        Effect.catch(() => Effect.succeed(true)),
      );
      if (cold && coldInFlight.size >= MAX_COLD_WAKES_IN_FLIGHT)
        return yield* holdAll(remaining, now, DETAIL.cold);

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
      yield* commands.apply(command).pipe(Effect.catch(() => Effect.void));
      yield* settleBatch(command.commandId, ctx, { replay: false });
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
