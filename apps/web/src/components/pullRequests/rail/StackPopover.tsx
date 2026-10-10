import { useRef, useState, type ReactElement, type ReactNode } from "react";

import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { MergeThroughPopover } from "./MergeThroughPopover";
import { StackLayerList } from "./StackLayerList";
import { StackSummary } from "./StackSummary";
import type { StackFacts } from "./useStackFacts";

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
