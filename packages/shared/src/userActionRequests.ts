/**
 * The words for user action requests (`@ryco/contracts/user-action-request`): the fixed label an
 * alert and the card's title show, the outcome lines and why an answer was refused. The requests
 * themselves are derived in `@ryco/shared/userActionRequestState`.
 *
 * Labels never carry the agent's message, a URL or anything a page or terminal showed: a push
 * alert or a Lock Screen shows only these.
 *
 * @module userActionRequests
 */
import type {
  UserActionNeed,
  UserActionOutcome,
  UserActionRequestFailureReason,
  UserActionSurface,
} from "@ryco/contracts/user-action-request";

const SURFACE_PLACE: Record<UserActionSurface, string> = {
  browser: "in browser",
  terminal: "in terminal",
};

const NEED_LABEL: Record<UserActionNeed, string> = {
  "sign-in": "Login required",
  verification: "Verification required",
  captcha: "Captcha",
  consent: "Consent required",
  input: "Your input needed",
};

/** "Login required in browser": the request's label for alerts and the card's title. */
export function userActionRequestLabel(request: {
  readonly surface: UserActionSurface;
  readonly need: UserActionNeed;
}): string {
  return `${NEED_LABEL[request.need] ?? NEED_LABEL.input} ${SURFACE_PLACE[request.surface] ?? ""}`.trim();
}

const OUTCOME_LINES: Record<UserActionOutcome, string> = {
  done: "You marked this done.",
  declined: "You declined this.",
  timeout: "This request expired.",
  cancelled: "The agent withdrew this request.",
  closed: "Closed before it was done.",
  "condition-met": "Done: the agent saw it finish.",
};

/** The line a card shows once (or while) its request ended. */
export function userActionOutcomeLine(outcome: UserActionOutcome): string {
  return OUTCOME_LINES[outcome] ?? "This request ended.";
}

const FAILURE_MESSAGES: Record<UserActionRequestFailureReason, string> = {
  "not-found": "This request no longer exists.",
  "already-resolved": "This request already ended.",
  expired: "This request expired.",
  "record-failed": "Could not record your answer. Try again.",
};

export function userActionRequestFailureMessage(reason: UserActionRequestFailureReason): string {
  return FAILURE_MESSAGES[reason] ?? "Could not answer the request.";
}
