import { isElectron } from "./env";

/**
 * Left inset for whichever bar owns the workspace's top-left corner while the
 * app sidebar is collapsed.
 *
 * A collapsed sidebar leaves no chrome at that corner, so the shell floats the
 * brand mark, statistics, settings, and the show-sidebar control there (see
 * `CollapsedAppSidebarChrome`) — roughly 120px of controls, starting at the x
 * the mark occupies in the expanded header. In the desktop shell the same
 * corner also carries the native window controls: macOS traffic lights, or the
 * Window Controls Overlay geometry. The inset has to clear both. Which bar
 * owns the corner depends on the layout: normally the chat header, or the
 * workspace panel tab bar while that panel is maximized.
 */
export const COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS = isElectron
  ? "pl-[232px] wco:pl-[calc(env(titlebar-area-x)+10rem)]"
  : "pl-[calc(env(safe-area-inset-left)+10rem)]";

/**
 * Pairs with the inset above on the same element.
 *
 * The inset swaps between two very different paddings the moment the sidebar
 * is toggled, while the surface it sits on resizes across the sidebar's 200ms
 * slide. Left unanimated the breadcrumb and thread title jump to their final
 * position on the first frame and then wait for the panel to catch up. Match
 * the sidebar's own timing so the two move as one.
 */
export const APP_SIDEBAR_CHROME_INSET_TRANSITION_CLASS =
  "transition-[padding-left] duration-200 ease-linear motion-reduce:transition-none";

/**
 * The 52px bar of a top-level page (pull requests, projects): a bottom
 * hairline, and in the desktop shell a drag region matching the native
 * titlebar height. Clickable non-button wrappers inside it need
 * `[-webkit-app-region:no-drag]`.
 */
export const PAGE_BAR_CLASS = isElectron
  ? "flex shrink-0 items-center gap-2 border-b border-border/70 drag-region h-[52px] wco:h-[env(titlebar-area-height)]"
  : "flex shrink-0 items-center gap-2 border-b border-border/70 h-[52px]";

/**
 * Right inset for the bar that owns the window's top-right corner, clearing
 * the Windows Controls Overlay buttons.
 */
export const PAGE_BAR_TRAILING_WCO_INSET_CLASS =
  "wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+0.75rem)]";

/** A left drawer overlays the window's corner: clear the macOS traffic lights (or the WCO origin). */
export const PAGE_DRAWER_LEADING_INSET_CLASS = isElectron
  ? "pl-[84px] wco:pl-[calc(env(titlebar-area-x)+0.75rem)]"
  : "pl-2.5";
