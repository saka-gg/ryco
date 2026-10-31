/**
 * The secret requests of a thread, read from its `secret.requested` / `secret.resolved`
 * activities (`@ryco/contracts/secret-request`). Server and clients derive them the same way:
 * the node to count a pending request as pending user input (settlement, queued wakes, restart
 * continuation) and to check an answer, clients to show the private card.
 *
 * Activities carry only the request (key, purpose, file, expiry) and its outcome, never a value.
 *
 * @module secretRequests
 */
import {
  SECRET_REQUESTED_ACTIVITY_KIND,
  SECRET_RESOLVED_ACTIVITY_KIND,
  type SecretRequestFailureReason,
  type SecretRequestId,
} from "@ryco/contracts/secret-request";
import {
  SecretRequestedActivityPayload,
  SecretResolvedActivityPayload,
  type SecretRequestStatus,
} from "@ryco/contracts/secret-request-details";
import * as Schema from "effect/Schema";

export interface SecretRequestActivity {
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly id?: string | undefined;
  readonly sequence?: number | undefined;
  readonly turnId?: string | null | undefined;
}

export interface SecretRequestView {
  readonly requestId: SecretRequestId;
  readonly key: string;
  readonly purpose: string;
  readonly file: string;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly turnId: string | null;
  /** `expired` also for an unanswered request whose expiry passed before the node recorded it. */
  readonly status: SecretRequestStatus;
}

const isRequestedPayload = Schema.is(SecretRequestedActivityPayload);
const isResolvedPayload = Schema.is(SecretResolvedActivityPayload);

export function isSecretRequestActivityKind(kind: string): boolean {
  return kind === SECRET_REQUESTED_ACTIVITY_KIND || kind === SECRET_RESOLVED_ACTIVITY_KIND;
}

function compareActivities(left: SecretRequestActivity, right: SecretRequestActivity): number {
  const bySequence =
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
  if (bySequence !== 0) return bySequence;
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return (left.id ?? "").localeCompare(right.id ?? "");
}

/**
 * Every request, oldest first. A request is answered once: the first resolution after it counts,
 * later ones (and a repeated request with the same id) change nothing. With `nowMs`, an unanswered
 * request past its expiry reads `expired`.
 */
export function deriveSecretRequests(
  activities: ReadonlyArray<SecretRequestActivity>,
  nowMs?: number,
): ReadonlyArray<SecretRequestView> {
  const requests = new Map<string, SecretRequestView>();
  for (const activity of activities
    .filter((candidate) => isSecretRequestActivityKind(candidate.kind))
    .toSorted(compareActivities)) {
    if (activity.kind === SECRET_REQUESTED_ACTIVITY_KIND) {
      if (!isRequestedPayload(activity.payload) || requests.has(activity.payload.requestId)) {
        continue;
      }
      requests.set(activity.payload.requestId, {
        requestId: activity.payload.requestId,
        key: activity.payload.key,
        purpose: activity.payload.purpose,
        file: activity.payload.file,
        requestedAt: activity.createdAt,
        expiresAt: activity.payload.expiresAt,
        turnId: activity.turnId ?? null,
        status: "pending",
      });
      continue;
    }
    if (!isResolvedPayload(activity.payload)) continue;
    const request = requests.get(activity.payload.requestId);
    if (request === undefined || request.status !== "pending") continue;
    requests.set(request.requestId, { ...request, status: activity.payload.status });
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

export function isSecretRequestExpired(
  request: Pick<SecretRequestView, "expiresAt">,
  nowMs: number,
): boolean {
  const expiresAtMs = Date.parse(request.expiresAt);
  // An unreadable expiry fails closed: the request can no longer be answered.
  return !Number.isFinite(expiresAtMs) || nowMs >= expiresAtMs;
}

/** The requests still waiting for an answer, oldest first. */
export function pendingSecretRequests(
  activities: ReadonlyArray<SecretRequestActivity>,
  nowMs?: number,
): ReadonlyArray<SecretRequestView> {
  return deriveSecretRequests(activities, nowMs).filter((request) => request.status === "pending");
}

const FAILURE_MESSAGES: Record<SecretRequestFailureReason, string> = {
  "not-found": "This request no longer exists.",
  "already-answered": "This request was already answered.",
  busy: "This request is being answered from another device.",
  expired: "This request expired. Ask the agent to request the value again.",
  "empty-value": "Enter a value, or decline.",
  "value-too-long": "That value is too long for a .env file (16 KiB at most).",
  "value-characters": "That value has characters a .env file cannot hold safely.",
  "value-quoting":
    "That value mixes quotes, backslashes or $ with line breaks or single quotes, which a .env file cannot hold safely.",
  "no-checkout": "This thread has no checkout on the node to write the file into.",
  "unsafe-path": "The file must be inside this thread's checkout, without links, and not in .git.",
  "not-ignored": "Git does not ignore that file, so Ryco will not write a secret there.",
  "not-git":
    "Ryco writes secrets only into a file Git ignores, and this checkout is not a Git repository.",
  "not-regular-file": "That path is not a regular file.",
  "file-too-large": "That file is too large to update.",
  "write-failed": "Could not write the file.",
  "record-failed": "The file was written, but the request could not be updated. Try again.",
};

/** The words for a refusal, for the card and the agent. Fixed per reason: never the value. */
export function secretRequestFailureMessage(reason: SecretRequestFailureReason): string {
  return FAILURE_MESSAGES[reason] ?? "Could not answer the request.";
}
