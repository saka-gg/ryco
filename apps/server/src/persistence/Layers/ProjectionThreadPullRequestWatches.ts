import { ThreadPullRequestWatches } from "@ryco/contracts";
import { summarizePullRequestWatches } from "@ryco/shared/pullRequestWatchSummary";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Effect, Layer, Schema, Struct } from "effect";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ProjectionThreadPullRequestWatches,
  ProjectionThreadPullRequestWatchesThreadInput,
  ProjectionThreadPullRequestWatchRepository,
  type ProjectionThreadPullRequestWatchRepositoryShape,
} from "../Services/ProjectionThreadPullRequestWatches.ts";

const ProjectionThreadPullRequestWatchesDbRow = ProjectionThreadPullRequestWatches.mapFields(
  Struct.assign({ watches: Schema.fromJsonString(ThreadPullRequestWatches) }),
);

const makeProjectionThreadPullRequestWatchRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Written as JSON computed here: the shell summary needs the decoded watches.
  const upsertRow = (row: ProjectionThreadPullRequestWatches) =>
    sql`
      INSERT INTO projection_thread_pull_request_watches (
        thread_id,
        watches_json,
        summary_json,
        active_count,
        updated_at
      )
      VALUES (
        ${row.threadId},
        ${JSON.stringify(row.watches)},
        ${JSON.stringify(summarizePullRequestWatches(row.watches))},
        ${row.watches.active.length},
        ${row.updatedAt}
      )
      ON CONFLICT (thread_id)
      DO UPDATE SET
        watches_json = excluded.watches_json,
        summary_json = excluded.summary_json,
        active_count = excluded.active_count,
        updated_at = excluded.updated_at
    `;

  const deleteRow = SqlSchema.void({
    Request: ProjectionThreadPullRequestWatchesThreadInput,
    execute: ({ threadId }) =>
      sql`DELETE FROM projection_thread_pull_request_watches WHERE thread_id = ${threadId}`,
  });

  const getRow = SqlSchema.findOneOption({
    Request: ProjectionThreadPullRequestWatchesThreadInput,
    Result: ProjectionThreadPullRequestWatchesDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT thread_id AS "threadId", watches_json AS "watches", updated_at AS "updatedAt"
        FROM projection_thread_pull_request_watches
        WHERE thread_id = ${threadId}
      `,
  });

  const listActiveRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadPullRequestWatchesDbRow,
    execute: () =>
      sql`
        SELECT thread_id AS "threadId", watches_json AS "watches", updated_at AS "updatedAt"
        FROM projection_thread_pull_request_watches
        WHERE active_count > 0
        ORDER BY updated_at ASC, thread_id ASC
      `,
  });

  const upsert: ProjectionThreadPullRequestWatchRepositoryShape["upsert"] = (row) =>
    upsertRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadPullRequestWatchRepository.upsert:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadPullRequestWatchRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadPullRequestWatchRepository.deleteByThreadId:query"),
      ),
    );

  const getByThreadId: ProjectionThreadPullRequestWatchRepositoryShape["getByThreadId"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadPullRequestWatchRepository.getByThreadId:query"),
      ),
    );

  const listActive: ProjectionThreadPullRequestWatchRepositoryShape["listActive"] = () =>
    listActiveRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadPullRequestWatchRepository.listActive:query"),
      ),
    );

  return {
    upsert,
    deleteByThreadId,
    getByThreadId,
    listActive,
  } satisfies ProjectionThreadPullRequestWatchRepositoryShape;
});

export const ProjectionThreadPullRequestWatchRepositoryLive = Layer.effect(
  ProjectionThreadPullRequestWatchRepository,
  makeProjectionThreadPullRequestWatchRepository,
);
