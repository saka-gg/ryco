import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The tables migration 053 created for the removed inbox ranking, rankings first (foreign key). */
export const THREAD_PRIORITY_TABLES = [
  "thread_priority_rankings",
  "thread_priority_batches",
] as const;

/**
 * Drops the tables of the removed inbox ranking (migration 053) and, with them, their indexes.
 * Nothing reads or writes them any more.
 *
 * Not a numbered migration: it runs as an unnumbered compatibility repair, so it needs no id
 * against the ones parallel branches claim. Idempotent; returns whether any table was dropped.
 */
export const dropThreadPriorityTables = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const existing = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ${sql.in(THREAD_PRIORITY_TABLES)}
      `;
      const present = new Set(existing.map((row) => row.name));
      const stale = THREAD_PRIORITY_TABLES.filter((name) => present.has(name));
      for (const name of stale) {
        yield* sql.unsafe(`DROP TABLE IF EXISTS ${name}`);
      }
      return stale.length > 0;
    }),
  );
});
