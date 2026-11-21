import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/**
 * User action requests (docs/agent-control.md, "User action requests"): an agent hands a surface
 * of the node (a browser tab, a terminal) to the user for something only they may do, such as a
 * sign-in, a one-time code, a captcha or a consent screen, and continues once they are done.
 *
 * Node-owned like secret requests (`secretRequest.ts`): the thread records only the request
 * (`user-action.requested`: surface, a short message, an optional target) and how it ended
 * (`user-action.resolved`). The user answers Done or Won't do on a card
 * (`userActions.answerRequest`, owner only); the surface itself can end it too (its condition
 * holds, the tab or terminal closed), and so can its expiry. A pending request counts as the
 * thread waiting for input, like a question.
 *
 * Generic over the surface: a surface adds its own tool, target and copy, and reuses the
 * request, the card, the answer and the bounded wait. This module is in the barrel (its answer RPC
 * is in every client's RPC group); what only the node and the card read is in
 * `userActionRequestDetails.ts` (`@ryco/contracts/user-action-request-details`).
 */

export const USER_ACTION_REQUESTED_ACTIVITY_KIND = "user-action.requested";
export const USER_ACTION_RESOLVED_ACTIVITY_KIND = "user-action.resolved";
export const USER_ACTION_REQUEST_ACTIVITY_KINDS = [
  USER_ACTION_REQUESTED_ACTIVITY_KIND,
  USER_ACTION_RESOLVED_ACTIVITY_KIND,
] as const;

/** How long a request waits for the user unless its surface asks otherwise. */
export const USER_ACTION_REQUEST_TTL_MS_DEFAULT = 10 * 60 * 1_000;
export const USER_ACTION_REQUEST_TTL_MS_MIN = 10 * 1_000;
export const USER_ACTION_REQUEST_TTL_MS_MAX = 60 * 60 * 1_000;
/** Unanswered requests one thread may hold at once. */
export const USER_ACTION_REQUEST_MAX_PENDING_PER_THREAD = 3;
export const USER_ACTION_REQUEST_MESSAGE_MAX_CHARS = 300;
export const USER_ACTION_REQUEST_TARGET_MAX_CHARS = 128;
/**
 * How long one tool call waits at most: every Agent Control call is cut at 60 s, so a surface's
 * tool returns `pending` and the agent calls again to keep waiting.
 */
export const USER_ACTION_REQUEST_WAIT_MS_MAX = 45_000;
export const USER_ACTION_REQUEST_WAIT_MS_DEFAULT = 30_000;

/** `user-action-` and 32 hex characters, derived on the node from the thread and the caller's id. */
export const UserActionRequestId = Schema.String.check(
  Schema.isPattern(/^user-action-[0-9a-f]{32}$/),
).pipe(Schema.brand("UserActionRequestId"));
export type UserActionRequestId = typeof UserActionRequestId.Type;

/** Where the user acts. */
export const UserActionSurface = Schema.Literals(["browser", "terminal"]);
export type UserActionSurface = typeof UserActionSurface.Type;

/**
 * What kind of thing the user is asked to do. Alerts and the card's title say only this (its
 * fixed label, `userActionRequestLabel` in `@ryco/shared/userActionRequests`), never the agent's
 * message: that can quote the page or the terminal.
 */
export const UserActionNeed = Schema.Literals([
  "sign-in",
  "verification",
  "captcha",
  "consent",
  "input",
]);
export type UserActionNeed = typeof UserActionNeed.Type;

/**
 * How a request ended: the user said Done or Won't do, its surface's condition held
 * (`condition-met`), its target closed, it expired (`timeout`), or the agent or the node withdrew
 * it (`cancelled`).
 */
export const UserActionOutcome = Schema.Literals([
  "done",
  "declined",
  "timeout",
  "cancelled",
  "closed",
  "condition-met",
]);
export type UserActionOutcome = typeof UserActionOutcome.Type;

/** `userActions.answerRequest` (owner only): the card's Done or Won't do. */
export const UserActionAnswerInput = Schema.Struct({
  threadId: ThreadId,
  requestId: UserActionRequestId,
  answer: Schema.Literals(["done", "declined"]),
});
export type UserActionAnswerInput = typeof UserActionAnswerInput.Type;

export const UserActionAnswerResult = Schema.Struct({ outcome: UserActionOutcome });
export type UserActionAnswerResult = typeof UserActionAnswerResult.Type;

/**
 * Why answering failed. The words for each reason live with the rest of the copy
 * (`userActionRequestFailureMessage` in `@ryco/shared/userActionRequests`).
 */
export const UserActionRequestFailureReason = Schema.Literals([
  "not-found",
  "already-resolved",
  "expired",
  "record-failed",
]);
export type UserActionRequestFailureReason = typeof UserActionRequestFailureReason.Type;

export class UserActionRequestError extends Schema.TaggedError<UserActionRequestError>()(
  "UserActionRequestError",
  { reason: UserActionRequestFailureReason },
) {}
