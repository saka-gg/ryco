/**
 * Follow-up queue holds: the pure rules every queue shares. The client queue (client-runtime's
 * `message-queue`) derives holds from what it sees; the server queue records them on the event
 * that causes them and uses the merge, release and copy rules below.
 *
 * Pure module: no services, no I/O.
 *
 * @module queueHold
 */
import type {
  FollowUpQueueHoldInput,
  OrchestrationLatestTurnState,
  OrchestrationSessionStatus,
  ThreadUsageLimit,
  TurnId,
} from "@ryco/contracts";
import {
  FOLLOW_UP_QUEUE_CAUSE_KEY_MAX_CHARS,
  FOLLOW_UP_QUEUE_HOLD_DETAIL_MAX_CHARS,
  FOLLOW_UP_QUEUE_MAX_CAUSE_KEYS,
} from "@ryco/contracts/orchestration";

import { ORPHANED_PROVIDER_SESSION_ERROR } from "./restartContinuation.ts";
import { applicableUsageLimit, isUsageLimitQueueHeld } from "./usageLimit.ts";

/**
 * The part of a thread the hold rules read; client-runtime's queue thread view is one. The
 * fields mean the same as there.
 */
export interface QueueHoldThreadView {
  /** A live thread-detail window or full-detail snapshot has been applied. */
  readonly detailLoaded: boolean;
  readonly session: {
    readonly status: OrchestrationSessionStatus;
    readonly lastError: string | null;
    readonly providerInstanceId: string | null;
    readonly activeTurnId: TurnId | null;
  } | null;
  readonly latestTurn: {
    readonly turnId: TurnId;
    readonly state: OrchestrationLatestTurnState;
  } | null;
  /** The latest turn's checkpoint is the provider-diff placeholder (see client-runtime). */
  readonly latestTurnPlaceholderCheckpoint: boolean;
  readonly turnStartFailures: ReadonlyArray<{
    readonly activityId: string;
    readonly messageId: string;
    readonly detail: string | null;
  }>;
  /** The projected usage limit; it only holds while `modelSelection` targets its instance. */
  readonly usageLimit?: ThreadUsageLimit | null | undefined;
  readonly modelSelection?: { readonly instanceId: string } | null | undefined;
}

/**
 * A queue hold is a recorded, per-thread pause of the follow-up queue. It is
 * edge-triggered: a failure *cause* only holds the queue when its key is new,
 * meaning it was neither acknowledged (baseline or Resume) nor already covered
 * by the current hold. Re-deriving a hold from current state would also hold a
 * message the user composed in response to an error they already saw.
 */
export type QueueHoldReason =
  | "interrupted"
  | "paused"
  | "restart"
  | "review"
  | "stalled"
  | "error"
  | "limit";

/**
 * Higher rank wins the hold's reason and detail when causes merge. `paused` (the Pause button)
 * and `restart` (a server boot) are recorded only by the server queue.
 */
export const QUEUE_HOLD_RANK: Record<QueueHoldReason, number> = {
  interrupted: 0,
  paused: 1,
  restart: 2,
  review: 3,
  stalled: 4,
  error: 5,
  limit: 6,
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

/** FNV-1a (32-bit) as 8 hex digits: a short, stable stand-in for a long text. */
function textHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Error text inside a cause key: kept up to 200 characters, a longer one cut and hashed. */
const ERROR_TEXT_MAX_CHARS = 200;
function causeKeyText(text: string): string {
  if (text.length <= ERROR_TEXT_MAX_CHARS) return text;
  return `${text.slice(0, ERROR_TEXT_MAX_CHARS - 9)}#${textHash(text)}`;
}

/**
 * A session error's cause: the turn it ended (`"session"` without one) and its error text (a long
 * one cut and hashed, so the key stays short and two errors still differ). `updatedAt` is
 * deliberately not part of it, so a repeated `error` session never mints a new cause.
 */
export function sessionErrorCauseKey(turnId: string | null, lastError: string | null): string {
  return `error:${turnId ?? "session"}:${causeKeyText(lastError ?? "")}`;
}

/** A queued message whose turn start failed, keyed by the failure activity. */
export function turnStartFailedCauseKey(activityId: string): string {
  return `start-failed:${activityId}`;
}

/** The server queue's hold at boot: one cause per process start. */
export function restartCauseKey(bootId: string): string {
  return `restart:${bootId}`;
}

/** The server queue's Pause button: one cause per press. */
export function pausedCauseKey(pausedAt: string): string {
  return `paused:${pausedAt}`;
}

/** The server queue's hold when its thread goes to Trash (a pause; restoring keeps it). */
export function trashedCauseKey(trashedAt: string): string {
  return `trash:${trashedAt}`;
}

/**
 * A failure of another provider instance than the one the queue's head targets: sending the
 * head is how users recover from it, so it must not hold the queue. Stops and causes without an
 * instance are never exempt.
 */
export function isQueueFailureCauseExempt(
  cause: Pick<QueueFailureCause, "reason" | "providerInstanceId">,
  headProviderInstanceId: string | null,
): boolean {
  return (
    cause.reason !== "interrupted" &&
    cause.providerInstanceId !== null &&
    headProviderInstanceId !== null &&
    cause.providerInstanceId !== headProviderInstanceId
  );
}

/** The usage limit that holds the queue now, if any (see `isUsageLimitQueueHeld`). */
function heldUsageLimit(view: QueueHoldThreadView, nowMs: number) {
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
export function isLatestTurnInterruptSettled(view: QueueHoldThreadView): boolean {
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
  view: QueueHoldThreadView,
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
      causeKey: turnStartFailedCauseKey(failure.activityId),
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
      causeKey: sessionErrorCauseKey(view.latestTurn?.turnId ?? null, session.lastError),
      detail: session.lastError,
      // A restart is not a provider failure, so a message queued for another instance
      // is no recovery from it: the restart cause holds until a later turn takes over.
      providerInstanceId:
        session.lastError === ORPHANED_PROVIDER_SESSION_ERROR ? null : session.providerInstanceId,
    });
  }
  // A turn a server restart released also reads interrupted. Its `interrupt:` cause is
  // still derived, so a baseline or Resume acknowledges it with the restart's `error:`
  // cause; `partitionNewQueueFailureCauses` keeps it from holding as a Stop.
  const latestTurnInterrupted =
    view.latestTurn?.state === "interrupted" &&
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
  readonly view: QueueHoldThreadView;
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
const INTERRUPT_CAUSE_PREFIX = "interrupt:";

/**
 * Hold causes the queue's head no longer runs into: a session error or a usage limit of another
 * provider instance than the one the head targets (`isQueueFailureCauseExempt`). Sending the head
 * is how a person recovers from those, so the server queue releases them once its head changes
 * (an edit, a move, an add at the head, a removal), as it never holds for them when the head
 * already targets another instance. A cause key does not name its instance, so only what the
 * thread still shows can be released: the error of its current session (`sessionError`, null
 * after a restart) and the limit it records, with the limited turn's own errors. An older error,
 * a failed start and stops stay held.
 */
export function headExemptCauseKeys(input: {
  readonly hold: QueueHold | null;
  readonly headProviderInstanceId: string | null;
  /** The `error:` cause the thread's current session accounts for, and that session's instance. */
  readonly sessionError: { readonly causeKey: string; readonly providerInstanceId: string } | null;
  /** The thread's usage limit, whose `limit:` cause names its turn. */
  readonly usageLimit: { readonly turnId: string; readonly providerInstanceId: string } | null;
}): string[] {
  if (input.hold === null || input.headProviderInstanceId === null) return [];
  const exempt = (providerInstanceId: string) =>
    isQueueFailureCauseExempt(
      { reason: "error", providerInstanceId },
      input.headProviderInstanceId,
    );
  const keys: string[] = [];
  const limitTurns = new Set<string>();
  for (const key of input.hold.causeKeys) {
    if (!key.startsWith(USAGE_LIMIT_CAUSE_PREFIX)) continue;
    const turnId = key.slice(USAGE_LIMIT_CAUSE_PREFIX.length);
    const limit = input.usageLimit?.turnId === turnId ? input.usageLimit : null;
    if (limit === null || !exempt(limit.providerInstanceId)) continue;
    // The limited turn's own `error:` causes go with it.
    keys.push(key);
    limitTurns.add(turnId);
  }
  const limitedTurnError = (key: string) =>
    [...limitTurns].some((turnId) => key.startsWith(`${ERROR_CAUSE_PREFIX}${turnId}:`));
  const sessionError = input.sessionError;
  for (const key of input.hold.causeKeys) {
    if (!key.startsWith(ERROR_CAUSE_PREFIX)) continue;
    if (
      limitedTurnError(key) ||
      (sessionError !== null &&
        key === sessionError.causeKey &&
        exempt(sessionError.providerInstanceId))
    ) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Built on use rather than at load, so a bundle that never calls the restart rules (the server's
 * queue rules) does not reference the restart module at all.
 */
const restartErrorCauseSuffix = () => `:${ORPHANED_PROVIDER_SESSION_ERROR}`;

/** The `error:` cause a server restart mints for the turn an `interrupt:` cause names. */
function restartErrorCauseKeyForInterrupt(causeKey: string): string | null {
  if (!causeKey.startsWith(INTERRUPT_CAUSE_PREFIX)) return null;
  const turnKey = causeKey.slice(INTERRUPT_CAUSE_PREFIX.length);
  return `${ERROR_CAUSE_PREFIX}${turnKey}${restartErrorCauseSuffix()}`;
}

/**
 * Hold causes a server restart minted (the orphaned session's `error:` cause) once a
 * later turn exists: an automatic continuation or the user's own message took over.
 * That turn's own failure or Stop holds again under its own key; a Stop recorded on the
 * restarted turn is a different key and keeps holding until Resume.
 *
 * Known limit: the projection records no Stop, so a Stop another client (or Agent Control)
 * issued that the provider had not acknowledged before the restart reads exactly like the
 * restart here. Only the client that pressed Stop holds until Resume.
 */
export function releasableRestartCauseKeys(input: {
  readonly hold: QueueHold | null;
  readonly view: QueueHoldThreadView;
}): string[] {
  const latestTurnId = input.view.latestTurn?.turnId ?? null;
  if (input.hold === null || latestTurnId === null) return [];
  return input.hold.causeKeys.filter((key) => {
    const suffix = restartErrorCauseSuffix();
    if (!key.startsWith(ERROR_CAUSE_PREFIX) || !key.endsWith(suffix)) {
      return false;
    }
    const turnKey = key.slice(ERROR_CAUSE_PREFIX.length, key.length - suffix.length);
    return turnKey !== latestTurnId;
  });
}

/**
 * Causes not yet acknowledged nor covered by the current hold, split by provider exemption.
 *
 * The derived `interrupt:` cause of a turn a server restart released never holds: nobody
 * stopped it, and the restart's `error:` cause for the same turn is current, held or
 * acknowledged. Keyed by the turn rather than the session's current status, so it stays
 * quiet when the session later leaves `error` (a session stop) without a new turn. A Stop
 * recorded locally already put the same `interrupt:` key in the hold, so it keeps holding.
 */
export function partitionNewQueueFailureCauses(input: {
  readonly causes: readonly QueueFailureCause[];
  readonly acknowledgedCauseKeys: readonly string[];
  readonly hold: QueueHold | null;
  readonly headProviderInstanceId: string | null;
}): { hold: QueueFailureCause[]; exempt: QueueFailureCause[] } {
  const known = new Set([...input.acknowledgedCauseKeys, ...(input.hold?.causeKeys ?? [])]);
  const current = new Set(input.causes.map((cause) => cause.causeKey));
  const hold: QueueFailureCause[] = [];
  const exempt: QueueFailureCause[] = [];
  for (const cause of input.causes) {
    if (known.has(cause.causeKey)) continue;
    const restartErrorKey =
      cause.reason === "interrupted" ? restartErrorCauseKeyForInterrupt(cause.causeKey) : null;
    if (restartErrorKey !== null && (known.has(restartErrorKey) || current.has(restartErrorKey))) {
      continue;
    }
    known.add(cause.causeKey);
    // A message queued for another provider is how users recover from a
    // provider failure, so that failure must not hold it.
    if (isQueueFailureCauseExempt(cause, input.headProviderInstanceId)) {
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
  ["paused:", "paused"],
  ["trash:", "paused"],
  ["restart:", "restart"],
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
  paused: "Paused",
  restart: "Paused after Ryco restarted",
  error: "Paused after an error",
  limit: "Paused at a usage limit",
  review: "Paused for Claude resume review",
  stalled: "Paused: the last queued message has not started",
};

/** Shared web and mobile copy for a held queue. */
export function describeQueueHold(hold: QueueHold): { title: string; detail: string | null } {
  return {
    title: QUEUE_HOLD_TITLES[hold.reason],
    detail: hold.reason === "interrupted" || hold.reason === "paused" ? null : hold.detail,
  };
}

/**
 * A derived hold as the server accepts one (`FollowUpQueueHoldInput`, e.g. the `hold` of a
 * device queue moving to the node with `thread.queue.add`): detail cut to its limit, each cause
 * key trimmed and, past its limit, cut and hashed, the newest keys kept. Null when no cause is
 * left.
 */
export function queueHoldInputOf(
  hold: Pick<QueueHold, "reason" | "detail" | "causeKeys">,
): FollowUpQueueHoldInput | null {
  const keys = uniqueKeys(
    hold.causeKeys
      .map((key) => key.trim())
      .filter((key) => key.length > 0)
      .map((key) =>
        key.length <= FOLLOW_UP_QUEUE_CAUSE_KEY_MAX_CHARS
          ? key
          : `${key.slice(0, FOLLOW_UP_QUEUE_CAUSE_KEY_MAX_CHARS - 9).trimEnd()}#${textHash(key)}`,
      ),
  );
  if (keys.length === 0) return null;
  return {
    reason: hold.reason,
    detail:
      hold.detail === null ? null : hold.detail.slice(0, FOLLOW_UP_QUEUE_HOLD_DETAIL_MAX_CHARS),
    causeKeys: keys.slice(-FOLLOW_UP_QUEUE_MAX_CAUSE_KEYS),
  };
}
