import {
  ApprovalRequestId,
  ApprovalResponseIdentity,
  ApprovalResponseState,
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
} from "@ryco/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionThreadUserInputRequest,
  ProjectionThreadUserInputRequestRepository,
  type ProjectionThreadUserInputRequestRepositoryShape,
} from "../Services/ProjectionThreadUserInputRequests.ts";

const ProjectionThreadUserInputRequestDbRow = Schema.Struct({
  requestId: ApprovalRequestId,
  threadId: ThreadId,
  isPending: NonNegativeInt,
  updatedAt: IsoDateTime,
  identity: Schema.NullOr(Schema.fromJsonString(ApprovalResponseIdentity)),
  responseAttemptId: Schema.NullOr(CommandId),
  responseState: Schema.NullOr(ApprovalResponseState),
  settlementRequiresIdentity: NonNegativeInt,
});

const makeProjectionThreadUserInputRequestRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: ProjectionThreadUserInputRequest,
    execute: (row) => sql`
      INSERT INTO projection_thread_user_input_requests (
        request_id,
        thread_id,
        is_pending,
        updated_at, identity_json, response_attempt_id, response_state, settlement_requires_identity
      )
      VALUES (
        ${row.requestId},
        ${row.threadId},
        ${Number(row.isPending)},
        ${row.updatedAt}, ${row.userInputIdentity ? JSON.stringify(row.userInputIdentity) : null},
        ${row.responseAttemptId ?? null}, ${row.responseState ?? null}, ${Number(row.settlementRequiresIdentity ?? false)}
      )
      ON CONFLICT (thread_id, request_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        is_pending = excluded.is_pending,
        updated_at = excluded.updated_at,
        identity_json = excluded.identity_json, response_attempt_id = excluded.response_attempt_id,
        response_state = excluded.response_state, settlement_requires_identity = excluded.settlement_requires_identity
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, requestId: ApprovalRequestId }),
    Result: ProjectionThreadUserInputRequestDbRow,
    execute: ({ threadId, requestId }) => sql`
      SELECT
        request_id AS "requestId",
        thread_id AS "threadId",
        is_pending AS "isPending",
        updated_at AS "updatedAt", identity_json AS "identity", response_attempt_id AS "responseAttemptId",
        response_state AS "responseState", settlement_requires_identity AS "settlementRequiresIdentity"
      FROM projection_thread_user_input_requests
      WHERE thread_id = ${threadId} AND request_id = ${requestId}
    `,
  });

  const deleteRowsByThread = SqlSchema.void({
    Request: Schema.Struct({ threadId: ThreadId }),
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_user_input_requests
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionThreadUserInputRequestRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadUserInputRequestRepository.upsert:query"),
      ),
    );

  const getByRequestId: ProjectionThreadUserInputRequestRepositoryShape["getByRequestId"] = (
    input,
  ) =>
    getRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadUserInputRequestRepository.getByRequestId:query"),
      ),
      Effect.map(
        Option.map((row) => ({
          requestId: row.requestId,
          threadId: row.threadId,
          isPending: row.isPending === 1,
          updatedAt: row.updatedAt,
          ...(row.identity ? { userInputIdentity: row.identity } : {}),
          ...(row.responseAttemptId ? { responseAttemptId: row.responseAttemptId } : {}),
          ...(row.responseState ? { responseState: row.responseState } : {}),
          settlementRequiresIdentity: row.settlementRequiresIdentity === 1,
        })),
      ),
    );

  const deleteByThreadId: ProjectionThreadUserInputRequestRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteRowsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadUserInputRequestRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByRequestId,
    deleteByThreadId,
  } satisfies ProjectionThreadUserInputRequestRepositoryShape;
});

export const ProjectionThreadUserInputRequestRepositoryLive = Layer.effect(
  ProjectionThreadUserInputRequestRepository,
  makeProjectionThreadUserInputRequestRepository,
);
