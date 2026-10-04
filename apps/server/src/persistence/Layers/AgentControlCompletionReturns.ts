import {
  AgentControlCompletionReturn,
  AgentControlProposalId,
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
import { hasTurnStartFailure } from "../delegatedRunStatus.ts";

/** Wake message ids carry this prefix; the turn they start is a delegation-wake turn. */
export const DELEGATION_WAKE_MESSAGE_PREFIX = "delegation-result:";
/** Wake command ids carry this prefix (user-stop attribution). */
export const DELEGATION_WAKE_COMMAND_PREFIX = "delegation-return:";

export const CompletionReturnOutcome = Schema.Literals([
  "completed",
  "error",
  "interrupted",
  "stopped",
  "start-failed",
  "advanced",
  "archived",
  "request-failed",
  "expired",
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
  deliveryAttempts: Schema.optional(NonNegativeInt),
  /** First event sequence of the child stream; bounds the user-stop scan. */
  sinceSequence: Schema.optional(Schema.NullOr(NonNegativeInt)),
  /** Delegation-wake turns of the child that `settled` advanced through. */
  delegationWakeTurns: Schema.optional(NonNegativeInt),
});
export type CompletionReturnRecord = typeof CompletionReturnRecord.Type;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(CompletionReturnRecord));

class CompletionReturnCasConflict {
  readonly _tag = "CompletionReturnCasConflict";
}

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
            )
          ) {
            // Nested delegation: the child woke for its own delegated work and finished
            // again. Its final output, not "I delegated", is what the parent gets.
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
  /**
   * The delegating chat's own cancel: `waiting|ready → cancelled`, retried once on a
   * concurrent write. Null when the row does not belong to `parentThreadId`.
   */
  const cancelOwned = (input: {
    readonly childThreadId: ThreadId;
    readonly parentThreadId: ThreadId;
    readonly detail: string;
    readonly now: string;
  }) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const record = yield* get(input.childThreadId);
        if (!record || record.parentThreadId !== input.parentThreadId) return null;
        if (record.status !== "waiting" && record.status !== "ready") return record;
        const next: CompletionReturnRecord = {
          ...record,
          status: "cancelled",
          detail: input.detail,
          updatedAt: input.now,
          nextCheckAt: input.now,
        };
        if (yield* save(record, next)) return { ...next, revision: record.revision + 1 };
      }
      return (yield* get(input.childThreadId)) ?? null;
    });
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
  /** Newest unbound turn start of the thread and whether its start already failed. */
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
            messageId.length > 0 && (yield* hasTurnStartFailure(sql, { threadId, messageId })),
        };
      }),
    );
  const wakeStartState = (threadId: ThreadId, messageId: MessageId) =>
    safe(
      Effect.gen(function* () {
        const rows = yield* sql<{ turnId: string | null }>`
    SELECT turn_id AS "turnId" FROM projection_turns
    WHERE thread_id = ${threadId} AND pending_message_id = ${messageId}
    ORDER BY row_id DESC LIMIT 1
  `;
        if (rows[0]?.turnId) return "bound" as const;
        if (yield* hasTurnStartFailure(sql, { threadId, messageId })) return "failed" as const;
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
   * Client interrupts of the thread after `sinceSequence`, each attributed to the latest
   * turn start that precedes it in the same stream. Agent Control interrupts
   * (`agent-control:*`), provider (startup reconciliation) and server interrupts never count.
   */
  const userStopAttributions = (threadId: ThreadId, sinceSequence: number) =>
    safe(
      sql<{
        stopSequence: number;
        startCommandId: string | null;
        startMessageId: string | null;
        startOccurredAt: string;
      }>`
    SELECT stop.sequence AS "stopSequence",
           start.command_id AS "startCommandId",
           json_extract(start.payload_json, '$.messageId') AS "startMessageId",
           start.occurred_at AS "startOccurredAt"
    FROM orchestration_events stop
    JOIN orchestration_events start
      ON start.aggregate_kind = 'thread' AND start.stream_id = stop.stream_id
     AND start.sequence = (
       SELECT max(prev.sequence) FROM orchestration_events prev
       WHERE prev.aggregate_kind = 'thread' AND prev.stream_id = stop.stream_id
         AND prev.event_type = 'thread.turn-start-requested' AND prev.sequence < stop.sequence)
    WHERE stop.aggregate_kind = 'thread' AND stop.stream_id = ${threadId}
      AND stop.sequence > ${sinceSequence}
      AND stop.event_type = 'thread.turn-interrupt-requested'
      AND stop.actor_kind = 'client'
      AND (stop.command_id IS NULL OR stop.command_id NOT LIKE 'agent-control:%')
    ORDER BY stop.sequence LIMIT 50
  `,
    );
  const startFailed = (threadId: ThreadId, messageId: MessageId) =>
    safe(hasTurnStartFailure(sql, { threadId, messageId }));
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
    userStopAttributions,
    startFailed,
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
