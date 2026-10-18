import type { ReactNode } from "react";

import { PAGE_BAR_CLASS, PAGE_BAR_TRAILING_WCO_INSET_CLASS } from "~/appChrome";
import { usePageLeadingInsetClass } from "~/hooks/usePageLeadingInsetClass";
import { cn } from "~/lib/utils";

import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";

/**
 * The Tasks page's shell: the 52px page bar (window drag area and the room
 * the collapsed sidebar's controls need, nothing else) over a scrolling
 * column centred at 680px. `state` replaces the column's content when the
 * page can't show tasks (not allowed, not supported, failed to load).
 */
export function TasksPageLayout(props: {
  readonly state?: ReactNode;
  readonly children?: ReactNode;
}) {
  const leadingInset = usePageLeadingInsetClass(true, "pl-3");
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header
          data-tasks-page-bar
          className={cn(PAGE_BAR_CLASS, leadingInset, "pr-3", PAGE_BAR_TRAILING_WCO_INSET_CLASS)}
        />
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-6 pt-6 pb-24">
            <div className="mx-auto w-full max-w-[680px]">{props.state ?? props.children}</div>
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
