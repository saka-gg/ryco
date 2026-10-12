import { SidebarInset } from "../ui/sidebar";

/**
 * Pending surface for a full-page route whose chunk is genuinely slow (cold
 * relay or a slow link). Fast loads never show it: the router keeps the
 * previous page until the route chunk resolves and only falls back to this
 * blank page shell after `ROUTE_PAGE_PENDING_MS`. It replaces the boot logo the
 * Statistics and Pull requests pages used to flash, which read as an app restart.
 */
export function RoutePagePending() {
  return (
    <SidebarInset
      aria-busy="true"
      className="h-dvh min-h-0 overflow-hidden bg-background text-foreground"
    />
  );
}

/** How long a page navigation keeps the previous page before showing `RoutePagePending`. */
export const ROUTE_PAGE_PENDING_MS = 300;
