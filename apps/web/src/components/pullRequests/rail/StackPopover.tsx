import { LayersIcon } from "lucide-react";
import { useRef, useState, type ReactElement, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { FACT_TONE_TEXT } from "./FactGlyph";
import { MergeThroughPopover } from "./MergeThroughPopover";
import { StackLayerList } from "./StackLayerList";
import type { StackFacts } from "./useStackFacts";

/** "Stack #14 · 3 of 4 · #701 can land" — the stack in one line. */
export function StackSummary(props: {
  readonly facts: StackFacts;
  readonly className?: string | undefined;
  /** Leave out "3 of 4" where the trigger right above already shows the position. */
  readonly withoutPosition?: boolean | undefined;
}) {
  const { facts } = props;
  const foot = facts.assessment.foot;
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5", props.className)}>
      <LayersIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 truncate">
        <span className="text-foreground">Stack #{facts.stack.number}</span>
        {props.withoutPosition ? null : (
          <>
            <span className="text-muted-foreground"> · </span>
            <span className="text-muted-foreground tabular-nums">{facts.position}</span>
          </>
        )}
        {facts.incomplete ? (
          <span className="text-muted-foreground"> · Stack details unavailable</span>
        ) : foot ? (
          <>
            <span className="text-muted-foreground"> · </span>
            <span className={FACT_TONE_TEXT[foot.tone]}>{foot.text}</span>
          </>
        ) : null}
      </span>
    </span>
  );
}

/**
 * The stack as a popover off its trigger (the bar's chip, the band's stack
 * fact). Picking a layer pushes to it; "Merge through" swaps this popover for
 * the merge-through picker on the same anchor. The header adds only what the
 * trigger does not already say, so no stack fact shows twice.
 */
export function StackPopover(props: {
  readonly facts: StackFacts;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Rendered as the popover trigger (a button). */
  readonly trigger: ReactElement;
  /**
   * What the trigger already shows: only the position (the bar's "3/4" chip),
   * or the whole summary (the band's stack fact, which leaves the header to
   * screen readers).
   */
  readonly triggerShows: "position" | "summary";
  /** Tooltip content for the trigger. */
  readonly tooltip?: ReactNode;
  readonly align?: "start" | "center" | "end";
}) {
  const { facts } = props;
  const anchorRef = useRef<HTMLElement | null>(null);
  const [mergeThrough, setMergeThrough] = useState<number | null>(null);
  return (
    <>
      <Popover open={props.open} onOpenChange={props.onOpenChange}>
        {props.tooltip ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <PopoverTrigger
                  ref={(node: HTMLElement | null) => {
                    anchorRef.current = node;
                  }}
                  render={props.trigger}
                />
              }
            />
            <TooltipPopup side="bottom" sideOffset={6}>
              {props.tooltip}
            </TooltipPopup>
          </Tooltip>
        ) : (
          <PopoverTrigger
            ref={(node: HTMLElement | null) => {
              anchorRef.current = node;
            }}
            render={props.trigger}
          />
        )}
        <PopoverPopup
          side="bottom"
          align={props.align ?? "end"}
          sideOffset={6}
          className="w-80"
          viewportClassName="px-2 py-2 [--viewport-inline-padding:--spacing(2)]"
        >
          {props.triggerShows === "summary" ? (
            <PopoverTitle className="sr-only">Stack #{facts.stack.number}</PopoverTitle>
          ) : (
            <div className="flex items-baseline gap-2 px-1.5 pt-1 pb-2">
              <PopoverTitle className="min-w-0 flex-1 text-xs font-normal">
                <StackSummary facts={facts} withoutPosition />
              </PopoverTitle>
            </div>
          )}
          <StackLayerList
            stack={facts.stack}
            currentNumber={facts.currentNumber}
            canMergeThrough={facts.canMergeThrough}
            onSelect={(number) => {
              props.onOpenChange(false);
              facts.selectLayer(number);
            }}
            onMergeThrough={(number) => {
              props.onOpenChange(false);
              setMergeThrough(number);
            }}
          />
        </PopoverPopup>
      </Popover>
      <MergeThroughPopover
        open={mergeThrough !== null}
        onOpenChange={(open) => {
          if (!open) setMergeThrough(null);
        }}
        anchor={anchorRef}
        initialThrough={mergeThrough}
        align={props.align ?? "end"}
      />
    </>
  );
}
