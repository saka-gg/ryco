/**
 * EventLogTimeSearch - finds a position in the event log by time without scanning it.
 *
 * `occurred_at` has no index, so a filter on it alone reads every row the sequence order passes.
 * Events are appended in nearly time order, so a binary search over the sequence key (one seek
 * per step, about 20 for a million events) finds the boundary; holes left by compaction and
 * retention are tolerated. A clock that went backwards can misplace it by the events written
 * meanwhile, which only the bounded readers below accept.
 *
 * @module EventLogTimeSearch
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** The largest sequence at most `head` whose event is older than `cutoffIso` (0 when none). */
export const lastSequenceBefore = (sql: SqlClient.SqlClient, cutoffIso: string, head: number) =>
  Effect.gen(function* () {
    let lo = 0;
    let hi = head;
    while (lo < hi) {
      const mid = lo + Math.ceil((hi - lo) / 2);
      const [row] = yield* sql<{ readonly sequence: number; readonly occurredAt: string | null }>`
        SELECT sequence, occurred_at AS "occurredAt" FROM orchestration_events
        WHERE sequence >= ${mid} AND sequence <= ${hi}
        ORDER BY sequence LIMIT 1
      `;
      if (row === undefined || row.occurredAt === null || !(row.occurredAt < cutoffIso)) {
        hi = mid - 1;
      } else {
        lo = Number(row.sequence);
      }
    }
    return lo;
  });
