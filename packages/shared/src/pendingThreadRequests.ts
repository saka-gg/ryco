/**
 * Every request a thread waits on the user for: the provider callbacks (approvals and questions,
 * `derivePendingProviderCallbackRequests` in `@ryco/shared/threadActivity`) and the node's own
 * secret requests (`@ryco/shared/secretRequestState`). The node counts them as pending input
 * (settlement, queued wakes, restart continuation).
 *
 * Its own module: the web boot chunk carries `threadActivity`, and only the node reads the
 * secret request derivation (and its payload schemas) through here.
 *
 * @module pendingThreadRequests
 */
import type { PendingThreadRequestActivity } from "./pendingRequestOrder.ts";
import { pendingSecretRequests } from "./secretRequestState.ts";
import {
  derivePendingProviderCallbackRequests,
  type PendingProviderCallbackRequest,
} from "./threadActivity.ts";

export interface PendingThreadRequest {
  readonly requestId: string;
  readonly kind: PendingProviderCallbackRequest["kind"] | "secret";
  readonly nonBlocking?: boolean;
  readonly turnId: string | null;
}

export interface PendingThreadRequestState {
  readonly pendingApprovalCount: number;
  readonly pendingUserInputCount: number;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

/**
 * The requests still waiting, by kind. A `secret` request (`ryco_request_secret`) is answered on
 * the node, not through a provider callback, so it outlives its turn and a restart; it ends with
 * its `secret.resolved` activity (answered, declined or expired) or, given `nowMs`, at its
 * expiry, so a lost expiry timer or a failed record cannot hold the thread for good. Secret
 * requests come from `pendingSecretRequests` (`@ryco/shared/secretRequestState`), so this and
 * the card always agree.
 */
export function derivePendingThreadRequests(
  activities: ReadonlyArray<PendingThreadRequestActivity>,
  nowMs?: number,
): ReadonlyArray<PendingThreadRequest> {
  return [
    ...derivePendingProviderCallbackRequests(activities),
    ...pendingSecretRequests(activities, nowMs).map((request) => ({
      requestId: request.requestId,
      turnId: request.turnId,
      kind: "secret" as const,
    })),
  ];
}

/** With `nowMs`, an expired secret request no longer counts (see {@link derivePendingThreadRequests}). */
export function derivePendingThreadRequestState(
  activities: ReadonlyArray<PendingThreadRequestActivity>,
  nowMs?: number,
): PendingThreadRequestState {
  const requests = derivePendingThreadRequests(activities, nowMs);
  const pendingApprovalCount = requests.filter((request) => request.kind === "approval").length;
  // A pending secret request waits on the user like a blocking question: it holds settlement,
  // queued wakes and restart continuation the same way.
  const pendingUserInputCount = requests.filter(
    (request) =>
      (request.kind === "user-input" && !request.nonBlocking) || request.kind === "secret",
  ).length;
  return {
    pendingApprovalCount,
    pendingUserInputCount,
    hasPendingApprovals: pendingApprovalCount > 0,
    hasPendingUserInput: pendingUserInputCount > 0,
  };
}
