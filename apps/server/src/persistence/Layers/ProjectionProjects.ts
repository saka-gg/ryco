import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";

import { ModelSelection, ProjectScript } from "@ryco/contracts";
import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionProjectInput,
  GetProjectionProjectInput,
  ProjectionProject,
  ProjectionProjectRepository,
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
          deleted_at = excluded.deleted_at
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

  return {
    upsert,
    getById,
    listAll,
    deleteById,
  } satisfies ProjectionProjectRepositoryShape;
});

export const ProjectionProjectRepositoryLive = Layer.effect(
  ProjectionProjectRepository,
  makeProjectionProjectRepository,
);
