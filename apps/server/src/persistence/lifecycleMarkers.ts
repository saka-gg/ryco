/**
 * lifecycleMarkers - small key/value records of one-time and recurring maintenance state.
 *
 * The `lifecycle_markers (key TEXT PRIMARY KEY, value TEXT)` table exists since migration 089
 * (repaired after the ledger, so every migrated database has it). It holds state that needs no
 * schema of its own: the Trash retirement time, the event-log compaction cursor.
 *
 * @module lifecycleMarkers
 */
import { Effect, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

export const readLifecycleMarker = (key: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly value: string }>`
      SELECT value FROM lifecycle_markers WHERE key = ${key}
    `;
    return Option.fromNullishOr(rows[0]?.value);
  });

/** Records a marker unless one exists; returns the stored value (the first writer wins). */
export const writeLifecycleMarkerOnce = (key: string, value: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT OR IGNORE INTO lifecycle_markers (key, value) VALUES (${key}, ${value})`;
    const stored = yield* readLifecycleMarker(key);
    return Option.getOrElse(stored, () => value);
  });

/** Records a marker, replacing any earlier value (the last writer wins). */
export const writeLifecycleMarker = (key: string, value: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO lifecycle_markers (key, value) VALUES (${key}, ${value})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `;
  });
