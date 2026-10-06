import {
  APP_SIDEBAR_CHROME_INSET_TRANSITION_CLASS,
  COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS,
} from "../appChrome";
import { cn } from "../lib/utils";
import { useAppSidebarCollapsed } from "./useAppSidebarCollapsed";

/**
 * Leading inset for whichever page bar owns the window's top-left corner: the
 * collapsed-sidebar chrome inset while the app sidebar is collapsed, else
 * `fallback`. Bars that do not own the corner pass `owns: false`.
 */
export function usePageLeadingInsetClass(owns: boolean, fallback: string): string {
  const collapsed = useAppSidebarCollapsed();
  return cn(
    APP_SIDEBAR_CHROME_INSET_TRANSITION_CLASS,
    owns && collapsed ? COLLAPSED_APP_SIDEBAR_CHROME_INSET_CLASS : fallback,
  );
}
