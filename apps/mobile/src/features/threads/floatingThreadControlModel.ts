/**
 * The floating control over a thread's feed, above the composer: a "Working"
 * pill with the turn's elapsed time while the agent runs, or a "Jump to latest"
 * button once the reader scrolled up from the end. Either one scrolls to the
 * newest message.
 */
export type FloatingThreadControl =
  | { readonly kind: "working"; readonly label: string; readonly accessibilityLabel: string }
  | { readonly kind: "jump"; readonly label: string; readonly accessibilityLabel: string };

/** Space the feed keeps under its newest message while the pill floats there. */
export const FLOATING_CONTROL_CLEARANCE = 52;

/** Further than this from the end, the reader is reading back, not following along. */
export const FOLLOWING_DISTANCE = 160;

export function isFollowingLatest(input: {
  readonly offsetY: number;
  readonly viewportHeight: number;
  readonly contentHeight: number;
}): boolean {
  return input.contentHeight - (input.offsetY + input.viewportHeight) <= FOLLOWING_DISTANCE;
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

export function resolveFloatingThreadControl(input: {
  /** When the running turn started; null while nothing runs. */
  readonly runningSince: string | null;
  readonly followingLatest: boolean;
  readonly nowMs: number;
}): FloatingThreadControl | null {
  if (input.runningSince !== null) {
    const startedMs = Date.parse(input.runningSince);
    const elapsed = Number.isFinite(startedMs) ? formatElapsed(input.nowMs - startedMs) : null;
    const label = elapsed === null ? "Working" : `Working · ${elapsed}`;
    return {
      kind: "working",
      label,
      accessibilityLabel: input.followingLatest ? label : `${label}. Jump to latest`,
    };
  }
  if (!input.followingLatest) {
    return { kind: "jump", label: "Jump to latest", accessibilityLabel: "Jump to latest message" };
  }
  return null;
}
