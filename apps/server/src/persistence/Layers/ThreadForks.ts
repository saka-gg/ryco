import { ThreadForkKey, ThreadForkResult } from "@ryco/contracts";
import { Effect, Layer, Schema, Struct } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  ThreadForkAttachmentsRecord,
  ThreadForkCheckoutRecord,
  ThreadForkFailure,
  ThreadForkLedgerRow,
  ThreadForkLedgerState,
  ThreadForkPlan,
  ThreadForkProviderRecord,
} from "../../threadFork/forkLedger.ts";
import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ThreadForkRepositoryError,
} from "../Errors.ts";
import {
  CompareAndSetThreadForkPhaseInput,
  GetThreadForkInput,
  ListRetryableFailedThreadForksInput,
  ThreadForkRepository,
  type ThreadForkRepositoryShape,
  UnfinishedThreadFork,
} from "../Services/ThreadForks.ts";

const JsonColumns = {
  plan: Schema.fromJsonString(ThreadForkPlan),
  checkout: Schema.NullOr(Schema.fromJsonString(ThreadForkCheckoutRecord)),
  provider: Schema.NullOr(Schema.fromJsonString(ThreadForkProviderRecord)),
  attachments: Schema.NullOr(Schema.fromJsonString(ThreadForkAttachmentsRecord)),
  result: Schema.NullOr(Schema.fromJsonString(ThreadForkResult)),
  error: Schema.NullOr(Schema.fromJsonString(ThreadForkFailure)),
} as const;

const ThreadForkDbRow = ThreadForkLedgerRow.mapFields(Struct.assign(JsonColumns));
const ThreadForkDbState = ThreadForkLedgerState.mapFields(
  Struct.assign(Struct.omit(JsonColumns, ["plan"])),
);

/** The patch with every provided column encoded to its stored JSON (or NULL). */
const CompareAndSetThreadForkPhaseDbInput = CompareAndSetThreadForkPhaseInput.mapFields(
  Struct.assign({
    patch: Schema.Struct({
      checkout: Schema.optional(JsonColumns.checkout),
      provider: Schema.optional(JsonColumns.provider),
      attachments: Schema.optional(JsonColumns.attachments),
      result: Schema.optional(JsonColumns.result),
      error: Schema.optional(JsonColumns.error),
    }),
  }),
);

const ForkKeyResult = Schema.Struct({ forkKey: ThreadForkKey });

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ThreadForkRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

/** `CASE` flag: 1 replaces the column with the bound value, 0 keeps it. */
const provided = (value: unknown) => (value === undefined ? 0 : 1);

const makeThreadForkRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRow = SqlSchema.findAll({
    Request: ThreadForkDbRow,
    Result: ForkKeyResult,
    execute: (row) => sql`
      INSERT INTO thread_forks (
        fork_key,
        request_digest,
        fork_thread_id,
        source_thread_id,
        source_message_id,
        destination_kind,
        phase,
        plan_json,
        checkout_json,
        provider_json,
        attachments_json,
        result_json,
        error_json,
        created_at,
        updated_at
      ) VALUES (
        ${row.forkKey},
        ${row.requestDigest},
        ${row.forkThreadId},
        ${row.sourceThreadId},
        ${row.sourceMessageId},
        ${row.destinationKind},
        ${row.phase},
        ${row.plan},
        ${row.checkout},
        ${row.provider},
        ${row.attachments},
        ${row.result},
        ${row.error},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT DO NOTHING
      RETURNING fork_key AS "forkKey"
    `,
  });

  // Every column but the plan: what a phase transition returns.
  const stateColumns = `
    fork_key AS "forkKey",
    request_digest AS "requestDigest",
    fork_thread_id AS "forkThreadId",
    source_thread_id AS "sourceThreadId",
    source_message_id AS "sourceMessageId",
    destination_kind AS "destinationKind",
    phase,
    checkout_json AS "checkout",
    provider_json AS "provider",
    attachments_json AS "attachments",
    result_json AS "result",
    error_json AS "error",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;
  const selectColumns = sql.literal(`${stateColumns}, plan_json AS "plan"`);

  const getRow = SqlSchema.findOneOption({
    Request: GetThreadForkInput,
    Result: ThreadForkDbRow,
    execute: ({ forkKey }) => sql`
      SELECT ${selectColumns}
      FROM thread_forks
      WHERE fork_key = ${forkKey}
      LIMIT 1
    `,
  });

  const getStateRow = SqlSchema.findOneOption({
    Request: GetThreadForkInput,
    Result: ThreadForkDbState,
    execute: ({ forkKey }) => sql`
      SELECT ${sql.literal(stateColumns)}
      FROM thread_forks
      WHERE fork_key = ${forkKey}
      LIMIT 1
    `,
  });

  const listUnfinishedKeyRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: UnfinishedThreadFork,
    execute: () => sql`
      SELECT fork_key AS "forkKey", phase, updated_at AS "updatedAt"
      FROM thread_forks
      WHERE phase NOT IN ('completed', 'failed')
      ORDER BY created_at ASC, fork_key ASC
    `,
  });

  const listUnfinishedRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadForkDbRow,
    execute: () => sql`
      SELECT ${selectColumns}
      FROM thread_forks
      WHERE phase NOT IN ('completed', 'failed')
      ORDER BY created_at ASC, fork_key ASC
    `,
  });

  const listRetryableFailedRows = SqlSchema.findAll({
    Request: ListRetryableFailedThreadForksInput,
    Result: ThreadForkDbRow,
    execute: ({ updatedBefore }) => sql`
      SELECT ${selectColumns}
      FROM thread_forks
      WHERE phase = 'failed'
        AND json_extract(error_json, '$.retryable') = 1
        AND updated_at < ${updatedBefore}
      ORDER BY updated_at ASC, fork_key ASC
    `,
  });

  const compareAndSetRow = SqlSchema.findOneOption({
    Request: CompareAndSetThreadForkPhaseDbInput,
    Result: ThreadForkDbState,
    execute: ({
      forkKey,
      expectedPhase,
      expectedUpdatedAt,
      nextPhase,
      patch,
      releaseHistory,
      updatedAt,
    }) => sql`
      UPDATE thread_forks
      SET phase = ${nextPhase},
          plan_json = CASE WHEN ${releaseHistory === true ? 1 : 0} = 1
            THEN json_set(
              plan_json,
              '$.command.messages', json('[]'),
              '$.command.proposedPlans', json('[]'),
              '$.command.activities', json('[]')
            )
            ELSE plan_json END,
          checkout_json = CASE WHEN ${provided(patch.checkout)} = 1
            THEN ${patch.checkout ?? null} ELSE checkout_json END,
          provider_json = CASE WHEN ${provided(patch.provider)} = 1
            THEN ${patch.provider ?? null} ELSE provider_json END,
          attachments_json = CASE WHEN ${provided(patch.attachments)} = 1
            THEN ${patch.attachments ?? null} ELSE attachments_json END,
          result_json = CASE WHEN ${provided(patch.result)} = 1
            THEN ${patch.result ?? null} ELSE result_json END,
          error_json = CASE WHEN ${provided(patch.error)} = 1
            THEN ${patch.error ?? null} ELSE error_json END,
          updated_at = ${updatedAt}
      WHERE fork_key = ${forkKey}
        AND phase = ${expectedPhase}
        AND (${expectedUpdatedAt ?? null} IS NULL OR updated_at = ${expectedUpdatedAt ?? null})
      RETURNING ${sql.literal(stateColumns)}
    `,
  });

  const insertIfAbsent: ThreadForkRepositoryShape["insertIfAbsent"] = (row) =>
    insertRow(row).pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toSqlOrDecodeError(
          "ThreadForkRepository.insertIfAbsent:query",
          "ThreadForkRepository.insertIfAbsent:encodeRequest",
        ),
      ),
    );

  const getByKey: ThreadForkRepositoryShape["getByKey"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "ThreadForkRepository.getByKey:query",
          "ThreadForkRepository.getByKey:decodeRow",
        ),
      ),
    );

  const getStateByKey: ThreadForkRepositoryShape["getStateByKey"] = (input) =>
    getStateRow(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "ThreadForkRepository.getStateByKey:query",
          "ThreadForkRepository.getStateByKey:decodeRow",
        ),
      ),
    );

  const listUnfinishedKeys: ThreadForkRepositoryShape["listUnfinishedKeys"] = () =>
    listUnfinishedKeyRows(undefined).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "ThreadForkRepository.listUnfinishedKeys:query",
          "ThreadForkRepository.listUnfinishedKeys:decodeRows",
        ),
      ),
    );

  const compareAndSetPhase: ThreadForkRepositoryShape["compareAndSetPhase"] = (input) =>
    compareAndSetRow(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "ThreadForkRepository.compareAndSetPhase:query",
          "ThreadForkRepository.compareAndSetPhase:codec",
        ),
      ),
    );

  const listRetryableFailed: ThreadForkRepositoryShape["listRetryableFailed"] = (input) =>
    listRetryableFailedRows(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "ThreadForkRepository.listRetryableFailed:query",
          "ThreadForkRepository.listRetryableFailed:decodeRows",
        ),
      ),
    );

  const listUnfinished: ThreadForkRepositoryShape["listUnfinished"] = () =>
    listUnfinishedRows(undefined).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "ThreadForkRepository.listUnfinished:query",
          "ThreadForkRepository.listUnfinished:decodeRows",
        ),
      ),
    );

  return {
    insertIfAbsent,
    getByKey,
    getStateByKey,
    compareAndSetPhase,
    listUnfinished,
    listUnfinishedKeys,
    listRetryableFailed,
  } satisfies ThreadForkRepositoryShape;
});

export const ThreadForkRepositoryLive = Layer.effect(
  ThreadForkRepository,
  makeThreadForkRepository,
);
