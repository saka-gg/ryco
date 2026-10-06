import { ChevronRightIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import { usePullRequestsPage } from "../PullRequestsPageContext";
import { usePullRequestsShortcut } from "../pullRequestsShortcuts";
import { MergeThroughPopover } from "./MergeThroughPopover";
import { usePullRequestRailStore } from "./railStore";
import { StackLayerList } from "./StackLayerList";
import { StackPopover } from "./StackPopover";
import { StackSummary } from "./StackSummary";
import { useStackFacts } from "./useStackFacts";

const SHELL =
  "grid transition-[grid-template-rows,opacity] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-gentle)";

/**
 * The stack, once, on Conversation. In the rail it is a disclosure: the
 * one-line summary, expanding to every layer (top first, down to the base).
 * In the band it is a fact that opens the same list in a popover. `S` toggles
 * either.
 */
export function StackSection(props: { readonly layout: "rail" | "band" }) {
  const facts = useStackFacts();
  const { readerKey } = usePullRequestsPage();
  const expanded = usePullRequestRailStore((state) =>
    readerKey ? (state.stackExpanded[readerKey] ?? false) : false,
  );
  const setExpanded = usePullRequestRailStore((state) => state.setStackExpanded);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [mergeThrough, setMergeThrough] = useState<number | null>(null);
  const mergeAnchorRef = useRef<Element | null>(null);
  const toggle = () => {
    if (props.layout === "band") setPopoverOpen((open) => !open);
    else if (readerKey) setExpanded(readerKey, !expanded);
  };
  usePullRequestsShortcut(
    "s",
    () => {
      if (!facts) return false;
      toggle();
    },
    { tab: "conversation", enabled: facts !== null },
  );
  if (!facts) return null;

  if (props.layout === "band") {
    return (
      <StackPopover
        facts={facts}
        open={popoverOpen}
        onOpenChange={setPopoverOpen}
        triggerShows="summary"
        align="start"
        trigger={
          <button
            type="button"
            className="-mx-1.5 inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent/60"
          >
            <StackSummary facts={facts} />
            <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        }
      />
    );
  }

  return (
    <section aria-label={`Stack #${facts.stack.number}`} className="flex flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={toggle}
        className="-mx-1.5 flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-left text-xs outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <StackSummary facts={facts} className="flex-1" />
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform duration-(--app-motion-duration-chip) ease-(--app-motion-spring-snappy)",
            expanded && "rotate-90",
          )}
        />
      </button>
      <div
        className={cn(
          SHELL,
          expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
        inert={!expanded}
      >
        <div className="min-h-0 overflow-hidden">
          <StackLayerList
            stack={facts.stack}
            currentNumber={facts.currentNumber}
            canMergeThrough={facts.canMergeThrough}
            onSelect={facts.selectLayer}
            onMergeThrough={(number, anchor) => {
              mergeAnchorRef.current = anchor.closest("[role=listitem]") ?? anchor;
              setMergeThrough(number);
            }}
            className="-mx-1.5 pt-1"
          />
        </div>
      </div>
      <MergeThroughPopover
        open={mergeThrough !== null}
        onOpenChange={(open) => {
          if (!open) setMergeThrough(null);
        }}
        anchor={mergeAnchorRef}
        initialThrough={mergeThrough}
        side="left"
        align="start"
      />
    </section>
  );
}
