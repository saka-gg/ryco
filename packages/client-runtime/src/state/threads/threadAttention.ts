/**
 * "Next thread that needs you": which threads wait on the user, in what order,
 * and where a next or previous press goes. Pure, so every client walks alike.
 *
 * A thread needs the user while it waits on them (an approval, then a question,
 * then a ready plan) or holds a result they have not seen (a failure, then a
 * completion). Running work never does. Reasons use the thread notification
 * vocabulary.
 */
import type { ThreadNotificationKind } from "./threadNotifications.ts";

const REASON_RANK: Readonly<Record<ThreadNotificationKind, number>> = {
  approval: 0,
  input: 1,
  "plan-ready": 2,
  failed: 3,
  stopped: 4,
  completed: 5,
};

/** A row's inbox state, as the web placement state or the mobile row state names it. */
export type ThreadAttentionRowState =
  | "needs-input"
  | "delivery-unknown"
  | "working"
  | "connecting"
  | "limited"
  | "error"
  | "reconnecting"
  | "offline"
  | "idle"
  | "settled";

export interface ThreadAttentionRow {
  readonly state: ThreadAttentionRowState;
  /** What a needs-input row waits on. */
  readonly attention: "approval" | "input" | "plan" | null;
  /** Settled or snoozed. */
  readonly resting: boolean;
  /** Its latest turn ended after the user last opened it. */
  readonly unseen: boolean;
  /** A delegated child: its plan, failure or result returns to its parent. */
  readonly delegated: boolean;
}

/**
 * Why a row needs the user, or null. Offline rows are not current and never
 * count. A delivery-unknown row waits on a delivery check its row already asks
 * for. A delegated child counts only for the requests it is blocked on.
 */
export function resolveThreadAttentionReason(
  row: ThreadAttentionRow,
): ThreadNotificationKind | null {
  if (row.resting) return null;
  if (row.state === "needs-input") {
    if (row.attention === "approval") return "approval";
    if (row.attention === "plan") return row.delegated ? null : "plan-ready";
    return "input";
  }
  if (!row.unseen || row.delegated) return null;
  if (row.state === "error" || row.state === "limited") return "failed";
  if (row.state === "idle") return "completed";
  return null;
}

export interface ThreadAttentionCandidate {
  readonly key: string;
  readonly reason: ThreadNotificationKind;
  /** The row's place in AI Focus, or null when it is not in Focus. */
  readonly focusIndex: number | null;
  /** Newest first; a value that is not finite sorts last. */
  readonly recencyMs: number;
}

/** By reason, then in Focus order, then newest first, then by key. */
export function compareThreadAttention(
  left: ThreadAttentionCandidate,
  right: ThreadAttentionCandidate,
): number {
  const byReason = REASON_RANK[left.reason] - REASON_RANK[right.reason];
  if (byReason !== 0) return byReason;
  if (left.focusIndex !== right.focusIndex) {
    if (left.focusIndex === null) return 1;
    if (right.focusIndex === null) return -1;
    return left.focusIndex - right.focusIndex;
  }
  const leftMs = Number.isFinite(left.recencyMs) ? left.recencyMs : Number.NEGATIVE_INFINITY;
  const rightMs = Number.isFinite(right.recencyMs) ? right.recencyMs : Number.NEGATIVE_INFINITY;
  if (leftMs !== rightMs) return rightMs > leftMs ? 1 : -1;
  return left.key.localeCompare(right.key);
}

/** The order one press walked and where it went; the caller keeps it for the next press. */
export interface ThreadAttentionWalk {
  readonly orderedKeys: ReadonlyArray<string>;
  readonly targetKey: string;
}

/**
 * Where a press goes from the open thread (`currentKey`, or null), wrapping at
 * either end. Null when no other thread needs the user.
 *
 * Opening an unseen result makes it seen, so it leaves the order. When the open
 * thread is the previous press's target, the walk goes on from that target's
 * place in the previous order instead of starting over.
 */
export function stepThreadAttention(input: {
  readonly candidates: ReadonlyArray<ThreadAttentionCandidate>;
  readonly currentKey: string | null;
  readonly direction: "previous" | "next";
  readonly previous: ThreadAttentionWalk | null;
}): ThreadAttentionWalk | null {
  const { currentKey, direction, previous } = input;
  const orderedKeys = input.candidates
    .toSorted(compareThreadAttention)
    .map((candidate) => candidate.key);
  const count = orderedKeys.length;
  if (count === 0) return null;
  const step = direction === "next" ? 1 : -1;
  const edgeKey = orderedKeys[direction === "next" ? 0 : count - 1]!;
  const index = currentKey === null ? -1 : orderedKeys.indexOf(currentKey);
  let targetKey: string;
  if (index !== -1) {
    targetKey = orderedKeys[(index + step + count) % count]!;
  } else if (previous !== null && previous.targetKey === currentKey) {
    targetKey = continueWalk(previous, new Set(orderedKeys), step) ?? edgeKey;
  } else {
    targetKey = edgeKey;
  }
  return targetKey === currentKey ? null : { orderedKeys, targetKey };
}

/** The first key past the previous target, in the previous order, that still needs the user. */
function continueWalk(
  previous: ThreadAttentionWalk,
  present: ReadonlySet<string>,
  step: 1 | -1,
): string | null {
  const keys = previous.orderedKeys;
  for (let index = keys.indexOf(previous.targetKey) + step; index >= 0; index += step) {
    const key = keys[index];
    if (key === undefined) return null;
    if (present.has(key)) return key;
  }
  return null;
}
