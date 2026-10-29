/**
 * Whether a server wake whose turn start ended without a turn (`readWakeStartState` →
 * `failed`) provably never reached the provider. Only restart recovery can prove it: it cancels a
 * start the provider was never handed with `deliveryState: "not-sent"`. A start that failed while
 * the server ran (the provider refused it, admission was busy), a recovery that could not tell,
 * and a Stop's cancel are all `uncertain`: the wake's message is in the chat and the agent may
 * have seen it, so nothing re-derives or re-sends it.
 *
 * Pure SQL builder, like `serverWakeQueries.ts`; loaded only with the pull request watch sweep.
 */
import { Effect } from "effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const readWakeStartFailureDelivery = (
  sql: SqlClient.SqlClient,
  input: { readonly threadId: string; readonly messageId: string },
) =>
  sql<{ deliveryState: string | null }>`
    SELECT json_extract(payload_json, '$.deliveryState') AS "deliveryState"
    FROM projection_thread_activities
    WHERE thread_id = ${input.threadId} AND kind = 'provider.turn.start.failed'
      AND json_valid(payload_json) AND json_extract(payload_json, '$.messageId') = ${input.messageId}
  `.pipe(
    Effect.map((rows) =>
      rows.length > 0 && rows.every((row) => row.deliveryState === "not-sent")
        ? ("not-sent" as const)
        : ("uncertain" as const),
    ),
  );
