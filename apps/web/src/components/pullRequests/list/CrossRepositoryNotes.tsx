import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../../lib/utils";
import { describeCrossRepositoryNote } from "../crossRepository/crossRepositoryList.logic";
import { usePullRequestsPage } from "../PullRequestsPageContext";

/** Notes shown before "and N more". */
const NOTES_SHOWN = 3;

const QUIET_BUTTON_CLASS =
  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-60";

/**
 * Above the All repositories rows: what the list could not read (a failed host or
 * repository, a node it cannot ask, rows cut short or left out), as quiet one-line notes,
 * and "Refresh", which reads every node again past their caches.
 */
export function CrossRepositoryNotes() {
  const { crossRepository } = usePullRequestsPage();
  const [expanded, setExpanded] = useState(false);
  if (!crossRepository) return null;
  const { notes, refresh, isFetching } = crossRepository;
  const shown = expanded ? notes : notes.slice(0, NOTES_SHOWN);
  const more = notes.length - shown.length;
  return (
    <div className="flex flex-col px-1.5 pt-1.5">
      {shown.length > 0 ? (
        <ul aria-label="About this list" className="flex flex-col gap-0.5 px-2.5 pt-0.5">
          {shown.map((note) => (
            <li
              key={JSON.stringify(note)}
              role="status"
              className="text-[11px] leading-4 break-words text-muted-foreground"
            >
              {describeCrossRepositoryNote(note)}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex items-center gap-0.5 pl-1">
        {more > 0 ? (
          <button type="button" className={QUIET_BUTTON_CLASS} onClick={() => setExpanded(true)}>
            and {more} more
          </button>
        ) : null}
        <button
          type="button"
          className={QUIET_BUTTON_CLASS}
          disabled={isFetching}
          onClick={refresh}
        >
          <RefreshCwIcon aria-hidden className={cn("size-3", isFetching && "animate-spin")} />
          Refresh
        </button>
      </div>
    </div>
  );
}
