import { ORPHANED_PROVIDER_SESSION_ERROR } from "@ryco/shared/restartContinuation";
import { applicableUsageLimit, isUsageLimitQueueHeld } from "@ryco/shared/usageLimit";

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

export interface DeriveQueueFailureCausesOptions {
  /**
   * Also return interrupts that cannot hold the queue yet (see
   * {@link isLatestTurnInterruptSettled}). Baselines and Resume acknowledge
   * them, so a Stop the user saw before composing never holds the follow-up
   * once its turn settles.
   */
  readonly includeUnsettled?: boolean;
  /** The usage-limit hold is time-bound (it ends after the reset). Defaults to now. */
  readonly nowMs?: number;
}

const USAGE_LIMIT_CAUSE_PREFIX = "limit:";

/** One limit per turn, so the turn id keys it and names its paired `error:` causes. */
export function usageLimitCauseKey(turnId: string): string {
  return `${USAGE_LIMIT_CAUSE_PREFIX}${turnId}`;
}

/** The usage limit that holds the queue now, if any (see `isUsageLimitQueueHeld`). */
function heldUsageLimit(view: QueueThreadView, nowMs: number) {
  return isUsageLimitQueueHeld(view, nowMs) ? applicableUsageLimit(view) : null;
}

/**
 * Whether an `interrupted` latest turn is a real, settled interrupt.
 * `latestTurn.state` alone is not a stable signal: a Codex turn in a git repo
 * reads `interrupted` from its first diff update through a placeholder
 * `missing` checkpoint, and keeps reading so after it settles until the real
 * capture replaces it (or for good when that capture fails). An edge-triggered
 * hold would outlive both. So the interrupt counts only once the turn is no
 * longer live and detail shows its checkpoint is not that placeholder. A local
 * Stop is recorded explicitly and does not depend on this.
 */
export function isLatestTurnInterruptSettled(view: QueueThreadView): boolean {
  if (view.latestTurn?.state !== "interrupted") return false;
  if (!view.detailLoaded || view.latestTurnPlaceholderCheckpoint) return false;
  const session = view.session;
  const turnLive =
    session !== null &&
    (session.status === "running" ||
      session.status === "starting" ||
      session.activeTurnId !== null);
  return !turnLive;
}

/**
 * Derived, current failure causes for a thread. A usage limit (`limit:`) outranks
 * the `error:` cause of the same failed turn.
 */
export function deriveQueueFailureCauses(
  view: QueueThreadView,
  dispatchedMessageIds: ReadonlySet<string>,
  options: DeriveQueueFailureCausesOptions = {},
): QueueFailureCause[] {
  const causes: QueueFailureCause[] = [];
  // Derived, never sticky: it stops being a cause when the limit is cleared, the
  // thread targets another instance, or the hold window after the reset passes.
  const limit = heldUsageLimit(view, options.nowMs ?? Date.now());
  if (limit !== null) {
    causes.push({
      reason: "limit",
      causeKey: usageLimitCauseKey(limit.turnId),
      detail: limit.message,
      providerInstanceId: limit.providerInstanceId,
    });
  }
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
  // A server restart releases the orphaned turn as interrupted; its `error:` cause
  // already holds, and nobody stopped it, so it is not a Stop.
  const releasedByRestart =
    session?.status === "error" && session.lastError === ORPHANED_PROVIDER_SESSION_ERROR;
  const latestTurnInterrupted =
    view.latestTurn?.state === "interrupted" &&
    !releasedByRestart &&
    (options.includeUnsettled === true || isLatestTurnInterruptSettled(view));
  if (latestTurnInterrupted || session?.status === "interrupted") {
    causes.push({
      reason: "interrupted",
      causeKey: `interrupt:${turnKey}`,
      detail: null,
      providerInstanceId: null,
    });
  }
  return causes;
}

/**
 * Hold causes a usage limit no longer justifies: its `limit:` cause and the `error:`
 * causes of the same limited turn, once the limit is cleared (a newer turn started),
 * targets another instance, or its hold window ended. The caller removes them from the
 * hold and acknowledges them, so the same failure never holds the queue again, while a
 * newer turn's own error still does.
 */
export function releasableUsageLimitCauseKeys(input: {
  readonly hold: QueueHold | null;
  readonly view: QueueThreadView;
  readonly currentCauses: readonly QueueFailureCause[];
  readonly nowMs: number;
}): string[] {
  if (input.hold === null) return [];
  const heldTurnId = heldUsageLimit(input.view, input.nowMs)?.turnId ?? null;
  const keys: string[] = [];
  for (const key of input.hold.causeKeys) {
    if (!key.startsWith(USAGE_LIMIT_CAUSE_PREFIX)) continue;
    const turnId = key.slice(USAGE_LIMIT_CAUSE_PREFIX.length);
    if (turnId === heldTurnId) continue;
    const errorPrefix = `error:${turnId}:`;
    keys.push(
      key,
      ...input.hold.causeKeys.filter((candidate) => candidate.startsWith(errorPrefix)),
      ...input.currentCauses
        .map((cause) => cause.causeKey)
        .filter((candidate) => candidate.startsWith(errorPrefix)),
    );
  }
  return uniqueKeys(keys);
}

const ERROR_CAUSE_PREFIX = "error:";
const RESTART_ERROR_CAUSE_SUFFIX = `:${ORPHANED_PROVIDER_SESSION_ERROR}`;

/**
 * Hold causes a server restart minted (the orphaned session's `error:` cause) once a
 * later turn exists: an automatic continuation or the user's own message took over.
 * That turn's own failure or Stop holds again under its own key; a Stop recorded on the
 * restarted turn is a different key and keeps holding until Resume.
 */
export function releasableRestartCauseKeys(input: {
  readonly hold: QueueHold | null;
  readonly view: QueueThreadView;
}): string[] {
  const latestTurnId = input.view.latestTurn?.turnId ?? null;
  if (input.hold === null || latestTurnId === null) return [];
  return input.hold.causeKeys.filter((key) => {
    if (!key.startsWith(ERROR_CAUSE_PREFIX) || !key.endsWith(RESTART_ERROR_CAUSE_SUFFIX)) {
      return false;
    }
    const turnKey = key.slice(
      ERROR_CAUSE_PREFIX.length,
      key.length - RESTART_ERROR_CAUSE_SUFFIX.length,
    );
    return turnKey !== latestTurnId;
  });
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

const CAUSE_KEY_REASONS: ReadonlyArray<readonly [prefix: string, reason: QueueHoldReason]> = [
  ["interrupt:", "interrupted"],
  ["review:", "review"],
  ["stalled:", "stalled"],
  ["error:", "error"],
  ["start-failed:", "error"],
  ["limit:", "limit"],
];

/** The reason a cause key holds for; null for a prefix this module does not mint. */
export function queueHoldReasonForCauseKey(causeKey: string): QueueHoldReason | null {
  for (const [prefix, reason] of CAUSE_KEY_REASONS) {
    if (causeKey.startsWith(prefix)) return reason;
  }
  return null;
}

/**
 * Removes causes without acknowledging them (an undone Stop, an auto-released
 * stall). The reason is recomputed from the remaining causes, and a detail that
 * belonged to a reason no longer present is dropped, so the copy never names a
 * cause that is gone. Returns the same hold when nothing matched and null when
 * no cause remains.
 */
export function removeQueueHoldCauses(
  hold: QueueHold,
  causeKeys: readonly string[],
): QueueHold | null {
  const remaining = hold.causeKeys.filter((key) => !causeKeys.includes(key));
  if (remaining.length === hold.causeKeys.length) return hold;
  if (remaining.length === 0) return null;
  let reason: QueueHoldReason | null = null;
  for (const key of remaining) {
    // An unrecognised cause (a newer package's) keeps the hold's own reason.
    const candidate = queueHoldReasonForCauseKey(key) ?? hold.reason;
    if (reason === null || QUEUE_HOLD_RANK[candidate] > QUEUE_HOLD_RANK[reason]) {
      reason = candidate;
    }
  }
  const nextReason = reason ?? hold.reason;
  return {
    reason: nextReason,
    detail: nextReason === hold.reason ? hold.detail : null,
    causeKeys: remaining,
    heldAt: hold.heldAt,
  };
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
