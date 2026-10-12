import { EventId } from "@ryco/contracts";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  BOUNDED_TOOL_ACTIVITY_KINDS,
  LEGACY_ACTIVITY_PAYLOAD_MIN_BYTES,
  reprojectLegacyToolActivityPayload,
} from "../../orchestration/legacyActivityPayloads.ts";

/** Rows read and rewritten per statement, so a large legacy history never sits in memory at once. */
const BATCH_SIZE = 64;
export const LEGACY_ACTIVITY_PAYLOADS_REPAIR_KEY = "legacy-activity-payloads-v1";

/**
 * Re-projects tool activity rows written before ingestion bounded tool data.
 *
 * Rows from before #481 (2026-08-30) and #508 (2026-09-03) keep raw tool output,
 * up to 1 MB in one `tool.completed`. Every window, history page and full thread
 * read parses them, and they dominate the projection table. This rewrites each
 * such row to the payload ingestion writes today: strings capped to a head and
 * tail, `tool.updated` data projected to the fields clients read, Ryco HTML tool
 * pages reduced to their length. Smaller rows and exempt item types (images,
 * file diffs) are untouched.
 *
 * Only the projection changes. The event log keeps every original payload, so a
 * projection rebuild or an export from events still sees the raw data.
 *
 * Idempotent and recorded in `ryco_compatibility_repairs`: it also runs as a
 * post-migrator repair when another branch recorded id 088 first.
 */
export const reprojectLegacyActivityPayloads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name = 'projection_thread_activities'
  `;
  if (tables.length === 0) return 0;
  yield* sql`
    CREATE TABLE IF NOT EXISTS ryco_compatibility_repairs (
      repair_key TEXT PRIMARY KEY
    )
  `;
  const completed = yield* sql`
    SELECT repair_key FROM ryco_compatibility_repairs
    WHERE repair_key = ${LEGACY_ACTIVITY_PAYLOADS_REPAIR_KEY}
  `;
  if (completed.length > 0) return 0;

  const candidates = yield* sql<{ readonly activityId: string }>`
    SELECT activity_id AS "activityId"
    FROM projection_thread_activities
    WHERE kind IN ${sql.in(BOUNDED_TOOL_ACTIVITY_KINDS)}
      AND length(CAST(payload_json AS BLOB)) > ${LEGACY_ACTIVITY_PAYLOAD_MIN_BYTES}
  `;
  let rewritten = 0;
  for (let start = 0; start < candidates.length; start += BATCH_SIZE) {
    const ids = candidates.slice(start, start + BATCH_SIZE).map((row) => row.activityId);
    const rows = yield* sql<{
      readonly activityId: string;
      readonly kind: string;
      readonly payloadJson: string;
    }>`
      SELECT activity_id AS "activityId", kind, payload_json AS "payloadJson"
      FROM projection_thread_activities
      WHERE activity_id IN ${sql.in(ids)}
    `;
    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payloadJson);
      } catch {
        continue;
      }
      const next = reprojectLegacyToolActivityPayload({
        id: EventId.make(row.activityId),
        kind: row.kind,
        payload,
      });
      if (next === null) continue;
      yield* sql`
        UPDATE projection_thread_activities
        SET payload_json = ${JSON.stringify(next)}
        WHERE activity_id = ${row.activityId}
      `;
      rewritten += 1;
    }
  }
  yield* sql`
    INSERT OR IGNORE INTO ryco_compatibility_repairs (repair_key)
    VALUES (${LEGACY_ACTIVITY_PAYLOADS_REPAIR_KEY})
  `;
  return rewritten;
});

export default Effect.asVoid(reprojectLegacyActivityPayloads);
