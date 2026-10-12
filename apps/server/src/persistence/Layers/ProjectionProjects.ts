import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";

import { ModelSelection, ProjectScript } from "@ryco/contracts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionProjectInput,
  GetProjectionProjectInput,
  ListOrphanChatProjectsInput,
  ListProjectionProjectRepositoryIdentityStatesInput,
  ProjectionProject,
  ProjectionProjectRepository,
  ProjectionProjectRepositoryIdentityState,
  RecordProjectionProjectRepositoryIdentityInput,
  type ProjectionProjectRepositoryShape,
} from "../Services/ProjectionProjects.ts";

const ProjectionProjectDbRow = ProjectionProject.mapFields(
  Struct.assign({
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
type ProjectionProjectDbRow = typeof ProjectionProjectDbRow.Type;

const makeProjectionProjectRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionProjectRow = SqlSchema.void({
    Request: ProjectionProject,
    execute: (row) =>
      sql`
        INSERT INTO projection_projects (
          project_id,
          kind,
          title,
          workspace_root,
          project_metadata_dir,
          default_model_selection_json,
          custom_system_prompt,
          custom_avatar_content_hash,
          preferred_remote_name,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.projectId},
          ${row.kind},
          ${row.title},
          ${row.workspaceRoot},
          ${row.projectMetadataDir},
          ${row.defaultModelSelection !== null ? JSON.stringify(row.defaultModelSelection) : null},
          ${row.customSystemPrompt ?? null},
          ${row.customAvatarContentHash ?? null},
          ${row.preferredRemoteName ?? null},
          ${JSON.stringify(row.scripts)},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (project_id)
        DO UPDATE SET
          kind = excluded.kind,
          title = excluded.title,
          workspace_root = excluded.workspace_root,
          project_metadata_dir = excluded.project_metadata_dir,
          default_model_selection_json = excluded.default_model_selection_json,
          custom_system_prompt = excluded.custom_system_prompt,
          custom_avatar_content_hash = excluded.custom_avatar_content_hash,
          preferred_remote_name = excluded.preferred_remote_name,
          scripts_json = excluded.scripts_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at,
          -- A persisted repository identity belongs to the root it was resolved for.
          repository_identity_json = CASE
            WHEN projection_projects.workspace_root = excluded.workspace_root
              THEN projection_projects.repository_identity_json
          END,
          repository_identity_fingerprint = CASE
            WHEN projection_projects.workspace_root = excluded.workspace_root
              THEN projection_projects.repository_identity_fingerprint
          END,
          repository_identity_checked_at = CASE
            WHEN projection_projects.workspace_root = excluded.workspace_root
              THEN projection_projects.repository_identity_checked_at
          END
      `,
  });

  const getProjectionProjectRow = SqlSchema.findOneOption({
    Request: GetProjectionProjectInput,
    Result: ProjectionProjectDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          kind,
          title,
          workspace_root AS "workspaceRoot",
          project_metadata_dir AS "projectMetadataDir",
          default_model_selection_json AS "defaultModelSelection",
          custom_system_prompt AS "customSystemPrompt",
          custom_avatar_content_hash AS "customAvatarContentHash",
          preferred_remote_name AS "preferredRemoteName",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
      `,
  });

  const listProjectionProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRow,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          kind,
          title,
          workspace_root AS "workspaceRoot",
          project_metadata_dir AS "projectMetadataDir",
          default_model_selection_json AS "defaultModelSelection",
          custom_system_prompt AS "customSystemPrompt",
          custom_avatar_content_hash AS "customAvatarContentHash",
          preferred_remote_name AS "preferredRemoteName",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listRepositoryIdentityStateRows = SqlSchema.findAll({
    Request: ListProjectionProjectRepositoryIdentityStatesInput,
    Result: ProjectionProjectRepositoryIdentityState,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          kind,
          workspace_root AS "workspaceRoot",
          repository_identity_json AS "repositoryIdentityJson",
          repository_identity_fingerprint AS "fingerprint",
          repository_identity_checked_at AS "checkedAt"
        FROM projection_projects
        WHERE deleted_at IS NULL
          ${projectId === undefined ? sql`` : sql`AND project_id = ${projectId}`}
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const recordRepositoryIdentityRow = SqlSchema.findAll({
    Request: RecordProjectionProjectRepositoryIdentityInput,
    Result: Schema.Struct({ projectId: Schema.String }),
    execute: (input) =>
      sql`
        UPDATE projection_projects
        SET
          repository_identity_json = ${input.repositoryIdentityJson},
          repository_identity_fingerprint = ${input.fingerprint},
          repository_identity_checked_at = ${input.checkedAt}
        WHERE project_id = ${input.projectId}
          AND workspace_root = ${input.workspaceRoot}
        RETURNING project_id AS "projectId"
      `,
  });

  // The NOT EXISTS predicate is `!isRolledBackThreadCreation(thread)` (ProjectionThreads.ts):
  // live, archived, trashed and used-then-deleted threads all keep the chat.
  const listOrphanChatProjectRows = SqlSchema.findAll({
    Request: ListOrphanChatProjectsInput,
    Result: ProjectionProjectDbRow,
    execute: ({ createdBefore }) =>
      sql`
        SELECT
          project_id AS "projectId",
          kind,
          title,
          workspace_root AS "workspaceRoot",
          project_metadata_dir AS "projectMetadataDir",
          default_model_selection_json AS "defaultModelSelection",
          custom_system_prompt AS "customSystemPrompt",
          custom_avatar_content_hash AS "customAvatarContentHash",
          preferred_remote_name AS "preferredRemoteName",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects AS projects
        WHERE projects.kind = 'chat'
          AND projects.deleted_at IS NULL
          AND projects.created_at < ${createdBefore}
          AND NOT EXISTS (
            SELECT 1 FROM projection_threads AS threads
            WHERE threads.project_id = projects.project_id
              AND NOT (
                threads.deleted_at IS NOT NULL
                AND threads.trashed_at IS NULL
                AND threads.latest_turn_id IS NULL
                AND threads.latest_user_message_at IS NULL
                -- A fork is never unused: it inherited history (isNeverUsedThread).
                AND threads.lineage_source_message_id IS NULL
              )
          )
        ORDER BY projects.created_at ASC, projects.project_id ASC
      `,
  });

  const deleteProjectionProjectRow = SqlSchema.void({
    Request: DeleteProjectionProjectInput,
    execute: ({ projectId }) =>
      sql`
        DELETE FROM projection_projects
        WHERE project_id = ${projectId}
      `,
  });

  const upsert: ProjectionProjectRepositoryShape["upsert"] = (row) =>
    upsertProjectionProjectRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.upsert:query")),
    );

  const getById: ProjectionProjectRepositoryShape["getById"] = (input) =>
    getProjectionProjectRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.getById:query")),
    );

  const listAll: ProjectionProjectRepositoryShape["listAll"] = () =>
    listProjectionProjectRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.listAll:query")),
    );

  const deleteById: ProjectionProjectRepositoryShape["deleteById"] = (input) =>
    deleteProjectionProjectRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.deleteById:query")),
    );

  const listRepositoryIdentityStates: ProjectionProjectRepositoryShape["listRepositoryIdentityStates"] =
    (input = {}) =>
      listRepositoryIdentityStateRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionProjectRepository.listRepositoryIdentityStates:query"),
        ),
      );

  const recordRepositoryIdentity: ProjectionProjectRepositoryShape["recordRepositoryIdentity"] = (
    input,
  ) =>
    recordRepositoryIdentityRow(input).pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(
        toPersistenceSqlError("ProjectionProjectRepository.recordRepositoryIdentity:query"),
      ),
    );

  const listOrphanChatProjects: ProjectionProjectRepositoryShape["listOrphanChatProjects"] = (
    input,
  ) =>
    listOrphanChatProjectRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionProjectRepository.listOrphanChatProjects:query"),
      ),
    );

  return {
    upsert,
    getById,
    listAll,
    deleteById,
    listRepositoryIdentityStates,
    recordRepositoryIdentity,
    listOrphanChatProjects,
  } satisfies ProjectionProjectRepositoryShape;
});

export const ProjectionProjectRepositoryLive = Layer.effect(
  ProjectionProjectRepository,
  makeProjectionProjectRepository,
);
