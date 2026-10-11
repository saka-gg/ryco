import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("040_ProjectionThreadsProjectUpdatedAtIndex", (it) => {
  it.effect("creates the project/updated_at recency index for threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 39 });
      yield* runMigrations({ toMigrationInclusive: 40 });

      const threadIndexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(projection_threads)
      `;
      assert.ok(
        threadIndexes.some((index) => index.name === "idx_projection_threads_project_updated_at"),
      );

      const threadIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_projection_threads_project_updated_at')
      `;
      assert.deepStrictEqual(
        threadIndexColumns.map((column) => column.name),
        ["project_id", "updated_at"],
      );
    }),
  );

  it.effect("ensures the orchestration event stream/sequence index exists", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 40 });

      const eventIndexes = yield* sql<{
        readonly seq: number;
        readonly name: string;
        readonly unique: number;
        readonly origin: string;
        readonly partial: number;
      }>`
        PRAGMA index_list(orchestration_events)
      `;
      assert.ok(eventIndexes.some((index) => index.name === "idx_orch_events_stream_sequence"));

      const eventIndexColumns = yield* sql<{
        readonly seqno: number;
        readonly cid: number;
        readonly name: string;
      }>`
        PRAGMA index_info('idx_orch_events_stream_sequence')
      `;
      assert.deepStrictEqual(
        eventIndexColumns.map((column) => column.name),
        ["aggregate_kind", "stream_id", "sequence"],
      );
    }),
  );
});
