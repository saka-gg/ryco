/**
 * A thread's secret requests (`ryco_request_secret`), read from its `secret.requested` /
 * `secret.resolved` activities: the one derivation the node (pending input, settlement,
 * answers, expiry) and every client (the private card) read. Activities carry only the request
 * (key, purpose, file, expiry, checkout identity) and its outcome, never a value or a path.
 *
 * Its own module, not `threadActivity`'s: the web boot chunk carries `threadActivity`, and the
 * payload schemas here are needed only where a card or the node reads them.
 *
 * @module secretRequestState
 */
import {
  SECRET_REQUESTED_ACTIVITY_KIND,
  SECRET_RESOLVED_ACTIVITY_KIND,
  type SecretRequestId,
  type SecretRequestResolution,
} from "@ryco/contracts/secret-request";
import {
  SecretRequestedActivityPayload,
  SecretResolvedActivityPayload,
  type SecretRequestStatus,
} from "@ryco/contracts/secret-request-details";
import * as Schema from "effect/Schema";

import {
  comparePendingRequestActivities,
  type PendingThreadRequestActivity,
} from "./pendingRequestOrder.ts";

/** A secret request (`ryco_request_secret`) as its activities tell it. Never a value or a path. */
export interface SecretRequestView {
  readonly requestId: SecretRequestId;
  readonly key: string;
  readonly purpose: string;
  readonly file: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  /** The checkout the request was opened for (`SecretRequestCheckoutId`). */
  readonly checkoutId: string;
  readonly turnId: string | null;
  /** `expired` also for an unanswered request whose expiry passed before the node recorded it. */
  readonly status: SecretRequestStatus;
}

export type SecretRequestActivity = PendingThreadRequestActivity;

export function isSecretRequestActivityKind(kind: string): boolean {
  return kind === SECRET_REQUESTED_ACTIVITY_KIND || kind === SECRET_RESOLVED_ACTIVITY_KIND;
}

// Built on first use, like every guard of a lazily read payload.
let secretPayloadGuards:
  | {
      readonly requested: (payload: unknown) => payload is SecretRequestedActivityPayload;
      readonly resolved: (payload: unknown) => payload is SecretResolvedActivityPayload;
    }
  | undefined;
const secretPayloads = () =>
  (secretPayloadGuards ??= {
    requested: Schema.is(SecretRequestedActivityPayload),
    resolved: Schema.is(SecretResolvedActivityPayload),
  });

export function isSecretRequestExpired(
  request: Pick<SecretRequestView, "expiresAt">,
  nowMs: number,
): boolean {
  const expiresAtMs = Date.parse(request.expiresAt);
  // An unreadable expiry fails closed: the request can no longer be answered.
  return !Number.isFinite(expiresAtMs) || nowMs >= expiresAtMs;
}

/**
 * A thread's secret requests, oldest first: the one derivation the node (pending input,
 * settlement, answers, expiry) and every client (the private card) read. Only payloads the
 * contract accepts count. A request is answered once: its first resolution counts, later ones
 * and a repeated request with the same id change nothing, and a resolution recorded before its
 * request still closes it. With `nowMs`, an unanswered request past its expiry reads `expired`.
 */
export function deriveSecretRequests(
  activities: ReadonlyArray<SecretRequestActivity>,
  nowMs?: number,
): ReadonlyArray<SecretRequestView> {
  const guards = secretPayloads();
  const requests = new Map<string, SecretRequestView>();
  const earlyResolutions = new Map<string, SecretRequestResolution>();
  for (const activity of activities
    .filter((candidate) => isSecretRequestActivityKind(candidate.kind))
    .toSorted(comparePendingRequestActivities)) {
    if (activity.kind === SECRET_REQUESTED_ACTIVITY_KIND) {
      if (!guards.requested(activity.payload) || requests.has(activity.payload.requestId)) {
        continue;
      }
      const { payload } = activity;
      requests.set(payload.requestId, {
        requestId: payload.requestId,
        key: payload.key,
        purpose: payload.purpose,
        file: payload.file,
        requestedAt: activity.createdAt,
        expiresAt: payload.expiresAt,
        checkoutId: payload.checkoutId,
        turnId: activity.turnId ?? null,
        status: earlyResolutions.get(payload.requestId) ?? "pending",
      });
      continue;
    }
    if (!guards.resolved(activity.payload)) continue;
    const { requestId, status } = activity.payload;
    const request = requests.get(requestId);
    if (request === undefined) {
      if (!earlyResolutions.has(requestId)) earlyResolutions.set(requestId, status);
      continue;
    }
    if (request.status !== "pending") continue;
    requests.set(requestId, { ...request, status });
  }
  const views: SecretRequestView[] = [];
  for (const request of requests.values()) {
    views.push(
      nowMs !== undefined && request.status === "pending" && isSecretRequestExpired(request, nowMs)
        ? { ...request, status: "expired" }
        : request,
    );
  }
  return views;
}

/** The secret requests still waiting for an answer, oldest first. */
export function pendingSecretRequests(
  activities: ReadonlyArray<SecretRequestActivity>,
  nowMs?: number,
): ReadonlyArray<SecretRequestView> {
  return deriveSecretRequests(activities, nowMs).filter((request) => request.status === "pending");
}
