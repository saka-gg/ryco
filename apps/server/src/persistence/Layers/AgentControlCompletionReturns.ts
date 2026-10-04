import {
  AgentControlCompletionReturn,
  AgentControlProposalId,
  AgentControlTaskNoticeOutcome,
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import { Context, Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { toPersistenceSqlError } from "../Errors.ts";
import { latestUserMessageIdQuery } from "../userMessageAnchors.ts";
import { hasTurnStartEnded, hasTurnStartFailure } from "../delegatedRunStatus.ts";

/** Wake message ids carry this prefix; the turn they start is a delegation-wake turn. */
export const DELEGATION_WAKE_MESSAGE_PREFIX = "delegation-result:";
/** Wake command ids carry this prefix (user-stop attribution). */
export const DELEGATION_WAKE_COMMAND_PREFIX = "delegation-return:";

export const CompletionReturnOutcome = Schema.Literals([
  "completed",
  "error",
  ...AgentControlTaskNoticeOutcome.literals,
]);
export type CompletionReturnOutcome = typeof CompletionReturnOutcome.Type;

/** What a row returns: a child result section or a server-authored notice section. */
export const CompletionReturnCapture = Schema.Struct({
  kind: Schema.Literals(["result", "notice"]),
  outcome: CompletionReturnOutcome,
  capturedAt: IsoDateTime,
  section: Schema.String.check(Schema.isMaxLength(60_000)),
});
export type CompletionReturnCapture = typeof CompletionReturnCapture.Type;

/** The batched wake a dispatching row belongs to. */
export const CompletionReturnBatch = Schema.Struct({
  commandId: CommandId,
  messageId: MessageId,
  anchorChildThreadId: ThreadId,
  childThreadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(10)),
  attempt: NonNegativeInt,
  replays: NonNegativeInt,
  dispatchedAt: IsoDateTime,
  cold: Schema.Boolean,
});
export type CompletionReturnBatch = typeof CompletionReturnBatch.Type;

export const CompletionReturnRecord = Schema.Struct({
  ...AgentControlCompletionReturn.fields,
  proposalId: AgentControlProposalId,
  projectId: ProjectId,
  parentRuntimeSessionId: RuntimeSessionId,
  parentProviderInstanceId: ProviderInstanceId,
  parentRuntimeMode: RuntimeMode,
  parentWorktreePath: Schema.NullOr(Schema.String),
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  nextCheckAt: IsoDateTime,
  settled: Schema.NullOr(
    Schema.Struct({
      turnId: TurnId,
      runtimeSessionId: RuntimeSessionId,
      state: Schema.Literals(["completed", "error", "interrupted"]),
      observationEpoch: Schema.String,
      backgroundPending: Schema.Boolean,
    }),
  ),
  /**
   * The anchor row of a dispatching batch holds the frozen batch command (replay source);
   * every other row holds null. Legacy rows may hold their own per-child command.
   */
  command: Schema.NullOr(ClientOrchestrationCommand),
  capture: Schema.optional(Schema.NullOr(CompletionReturnCapture)),
  batch: Schema.optional(Schema.NullOr(CompletionReturnBatch)),
  /** Wake id attempt: the batch maximum plus one after each rejection, so ids stay unique. */
  deliveryAttempts: Schema.optional(NonNegativeInt),
  /** Rejected wakes this row itself was part of; blocking is decided per row from it. */
  rejections: Schema.optional(NonNegativeInt),
  /**
   * Lower bound of the user-stop scan on the parent stream: the delegating turn's own
   * `thread.turn-start-requested` sequence (the child's first event when that is unknown).
   * Every stop attributable to a cohort turn comes after it, so it is a performance bound only.
   */
  sinceSequence: Schema.optional(Schema.NullOr(NonNegativeInt)),
  /** Delegation-wake turns of the child that `settled` advanced through. */
  delegationWakeTurns: Schema.optional(NonNegativeInt),
});
export type CompletionReturnRecord = typeof CompletionReturnRecord.Type;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(CompletionReturnRecord));

/**
 * Statuses in which a child's result is still owed to its parent. The SQL `IN (...)`
 * lists in `listDue`, `listProposalIds` and `hasOutstandingDelegations` must match.
 */
export const PENDING_COMPLETION_RETURN_STATUSES = ["waiting", "ready", "dispatching"] as const;
const PENDING_COMPLETION_RETURN_STATUS_SET: ReadonlySet<string> = new Set(
  PENDING_COMPLETION_RETURN_STATUSES,
);
export function isPendingCompletionReturn(record: { readonly status: string }): boolean {
  return PENDING_COMPLETION_RETURN_STATUS_SET.has(record.status);
}

class CompletionReturnCasConflict {
  readonly _tag = "CompletionReturnCasConflict";
}

/**
 * The delegating chat's own cancel: `waiting|ready → cancelled`, retried once on a concurrent
 * write. Null when the row does not belong to `parentThreadId`; otherwise the resulting
 * record, which is still `waiting`/`ready` when both attempts lost the revision race.
 */
export const cancelOwnedCompletionReturn =
  <E>(ops: {
    readonly get: (childThreadId: ThreadId) => Effect.Effect<CompletionReturnRecord | undefined, E>;
    readonly save: (
      previous: CompletionReturnRecord,
      next: CompletionReturnRecord,
    ) => Effect.Effect<boolean, E>;
  }) =>
  (input: {
    readonly childThreadId: ThreadId;
    readonly parentThreadId: ThreadId;
    readonly detail: string;
    readonly now: string;
  }) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const record = yield* ops.get(input.childThreadId);
        if (!record || record.parentThreadId !== input.parentThreadId) return null;
        if (record.status !== "waiting" && record.status !== "ready") return record;
        const next: CompletionReturnRecord = {
          ...record,
          status: "cancelled",
          detail: input.detail,
          updatedAt: input.now,
          nextCheckAt: input.now,
        };
        if (yield* ops.save(record, next)) return { ...next, revision: record.revision + 1 };
      }
      return (yield* ops.get(input.childThreadId)) ?? null;
    });

export const makeCompletionReturnRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Quarantined rows keep their malformed JSON; never let json_extract fail a query on them.
  const recordJson = sql.literal(
    "CASE WHEN json_valid(record_json) THEN record_json ELSE '{}' END",
  );
  const safe = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(toPersistenceSqlError("AgentControlCompletionReturns")));
  const readRows = (rows: ReadonlyArray<{ childThreadId: string; record: string }>) =>
    Effect.gen(function* () {
      const records: CompletionReturnRecord[] = [];
      for (const row of rows) {
        try {
          records.push(decode(row.record));
        } catch {
          // Quarantine one corrupt record; never let it poison the due batch or
          // keep starving healthy records behind it. Do not log stored content.
          yield* sql`UPDATE agent_control_completion_returns SET status = 'failed'
          WHERE child_thread_id = ${row.childThreadId}`;
          yield* Effect.logWarning(
            "Invalid completion-return ledger row quarantined; inspect the task manually.",
          );
        }
      }
      return records;
    });
  const insert = (record: CompletionReturnRecord) =>
    safe(
      sql`
    INSERT INTO agent_control_completion_returns
      (child_thread_id, proposal_id, status, revision, next_check_at, record_json)
    VALUES (${record.childThreadId}, ${record.proposalId}, ${record.status}, ${record.revision},
      ${record.nextCheckAt}, ${JSON.stringify(record)}) ON CONFLICT DO NOTHING
  `.pipe(Effect.asVoid),
    );
  const listDue = (now: string) =>
    safe(
      sql<{ childThreadId: string; record: string }>`
    SELECT child_thread_id AS "childThreadId", record_json AS record FROM agent_control_completion_returns
    WHERE status IN ('waiting', 'ready', 'dispatching') AND next_check_at <= ${now}
    ORDER BY next_check_at, child_thread_id LIMIT 100
  `.pipe(Effect.flatMap(readRows)),
    );
  const listForProposal = (proposalId: AgentControlProposalId) =>
    safe(
      sql<{ childThreadId: string; record: string }>`
    SELECT child_thread_id AS "childThreadId", record_json AS record FROM agent_control_completion_returns
    WHERE proposal_id = ${proposalId} ORDER BY child_thread_id
  `.pipe(Effect.flatMap(readRows)),
    );
  const listProposalIds = (pending: boolean, limit: number) =>
    safe(
      sql<{ proposalId: string }>`
    SELECT proposal_id AS "proposalId" FROM agent_control_completion_returns
    WHERE (${pending ? 1 : 0} = 0 OR status IN ('waiting', 'ready', 'dispatching'))
    GROUP BY proposal_id ORDER BY max(next_check_at) DESC LIMIT ${Math.min(limit, 100)}
  `.pipe(Effect.map((rows) => rows.map((row) => AgentControlProposalId.make(row.proposalId)))),
    );
  const get = (childThreadId: ThreadId) =>
    safe(
      sql<{ childThreadId: string; record: string }>`
    SELECT child_thread_id AS "childThreadId", record_json AS record FROM agent_control_completion_returns WHERE child_thread_id = ${childThreadId}
  `.pipe(
        Effect.flatMap(readRows),
        Effect.map((rows) => rows[0]),
      ),
    );
  const save = (previous: CompletionReturnRecord, next: CompletionReturnRecord) =>
    safe(
      sql`
    UPDATE agent_control_completion_returns SET status = ${next.status}, revision = ${previous.revision + 1},
      next_check_at = ${next.nextCheckAt}, record_json = ${JSON.stringify({ ...next, revision: previous.revision + 1 })}
    WHERE child_thread_id = ${previous.childThreadId} AND revision = ${previous.revision}
    RETURNING child_thread_id
  `.pipe(Effect.map((rows) => rows.length === 1)),
    );
  // The initial user message, not the latest turn, owns the delegation.
  const initialTurnId = (record: CompletionReturnRecord) =>
    safe(
      sql<{ turnId: string }>`
    SELECT turn_id AS "turnId" FROM projection_turns
    WHERE thread_id = ${record.childThreadId} AND pending_message_id = ${record.initialMessageId}
      AND turn_id IS NOT NULL LIMIT 1
  `.pipe(Effect.map((rows) => (rows[0] ? TurnId.make(rows[0].turnId) : null))),
    );
  const turnMessageId = (threadId: ThreadId, turnId: TurnId) =>
    safe(
      sql<{ messageId: string | null }>`
    SELECT pending_message_id AS "messageId" FROM projection_turns
    WHERE thread_id = ${threadId} AND turn_id = ${turnId} LIMIT 1
  `.pipe(Effect.map((rows) => (rows[0]?.messageId ? MessageId.make(rows[0].messageId) : null))),
    );
  const latestUserMessageId = (threadId: ThreadId) =>
    safe(
      latestUserMessageIdQuery(sql, threadId).pipe(
        Effect.map((rows) => (rows[0] ? MessageId.make(rows[0].messageId) : null)),
      ),
    );
  const output = (threadId: ThreadId, turnId: TurnId) =>
    safe(
      sql<{ text: string; streaming: number }>`
    SELECT substr(CASE WHEN m.text_json IS NULL THEN m.text ELSE json_extract(m.text_json, '$') END, 1, 8001) AS text,
      (SELECT count(*) FROM projection_thread_messages live WHERE live.thread_id = ${threadId}
        AND live.turn_id = ${turnId} AND live.is_streaming <> 0) AS streaming
    FROM projection_turns t JOIN projection_thread_messages m ON m.message_id = t.assistant_message_id
      AND m.thread_id = t.thread_id AND m.turn_id = t.turn_id AND m.role = 'assistant'
    WHERE t.thread_id = ${threadId} AND t.turn_id = ${turnId} LIMIT 1
  `.pipe(Effect.map((rows) => rows[0] ?? { text: "", streaming: 0 })),
    );
  const observe = (input: {
    childThreadId: ThreadId;
    runtimeSessionId: RuntimeSessionId;
    observationEpoch: string;
    backgroundPending: boolean;
    terminal?: { turnId: TurnId; state: "completed" | "error" | "interrupted" };
  }) =>
    safe(
      sql.withTransaction(
        Effect.gen(function* () {
          const record = yield* get(input.childThreadId);
          if (!record || record.status !== "waiting") return;
          const initial = yield* initialTurnId(record);
          const terminal = input.terminal;
          if (terminal && !record.settled && initial === terminal.turnId) {
            yield* save(record, {
              ...record,
              childTurnId: initial,
              settled: {
                ...terminal,
                runtimeSessionId: input.runtimeSessionId,
                observationEpoch: input.observationEpoch,
                backgroundPending: input.backgroundPending,
              },
            });
          } else if (
            terminal &&
            record.settled &&
            terminal.turnId !== record.settled.turnId &&
            (yield* turnInfo(input.childThreadId, terminal.turnId))?.pendingMessageId?.startsWith(
              DELEGATION_WAKE_MESSAGE_PREFIX,
            ) &&
            !(yield* nonWakeTurnBetween(
              input.childThreadId,
              record.settled.turnId,
              terminal.turnId,
            ))
          ) {
            // Nested delegation: the child woke for its own delegated work and finished
            // again. Its final output, not "I delegated", is what the parent gets. A
            // follow-up someone else sent in between is never skipped over: delivery
            // turns it into an `advanced` notice instead.
            yield* save(record, {
              ...record,
              settled: {
                ...terminal,
                runtimeSessionId: input.runtimeSessionId,
                observationEpoch: input.observationEpoch,
                backgroundPending: input.backgroundPending,
              },
              delegationWakeTurns: (record.delegationWakeTurns ?? 0) + 1,
            });
          } else if (
            record.settled?.runtimeSessionId === input.runtimeSessionId &&
            record.settled.observationEpoch === input.observationEpoch &&
            record.settled.backgroundPending !== input.backgroundPending
          ) {
            yield* save(record, {
              ...record,
              settled: { ...record.settled, backgroundPending: input.backgroundPending },
            });
          }
        }),
      ),
    );
  const listReadyForParent = (parentThreadId: ThreadId) =>
    safe(
      sql<{ childThreadId: string; record: string }>`
    SELECT child_thread_id AS "childThreadId", record_json AS record FROM agent_control_completion_returns
    WHERE status = 'ready' AND json_extract(${recordJson}, '$.parentThreadId') = ${parentThreadId}
    ORDER BY child_thread_id LIMIT 100
  `.pipe(Effect.flatMap(readRows)),
    );
  /** Non-terminal rows first, then most recently updated. */
  const listForParent = (parentThreadId: ThreadId, limit: number) =>
    safe(
      sql<{ childThreadId: string; record: string }>`
    SELECT child_thread_id AS "childThreadId", record_json AS record FROM agent_control_completion_returns
    WHERE json_extract(${recordJson}, '$.parentThreadId') = ${parentThreadId}
    ORDER BY CASE WHEN status IN ('waiting', 'ready', 'dispatching') THEN 0 ELSE 1 END,
      json_extract(${recordJson}, '$.updatedAt') DESC, child_thread_id
    LIMIT ${Math.max(1, Math.min(limit, 20))}
  `.pipe(Effect.flatMap(readRows)),
    );
  const listBatch = (commandId: CommandId) =>
    safe(
      sql<{ childThreadId: string; record: string }>`
    SELECT child_thread_id AS "childThreadId", record_json AS record FROM agent_control_completion_returns
    WHERE status = 'dispatching' AND json_extract(${recordJson}, '$.batch.commandId') = ${commandId}
    ORDER BY child_thread_id LIMIT 20
  `.pipe(Effect.flatMap(readRows)),
    );
  /** All-or-nothing revision CAS: one stale pair rolls back every write and returns false. */
  const saveAll = (
    pairs: ReadonlyArray<readonly [previous: CompletionReturnRecord, next: CompletionReturnRecord]>,
  ) =>
    safe(
      sql
        .withTransaction(
          Effect.gen(function* () {
            for (const [previous, next] of pairs) {
              const rows = yield* sql`
    UPDATE agent_control_completion_returns SET status = ${next.status}, revision = ${previous.revision + 1},
      next_check_at = ${next.nextCheckAt}, record_json = ${JSON.stringify({ ...next, revision: previous.revision + 1 })}
    WHERE child_thread_id = ${previous.childThreadId} AND revision = ${previous.revision}
    RETURNING child_thread_id
  `;
              if (rows.length !== 1) return yield* Effect.fail(new CompletionReturnCasConflict());
            }
            return true;
          }),
        )
        .pipe(
          Effect.catch((error) =>
            error instanceof CompletionReturnCasConflict
              ? Effect.succeed(false)
              : Effect.fail(error),
          ),
        ),
    );
  const claimBatch = saveAll;
  const cancelOwned = cancelOwnedCompletionReturn({ get, save });
  const hasOutstandingDelegations = (threadId: ThreadId) =>
    safe(
      sql`
    SELECT 1 FROM agent_control_completion_returns
    WHERE status IN ('waiting', 'ready', 'dispatching')
      AND json_extract(${recordJson}, '$.parentThreadId') = ${threadId}
    LIMIT 1
  `.pipe(Effect.map((rows) => rows.length > 0)),
    );
  const turnInfo = (threadId: ThreadId, turnId: TurnId) =>
    safe(
      sql<{ pendingMessageId: string | null; state: string }>`
    SELECT pending_message_id AS "pendingMessageId", state FROM projection_turns
    WHERE thread_id = ${threadId} AND turn_id = ${turnId} LIMIT 1
  `.pipe(Effect.map((rows) => rows[0] ?? null)),
    );
  /**
   * Newest unbound turn start of the thread and whether its start already ended
   * without a turn (`startFailed`: it failed, or a Stop cancelled it).
   */
  const pendingTurnStart = (threadId: ThreadId) =>
    safe(
      Effect.gen(function* () {
        const rows = yield* sql<{ messageId: string | null }>`
    SELECT pending_message_id AS "messageId" FROM projection_turns
    WHERE thread_id = ${threadId} AND turn_id IS NULL
    ORDER BY row_id DESC LIMIT 1
  `;
        const row = rows[0];
        if (!row) return null;
        const messageId = row.messageId ?? "";
        return {
          messageId,
          startFailed:
            messageId.length > 0 && (yield* hasTurnStartEnded(sql, { threadId, messageId })),
        };
      }),
    );
  /** `failed`: the wake's start ended without a turn (it failed, or a Stop cancelled it). */
  const wakeStartState = (threadId: ThreadId, messageId: MessageId) =>
    safe(
      Effect.gen(function* () {
        const rows = yield* sql<{ turnId: string | null }>`
    SELECT turn_id AS "turnId" FROM projection_turns
    WHERE thread_id = ${threadId} AND pending_message_id = ${messageId}
    ORDER BY row_id DESC LIMIT 1
  `;
        if (rows[0]?.turnId) return "bound" as const;
        if (yield* hasTurnStartEnded(sql, { threadId, messageId })) return "failed" as const;
        return rows[0] ? ("pending" as const) : ("absent" as const);
      }),
    );
  const firstEventSequence = (threadId: ThreadId) =>
    safe(
      sql<{ sequence: number }>`
    SELECT sequence FROM orchestration_events
    WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
    ORDER BY sequence ASC LIMIT 1
  `.pipe(Effect.map((rows) => rows[0]?.sequence ?? null)),
    );
  const worktreeArchived = (worktreeId: string) =>
    safe(
      sql<{ archivedAt: string | null }>`
    SELECT archived_at AS "archivedAt" FROM projection_worktrees WHERE worktree_id = ${worktreeId}
  `.pipe(Effect.map((rows) => (rows[0]?.archivedAt ?? null) !== null)),
    );
  /**
   * Whether the user stopped a cohort turn of a return on `threadId` after `sinceSequence`.
   * A client interrupt is attributed to the latest turn start that precedes it in the same
   * stream; it counts when that start is the delegating message's or a delegation wake
   * requested at or after `wakesSince`. Agent Control interrupts (`agent-control:*`),
   * provider (startup reconciliation) and server interrupts never count. The cohort filter
   * runs in SQL, so no number of unrelated stops can hide a matching one.
   */
  const cohortUserStop = (input: {
    readonly threadId: ThreadId;
    readonly sinceSequence: number;
    readonly delegatingMessageId: MessageId | null;
    readonly wakesSince: string;
  }) =>
    safe(
      sql`
    SELECT 1
    FROM orchestration_events stop
    JOIN orchestration_events start
      ON start.aggregate_kind = 'thread' AND start.stream_id = stop.stream_id
     AND start.sequence = (
       SELECT max(prev.sequence) FROM orchestration_events prev
       WHERE prev.aggregate_kind = 'thread' AND prev.stream_id = stop.stream_id
         AND prev.event_type = 'thread.turn-start-requested' AND prev.sequence < stop.sequence)
    WHERE stop.aggregate_kind = 'thread' AND stop.stream_id = ${input.threadId}
      AND stop.sequence > ${input.sinceSequence}
      AND stop.event_type = 'thread.turn-interrupt-requested'
      AND stop.actor_kind = 'client'
      AND (stop.command_id IS NULL OR stop.command_id NOT LIKE 'agent-control:%')
      AND ((${input.delegatingMessageId} IS NOT NULL
            AND json_extract(start.payload_json, '$.messageId') = ${input.delegatingMessageId})
        OR (substr(start.command_id, 1, ${DELEGATION_WAKE_COMMAND_PREFIX.length}) = ${DELEGATION_WAKE_COMMAND_PREFIX}
            AND start.occurred_at >= ${input.wakesSince}))
    LIMIT 1
  `.pipe(Effect.map((rows) => rows.length > 0)),
    );
  const startFailed = (threadId: ThreadId, messageId: MessageId) =>
    safe(hasTurnStartFailure(sql, { threadId, messageId }));
  /** Sequence of the first `thread.turn-start-requested` event for `messageId` on the thread. */
  const turnStartSequence = (threadId: ThreadId, messageId: MessageId) =>
    safe(
      sql<{ sequence: number }>`
    SELECT sequence FROM orchestration_events
    WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
      AND event_type = 'thread.turn-start-requested'
      AND json_extract(payload_json, '$.messageId') = ${messageId}
    ORDER BY sequence ASC LIMIT 1
  `.pipe(Effect.map((rows) => rows[0]?.sequence ?? null)),
    );
  /**
   * Whether a bound turn that is not a delegation wake (someone else's follow-up, or a turn
   * with no user message) sits after `afterTurnId`, and before `beforeTurnId` when given.
   * Turn rows are ordered by `row_id` (start order).
   */
  const nonWakeTurnBetween = (
    threadId: ThreadId,
    afterTurnId: TurnId,
    beforeTurnId: TurnId | null,
  ) =>
    safe(
      sql`
    SELECT 1 FROM projection_turns turn
    WHERE turn.thread_id = ${threadId} AND turn.turn_id IS NOT NULL
      AND turn.row_id > (SELECT lower_turn.row_id FROM projection_turns lower_turn
        WHERE lower_turn.thread_id = ${threadId} AND lower_turn.turn_id = ${afterTurnId})
      AND (${beforeTurnId} IS NULL OR turn.row_id < (SELECT upper_turn.row_id
        FROM projection_turns upper_turn
        WHERE upper_turn.thread_id = ${threadId} AND upper_turn.turn_id = ${beforeTurnId}))
      AND (turn.pending_message_id IS NULL
        OR substr(turn.pending_message_id, 1, ${DELEGATION_WAKE_MESSAGE_PREFIX.length}) <> ${DELEGATION_WAKE_MESSAGE_PREFIX})
    LIMIT 1
  `.pipe(Effect.map((rows) => rows.length > 0)),
    );
  /**
   * Message id of the newest delegation wake delivered to `parentThreadId` through a batch
   * (rows acknowledged with ryco_task_status carry no batch and started no wake), among rows
   * delivered at or after `since`. A delivered row is never rescheduled, so its
   * `next_check_at` is its delivery time: the bound keeps the scan an index range over recent
   * deliveries instead of every delivered row ever, and orders wakes by when they started.
   */
  const latestDeliveredWake = (parentThreadId: ThreadId, since: string) =>
    safe(
      sql<{ messageId: string }>`
    SELECT json_extract(${recordJson}, '$.batch.messageId') AS "messageId"
    FROM agent_control_completion_returns
    WHERE status = 'delivered' AND next_check_at >= ${since}
      AND json_extract(${recordJson}, '$.parentThreadId') = ${parentThreadId}
      AND json_extract(${recordJson}, '$.batch.messageId') IS NOT NULL
    ORDER BY next_check_at DESC, json_extract(${recordJson}, '$.batch.dispatchedAt') DESC,
      json_extract(${recordJson}, '$.batch.messageId') DESC
    LIMIT 1
  `.pipe(Effect.map((rows) => (rows[0] ? MessageId.make(rows[0].messageId) : null))),
    );
  return {
    insert,
    listDue,
    listForProposal,
    listProposalIds,
    get,
    save,
    initialTurnId,
    observe,
    output,
    latestUserMessageId,
    turnMessageId,
    listReadyForParent,
    listForParent,
    listBatch,
    saveAll,
    claimBatch,
    cancelOwned,
    hasOutstandingDelegations,
    turnInfo,
    pendingTurnStart,
    wakeStartState,
    firstEventSequence,
    worktreeArchived,
    cohortUserStop,
    startFailed,
    turnStartSequence,
    nonWakeTurnBetween,
    latestDeliveredWake,
  };
});
export class CompletionReturnRepository extends Context.Service<
  CompletionReturnRepository,
  Effect.Success<typeof makeCompletionReturnRepository>
>()("ryco/persistence/CompletionReturnRepository") {}
export const CompletionReturnRepositoryLive = Layer.effect(
  CompletionReturnRepository,
  makeCompletionReturnRepository,
);

export const completionReturnSummary = (
  record: CompletionReturnRecord,
): AgentControlCompletionReturn => ({
  revision: record.revision,
  childThreadId: record.childThreadId,
  initialMessageId: MessageId.make(record.initialMessageId),
  parentThreadId: record.parentThreadId,
  parentTurnId: record.parentTurnId,
  childTurnId: record.childTurnId,
  status: record.status,
  detail: record.detail,
  updatedAt: record.updatedAt,
});
