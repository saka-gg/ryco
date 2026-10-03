import type {
  SourceControlChangeRequestStack,
  SourceControlChangeRequestStackEntry,
} from "@ryco/contracts";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { cn } from "../../../lib/utils";
import { FACT_TONE_TEXT } from "./FactGlyph";
import type { FactTone } from "./mergeFacts.logic";
import {
  newlyMergedLayers,
  stackLayersTopDown,
  stackLayerWord,
  stackLinkTone,
  stackMergeThroughPlan,
  type StackLinkTone,
} from "./stackFacts.logic";

/**
 * The stack's layers, top first down to the base branch, threaded on one
 * spine. Shared by the rail's stack section, the bar's stack popover and the
 * merge-through picker so a layer reads the same everywhere.
 */

export type SpineTone = StackLinkTone | "selected";

const SPINE_CLASS: Record<SpineTone, string> = {
  plain: "bg-border",
  landable: "bg-success/50",
  merged: "bg-violet-500/55",
  selected: "bg-foreground/70",
};

const MARK_RING_CLASS: Record<FactTone, string> = {
  success: "border-success",
  warning: "border-warning",
  danger: "border-destructive",
  progress: "border-warning",
  neutral: "border-muted-foreground/60",
  merged: "border-violet-600 dark:border-violet-400",
};

const MARK_FILL_CLASS: Record<FactTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  progress: "bg-warning",
  neutral: "bg-muted-foreground/70",
  merged: "bg-violet-600 dark:bg-violet-400",
};

/** One layer's mark: a ring in its tone, filled for the current layer and merged layers. */
export function StackMark(props: {
  readonly tone: FactTone;
  readonly filled?: boolean | undefined;
  /** Stagger index when this mark just turned violet (merge landed). */
  readonly landedIndex?: number | undefined;
}) {
  const filled = props.filled === true || props.tone === "merged";
  return (
    <span
      data-landed={props.landedIndex !== undefined ? "" : undefined}
      style={
        props.landedIndex !== undefined
          ? ({ "--i": props.landedIndex } as CSSProperties)
          : undefined
      }
      className={cn(
        "pr-stack-mark relative block size-[9px] rounded-full border-[1.5px] bg-background",
        MARK_RING_CLASS[props.tone],
        filled && MARK_FILL_CLASS[props.tone],
      )}
      aria-hidden
    />
  );
}

/** The spine column: segments above and below the mark, so rows join into one line. */
export function SpineCell(props: {
  readonly above: SpineTone | null;
  readonly below: SpineTone | null;
  readonly children: ReactNode;
}) {
  const segment =
    "absolute left-1/2 w-px -translate-x-1/2 transition-colors duration-(--app-motion-duration-pane) ease-(--app-motion-ease)";
  return (
    <span className="relative flex w-3.5 shrink-0 items-center justify-center self-stretch">
      {props.above ? (
        <span className={cn(segment, "top-0 h-1/2", SPINE_CLASS[props.above])} />
      ) : null}
      {props.below ? (
        <span className={cn(segment, "bottom-0 h-1/2", SPINE_CLASS[props.below])} />
      ) : null}
      {props.children}
    </span>
  );
}

/**
 * Layers that just landed, bottom-up, so their marks pop violet one after
 * another (`--i` · 90ms). Remembers the previous states per stack.
 */
export function useLandedLayers(
  stack: SourceControlChangeRequestStack,
): ReadonlyMap<number, number> {
  const [landed, setLanded] = useState<ReadonlyMap<number, number>>(() => new Map());
  const previousRef = useRef<{
    readonly stackNumber: number;
    readonly states: ReadonlyMap<number, SourceControlChangeRequestStackEntry["state"]>;
  } | null>(null);
  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = {
      stackNumber: stack.number,
      states: new Map(stack.entries.map((entry) => [entry.number, entry.state])),
    };
    if (!previous || previous.stackNumber !== stack.number) return;
    const newly = newlyMergedLayers(previous.states, stack);
    if (newly.length > 0) setLanded(new Map(newly.map((number, index) => [number, index])));
  }, [stack]);
  return landed;
}

/** Spine tones for each layer row (top-first) plus the base foot. */
export function useStackSpine(
  stack: SourceControlChangeRequestStack,
  selectedThrough: number | null = null,
) {
  return useMemo(() => {
    const layers = stackLayersTopDown(stack);
    const through =
      selectedThrough === null
        ? null
        : (stack.entries.find((entry) => entry.number === selectedThrough) ?? null);
    const linkBelow = (entry: SourceControlChangeRequestStackEntry): SpineTone =>
      through && entry.state !== "merged" && entry.position <= through.position
        ? "selected"
        : stackLinkTone(stack, entry);
    const rows = layers.map((entry, index) => {
      const above = layers[index - 1];
      return {
        entry,
        above: above ? linkBelow(above) : null,
        below: linkBelow(entry),
      };
    });
    const bottom = layers.at(-1);
    return { rows, footAbove: bottom ? linkBelow(bottom) : null };
  }, [selectedThrough, stack]);
}

/** The base branch the stack lands on, as the spine's foot. */
export function StackBaseFoot(props: {
  readonly baseRefName: string;
  readonly above: SpineTone | null;
  readonly trailing?: ReactNode;
}) {
  return (
    <div className="flex h-7 items-center gap-2 px-1.5">
      <SpineCell above={props.above} below={null}>
        <span className="relative block size-[7px] rounded-full border border-muted-foreground/50 bg-background" />
      </SpineCell>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
        {props.baseRefName}
      </span>
      {props.trailing}
    </div>
  );
}

/**
 * Navigable layer list. Clicking a row pushes to that layer; hovering a layer
 * the stack could merge through right now reveals a ghost "Merge through".
 * The current layer carries the selection plate instead of a state word.
 */
export function StackLayerList(props: {
  readonly stack: SourceControlChangeRequestStack;
  readonly currentNumber: number;
  /** Offer merge-through (GitHub-native, complete metadata, viewer may merge). */
  readonly canMergeThrough: boolean;
  readonly onSelect: (number: number) => void;
  readonly onMergeThrough: (number: number, anchor: HTMLElement) => void;
  readonly className?: string | undefined;
}) {
  const { stack } = props;
  const spine = useStackSpine(stack);
  const landed = useLandedLayers(stack);
  return (
    <div
      role="list"
      aria-label={`Stack #${stack.number}`}
      className={cn("flex flex-col", props.className)}
    >
      {spine.rows.map(({ entry, above, below }) => {
        const current = entry.number === props.currentNumber;
        const word = stackLayerWord(entry);
        const landable =
          props.canMergeThrough && stackMergeThroughPlan(stack, entry.number).blocker === null;
        return (
          <div
            key={entry.number}
            role="listitem"
            aria-current={current ? "true" : undefined}
            className={cn(
              "pr-swap relative flex h-7 items-center rounded-md ring-ring transition-colors duration-(--app-motion-duration-chip) has-[[data-layer-main]:focus-visible]:ring-2",
              current ? "bg-accent" : "hover:bg-accent/50",
            )}
          >
            <button
              type="button"
              data-layer-main=""
              onClick={() => props.onSelect(entry.number)}
              className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md pl-1.5 text-left outline-hidden"
              title={entry.title}
            >
              <SpineCell above={above} below={below}>
                <StackMark
                  key={`${entry.number}:${entry.state}`}
                  tone={word.tone}
                  filled={current}
                  landedIndex={landed.get(entry.number)}
                />
              </SpineCell>
              <span
                className={cn(
                  "shrink-0 text-xs tabular-nums",
                  current ? "text-foreground" : "text-muted-foreground",
                )}
              >
                #{entry.number}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-[13px]",
                  current ? "font-medium text-foreground" : "text-foreground/85",
                  entry.state === "merged" && "text-muted-foreground",
                )}
              >
                {entry.title}
              </span>
            </button>
            {/* The state word gives way to "Merge through" (see `.pr-swap` in rail.css). */}
            <span className="pr-swap-slot shrink-0 justify-items-end pr-1.5">
              {current ? null : (
                <span
                  className={cn("text-xs", FACT_TONE_TEXT[word.tone], landable && "pr-swap-out")}
                >
                  {word.text}
                </span>
              )}
              {landable ? (
                <button
                  type="button"
                  onClick={(event) => props.onMergeThrough(entry.number, event.currentTarget)}
                  className="pr-swap-in h-5 rounded px-1.5 text-[11px] text-muted-foreground outline-hidden hover:bg-background/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Merge through
                </button>
              ) : null}
            </span>
          </div>
        );
      })}
      <StackBaseFoot baseRefName={stack.baseRefName} above={spine.footAbove} />
    </div>
  );
}
