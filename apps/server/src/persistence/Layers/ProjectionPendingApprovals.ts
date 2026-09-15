import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Option } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  GetProjectionPendingApprovalInput,
  DeleteProjectionPendingApprovalInput,
  ListProjectionPendingApprovalsInput,
  ProjectionPendingApproval,
  ProjectionPendingApprovalRepository,
  type ProjectionPendingApprovalRepositoryShape,
} from "../Services/ProjectionPendingApprovals.ts";

const ApprovalRow = ProjectionPendingApproval.mapFields((fields) => ({
  ...fields,
  approvalIdentity: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  responseAttemptId: Schema.NullOr(Schema.String),
  responseState: Schema.NullOr(Schema.String),
  settlementRequiresIdentity: Schema.Number,
}));
const decodeRow = (row: typeof ApprovalRow.Type) =>
  Schema.decodeUnknownEffect(ProjectionPendingApproval)({
    ...row,
    approvalIdentity: row.approvalIdentity ?? undefined,
    responseAttemptId: row.responseAttemptId ?? undefined,
    responseState: row.responseState ?? undefined,
    settlementRequiresIdentity: row.settlementRequiresIdentity === 1,
  });

const makeProjectionPendingApprovalRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionPendingApprovalRow = SqlSchema.void({
    Request: ProjectionPendingApproval,
    execute: (row) =>
      sql`
        INSERT INTO projection_pending_approvals (
          request_id,
          thread_id,
          turn_id,
          status,
          decision,
          created_at,
          resolved_at, identity_json, response_attempt_id, response_state, settlement_requires_identity
        )
        VALUES (
          ${row.requestId},
          ${row.threadId},
          ${row.turnId},
          ${row.status},
          ${row.decision},
          ${row.createdAt},
          ${row.resolvedAt}, ${row.approvalIdentity ? JSON.stringify(row.approvalIdentity) : null},
          ${row.responseAttemptId ?? null}, ${row.responseState ?? null}, ${row.settlementRequiresIdentity ? 1 : 0}
        )
        ON CONFLICT (thread_id, request_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          status = excluded.status,
          decision = excluded.decision,
          created_at = excluded.created_at,
          resolved_at = excluded.resolved_at,
          identity_json = excluded.identity_json,
          response_attempt_id = excluded.response_attempt_id,
          response_state = excluded.response_state,
          settlement_requires_identity = excluded.settlement_requires_identity
      `,
  });

  const listProjectionPendingApprovalRows = SqlSchema.findAll({
    Request: ListProjectionPendingApprovalsInput,
    Result: ApprovalRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          request_id AS "requestId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          status,
          decision,
          created_at AS "createdAt",
          resolved_at AS "resolvedAt",
          identity_json AS "approvalIdentity", response_attempt_id AS "responseAttemptId",
          response_state AS "responseState", settlement_requires_identity AS "settlementRequiresIdentity"
        FROM projection_pending_approvals
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, request_id ASC
      `,
  });

  const getProjectionPendingApprovalRow = SqlSchema.findOneOption({
    Request: GetProjectionPendingApprovalInput,
    Result: ApprovalRow,
    execute: ({ threadId, requestId }) =>
      sql`
        SELECT
          request_id AS "requestId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          status,
          decision,
          created_at AS "createdAt",
          resolved_at AS "resolvedAt",
          identity_json AS "approvalIdentity", response_attempt_id AS "responseAttemptId",
          response_state AS "responseState", settlement_requires_identity AS "settlementRequiresIdentity"
        FROM projection_pending_approvals
        WHERE thread_id = ${threadId} AND request_id = ${requestId}
      `,
  });

  const deleteProjectionPendingApprovalRow = SqlSchema.void({
    Request: DeleteProjectionPendingApprovalInput,
    execute: ({ threadId, requestId }) =>
      sql`
        DELETE FROM projection_pending_approvals
        WHERE thread_id = ${threadId} AND request_id = ${requestId}
      `,
  });

  const deleteProjectionPendingApprovalRowsByThread = SqlSchema.void({
    Request: ListProjectionPendingApprovalsInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_pending_approvals
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionPendingApprovalRepositoryShape["upsert"] = (row) =>
    upsertProjectionPendingApprovalRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionPendingApprovalRepository.upsert:query")),
    );

  const listByThreadId: ProjectionPendingApprovalRepositoryShape["listByThreadId"] = (input) =>
    listProjectionPendingApprovalRows(input).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
      Effect.mapError(
        toPersistenceSqlError("ProjectionPendingApprovalRepository.listByThreadId:query"),
      ),
    );

  const getByRequestId: ProjectionPendingApprovalRepositoryShape["getByRequestId"] = (input) =>
    getProjectionPendingApprovalRow(input).pipe(
      Effect.flatMap((row) =>
        Option.isSome(row)
          ? decodeRow(row.value).pipe(Effect.map(Option.some))
          : Effect.succeed(Option.none()),
      ),
      Effect.mapError(
        toPersistenceSqlError("ProjectionPendingApprovalRepository.getByRequestId:query"),
      ),
    );

  const deleteByRequestId: ProjectionPendingApprovalRepositoryShape["deleteByRequestId"] = (
    input,
  ) =>
    deleteProjectionPendingApprovalRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionPendingApprovalRepository.deleteByRequestId:query"),
      ),
    );

  const deleteByThreadId: ProjectionPendingApprovalRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionPendingApprovalRowsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionPendingApprovalRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    getByRequestId,
    deleteByRequestId,
    deleteByThreadId,
  } satisfies ProjectionPendingApprovalRepositoryShape;
});

export const ProjectionPendingApprovalRepositoryLive = Layer.effect(
  ProjectionPendingApprovalRepository,
  makeProjectionPendingApprovalRepository,
);
