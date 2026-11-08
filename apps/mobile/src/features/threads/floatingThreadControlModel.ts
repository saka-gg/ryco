/**
 * The live status that floats over the bottom of a thread's feed, above the
 * composer. It replaces the old context card's status word: one glass capsule
 * that says what the chat is doing or what it waits on, and a round "jump to
 * latest" button that slides out beside it once the reader scrolled back
 * (t3code's floating working control: one capsule, a separate scroll button).
 */
export type FloatingThreadStatus =
  /** The agent runs: "Working · 1:24". Tapping follows the feed. */
  | {
      readonly kind: "working";
      readonly label: string;
      readonly accessibilityLabel: string;
    }
  /** This chat waits on the reader: an approval or a question (their cards sit below). */
  | {
      readonly kind: "attention";
      readonly label: string;
      readonly accessibilityLabel: string;
    }
  /** A chat this one delegated waits on the reader. Tapping opens it. */
  | {
      readonly kind: "child-attention";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly threadId: string;
    };

export interface FloatingThreadControlView {
  readonly status: FloatingThreadStatus | null;
  /** The reader scrolled back: the round button to the newest message shows. */
  readonly jump: boolean;
}

/** What this chat itself waits on, the most pressing first. */
export type FloatingThreadAttention = "approval" | "question" | null;

/** Space the feed keeps under its newest message while the status floats there. */
export const FLOATING_CONTROL_CLEARANCE = 52;

/** Further than this from the end, the reader is reading back, not following along. */
export const FOLLOWING_DISTANCE = 160;

export function isFollowingLatest(input: {
  readonly offsetY: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
  /** Space under the content the list scrolls through as well (its bottom inset). */
  readonly bottomInset?: number;
}): boolean {
  return (
    input.contentHeight + (input.bottomInset ?? 0) - (input.offsetY + input.viewportHeight) <=
    FOLLOWING_DISTANCE
  );
}

/** "42s", "3:07", "1:02:09": the elapsed time of the running turn. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, "0")}`;
  return `${seconds}s`;
}

const ATTENTION_LABEL: Readonly<Record<NonNullable<FloatingThreadAttention>, string>> = {
  approval: "Needs your approval",
  question: "Waiting for your answer",
};

export function resolveFloatingThreadControl(input: {
  /** When the running turn started; null while nothing runs. */
  readonly runningSince: string | null;
  readonly followingLatest: boolean;
  readonly nowMs: number;
  readonly attention: FloatingThreadAttention;
  /** The first delegated chat that waits on the reader, when one does. */
  readonly childAttention: { readonly threadId: string; readonly title: string } | null;
}): FloatingThreadControlView {
  const jump = !input.followingLatest;
  // The reader's own move comes first: this chat's card, then a delegated chat's, then progress.
  if (input.attention !== null) {
    const label = ATTENTION_LABEL[input.attention];
    return { status: { kind: "attention", label, accessibilityLabel: label }, jump };
  }
  if (input.childAttention !== null) {
    return {
      status: {
        kind: "child-attention",
        label: "Delegated chat needs you",
        accessibilityLabel: `${input.childAttention.title} needs you. Open it.`,
        threadId: input.childAttention.threadId,
      },
      jump,
    };
  }
  if (input.runningSince !== null) {
    const startedMs = Date.parse(input.runningSince);
    const elapsed = Number.isFinite(startedMs) ? formatElapsed(input.nowMs - startedMs) : null;
    const label = elapsed === null ? "Working" : `Working · ${elapsed}`;
    return {
      status: {
        kind: "working",
        label,
        accessibilityLabel: jump ? `${label}. Jump to latest` : label,
      },
      jump,
    };
  }
  return { status: null, jump };
}
