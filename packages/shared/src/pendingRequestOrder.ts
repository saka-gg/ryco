/**
 * The order the pending-request derivations read a thread's activities in: the durable
 * orchestration sequence, then creation time, then id. Shared by `derivePendingThreadRequests`
 * (`@ryco/shared/threadActivity`), `deriveSecretRequests` (`@ryco/shared/secretRequestState`) and
 * `deriveUserActionRequests` (`@ryco/shared/userActionRequestState`), so all agree on which of two
 * records came first; the last two share one fold (`foldResolvableRequests`).
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

/**
 * The fold of a node-owned request kind (secret requests, user action requests): a request
 * activity opens a request, a resolution activity closes it. Only payloads the caller's guards
 * accept count. A request is resolved once: its first resolution counts, later ones and a
 * repeated request with the same id change nothing, and a resolution recorded before its request
 * still closes it. Returns the requests in the order they were opened.
 */
export function foldResolvableRequests<
  Requested extends { readonly requestId: string },
  Resolution,
  View,
>(
  activities: ReadonlyArray<PendingThreadRequestActivity>,
  spec: {
    readonly requestedKind: string;
    readonly resolvedKind: string;
    readonly isRequested: (payload: unknown) => payload is Requested;
    readonly readResolution: (payload: unknown) => { requestId: string; value: Resolution } | null;
    readonly view: (
      payload: Requested,
      activity: PendingThreadRequestActivity,
      resolution: Resolution | undefined,
    ) => View;
    readonly resolve: (view: View, resolution: Resolution) => View;
    readonly isPending: (view: View) => boolean;
  },
): ReadonlyArray<View> {
  const requests = new Map<string, View>();
  const earlyResolutions = new Map<string, Resolution>();
  for (const activity of activities
    .filter(
      (candidate) => candidate.kind === spec.requestedKind || candidate.kind === spec.resolvedKind,
    )
    .toSorted(comparePendingRequestActivities)) {
    if (activity.kind === spec.requestedKind) {
      if (!spec.isRequested(activity.payload) || requests.has(activity.payload.requestId)) {
        continue;
      }
      const early = earlyResolutions.get(activity.payload.requestId);
      requests.set(activity.payload.requestId, spec.view(activity.payload, activity, early));
      continue;
    }
    const resolution = spec.readResolution(activity.payload);
    if (resolution === null) continue;
    const request = requests.get(resolution.requestId);
    if (request === undefined) {
      if (!earlyResolutions.has(resolution.requestId)) {
        earlyResolutions.set(resolution.requestId, resolution.value);
      }
      continue;
    }
    if (!spec.isPending(request)) continue;
    requests.set(resolution.requestId, spec.resolve(request, resolution.value));
  }
  return Array.from(requests.values());
}
