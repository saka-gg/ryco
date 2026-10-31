/**
 * Codex optional questions that outlive their turn. An answer sent after the question's turn
 * ended is the message of an ordinary `thread.turn.start` (it starts the next turn, resuming the
 * session), and the same commit records the question answered in the durable question ledger:
 * the card leaves every client and a second answer is refused. While the question's turn still
 * runs, `thread.user-input.respond` steers that turn through the provider's process-local
 * delivery authority instead. Thread windows carry every open question along, however much the
 * agent did since.
 *
 * Loaded on demand (`import()`): it imports no runtime values, so it stays off the boot path.
 *
 * @module optionalQuestionAnswers
 */
import type {
  EventId,
  OptionalQuestionTurnAnswer,
  OrchestrationEvent,
  OrchestrationThreadActivity,
  ThreadId,
  ThreadTurnStartCommand,
} from "@ryco/contracts";
import type { SqlClient } from "effect/sql/SqlClient";

import type { ProjectionThreadUserInputRequest } from "../persistence/Services/ProjectionThreadUserInputRequests.ts";

export const OPTIONAL_ANSWER_NOT_OPEN =
  "This question was already answered, dismissed or cleared. Refresh the thread to see its current state.";

/**
 * Why the node refuses `answer` as the message of a new turn, or null when it takes it. Read
 * from the question's ledger row inside the commit's transaction, so two answers racing each
 * other cannot both pass.
 */
export function optionalAnswerClaimBlocker(
  row: ProjectionThreadUserInputRequest | undefined,
  threadId: ThreadId,
  answer: OptionalQuestionTurnAnswer,
): string | null {
  if (!row || row.threadId !== threadId || !row.isPending) return OPTIONAL_ANSWER_NOT_OPEN;
  if (row.nonBlocking !== true) {
    return "Only an optional question can be answered with a new message. Answer this one in its card.";
  }
  if (
    row.userInputIdentity === undefined ||
    row.userInputIdentity.requestEventId !== answer.userInputIdentity.requestEventId ||
    row.userInputIdentity.runtimeSessionId !== answer.userInputIdentity.runtimeSessionId
  ) {
    return "This question changed. Refresh the thread before answering it.";
  }
  // A steer of it may be on its way, or may have arrived: an answer is never sent twice.
  if (row.responseState !== undefined && row.responseState !== "retryable") {
    return "An answer to this question was already sent. Wait for it to settle; it is never sent twice.";
  }
  if (Object.keys(answer.answers).length === 0) {
    return "An empty answer would dismiss the question. Dismiss it instead.";
  }
  return null;
}

/**
 * The event that settles the question in the ledger, committed with the turn start whose
 * message carries the answer. It names the identity the claim checked, so it settles exactly
 * that question.
 */
export function optionalAnswerResolvedEvent(
  base: Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  command: Pick<ThreadTurnStartCommand, "commandId" | "threadId" | "message" | "createdAt"> & {
    readonly optionalAnswer: OptionalQuestionTurnAnswer;
  },
): Omit<OrchestrationEvent, "sequence"> {
  const answer = command.optionalAnswer;
  return {
    ...base,
    type: "thread.activity-appended",
    payload: {
      threadId: command.threadId,
      activity: {
        id: `optional-answer:${command.commandId}` as EventId,
        kind: "user-input.resolved",
        tone: "info",
        summary: "Answered with a new message",
        payload: {
          requestId: answer.requestId,
          userInputIdentity: answer.userInputIdentity,
          ...(answer.userInputIdentity.runtimeSessionId !== undefined
            ? { runtimeSessionId: answer.userInputIdentity.runtimeSessionId }
            : {}),
          answers: answer.answers,
          messageId: command.message.messageId,
        },
        turnId: null,
        createdAt: command.createdAt,
      },
    },
  };
}

interface OpenQuestionRow {
  readonly activityId: string;
  readonly turnId: string | null;
  readonly tone: OrchestrationThreadActivity["tone"];
  readonly kind: string;
  readonly summary: string;
  readonly payload: string;
  readonly sequence: number | null;
  readonly createdAt: string;
}

/**
 * The request activity of each optional question still open on the thread: from the ledger's
 * pending rows (thread-prefixed key) to the activity by its id.
 */
export function readOpenOptionalQuestions(sql: SqlClient, threadId: ThreadId) {
  return sql<OpenQuestionRow>`
    SELECT a.activity_id AS "activityId", a.turn_id AS "turnId", a.tone, a.kind, a.summary,
      a.payload_json AS "payload", a.sequence, a.created_at AS "createdAt"
    FROM projection_thread_user_input_requests q
    JOIN projection_thread_activities a
      ON a.activity_id = json_extract(q.identity_json, '$.requestEventId')
      AND a.thread_id = q.thread_id
    WHERE q.thread_id = ${threadId} AND q.is_pending = 1 AND q.non_blocking = 1
      AND a.kind = 'user-input.requested'
    ORDER BY a.sequence, a.created_at, a.activity_id
    LIMIT 50
  `;
}

/**
 * The window with the open questions it does not hold put in front: they are older than its
 * newest activities, and history paging never reaches past its first row.
 */
export function withOpenOptionalQuestions<
  T extends { readonly activities: ReadonlyArray<OrchestrationThreadActivity> },
>(thread: T, rows: ReadonlyArray<OpenQuestionRow>): T {
  const missing = rows.filter(
    (row) => !thread.activities.some((entry) => entry.id === row.activityId),
  );
  if (missing.length === 0) return thread;
  const questions = missing.map((row): OrchestrationThreadActivity => ({
    id: row.activityId as EventId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: JSON.parse(row.payload) as unknown,
    turnId: row.turnId as OrchestrationThreadActivity["turnId"],
    createdAt: row.createdAt,
    ...(row.sequence === null ? {} : { sequence: row.sequence }),
  }));
  return { ...thread, activities: [...questions, ...thread.activities] };
}
