/**
 * alertExcerptSource - Reads what an approval or question alert's excerpt shows: the thread's
 * open request, derived from its request activities with the clients' own rules
 * (`derivePendingApprovals`, `derivePendingUserInputs`), so the excerpt names exactly the request
 * the thread's card shows.
 *
 * One indexed read per alert (`idx_projection_thread_activities_kind_order`): only the request
 * activities of that thread, newest first and bounded, never the whole thread.
 *
 * @module push/alertExcerptSource
 */
import {
  derivePendingApprovals,
  derivePendingUserInputs,
} from "@ryco/client-runtime/state/session";
import type { OrchestrationThreadActivity, ThreadId } from "@ryco/contracts";
import type { PushAlertExcerpt } from "@ryco/contracts/push-hub";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import { approvalExcerpt, inputExcerpt } from "./alertExcerpt.ts";

const APPROVAL_KINDS = [
  "approval.requested",
  "approval.resolved",
  "approval.response.submitted",
  "provider.approval.respond.failed",
] as const;
const INPUT_KINDS = [
  "user-input.requested",
  "user-input.resolved",
  "user-input.response.submitted",
  "provider.user-input.respond.failed",
] as const;
/** Request activities read per alert: far more than any one turn has open at once. */
const ACTIVITY_LIMIT = 200;

interface ActivityRow {
  readonly activityId: string;
  readonly turnId: string | null;
  readonly tone: string;
  readonly kind: string;
  readonly summary: string;
  readonly payload: string;
  readonly sequence: number | null;
  readonly createdAt: string;
}

function toActivity(row: ActivityRow): OrchestrationThreadActivity | null {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return null;
  }
  return {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload,
    turnId: row.turnId,
    ...(row.sequence === null ? {} : { sequence: row.sequence }),
    createdAt: row.createdAt,
  } as OrchestrationThreadActivity;
}

/** The excerpt for one alert from its thread's request activities (oldest first). */
export function excerptFromActivities(input: {
  readonly kind: "approval" | "input";
  /** The approval the alert names (`rq`); null: the newest open one. */
  readonly approvalRequestId: string | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}): PushAlertExcerpt | null {
  if (input.kind === "approval") {
    const open = derivePendingApprovals(input.activities);
    const approval =
      input.approvalRequestId === null
        ? open.at(-1)
        : open.find((candidate) => candidate.requestId === input.approvalRequestId);
    return approval === undefined ? null : approvalExcerpt(approval);
  }
  // The question the thread waits on: the newest blocking one.
  const question = derivePendingUserInputs(input.activities)
    .filter((candidate) => candidate.nonBlocking !== true)
    .at(-1);
  return question === undefined ? null : inputExcerpt(question);
}

/** Reads the thread's request activities and derives the alert's excerpt. */
export const readAlertExcerpt = (input: {
  readonly threadId: ThreadId;
  readonly kind: "approval" | "input";
  readonly approvalRequestId: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const kinds = input.kind === "approval" ? APPROVAL_KINDS : INPUT_KINDS;
    const rows = yield* sql<ActivityRow>`
      SELECT
        activity_id AS "activityId",
        turn_id AS "turnId",
        tone,
        kind,
        summary,
        payload_json AS "payload",
        sequence,
        created_at AS "createdAt"
      FROM projection_thread_activities
      WHERE kind IN ${sql.in(kinds)} AND thread_id = ${input.threadId}
      ORDER BY
        CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
        sequence DESC,
        created_at DESC,
        activity_id DESC
      LIMIT ${ACTIVITY_LIMIT}
    `;
    const activities = rows
      .toReversed()
      .map(toActivity)
      .filter((activity): activity is OrchestrationThreadActivity => activity !== null);
    return excerptFromActivities({
      kind: input.kind,
      approvalRequestId: input.approvalRequestId,
      activities,
    });
  });
