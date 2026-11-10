/**
 * alertExcerptSource - Reads what an approval or question alert's excerpt shows: the thread's
 * open request as the node's own projection holds it (`projection_pending_approvals`,
 * `projection_thread_user_input_requests`), with the payload of the activity that asked
 * (`approval.requested`, `user-input.requested`), which is what the thread's card shows.
 *
 * One indexed read per alert, never the whole thread. Loaded on the first approval or question
 * alert (`attentionPublisherLive.ts`).
 *
 * @module push/alertExcerptSource
 */
import { ApprovalRequestId, EventId, type ThreadId, UserInputQuestion } from "@ryco/contracts";
import type { PushAlertExcerpt } from "@ryco/contracts/push-alert";
import { Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { approvalExcerpt, inputExcerpt } from "./alertExcerpt.ts";

/** What an `approval.requested` activity carries (`ProviderRuntimeIngestion`). */
const ApprovalRequestedPayload = Schema.Struct({
  requestKind: Schema.Literals(["command", "file-read", "file-change"]),
  detail: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
});
const decodeApprovalPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(ApprovalRequestedPayload),
);

/** What a `user-input.requested` activity carries. */
const UserInputRequestedPayload = Schema.Struct({ questions: Schema.Array(UserInputQuestion) });
const decodeUserInputPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(UserInputRequestedPayload),
);

/** The request's identity; its event id keys the app's answer draft. */
const RequestIdentity = Schema.Struct({ requestEventId: Schema.String });
const decodeIdentity = Schema.decodeUnknownOption(Schema.fromJsonString(RequestIdentity));

/** Reads the thread's open request and builds the alert's excerpt; null when none is open. */
export const readAlertExcerpt = (input: {
  readonly threadId: ThreadId;
  readonly kind: "approval" | "input";
  /** The approval the alert names (`rq`); null: the newest open one. */
  readonly approvalRequestId: string | null;
}): Effect.Effect<PushAlertExcerpt | null, SqlError, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (input.kind === "approval") {
      const rows = yield* sql<{ readonly payload: string }>`
        SELECT a.payload_json AS "payload"
        FROM projection_pending_approvals p
        JOIN projection_thread_activities a
          ON a.kind = 'approval.requested'
          AND a.thread_id = p.thread_id
          AND json_extract(a.payload_json, '$.requestId') = p.request_id
        WHERE p.thread_id = ${input.threadId}
          AND p.status = 'pending'
          AND (${input.approvalRequestId} IS NULL OR p.request_id = ${input.approvalRequestId})
        ORDER BY p.created_at DESC, a.sequence DESC
        LIMIT 1
      `;
      const row = rows[0];
      if (row === undefined) return null;
      const payload = decodeApprovalPayload(row.payload);
      return Option.isSome(payload) ? approvalExcerpt(payload.value) : null;
    }
    // The question the thread waits on: the newest blocking one still open.
    const rows = yield* sql<{
      readonly payload: string;
      readonly requestId: string;
      readonly identity: string | null;
    }>`
      SELECT a.payload_json AS "payload", u.request_id AS "requestId", u.identity_json AS "identity"
      FROM projection_thread_user_input_requests u
      JOIN projection_thread_activities a
        ON a.kind = 'user-input.requested'
        AND a.thread_id = u.thread_id
        AND json_extract(a.payload_json, '$.requestId') = u.request_id
      WHERE u.thread_id = ${input.threadId} AND u.is_pending = 1 AND u.non_blocking = 0
      ORDER BY u.updated_at DESC, a.sequence DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (row === undefined) return null;
    const payload = decodeUserInputPayload(row.payload);
    if (Option.isNone(payload)) return null;
    const identity = row.identity === null ? Option.none() : decodeIdentity(row.identity);
    return inputExcerpt({
      requestId: ApprovalRequestId.make(row.requestId),
      ...(Option.isSome(identity)
        ? { userInputIdentity: { requestEventId: EventId.make(identity.value.requestEventId) } }
        : {}),
      questions: payload.value.questions,
    });
  });
