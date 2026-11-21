/**
 * alertExcerptSource - Reads what an approval or question alert's excerpt shows: the thread's
 * open request as the node's own projection holds it (`projection_pending_approvals`,
 * `projection_thread_user_input_requests`), with the payload of the activity that asked
 * (`approval.requested`, `user-input.requested`), which is what the thread's card shows. An input
 * alert without an open question may be for a user action request (`user-action.requested`
 * without its `user-action.resolved`): its excerpt is the request's fixed label only, never the
 * agent's message or anything its surface showed.
 *
 * One indexed read per alert, never the whole thread. Loaded on the first approval or question
 * alert (`attentionPublisherLive.ts`).
 *
 * @module push/alertExcerptSource
 */
import { ApprovalRequestId, EventId, type ThreadId, UserInputQuestion } from "@ryco/contracts";
import type { PushAlertExcerpt } from "@ryco/contracts/push-alert";
import {
  USER_ACTION_REQUEST_MAX_PENDING_PER_THREAD,
  USER_ACTION_REQUESTED_ACTIVITY_KIND,
  USER_ACTION_RESOLVED_ACTIVITY_KIND,
  UserActionNeed,
  UserActionSurface,
} from "@ryco/contracts/user-action-request";
import { isUserActionRequestExpired } from "@ryco/shared/userActionRequestState";
import { userActionRequestLabel } from "@ryco/shared/userActionRequests";
import { Clock, Effect, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import { approvalExcerpt, inputExcerpt, labelExcerpt } from "./alertExcerpt.ts";

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

/** What the label of a `user-action.requested` activity is made of, and when it expires. */
const UserActionLabelParts = Schema.Struct({
  surface: UserActionSurface,
  need: UserActionNeed,
  expiresAt: Schema.String,
});
const decodeUserActionLabelParts = Schema.decodeUnknownOption(UserActionLabelParts);

/**
 * The newest unanswered, unexpired user action request's label as an excerpt; null without one.
 * Reads only the surface, the need and the expiry out of the payload, never its message.
 */
const readUserActionLabelExcerpt = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Both sides on the kind-leading index (kind, thread_id, sequence). A thread holds at most
    // a few unanswered requests, so the expiry is checked here, on those few rows.
    const rows = yield* sql<{
      readonly surface: unknown;
      readonly need: unknown;
      readonly expiresAt: unknown;
    }>`
      SELECT
        json_extract(r.payload_json, '$.surface') AS "surface",
        json_extract(r.payload_json, '$.need') AS "need",
        json_extract(r.payload_json, '$.expiresAt') AS "expiresAt"
      FROM projection_thread_activities r
      WHERE r.kind = ${USER_ACTION_REQUESTED_ACTIVITY_KIND}
        AND r.thread_id = ${threadId}
        AND NOT EXISTS (
          SELECT 1 FROM projection_thread_activities d
          WHERE d.kind = ${USER_ACTION_RESOLVED_ACTIVITY_KIND}
            AND d.thread_id = r.thread_id
            AND json_extract(d.payload_json, '$.requestId') =
              json_extract(r.payload_json, '$.requestId')
        )
      ORDER BY r.sequence DESC
      LIMIT ${USER_ACTION_REQUEST_MAX_PENDING_PER_THREAD}
    `;
    const nowMs = yield* Clock.currentTimeMillis;
    for (const row of rows) {
      const parts = decodeUserActionLabelParts(row);
      if (Option.isNone(parts) || isUserActionRequestExpired(parts.value, nowMs)) continue;
      return labelExcerpt(userActionRequestLabel(parts.value));
    }
    return null;
  });

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
    // No open question: the thread may wait on a user action request instead.
    if (row === undefined) return yield* readUserActionLabelExcerpt(input.threadId);
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
