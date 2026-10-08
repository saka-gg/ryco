import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";

import {
  type ProjectionRepositoryError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../Errors.ts";
import {
  GetProjectRelocationInput,
  ListProjectRelocationsByProjectInput,
  ProjectRelocation,
  ProjectRelocationRepository,
  type ProjectRelocationRepositoryShape,
  UpdateProjectRelocationInput,
} from "../Services/ProjectRelocations.ts";

const ProjectRelocationDbRow = ProjectRelocation.mapFields(
  Struct.assign({ destinationCreated: Schema.BooleanFromBit }),
);
const UpdateProjectRelocationDbInput = UpdateProjectRelocationInput.mapFields(
  Struct.assign({ destinationCreated: Schema.BooleanFromBit }),
);
const RelocationIdResult = Schema.Struct({ relocationId: Schema.String });

const toError =
  (operation: string) =>
  (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(`${operation}:decode`)(cause)
      : toPersistenceSqlError(`${operation}:query`)(cause);

const makeProjectRelocationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectColumns = sql.literal(`
    relocation_id AS "relocationId",
    project_id AS "projectId",
    source_path AS "sourcePath",
    destination_path AS "destinationPath",
    strategy,
    state,
    destination_created AS "destinationCreated",
    title,
    error,
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `);

  const insertRow = SqlSchema.void({
    Request: ProjectRelocationDbRow,
    execute: (row) => sql`
      INSERT INTO project_relocations (
        relocation_id, project_id, source_path, destination_path, strategy, state,
        destination_created, title, error, created_at, updated_at
      ) VALUES (
        ${row.relocationId}, ${row.projectId}, ${row.sourcePath}, ${row.destinationPath},
        ${row.strategy}, ${row.state}, ${row.destinationCreated}, ${row.title}, ${row.error},
        ${row.createdAt}, ${row.updatedAt}
      )
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetProjectRelocationInput,
    Result: ProjectRelocationDbRow,
    execute: ({ relocationId }) => sql`
      SELECT ${selectColumns}
      FROM project_relocations
      WHERE relocation_id = ${relocationId}
    `,
  });

  const listUnresolvedRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectRelocationDbRow,
    execute: () => sql`
      SELECT ${selectColumns}
      FROM project_relocations
      WHERE state IN ('pending', 'moved')
      ORDER BY created_at ASC, relocation_id ASC
    `,
  });

  const listUnresolvedRowsByProject = SqlSchema.findAll({
    Request: ListProjectRelocationsByProjectInput,
    Result: ProjectRelocationDbRow,
    execute: ({ projectId }) => sql`
      SELECT ${selectColumns}
      FROM project_relocations
      WHERE project_id = ${projectId} AND state IN ('pending', 'moved')
      ORDER BY created_at ASC, relocation_id ASC
    `,
  });

  const updateRow = SqlSchema.findAll({
    Request: UpdateProjectRelocationDbInput,
    Result: RelocationIdResult,
    execute: (input) => sql`
      UPDATE project_relocations
      SET state = ${input.state},
          strategy = ${input.strategy},
          destination_created = ${input.destinationCreated},
          error = ${input.error},
          updated_at = ${input.updatedAt}
      WHERE relocation_id = ${input.relocationId}
        AND state IN ('pending', 'moved')
      RETURNING relocation_id AS "relocationId"
    `,
  });

  const create: ProjectRelocationRepositoryShape["create"] = (row) =>
    insertRow(row).pipe(Effect.mapError(toError("ProjectRelocationRepository.create")));

  const getById: ProjectRelocationRepositoryShape["getById"] = (input) =>
    getRow(input).pipe(Effect.mapError(toError("ProjectRelocationRepository.getById")));

  const listUnresolved: ProjectRelocationRepositoryShape["listUnresolved"] = () =>
    listUnresolvedRows().pipe(
      Effect.mapError(toError("ProjectRelocationRepository.listUnresolved")),
    );

  const listUnresolvedByProjectId: ProjectRelocationRepositoryShape["listUnresolvedByProjectId"] = (
    input,
  ) =>
    listUnresolvedRowsByProject(input).pipe(
      Effect.mapError(toError("ProjectRelocationRepository.listUnresolvedByProjectId")),
    );

  const update: ProjectRelocationRepositoryShape["update"] = (input) =>
    updateRow(input).pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(toError("ProjectRelocationRepository.update")),
    );

  return {
    create,
    getById,
    listUnresolved,
    listUnresolvedByProjectId,
    update,
  } satisfies ProjectRelocationRepositoryShape;
});

export const ProjectRelocationRepositoryLive = Layer.effect(
  ProjectRelocationRepository,
  makeProjectRelocationRepository,
);
