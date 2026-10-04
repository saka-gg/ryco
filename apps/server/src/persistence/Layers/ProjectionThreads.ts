import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  AttachProjectionThreadToWorktreeInput,
  SetProjectionThreadManualBucketInput,
  SetProjectionThreadManualPositionInput,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";
import { DEFAULT_AGENT_TOKEN_MODE, ModelSelection, ThreadGoal } from "@ryco/contracts";

const ProjectionThreadDbRow = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    goal: Schema.NullOr(Schema.fromJsonString(ThreadGoal)),
  }),
);
type ProjectionThreadDbRow = typeof ProjectionThreadDbRow.Type;

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThread,
    execute: (row) =>
      sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          token_mode,
          branch,
          worktree_path,
          worktree_id,
          manual_status_bucket,
          manual_position,
          latest_turn_id,
          goal_json,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          snoozed_until,
          snoozed_at,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          deleted_at,
          lineage_parent_thread_id,
          lineage_root_thread_id,
          lineage_relationship
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.title},
          ${JSON.stringify(row.modelSelection)},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE},
          ${row.branch},
          ${row.worktreePath},
          ${row.worktreeId ?? null},
          ${row.manualStatusBucket ?? null},
          ${row.manualPosition ?? 0},
          ${row.latestTurnId},
          ${row.goal === null ? null : JSON.stringify(row.goal)},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.archivedAt},
          ${row.settledOverride},
          ${row.settledAt},
          ${row.snoozedUntil ?? null},
          ${row.snoozedAt ?? null},
          ${row.latestUserMessageAt},
          ${row.pendingApprovalCount},
          ${row.pendingUserInputCount},
          ${row.hasActionableProposedPlan},
          ${row.deletedAt},
          ${row.lineageParentThreadId},
          ${row.lineageRootThreadId},
          ${row.lineageRelationship}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          token_mode = excluded.token_mode,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          worktree_id = excluded.worktree_id,
          manual_status_bucket = excluded.manual_status_bucket,
          manual_position = excluded.manual_position,
          latest_turn_id = excluded.latest_turn_id,
          goal_json = excluded.goal_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at,
          settled_override = excluded.settled_override,
          settled_at = excluded.settled_at,
          snoozed_until = excluded.snoozed_until,
          snoozed_at = excluded.snoozed_at,
          latest_user_message_at = excluded.latest_user_message_at,
          pending_approval_count = excluded.pending_approval_count,
          pending_user_input_count = excluded.pending_user_input_count,
          has_actionable_proposed_plan = excluded.has_actionable_proposed_plan,
          deleted_at = excluded.deleted_at,
          lineage_parent_thread_id = excluded.lineage_parent_thread_id,
          lineage_root_thread_id = excluded.lineage_root_thread_id,
          lineage_relationship = excluded.lineage_relationship
      `,
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          token_mode AS "tokenMode",
          branch,
          worktree_path AS "worktreePath",
          worktree_id AS "worktreeId",
          manual_status_bucket AS "manualStatusBucket",
          manual_position AS "manualPosition",
          latest_turn_id AS "latestTurnId",
          goal_json AS "goal",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt",
          lineage_parent_thread_id AS "lineageParentThreadId",
          lineage_root_thread_id AS "lineageRootThreadId",
          lineage_relationship AS "lineageRelationship"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThreadDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          token_mode AS "tokenMode",
          branch,
          worktree_path AS "worktreePath",
          worktree_id AS "worktreeId",
          manual_status_bucket AS "manualStatusBucket",
          manual_position AS "manualPosition",
          latest_turn_id AS "latestTurnId",
          goal_json AS "goal",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt",
          lineage_parent_thread_id AS "lineageParentThreadId",
          lineage_root_thread_id AS "lineageRootThreadId",
          lineage_relationship AS "lineageRelationship"
        FROM projection_threads
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const deleteProjectionThreadRow = SqlSchema.void({
    Request: DeleteProjectionThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const attachProjectionThreadToWorktree = SqlSchema.void({
    Request: AttachProjectionThreadToWorktreeInput,
    execute: ({ threadId, worktreeId }) =>
      sql`
        UPDATE projection_threads
        SET worktree_id = ${worktreeId}
        WHERE thread_id = ${threadId}
      `,
  });

  const setProjectionThreadManualBucket = SqlSchema.void({
    Request: SetProjectionThreadManualBucketInput,
    execute: ({ threadId, bucket }) =>
      sql`
        UPDATE projection_threads
        SET manual_status_bucket = ${bucket}
        WHERE thread_id = ${threadId}
      `,
  });

  const setProjectionThreadManualPosition = SqlSchema.void({
    Request: SetProjectionThreadManualPositionInput,
    execute: ({ threadId, position }) =>
      sql`
        UPDATE projection_threads
        SET manual_position = ${position}
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:query")),
    );

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.getById:query")),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listByProjectId:query")),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );

  const attachToWorktree: ProjectionThreadRepositoryShape["attachToWorktree"] = (input) =>
    attachProjectionThreadToWorktree(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.attachToWorktree:query")),
    );

  const setManualBucket: ProjectionThreadRepositoryShape["setManualBucket"] = (input) =>
    setProjectionThreadManualBucket(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.setManualBucket:query")),
    );

  const setManualPosition: ProjectionThreadRepositoryShape["setManualPosition"] = (input) =>
    setProjectionThreadManualPosition(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.setManualPosition:query")),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
    attachToWorktree,
    setManualBucket,
    setManualPosition,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);
