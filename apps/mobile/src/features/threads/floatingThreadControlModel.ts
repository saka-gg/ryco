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

/** What decides whether the capsule shows and what it says. */
export interface FloatingThreadStatusInput {
  /** When the running turn started; null while nothing runs. */
  readonly runningSince: string | null;
  readonly attention: FloatingThreadAttention;
  /** The first delegated chat that waits on the reader, when one does. */
  readonly childAttention: { readonly threadId: string; readonly title: string } | null;
}

/**
 * Whether the capsule floats over the feed's end: a status, or the live agents count. The feed
 * keeps FLOATING_CONTROL_CLEARANCE under its newest message exactly then, so the capsule never
 * covers it. (The jump button alone shows only while the reader is away from the end.)
 */
export function showsFloatingThreadCapsule(
  input: FloatingThreadStatusInput & { readonly agentsLive: boolean },
): boolean {
  return (
    input.attention !== null ||
    input.childAttention !== null ||
    input.runningSince !== null ||
    input.agentsLive
  );
}

/** Whether the capsule reads the clock: only while it shows "Working · 1:24". */
export function floatingThreadControlTicks(input: FloatingThreadStatusInput): boolean {
  return input.runningSince !== null && input.attention === null && input.childAttention === null;
}

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
