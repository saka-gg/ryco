import { useCallback, useEffect, useMemo, useState } from "react";

import type { RightPanelMode } from "../rightPanelRouteSearch";
import {
  buildRightPanelTargetSearch,
  closeRightPanelTab,
  markRightPanelTabOpened,
  openedTabsFromRoute,
  rememberActiveAgentTab,
  rememberActiveRenderTab,
  resolveOpenedTabs,
  resolveRightPanelReopenTarget,
  shouldMountRightPanelContent,
  visibleRightPanelTabs,
  type RightPanelRouteTabs,
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
}) {
  const { scopeKey, rightPanelMode, rightPanelOpen, activeAgentKey, navigateSearch } = input;
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

  const openRightPanel = useCallback(() => {
    const target = resolveRightPanelReopenTarget(state, route, lastOpenedRightPanelMode);
    navigateSearch((previous) => buildRightPanelTargetSearch(previous, target));
  }, [lastOpenedRightPanelMode, navigateSearch, route, state]);

  const toggleRightPanel = useCallback(() => {
    if (rightPanelOpen) {
      closeRightPanel();
      return;
    }
    openRightPanel();
  }, [closeRightPanel, openRightPanel, rightPanelOpen]);

  const closePanelTab = useCallback(
    (tab: { mode: RightPanelMode; agentKey?: string }) => {
      const { target } = closeRightPanelTab(state, route, tab);
      setState((previous) => closeRightPanelTab(previous, route, tab).next);
      if (target) {
        navigateSearch((previous) => buildRightPanelTargetSearch(previous, target));
      }
    },
    [navigateSearch, route, state],
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
