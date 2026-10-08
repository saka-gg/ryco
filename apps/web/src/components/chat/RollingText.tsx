import { memo, useLayoutEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { isReducedMotionEffective } from "~/themes/appearancePreferences";

export type RollDirection = 1 | -1;

/**
 * Which way a ranked value last moved (1 up, -1 down), derived during render
 * so the roll animation and the value change commit together.
 */
export function useTravelDirection(rank: number): RollDirection {
  const [state, setState] = useState<{ rank: number; direction: RollDirection }>({
    rank,
    direction: 1,
  });
  if (state.rank !== rank) {
    const direction: RollDirection = rank > state.rank ? 1 : -1;
    setState({ rank, direction });
    return direction;
  }
  return state.direction;
}

interface RollEntry {
  readonly key: number;
  readonly text: string;
  readonly phase: "idle" | "enter" | "leave";
  readonly direction: RollDirection;
}

/**
 * A label that rolls vertically when its text changes: the old value leaves in
 * the direction of travel while the new one arrives from the other side, and
 * the width eases between them. `direction` 1 reads as "went up" (e.g. more
 * effort), -1 as "went down". Durations come from the house motion tokens, so
 * reduced motion collapses the roll to an instant swap.
 */
export const RollingText = memo(function RollingText(props: {
  text: string;
  direction?: RollDirection;
  align?: "start" | "center";
  /** Ease the width between values (default). Off, the width snaps like a plain inline-grid. */
  animateWidth?: boolean;
  className?: string;
  itemClassName?: string;
}) {
  const animateWidth = props.animateWidth ?? true;
  const [shownText, setShownText] = useState(props.text);
  const [entries, setEntries] = useState<ReadonlyArray<RollEntry>>(() => [
    { key: 0, text: props.text, phase: "idle", direction: 1 },
  ]);
  const containerRef = useRef<HTMLSpanElement>(null);
  const settledWidthRef = useRef<number | null>(null);

  if (shownText !== props.text) {
    const direction = props.direction ?? 1;
    const nextKey = entries.reduce((max, entry) => Math.max(max, entry.key), 0) + 1;
    setShownText(props.text);
    setEntries(
      isReducedMotionEffective()
        ? [{ key: nextKey, text: props.text, phase: "idle", direction }]
        : [
            ...entries
              .filter((entry) => entry.phase !== "leave")
              .map((entry): RollEntry => ({
                key: entry.key,
                text: entry.text,
                phase: "leave",
                direction,
              })),
            { key: nextKey, text: props.text, phase: "enter", direction },
          ],
    );
  }

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !animateWidth) return;
    const enteringKey = entries.find((entry) => entry.phase === "enter")?.key;
    const entering =
      enteringKey === undefined
        ? null
        : container.querySelector<HTMLElement>(`[data-roll-key="${enteringKey}"]`);
    const from = settledWidthRef.current;
    const to = (entering ?? container).getBoundingClientRect().width;
    settledWidthRef.current = to;
    if (!entering || from === null || Math.abs(from - to) < 0.5 || isReducedMotionEffective()) {
      return;
    }
    container.animate([{ width: `${from}px` }, { width: `${to}px` }], {
      duration: 300,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    });
  }, [animateWidth, entries]);

  return (
    <span
      ref={containerRef}
      className={cn("rolling-text", props.className)}
      data-align={props.align ?? "start"}
    >
      {entries.map((entry) => (
        <span
          key={entry.key}
          data-roll-key={entry.key}
          data-roll-phase={entry.phase}
          data-roll-direction={entry.direction === 1 ? "up" : "down"}
          aria-hidden={entry.phase === "leave" ? true : undefined}
          onAnimationEnd={(event) => {
            if (event.target !== event.currentTarget) return;
            if (entry.phase === "leave") {
              setEntries((current) => current.filter((candidate) => candidate.key !== entry.key));
            }
          }}
        >
          <span className={props.itemClassName}>{entry.text}</span>
        </span>
      ))}
    </span>
  );
});
