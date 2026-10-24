import { useCallback, useEffect, useMemo, useState } from "react";

import { rememberClosedView, type ClosedViewOwner } from "../closedViews";
import type { RightPanelMode } from "../rightPanelRouteSearch";
import {
  buildRightPanelTargetSearch,
  closedRightPanelTarget,
  closeRightPanelTab,
  isRightPanelTargetVisible,
  markRightPanelTabOpened,
  openedTabsFromRoute,
  rememberActiveAgentTab,
  rememberActiveRenderTab,
  resolveActiveRightPanelClose,
  resolveOpenedTabs,
  resolveRightPanelReopenTarget,
  shouldMountRightPanelContent,
  visibleRightPanelTabs,
  type RightPanelRouteTabs,
  type RightPanelTabRef,
  type RightPanelTarget,
  type RightPanelTabTarget,
} from "../rightPanelTabs.logic";
import { buildCloseWorkspacePanelSearch } from "../workspaceRouteSearch";

export type RightPanelSearchUpdate = (previous: Record<string, unknown>) => Record<string, unknown>;

/**
 * The workspace panel's tab memory for one route (a thread or a draft):
 * which tabs are open, where the panel reopens, and where closing the active
 * tab lands. `navigateSearch` pushes a search update onto the hosting route.
 */
export function useRightPanelTabs(input: {
  readonly scopeKey: string | null;
  readonly rightPanelMode: RightPanelMode | null;
  readonly rightPanelOpen: boolean;
  readonly activeAgentKey: string | null;
  /** The render the route's page tab shows; routes without pages leave it out. */
  readonly activeRenderKey?: string | null;
  /** Where the panel reopens before any tab was shown on this route. */
  readonly defaultLastMode: RightPanelMode;
  readonly navigateSearch: (update: RightPanelSearchUpdate) => void;
  /** Who closed tabs are remembered for, so they can be reopened; null remembers none. */
  readonly closedViewOwner: ClosedViewOwner | null;
}) {
  const {
    scopeKey,
    rightPanelMode,
    rightPanelOpen,
    activeAgentKey,
    navigateSearch,
    closedViewOwner,
  } = input;
  const activeRenderKey = input.activeRenderKey ?? null;
  const route = useMemo<RightPanelRouteTabs>(
    () => ({ scopeKey, mode: rightPanelMode, activeAgentKey, activeRenderKey }),
    [activeAgentKey, activeRenderKey, rightPanelMode, scopeKey],
  );
  const [state, setState] = useState(() => openedTabsFromRoute(route));
  const [lastOpenedRightPanelMode, setLastOpenedRightPanelMode] = useState<RightPanelMode>(
    () => rightPanelMode ?? input.defaultLastMode,
  );
  const opened = useMemo(() => resolveOpenedTabs(state, route), [route, state]);
  const visible = useMemo(() => visibleRightPanelTabs(opened, route), [opened, route]);

  const markRightPanelOpened = useCallback(
    (mode: RightPanelMode) => {
      setLastOpenedRightPanelMode(mode);
      setState((previous) => markRightPanelTabOpened(previous, route, mode));
    },
    [route],
  );

  const closeRightPanel = useCallback(() => {
    navigateSearch((previous) => buildCloseWorkspacePanelSearch(previous));
  }, [navigateSearch]);

  const openPanelTarget = useCallback(
    (target: RightPanelTarget) => {
      navigateSearch((previous) => buildRightPanelTargetSearch(previous, target));
    },
    [navigateSearch],
  );

  const openRightPanel = useCallback(() => {
    openPanelTarget(resolveRightPanelReopenTarget(state, route, lastOpenedRightPanelMode));
  }, [lastOpenedRightPanelMode, openPanelTarget, route, state]);

  const toggleRightPanel = useCallback(() => {
    if (rightPanelOpen) {
      closeRightPanel();
      return;
    }
    openRightPanel();
  }, [closeRightPanel, openRightPanel, rightPanelOpen]);

  const closePanelTab = useCallback(
    (tab: RightPanelTabRef) => {
      const closed = closedRightPanelTarget(visible, tab);
      if (closedViewOwner && closed) {
        rememberClosedView({ kind: "tab", owner: closedViewOwner, target: closed });
      }
      const { target } = closeRightPanelTab(state, route, tab);
      setState((previous) => closeRightPanelTab(previous, route, tab).next);
      if (target) openPanelTarget(target);
    },
    [closedViewOwner, openPanelTarget, route, state, visible],
  );

  /** Closes the open panel's active tab, or the panel while it shows the launcher. */
  const closeActiveView = useCallback((): boolean => {
    const active = resolveActiveRightPanelClose({ open: rightPanelOpen, route });
    if (active?.kind === "tab") closePanelTab(active.tab);
    else if (active) closeRightPanel();
    return active !== null;
  }, [closePanelTab, closeRightPanel, rightPanelOpen, route]);

  const isPanelTargetOpen = useCallback(
    (target: RightPanelTabTarget) => rightPanelOpen && isRightPanelTargetVisible(visible, target),
    [rightPanelOpen, visible],
  );

  useEffect(() => {
    if (rightPanelMode !== null) {
      markRightPanelOpened(rightPanelMode);
    }
  }, [markRightPanelOpened, rightPanelMode]);

  useEffect(() => {
    setState((previous) => rememberActiveRenderTab(rememberActiveAgentTab(previous, route), route));
  }, [route]);

  return {
    openedPanelModes: visible.modes,
    openedAgentKeys: visible.agentKeys,
    openedRenderKey: visible.renderKey,
    lastOpenedRightPanelMode,
    markRightPanelOpened,
    openRightPanel,
    closeRightPanel,
    toggleRightPanel,
    closePanelTab,
    closeActiveView,
    isPanelTargetOpen,
    openPanelTarget,
    shouldRenderRightPanelContent: shouldMountRightPanelContent({
      open: rightPanelOpen,
      route,
      opened,
      agentKeys: visible.agentKeys,
      phone: false,
    }),
    shouldRenderPhoneRightPanelContent: shouldMountRightPanelContent({
      open: rightPanelOpen,
      route,
      opened,
      agentKeys: visible.agentKeys,
      phone: true,
    }),
  };
}
