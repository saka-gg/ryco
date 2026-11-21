import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  USER_ACTION_REQUEST_MESSAGE_MAX_CHARS,
  USER_ACTION_REQUEST_TARGET_MAX_CHARS,
  UserActionNeed,
  UserActionOutcome,
  UserActionRequestId,
  UserActionSurface,
} from "./userActionRequest.ts";

/**
 * The parts of user action requests (`userActionRequest.ts`) that only the node and the card
 * read: the activity payloads. Kept out of the barrel, so the web app's boot chunk, which carries
 * the barrel's schemas, does not carry them.
 */

export const UserActionRequestStatus = Schema.Literals(["pending", ...UserActionOutcome.literals]);
export type UserActionRequestStatus = typeof UserActionRequestStatus.Type;

export const UserActionRequestMessage = TrimmedNonEmptyString.check(
  Schema.isMaxLength(USER_ACTION_REQUEST_MESSAGE_MAX_CHARS),
);

/** What the request is about on its surface: a browser tab id, a terminal id. */
export const UserActionRequestTarget = TrimmedNonEmptyString.check(
  Schema.isMaxLength(USER_ACTION_REQUEST_TARGET_MAX_CHARS),
);

/** The `user-action.requested` activity's payload: what the card shows. */
export const UserActionRequestedActivityPayload = Schema.Struct({
  requestId: UserActionRequestId,
  surface: UserActionSurface,
  need: UserActionNeed,
  /** The agent's own words: shown on the card in the thread, never in an alert. */
  message: UserActionRequestMessage,
  target: Schema.optionalKey(UserActionRequestTarget),
  expiresAt: IsoDateTime,
});
export type UserActionRequestedActivityPayload = typeof UserActionRequestedActivityPayload.Type;

/** The `user-action.resolved` activity's payload: how the request ended. */
export const UserActionResolvedActivityPayload = Schema.Struct({
  requestId: UserActionRequestId,
  outcome: UserActionOutcome,
});
export type UserActionResolvedActivityPayload = typeof UserActionResolvedActivityPayload.Type;
