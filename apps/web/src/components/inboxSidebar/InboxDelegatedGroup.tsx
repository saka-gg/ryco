import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Compact disclosure under an inbox host row for its folded delegated children.
 * Only quiet children fold (see `planDelegatedNesting`), so collapsing never
 * hides live work. Expanded children render as ordinary inbox rows behind a
 * guide line, not inside a card.
 */
export function InboxDelegatedGroup(props: {
  readonly hostTitle: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  const Chevron = props.expanded ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div data-testid="inbox-delegated-group">
      <button
        aria-expanded={props.expanded}
        aria-label={`Show ${props.count} delegated ${props.count === 1 ? "thread" : "threads"} from ${props.hostTitle}`}
        // Indented to the row's title column: px-2 plus the 1.375rem glyph column.
        className="flex h-5 w-full items-center gap-1 rounded-md pl-[1.875rem] pr-2 text-left text-[11px] text-muted-foreground outline-hidden hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={props.onToggle}
        type="button"
      >
        <Chevron aria-hidden className="size-3 shrink-0 text-muted-foreground/55" />
        <span className="tabular-nums">{props.count} delegated</span>
      </button>
      {props.expanded ? (
        <div className="ml-3 space-y-px border-l border-sidebar-border/60 pl-1">
          {props.children}
        </div>
      ) : null}
    </div>
  );
}
