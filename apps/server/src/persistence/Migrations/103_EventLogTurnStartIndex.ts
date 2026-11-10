import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export const TURN_START_INDEX = "idx_orch_events_thread_turn_starts";

/**
 * A partial index of the turn starts in the event log: `(aggregate_kind, stream_id, sequence)`
 * of every `thread.turn-start-requested` event, about one event in 500.
 *
 * Event-log retention (`EventLogRetention.ts`) looks up every thread's latest turn start each
 * pass. Through the stream index that walks each stream backwards from its newest event, reading
 * the row of every event after the latest turn start: on a 10 GB database (650,000 events, 1,000
 * threads) about 125,000 pages per pass, which held the server's event loop for 7 to 9 s every 6
 * hours. Through this index it is one seek per thread (about 500 pages, 4 ms). The completion
 * return and restart-continuation reads that search a stream's turn starts use it too.
 *
 * Building it reads the event table once (0.5 s on that database with a warm cache). Each later
 * turn start adds one small index entry.
 *
 * Idempotent: it also runs as a post-migrator repair, because the migrator skips ids at or
 * below the latest applied one and parallel branches may claim the same id.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql.unsafe(`
    CREATE INDEX IF NOT EXISTS ${TURN_START_INDEX}
    ON orchestration_events(aggregate_kind, stream_id, sequence)
    WHERE event_type = 'thread.turn-start-requested'
  `);
});
