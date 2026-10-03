import { useMemo } from "react";

import type { PullRequestsLayout } from "./PullRequestsPageContext";
import { usePullRequestsLayoutStore } from "./pullRequestsLayoutStore";
import { derivePullRequestsLayoutMetrics } from "./pullRequestsModel.logic";
import type { PullRequestsTab } from "./pullRequestsSearch";

/**
 * The page layout from its measured width and the persisted preferences:
 * the breakpoints (`derivePullRequestsLayoutMetrics`) plus the list toggle.
 * Shared by the page and the test provider so both lay out identically.
 */
export function usePullRequestsLayout(input: {
  readonly pageWidth: number;
  readonly hasSelection: boolean;
  readonly tab: PullRequestsTab;
  /** Test-only: pin individual facts (e.g. `{ railDocked: false }`). */
  readonly overrides?: Partial<PullRequestsLayout> | undefined;
}): PullRequestsLayout {
  const { pageWidth, hasSelection, tab, overrides } = input;
  const listWidth = usePullRequestsLayoutStore((state) => state.listWidth);
  const listHidden = usePullRequestsLayoutStore((state) => state.listHidden);
  const drawerOpen = usePullRequestsLayoutStore((state) => state.drawerOpen);
  const metrics = derivePullRequestsLayoutMetrics({
    pageWidth,
    listWidth,
    listHidden,
    hasSelection,
    tab,
  });
  const {
    listDocked,
    listVisible,
    listFillsPage,
    readerWidth,
    railDocked,
    treeDocked,
    barCompact,
    leadingRegion,
  } = metrics;
  return useMemo<PullRequestsLayout>(
    () => ({
      pageWidth,
      listDocked,
      listVisible,
      listFillsPage,
      listWidth,
      readerWidth,
      railDocked,
      treeDocked,
      barCompact,
      leadingRegion,
      drawerOpen,
      toggleList: () => {
        const store = usePullRequestsLayoutStore.getState();
        if (listDocked) store.toggleListHidden();
        else store.setDrawerOpen(!store.drawerOpen);
      },
      openDrawer: () => usePullRequestsLayoutStore.getState().setDrawerOpen(true),
      closeDrawer: () => usePullRequestsLayoutStore.getState().setDrawerOpen(false),
      ...overrides,
    }),
    [
      barCompact,
      drawerOpen,
      leadingRegion,
      listDocked,
      listFillsPage,
      listVisible,
      listWidth,
      overrides,
      pageWidth,
      railDocked,
      readerWidth,
      treeDocked,
    ],
  );
}
