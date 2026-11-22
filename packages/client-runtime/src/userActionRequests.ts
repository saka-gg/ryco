/**
 * The card for an agent's user action request (a browser tab or terminal handed to the user),
 * shared by web and mobile: which requests a thread shows, the answer payload, the copy and who
 * may answer. The surface itself (the Browser panel, the terminal drawer) is opened by the client
 * through its own Show handler; a client that cannot show it says where to continue instead, or,
 * when the node serves the handed-off tab to remote viewers (`remoteView`), opens it there itself
 * (Open tab) under `userActionRemoteViewTabId`.
 *
 * @module userActionRequests
 */
import { hasActivityKind } from "@ryco/shared/threadActivityPayloads";
import {
  USER_ACTION_REQUESTED_ACTIVITY_KIND,
  UserActionRequestFailureReason,
  type UserActionAnswerInput,
  type UserActionRequestId,
  type UserActionSurface,
} from "@ryco/contracts/user-action-request";
import type { SpaceRole, ThreadId } from "@ryco/contracts";
import { WS_METHODS } from "@ryco/contracts/rpc";
import { hostedRoleAllows } from "@ryco/shared/rpcAccessPolicy";
import {
  userActionOutcomeLine,
  userActionRemoteViewTabId,
  userActionRequestFailureMessage,
  userActionRequestLabel,
} from "@ryco/shared/userActionRequests";
import {
  pendingUserActionRequests,
  type UserActionRequestActivity,
  type UserActionRequestView,
} from "@ryco/shared/userActionRequestState";
import * as Schema from "effect/Schema";

export type { UserActionRequestView } from "@ryco/shared/userActionRequestState";
export { userActionOutcomeLine, userActionRemoteViewTabId, userActionRequestLabel };

/** Cheap: whether a thread has ever handed something over, so a client loads the card only then. */
export function hasUserActionRequestActivity(
  activities: ReadonlyArray<Pick<UserActionRequestActivity, "kind">>,
): boolean {
  return activities.some((activity) =>
    hasActivityKind(activity, USER_ACTION_REQUESTED_ACTIVITY_KIND),
  );
}

/** The cards a thread shows: its unanswered, unexpired requests, oldest first. */
export function userActionRequestCards(
  activities: ReadonlyArray<UserActionRequestActivity>,
  nowMs: number,
): ReadonlyArray<UserActionRequestView> {
  return pendingUserActionRequests(activities, nowMs);
}

export const USER_ACTION_SHOW_LABEL = "Show";
export const USER_ACTION_DONE_LABEL = "Done";
export const USER_ACTION_DECLINE_LABEL = "Won't do";
/** Opens the handed-off tab on this client, when the node serves it (`remoteView`). */
export const USER_ACTION_OPEN_TAB_LABEL = "Open tab";

const SURFACE_NOUN: Record<UserActionSurface, string> = {
  browser: "browser tab",
  terminal: "terminal",
};

/** Under the agent's message: what Done means. */
export function userActionDoneHint(surface: UserActionSurface): string {
  return `Do it in the ${SURFACE_NOUN[surface] ?? "app"}, then press Done. The agent can't use it meanwhile.`;
}

/**
 * On a client that cannot show the surface (the phone app, the website): where the user
 * continues. Done and Won't do still work from here.
 */
export function userActionContinueElsewhereHint(surface: UserActionSurface): string {
  return surface === "browser"
    ? "Continue on your desktop: the tab is in Ryco's Browser panel there."
    : "Continue on your desktop: the terminal is in Ryco there.";
}

/** Under the agent's message, when this client can open the handed-off tab (Open tab). */
export const USER_ACTION_REMOTE_VIEW_HINT =
  "Open the tab here and sign in; the agent can't use it meanwhile.";

/** In the remote viewer, once the node stopped serving the tab (the hand-off ended or left). */
export const USER_ACTION_REMOTE_VIEW_ENDED_TEXT =
  "The tab is no longer available here. Continue on your desktop.";

/**
 * Whether a client that cannot show the surface itself may offer Open tab: the request's
 * browser tab is served to remote viewers (`remoteView`) and this session may answer it, which
 * means the owner (the node serves `userActionRemoteViewTabId` ids to the owner only). The
 * client still needs a way to stream or poll the tab; otherwise it says where to continue.
 */
export function userActionOffersRemoteView(
  request: Pick<UserActionRequestView, "surface" | "remoteView">,
  access: Pick<UserActionAnswerAccess, "canAnswer">,
): boolean {
  return request.surface === "browser" && request.remoteView && access.canAnswer;
}

export function userActionAnswerInput(
  threadId: ThreadId,
  requestId: UserActionRequestId,
  answer: "done" | "declined",
): UserActionAnswerInput {
  return { threadId, requestId, answer };
}

const GENERIC_FAILURE = "Could not answer the request. Check the connection and try again.";

/** Inline error copy for a failed answer: the node's reason in this build's words. */
export function userActionRequestFailureText(failure: unknown): string {
  if (typeof failure !== "object" || failure === null || !("_tag" in failure)) {
    return GENERIC_FAILURE;
  }
  if (failure._tag === "UserActionRequestError" && "reason" in failure) {
    return Schema.is(UserActionRequestFailureReason)(failure.reason)
      ? userActionRequestFailureMessage(failure.reason)
      : GENERIC_FAILURE;
  }
  if (
    failure._tag === "AuthRpcError" &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return GENERIC_FAILURE;
}

export interface UserActionAnswerAccess {
  readonly canAnswer: boolean;
  /** Why the card is read-only, shown on it. */
  readonly reason: string | null;
}

/**
 * Whether this session may answer: the node must offer the RPC, the session's role must be the
 * owner's (`userActions.answerRequest` is owner-only), and the connection must take mutations now.
 * `role` undefined means the role is not known yet; it is not assumed to be enough.
 */
export function userActionAnswerAccess(input: {
  readonly nodeSupports: boolean;
  readonly role: SpaceRole | undefined;
  readonly mutationReady: boolean;
  readonly mutationReason?: string | null;
}): UserActionAnswerAccess {
  if (!input.nodeSupports) {
    return { canAnswer: false, reason: "Update this node to answer this request." };
  }
  if (
    input.role === undefined ||
    !hostedRoleAllows(input.role, WS_METHODS.userActionsAnswerRequest)
  ) {
    return { canAnswer: false, reason: "Only the node's owner can answer this request." };
  }
  if (!input.mutationReady) {
    return { canAnswer: false, reason: input.mutationReason ?? "Connect to the node to answer." };
  }
  return { canAnswer: true, reason: null };
}
