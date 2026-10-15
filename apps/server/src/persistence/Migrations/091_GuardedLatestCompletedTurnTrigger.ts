import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { latestCompletedTurnAt } from "./087_ProjectionThreadAnchorsAndStatisticsPartials.ts";

/**
 * Guards `projection_turns_latest_completed_update` (087) with a value-change WHEN clause.
 *
 * `ProjectionTurns.upsertByTurnId` always lists the watched columns in its DO UPDATE SET, so the
 * unguarded trigger recomputed `latest_completed_turn_at` twice (NEW and OLD thread) and rewrote
 * the thread row for every turn upsert, including the one each streamed assistant delta causes,
 * even when nothing it reads changed. The guarded trigger fires only when a watched value
 * changes, and recomputes the OLD thread only when the turn moved between threads. The rule SQL
 * is 087's frozen `latestCompletedTurnAt`, so the column keeps the same values.
 *
 * The trigger keeps its 087 name on purpose: the 087 repair recreates triggers that are missing
 * by name, so a renamed trigger would bring the unguarded body back next to this one.
 *
 * Idempotent: it also runs as a post-migrator repair, after the 087 repair, because the migrator
 * skips ids at or below the latest applied one and parallel branches may claim the same id. It
 * replaces the trigger only while it exists and its stored body lacks the guard.
 */
const TRIGGER_NAME = "projection_turns_latest_completed_update";

const WATCHED_COLUMNS = [
  "thread_id",
  "turn_id",
  "state",
  "completed_at",
  "requested_at",
  "assistant_message_id",
] as const;

/** Present in the stored trigger SQL once the guarded body is installed. */
const GUARD = WATCHED_COLUMNS.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ");

const GUARDED_TRIGGER = `CREATE TRIGGER ${TRIGGER_NAME}
     AFTER UPDATE OF ${WATCHED_COLUMNS.join(", ")}
     ON projection_turns
     WHEN ${GUARD}
     BEGIN
       UPDATE projection_threads SET latest_completed_turn_at = ${latestCompletedTurnAt("NEW.thread_id")}
       WHERE thread_id = NEW.thread_id;
       UPDATE projection_threads SET latest_completed_turn_at = ${latestCompletedTurnAt("OLD.thread_id")}
       WHERE thread_id = OLD.thread_id AND OLD.thread_id IS NOT NEW.thread_id;
     END`;

export const ensureGuardedLatestCompletedTurnTrigger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const [existing] = yield* sql<{ readonly sql: string | null }>`
    SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ${TRIGGER_NAME}
  `;
  // 087 (or its repair, which runs first) creates the trigger once its tables exist.
  if (existing === undefined || existing.sql?.includes(GUARD) === true) return false;

  yield* sql.unsafe(`DROP TRIGGER IF EXISTS ${TRIGGER_NAME}`);
  yield* sql.unsafe(GUARDED_TRIGGER);
  return true;
});

export default Effect.asVoid(ensureGuardedLatestCompletedTurnTrigger);
