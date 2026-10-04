import {
  AgentControlCompletionReturn,
  AgentControlProposalId,
  ClientOrchestrationCommand,
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
  /** Frozen before dispatch, including timestamp and command identity. */
  command: Schema.NullOr(ClientOrchestrationCommand),
});
export type CompletionReturnRecord = typeof CompletionReturnRecord.Type;
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(CompletionReturnRecord));

export const makeCompletionReturnRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
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
  const pendingTurnExists = (threadId: ThreadId) =>
    safe(
      sql`
    SELECT 1 FROM projection_turns WHERE thread_id = ${threadId} AND turn_id IS NULL LIMIT 1
  `.pipe(Effect.map((rows) => rows.length > 0)),
    );
  const isReturnContinuation = (record: CompletionReturnRecord, turnId: TurnId | null) =>
    safe(
      sql`
    SELECT 1 FROM projection_turns t
    JOIN agent_control_completion_returns r ON r.child_thread_id = substr(t.pending_message_id, length('delegation-result:') + 1)
      AND json_valid(r.record_json)
      AND json_extract(CASE WHEN json_valid(r.record_json) THEN r.record_json ELSE '{}' END, '$.command.message.messageId') = t.pending_message_id
    JOIN orchestration_command_receipts c ON c.command_id = json_extract(CASE WHEN json_valid(r.record_json) THEN r.record_json ELSE '{}' END, '$.command.commandId')
      AND c.status = 'accepted' AND c.aggregate_id = ${record.parentThreadId}
    WHERE t.thread_id = ${record.parentThreadId} AND t.turn_id IS ${turnId}
      AND t.requested_at = json_extract(CASE WHEN json_valid(r.record_json) THEN r.record_json ELSE '{}' END, '$.command.createdAt')
      AND r.status IN ('delivered', 'dispatching')
      AND json_extract(CASE WHEN json_valid(r.record_json) THEN r.record_json ELSE '{}' END, '$.parentThreadId') = ${record.parentThreadId}
      AND json_extract(CASE WHEN json_valid(r.record_json) THEN r.record_json ELSE '{}' END, '$.parentTurnId') = ${record.parentTurnId}
      AND json_extract(CASE WHEN json_valid(r.record_json) THEN r.record_json ELSE '{}' END, '$.parentRuntimeSessionId') = ${record.parentRuntimeSessionId}
      AND json_extract(CASE WHEN json_valid(r.record_json) THEN r.record_json ELSE '{}' END, '$.parentProviderInstanceId') = ${record.parentProviderInstanceId}
    LIMIT 1
  `.pipe(Effect.map((rows) => rows.length === 1)),
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
    isReturnContinuation,
    pendingTurnExists,
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
