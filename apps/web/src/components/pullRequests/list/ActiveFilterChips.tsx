import { XIcon } from "lucide-react";
import { useRef } from "react";

import { cn } from "../../../lib/utils";
import { usePullRequestsPage } from "../PullRequestsPageContext";
import {
  PULL_REQUEST_FILTER_RESET,
  pullRequestFilterChips,
  type PullRequestFilterChip,
} from "./pullRequestListFilters.logic";

const CHIP_CLASS =
  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

/**
 * Filters that are off their default, each removable, plus "Clear". Quiet text
 * buttons rather than pills; the row folds open and shut with the disclosure
 * motion, keeping its last chips on screen while it closes.
 */
export function ActiveFilterChips() {
  const { nav, model } = usePullRequestsPage();
  const chips = pullRequestFilterChips(nav.search, model.list.labels);
  const lastChipsRef = useRef<ReadonlyArray<PullRequestFilterChip>>(chips);
  if (chips.length > 0) lastChipsRef.current = chips;
  const open = chips.length > 0;
  const shown = open ? chips : lastChipsRef.current;
  return (
    <div
      data-open={open}
      aria-hidden={open ? undefined : true}
      inert={!open}
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-(--app-motion-duration-stack) ease-(--app-motion-spring-gentle)",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          role="group"
          aria-label="Active filters"
          className="flex flex-wrap items-center gap-x-0.5 gap-y-1 pt-2 pr-1.5 pb-0.5 pl-2.5"
        >
          {shown.map((chip) => (
            <button
              key={chip.key}
              type="button"
              aria-label={`Remove filter: ${chip.label}`}
              className={CHIP_CLASS}
              onClick={() => nav.setSearch(chip.clear)}
            >
              {chip.key.startsWith("label:") ? (
                <span
                  aria-hidden
                  className="size-1.5 rounded-full bg-muted-foreground/50"
                  style={chip.color ? { backgroundColor: `#${chip.color}` } : undefined}
                />
              ) : null}
              <span className="text-foreground/80">{chip.label}</span>
              <XIcon aria-hidden className="size-3 opacity-60" />
            </button>
          ))}
          {shown.length > 1 ? (
            <button
              type="button"
              className={cn(CHIP_CLASS, "text-muted-foreground/80")}
              onClick={() => nav.setSearch(PULL_REQUEST_FILTER_RESET)}
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
