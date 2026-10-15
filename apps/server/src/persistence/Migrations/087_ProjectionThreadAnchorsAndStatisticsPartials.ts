import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Two read-path summaries, so hydration and shell builds stop running per-thread correlated
 * subqueries, and persisted statistics partials, so the first statistics open after a restart
 * does not recompute the whole history.
 *
 * 1. `projection_threads` gains
 *    - `first_user_message_id`: the thread's oldest user message (created_at, message_id), the
 *      rule of `firstUserMessageIdQuery`;
 *    - `latest_user_message_id`: its newest user message (created_at DESC, rowid DESC), the ONE
 *      rule of `latestUserMessageIdQuery` that the delegated-return fence depends on;
 *    - `latest_completed_turn_at`: the completion time of the latest settled, non-inherited turn
 *      that is not the session's active turn, the rule of the snapshot query's former
 *      `latestCompletedTurnAt` subquery.
 *    Triggers on every input table (messages, turns, sessions, and thread inserts) recompute the
 *    affected thread's values with the same indexed lookups the subqueries ran, so the columns
 *    equal the subqueries after any write path: projectors, imports, forks, reverts, deletes and
 *    the offline CLI alike. Assistant-message streaming does not fire them (role filter).
 * 2. `statistics_thread_partials` and `statistics_partials_state` persist the per-thread
 *    statistics partials (see statistics/StatisticsQuery.ts). They are a cache: dropping their
 *    rows only costs one full recompute.
 *
 * The trigger SQL is frozen here on purpose (it must not follow later edits of the read
 * queries); parity with those queries is pinned by tests.
 *
 * Idempotent: it also runs as a post-migrator repair, because the migrator skips ids at or below
 * the latest applied one and parallel branches may claim the same id. The backfill runs only when
 * the columns are created.
 */
const COLUMNS = ["first_user_message_id", "latest_user_message_id", "latest_completed_turn_at"];

/** `inheritedTurnRowSql` with the `:inherited:` segment (11 characters) inlined. */
const INHERITED_TURN = `(turns.assistant_message_id IS NOT NULL
  AND substr(turns.assistant_message_id, 1, length(turns.thread_id) + 11) = turns.thread_id || ':inherited:')`;

const firstUserMessageId = (thread: string) => `(
  SELECT first_user.message_id FROM projection_thread_messages first_user
  WHERE first_user.thread_id = ${thread} AND first_user.role = 'user'
  ORDER BY first_user.created_at ASC, first_user.message_id ASC
  LIMIT 1
)`;

const latestUserMessageId = (thread: string) => `(
  SELECT latest_user.message_id FROM projection_thread_messages latest_user
  WHERE latest_user.thread_id = ${thread} AND latest_user.role = 'user'
  ORDER BY latest_user.created_at DESC, latest_user.rowid DESC
  LIMIT 1
)`;

/** Frozen rule; 091 reuses it so its guarded trigger stays byte-identical in effect. */
export const latestCompletedTurnAt = (thread: string) => `(
  SELECT turns.completed_at FROM projection_turns AS turns
  WHERE turns.thread_id = ${thread}
    AND turns.state = 'completed'
    AND turns.completed_at IS NOT NULL
    AND NOT ${INHERITED_TURN}
    AND NOT EXISTS (
      SELECT 1 FROM projection_thread_sessions AS sessions
      WHERE sessions.thread_id = turns.thread_id AND sessions.active_turn_id = turns.turn_id
    )
  ORDER BY turns.requested_at DESC, turns.turn_id DESC
  LIMIT 1
)`;

const updateAnchors = (thread: string) => `
  UPDATE projection_threads SET
    first_user_message_id = ${firstUserMessageId(thread)},
    latest_user_message_id = ${latestUserMessageId(thread)}
  WHERE thread_id = ${thread};`;

const updateLatestCompleted = (thread: string) => `
  UPDATE projection_threads SET latest_completed_turn_at = ${latestCompletedTurnAt(thread)}
  WHERE thread_id = ${thread};`;

/** name -> CREATE statement. */
const TRIGGERS: ReadonlyArray<readonly [string, string]> = [
  [
    "projection_threads_summary_insert",
    `CREATE TRIGGER projection_threads_summary_insert AFTER INSERT ON projection_threads
     BEGIN
       ${updateAnchors("NEW.thread_id")}
       ${updateLatestCompleted("NEW.thread_id")}
     END`,
  ],
  [
    "projection_thread_messages_user_anchor_insert",
    `CREATE TRIGGER projection_thread_messages_user_anchor_insert
     AFTER INSERT ON projection_thread_messages WHEN NEW.role = 'user'
     BEGIN ${updateAnchors("NEW.thread_id")} END`,
  ],
  [
    "projection_thread_messages_user_anchor_update",
    `CREATE TRIGGER projection_thread_messages_user_anchor_update
     AFTER UPDATE OF thread_id, role, created_at, message_id ON projection_thread_messages
     WHEN OLD.role = 'user' OR NEW.role = 'user'
     BEGIN
       ${updateAnchors("NEW.thread_id")}
       ${updateAnchors("OLD.thread_id")}
     END`,
  ],
  [
    "projection_thread_messages_user_anchor_delete",
    `CREATE TRIGGER projection_thread_messages_user_anchor_delete
     AFTER DELETE ON projection_thread_messages WHEN OLD.role = 'user'
     BEGIN ${updateAnchors("OLD.thread_id")} END`,
  ],
  [
    "projection_turns_latest_completed_insert",
    `CREATE TRIGGER projection_turns_latest_completed_insert AFTER INSERT ON projection_turns
     BEGIN ${updateLatestCompleted("NEW.thread_id")} END`,
  ],
  [
    "projection_turns_latest_completed_update",
    `CREATE TRIGGER projection_turns_latest_completed_update
     AFTER UPDATE OF thread_id, turn_id, state, completed_at, requested_at, assistant_message_id
     ON projection_turns
     BEGIN
       ${updateLatestCompleted("NEW.thread_id")}
       ${updateLatestCompleted("OLD.thread_id")}
     END`,
  ],
  [
    "projection_turns_latest_completed_delete",
    `CREATE TRIGGER projection_turns_latest_completed_delete AFTER DELETE ON projection_turns
     BEGIN ${updateLatestCompleted("OLD.thread_id")} END`,
  ],
  [
    "projection_thread_sessions_latest_completed_insert",
    `CREATE TRIGGER projection_thread_sessions_latest_completed_insert
     AFTER INSERT ON projection_thread_sessions
     BEGIN ${updateLatestCompleted("NEW.thread_id")} END`,
  ],
  [
    "projection_thread_sessions_latest_completed_update",
    `CREATE TRIGGER projection_thread_sessions_latest_completed_update
     AFTER UPDATE OF thread_id, active_turn_id ON projection_thread_sessions
     WHEN OLD.active_turn_id IS NOT NEW.active_turn_id OR OLD.thread_id IS NOT NEW.thread_id
     BEGIN
       ${updateLatestCompleted("NEW.thread_id")}
       ${updateLatestCompleted("OLD.thread_id")}
     END`,
  ],
  [
    "projection_thread_sessions_latest_completed_delete",
    `CREATE TRIGGER projection_thread_sessions_latest_completed_delete
     AFTER DELETE ON projection_thread_sessions
     BEGIN ${updateLatestCompleted("OLD.thread_id")} END`,
  ],
];

const REQUIRED_TABLES = [
  "projection_threads",
  "projection_thread_messages",
  "projection_turns",
  "projection_thread_sessions",
];

export const ensureProjectionThreadAnchorsAndStatisticsPartials = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  let changed = false;

  const statisticsTables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('statistics_thread_partials', 'statistics_partials_state')
  `;
  if (statisticsTables.length < 2) {
    yield* sql`
      CREATE TABLE IF NOT EXISTS statistics_thread_partials (
        thread_id TEXT PRIMARY KEY,
        partial_json TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS statistics_partials_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        format_version INTEGER NOT NULL,
        schema_version TEXT NOT NULL,
        covered_sequence INTEGER NOT NULL,
        event_sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      )
    `;
    changed = true;
  }

  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ${sql.in(REQUIRED_TABLES)}
  `;
  if (tables.length < REQUIRED_TABLES.length) return changed;

  const columns = new Set(
    (yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`).map(
      (column) => column.name,
    ),
  );
  const missingColumns = COLUMNS.filter((column) => !columns.has(column));
  for (const column of missingColumns) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN ${sql.literal(column)} TEXT`;
  }

  const existingTriggers = new Set(
    (yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN ${sql.in(
        TRIGGERS.map(([name]) => name),
      )}
    `).map((row) => row.name),
  );
  for (const [name, statement] of TRIGGERS) {
    if (existingTriggers.has(name)) continue;
    yield* sql.unsafe(statement);
    changed = true;
  }

  if (missingColumns.length > 0) {
    yield* sql.unsafe(`
      UPDATE projection_threads SET
        first_user_message_id = ${firstUserMessageId("projection_threads.thread_id")},
        latest_user_message_id = ${latestUserMessageId("projection_threads.thread_id")},
        latest_completed_turn_at = ${latestCompletedTurnAt("projection_threads.thread_id")}
    `);
    changed = true;
  }
  return changed;
});

export default Effect.asVoid(ensureProjectionThreadAnchorsAndStatisticsPartials);
