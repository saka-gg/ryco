import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One row per thread that ever watched a pull request (`thread.pull-request-watch-updated`).
 *
 * - `watches_json`: the full state (`ThreadPullRequestWatches`, active and ended), read once when
 *   the server hydrates its command read model.
 * - `summary_json`: what thread shells show (`ThreadPullRequestWatchShell`), computed by the
 *   projector, so shell reads never parse the full state or load the decision rules.
 * - `active_count`: active watches, so the sweep and the settlement queries find watched threads
 *   through the partial index without reading JSON.
 *
 * No backfill: no watch event exists before this table. A projection rebuild reproduces it.
 *
 * Idempotent: it also runs as a post-migrator repair, because the migrator skips ids at or
 * below the latest applied one and parallel branches may claim the same id (the cross-node
 * project copy branch also numbers its migration 094). Returns whether the table was missing.
 */
export const ensurePullRequestWatchesTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const existing = yield* sql`
        SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_thread_pull_request_watches'
      `;
      yield* sql`CREATE TABLE IF NOT EXISTS projection_thread_pull_request_watches (
        thread_id TEXT PRIMARY KEY,
        watches_json TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        active_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      )`;
      yield* sql`CREATE INDEX IF NOT EXISTS idx_projection_thread_pull_request_watches_active
        ON projection_thread_pull_request_watches (thread_id) WHERE active_count > 0`;
      return existing.length === 0;
    }),
  );
});

export default ensurePullRequestWatchesTable.pipe(Effect.asVoid);
