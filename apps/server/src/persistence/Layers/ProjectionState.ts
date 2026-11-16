import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Effect, Layer, Schema } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionStateRepository,
  type ProjectionStateRepositoryShape,
  ProjectionState,
} from "../Services/ProjectionState.ts";

const makeProjectionStateRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionState,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
        ORDER BY projector ASC
      `,
  });

  const upsertMany: ProjectionStateRepositoryShape["upsertMany"] = (rows) => {
    if (rows.length === 0) {
      return Effect.void;
    }
    return sql`
      INSERT INTO projection_state ${sql.insert(
        rows.map((row) => ({
          projector: row.projector,
          last_applied_sequence: row.lastAppliedSequence,
          updated_at: row.updatedAt,
        })),
      )}
      ON CONFLICT (projector)
      DO UPDATE SET
        last_applied_sequence = excluded.last_applied_sequence,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProjectionStateRepository.upsertMany:query")),
    );
  };

  const listAll: ProjectionStateRepositoryShape["listAll"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionStateRepository.listAll:query")),
    );

  return { upsertMany, listAll } satisfies ProjectionStateRepositoryShape;
});

export const ProjectionStateRepositoryLive = Layer.effect(
  ProjectionStateRepository,
  makeProjectionStateRepository,
);
