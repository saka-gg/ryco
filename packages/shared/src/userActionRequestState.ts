/**
 * A thread's user action requests (a browser tab or terminal an agent handed to the user), read
 * from its `user-action.requested` / `user-action.resolved` activities: the one derivation the
 * node (pending input, settlement, answers, expiry) and every client (the card) read.
 *
 * Its own module, not `threadActivity`'s: the web boot chunk carries `threadActivity`, and the
 * payload schemas here are needed only where a card or the node reads them.
 *
 * @module userActionRequestState
 */
import {
  USER_ACTION_REQUESTED_ACTIVITY_KIND,
  USER_ACTION_RESOLVED_ACTIVITY_KIND,
  type UserActionNeed,
  type UserActionOutcome,
  type UserActionRequestId,
  type UserActionSurface,
} from "@ryco/contracts/user-action-request";
import {
  UserActionRequestedActivityPayload,
  UserActionResolvedActivityPayload,
  type UserActionRequestStatus,
} from "@ryco/contracts/user-action-request-details";
import * as Schema from "effect/Schema";

import {
  foldResolvableRequests,
  isNodeRequestExpired,
  type PendingThreadRequestActivity,
} from "./pendingRequestOrder.ts";

/** A user action request as its activities tell it. */
export interface UserActionRequestView {
  readonly requestId: UserActionRequestId;
  readonly surface: UserActionSurface;
  readonly need: UserActionNeed;
  readonly message: string;
  /** The tab or terminal it is about, when the surface named one. */
  readonly target: string | null;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly turnId: string | null;
  /** `timeout` also for an unanswered request whose expiry passed before the node recorded it. */
  readonly status: UserActionRequestStatus;
}

export type UserActionRequestActivity = PendingThreadRequestActivity;

export function isUserActionRequestActivityKind(kind: string): boolean {
  return (
    kind === USER_ACTION_REQUESTED_ACTIVITY_KIND || kind === USER_ACTION_RESOLVED_ACTIVITY_KIND
  );
}

// Built on first use, like every guard of a lazily read payload.
let guards:
  | {
      readonly requested: (payload: unknown) => payload is UserActionRequestedActivityPayload;
      readonly resolved: (payload: unknown) => payload is UserActionResolvedActivityPayload;
    }
  | undefined;
const payloadGuards = () =>
  (guards ??= {
    requested: Schema.is(UserActionRequestedActivityPayload),
    resolved: Schema.is(UserActionResolvedActivityPayload),
  });

export function isUserActionRequestExpired(
  request: Pick<UserActionRequestView, "expiresAt">,
  nowMs: number,
): boolean {
  return isNodeRequestExpired(request.expiresAt, nowMs);
}

/**
 * A thread's user action requests, oldest first. Resolved once (`foldResolvableRequests`). With
 * `nowMs`, an unanswered request past its expiry reads `timeout`.
 */
export function deriveUserActionRequests(
  activities: ReadonlyArray<UserActionRequestActivity>,
  nowMs?: number,
): ReadonlyArray<UserActionRequestView> {
  const { requested, resolved } = payloadGuards();
  const requests = foldResolvableRequests(activities, {
    requestedKind: USER_ACTION_REQUESTED_ACTIVITY_KIND,
    resolvedKind: USER_ACTION_RESOLVED_ACTIVITY_KIND,
    isRequested: requested,
    readResolution: (payload): { requestId: string; value: UserActionOutcome } | null =>
      resolved(payload) ? { requestId: payload.requestId, value: payload.outcome } : null,
    view: (payload, activity, outcome): UserActionRequestView => ({
      requestId: payload.requestId,
      surface: payload.surface,
      need: payload.need,
      message: payload.message,
      target: payload.target ?? null,
      requestedAt: activity.createdAt,
      expiresAt: payload.expiresAt,
      turnId: activity.turnId ?? null,
      status: outcome ?? "pending",
    }),
    resolve: (request, status) => ({ ...request, status }),
    isPending: (request) => request.status === "pending",
  });
  if (nowMs === undefined) return requests;
  return requests.map((request) =>
    request.status === "pending" && isUserActionRequestExpired(request, nowMs)
      ? { ...request, status: "timeout" }
      : request,
  );
}

/** The user action requests still waiting for the user, oldest first. */
export function pendingUserActionRequests(
  activities: ReadonlyArray<UserActionRequestActivity>,
  nowMs?: number,
): ReadonlyArray<UserActionRequestView> {
  return deriveUserActionRequests(activities, nowMs).filter(
    (request) => request.status === "pending",
  );
}
