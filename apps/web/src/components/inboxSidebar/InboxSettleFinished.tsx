import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { ScopedThreadRef } from "@ryco/contracts";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

import { useUiStateStore } from "../../uiStateStore";
import { isCompletionUnseen } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { selectSettleFinishedRows } from "./inboxSettleFinished.logic";
import type { InboxSidebarRow } from "./inboxSidebarModel";

// InboxSidebar loads this after the shell. Import only boot modules and modules
// nothing else imports: a module that also sits in a shell chunk would move
// into a chunk file of its own. That is why `onSettle` is passed in.

export interface InboxSettleFinishedProps {
  readonly rows: ReadonlyArray<InboxSidebarRow>;
  readonly activeThreadKey: string | null;
  /** Settles the threads with one Undo; the button stays disabled until it resolves. */
  readonly onSettle: (targets: readonly ScopedThreadRef[]) => Promise<unknown>;
}

/**
 * The Recent header's "Settle finished": settles, with one Undo, every
 * finished thread there whose result the user has seen. Absent when none
 * qualifies. It reads the visits itself, so a visit renders only this button.
 */
export function InboxSettleFinished(props: InboxSettleFinishedProps) {
  const lastVisitedAtByKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const [pending, setPending] = useState(false);
  const finished = selectSettleFinishedRows(props.rows, {
    // The open thread counts as seen, as on its row.
    isUnseen: (row) =>
      row.key !== props.activeThreadKey &&
      isCompletionUnseen(row.latestTurnCompletedAt, lastVisitedAtByKey[row.key]),
  });
  if (finished.length === 0) return null;
  const settle = () => {
    setPending(true);
    void props
      .onSettle(finished.map((row) => scopeThreadRef(row.environmentId, row.threadId)))
      .finally(() => setPending(false));
  };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={`Settle ${finished.length} finished ${finished.length === 1 ? "thread" : "threads"}`}
            // Negative margins keep the header as tall as the others. Revealed with
            // the header's hover or focus, and always shown to touch.
            className="-my-1 ml-auto flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-hidden transition-opacity duration-(--app-motion-duration-chip) hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:text-muted-foreground/40 disabled:hover:bg-transparent motion-reduce:transition-none group-hover/inbox-section:opacity-100 group-focus-within/inbox-section:opacity-100 pointer-coarse:opacity-100"
            disabled={pending}
            onClick={settle}
            type="button"
          />
        }
      >
        <CheckIcon aria-hidden className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">Settle finished</TooltipPopup>
    </Tooltip>
  );
}
