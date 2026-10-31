/**
 * The order the pending-request derivations read a thread's activities in: the durable
 * orchestration sequence, then creation time, then id. Shared by `derivePendingThreadRequests`
 * (`@ryco/shared/threadActivity`) and `deriveSecretRequests` (`@ryco/shared/secretRequestState`),
 * so both agree on which of two records came first.
 *
 * @module pendingRequestOrder
 */

export interface PendingThreadRequestActivity {
  readonly kind: string;
  readonly payload: unknown;
  readonly createdAt: string;
  readonly id?: string | undefined;
  readonly activityId?: string | undefined;
  readonly sequence?: number | undefined;
  readonly turnId?: string | null | undefined;
}

export function comparePendingRequestActivities(
  left: PendingThreadRequestActivity,
  right: PendingThreadRequestActivity,
): number {
  const bySequence =
    (left.sequence ?? Number.MAX_SAFE_INTEGER) - (right.sequence ?? Number.MAX_SAFE_INTEGER);
  if (bySequence !== 0) return bySequence;
  const byCreatedAt = left.createdAt.localeCompare(right.createdAt);
  if (byCreatedAt !== 0) return byCreatedAt;
  return (left.id ?? left.activityId ?? "").localeCompare(right.id ?? right.activityId ?? "");
}
