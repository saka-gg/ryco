import type { QueueThreadView } from "./threadView.ts";

/**
 * A queue hold is a recorded, per-thread pause of the follow-up queue. It is
 * edge-triggered: a failure *cause* only holds the queue when its key is new,
 * meaning it was neither acknowledged (baseline or Resume) nor already covered
 * by the current hold. Re-deriving a hold from current state would also hold a
 * message the user composed in response to an error they already saw.
 */
export type QueueHoldReason = "interrupted" | "review" | "stalled" | "error" | "limit";

/** Higher rank wins the hold's reason and detail when causes merge. */
export const QUEUE_HOLD_RANK: Record<QueueHoldReason, number> = {
  interrupted: 0,
  review: 1,
  stalled: 2,
  error: 3,
  limit: 4,
};

/** Acknowledged cause keys kept per thread; the newest win. */
export const MAX_ACKNOWLEDGED_CAUSE_KEYS = 32;

export interface QueueHold {
  readonly reason: QueueHoldReason;
  readonly detail: string | null;
  /** Every cause this hold covers. */
  readonly causeKeys: readonly string[];
  /** ISO timestamp of the first cause. */
  readonly heldAt: string;
}

export interface QueueFailureCause {
  readonly reason: "interrupted" | "error" | "limit";
  readonly causeKey: string;
  readonly detail: string | null;
  /** Instance of the failed session; null = cannot be exempted by provider. */
  readonly providerInstanceId: string | null;
}

export interface QueueHoldInput {
  readonly reason: QueueHoldReason;
  readonly causeKeys: readonly string[];
  readonly detail: string | null;
}

/**
 * Derived, current failure causes for a thread.
 *
 * Usage-limits adds its `limit:` rule HERE, ranked before `error`.
 */
export function deriveQueueFailureCauses(
  view: QueueThreadView,
  dispatchedMessageIds: ReadonlySet<string>,
): QueueFailureCause[] {
  const causes: QueueFailureCause[] = [];
  for (const failure of view.turnStartFailures) {
    if (!dispatchedMessageIds.has(failure.messageId)) continue;
    causes.push({
      reason: "error",
      causeKey: `start-failed:${failure.activityId}`,
      detail: failure.detail,
      providerInstanceId: null,
    });
  }
  const session = view.session;
  const turnKey = view.latestTurn?.turnId ?? "session";
  // `updatedAt` is deliberately not part of the key: repeated session-set(error)
  // and a later `stopped` must not mint a new cause. `stopped` and `running`
  // never produce one, even when they carry a stale `lastError`.
  if (session?.status === "error") {
    causes.push({
      reason: "error",
      causeKey: `error:${turnKey}:${session.lastError ?? ""}`,
      detail: session.lastError,
      providerInstanceId: session.providerInstanceId,
    });
  }
  if (view.latestTurn?.state === "interrupted" || session?.status === "interrupted") {
    causes.push({
      reason: "interrupted",
      causeKey: `interrupt:${turnKey}`,
      detail: null,
      providerInstanceId: null,
    });
  }
  return causes;
}

/** Causes not yet acknowledged nor covered by the current hold, split by provider exemption. */
export function partitionNewQueueFailureCauses(input: {
  readonly causes: readonly QueueFailureCause[];
  readonly acknowledgedCauseKeys: readonly string[];
  readonly hold: QueueHold | null;
  readonly headProviderInstanceId: string | null;
}): { hold: QueueFailureCause[]; exempt: QueueFailureCause[] } {
  const known = new Set([...input.acknowledgedCauseKeys, ...(input.hold?.causeKeys ?? [])]);
  const hold: QueueFailureCause[] = [];
  const exempt: QueueFailureCause[] = [];
  for (const cause of input.causes) {
    if (known.has(cause.causeKey)) continue;
    known.add(cause.causeKey);
    // A message queued for another provider is how users recover from a
    // provider failure, so that failure must not hold it.
    if (
      cause.reason !== "interrupted" &&
      cause.providerInstanceId !== null &&
      input.headProviderInstanceId !== null &&
      cause.providerInstanceId !== input.headProviderInstanceId
    ) {
      exempt.push(cause);
    } else {
      hold.push(cause);
    }
  }
  return { hold, exempt };
}

function uniqueKeys(keys: readonly string[]): string[] {
  return [...new Set(keys)];
}

export function mergeQueueHold(
  existing: QueueHold | null,
  incoming: QueueHoldInput,
  nowIso: string,
): QueueHold {
  if (!existing) {
    return {
      reason: incoming.reason,
      detail: incoming.detail,
      causeKeys: uniqueKeys(incoming.causeKeys),
      heldAt: nowIso,
    };
  }
  const incomingWins = QUEUE_HOLD_RANK[incoming.reason] > QUEUE_HOLD_RANK[existing.reason];
  return {
    reason: incomingWins ? incoming.reason : existing.reason,
    detail: incomingWins ? incoming.detail : existing.detail,
    causeKeys: uniqueKeys([...existing.causeKeys, ...incoming.causeKeys]),
    heldAt: existing.heldAt,
  };
}

/** Folds new causes into a hold, highest rank first. */
export function holdQueueForCauses(
  existing: QueueHold | null,
  causes: readonly QueueFailureCause[],
  nowIso: string,
): QueueHold | null {
  let hold = existing;
  for (const cause of causes.toSorted(
    (left, right) => QUEUE_HOLD_RANK[right.reason] - QUEUE_HOLD_RANK[left.reason],
  )) {
    hold = mergeQueueHold(
      hold,
      { reason: cause.reason, causeKeys: [cause.causeKey], detail: cause.detail },
      nowIso,
    );
  }
  return hold;
}

export function queueHoldsEqual(left: QueueHold | null, right: QueueHold | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.reason === right.reason &&
    left.detail === right.detail &&
    left.heldAt === right.heldAt &&
    left.causeKeys.length === right.causeKeys.length &&
    left.causeKeys.every((key, index) => right.causeKeys[index] === key)
  );
}

/** Keys a Resume acknowledges: the hold's own keys plus every current cause. */
export function releaseQueueHoldKeys(
  hold: QueueHold | null,
  currentCauses: readonly QueueFailureCause[],
): string[] {
  return uniqueKeys([...(hold?.causeKeys ?? []), ...currentCauses.map((cause) => cause.causeKey)]);
}

/** Appends acknowledged keys, keeping the newest {@link MAX_ACKNOWLEDGED_CAUSE_KEYS}. */
export function appendAcknowledgedCauseKeys(
  existing: readonly string[] | undefined,
  keys: readonly string[],
): readonly string[] {
  const base = existing ?? [];
  const fresh = keys.filter((key, index) => !base.includes(key) && keys.indexOf(key) === index);
  if (fresh.length === 0) return base;
  const next = [...base, ...fresh];
  return next.length > MAX_ACKNOWLEDGED_CAUSE_KEYS
    ? next.slice(next.length - MAX_ACKNOWLEDGED_CAUSE_KEYS)
    : next;
}

/** The explicit hold a local Stop records before the interrupt is dispatched. */
export function createInterruptQueueHold(activeTurnId: string | null, nowIso: string): QueueHold {
  return {
    reason: "interrupted",
    detail: null,
    causeKeys: [activeTurnId ? `interrupt:${activeTurnId}` : `interrupt:user:${nowIso}`],
    heldAt: nowIso,
  };
}

const QUEUE_HOLD_TITLES: Record<QueueHoldReason, string> = {
  interrupted: "Paused after Stop",
  error: "Paused after an error",
  limit: "Paused at a usage limit",
  review: "Paused for Claude resume review",
  stalled: "Paused: the last queued message has not started",
};

/** Shared web and mobile copy for a held queue. */
export function describeQueueHold(hold: QueueHold): { title: string; detail: string | null } {
  return {
    title: QUEUE_HOLD_TITLES[hold.reason],
    detail: hold.reason === "interrupted" ? null : hold.detail,
  };
}
