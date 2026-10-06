import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { usePrimaryEnvironmentId } from "../../environments/primary";
import {
  CHECKOUT_WAIT_GRACE_MS,
  createRecentCheckoutKeysSelector,
  useHeldFor,
  useRequestedEnvironment,
} from "../../hooks/useCheckoutResolution";
import { useElementWidth } from "../../hooks/useElementWidth";
import { useEvent } from "../../hooks/useEvent";
import { useLogicalProjectSnapshots } from "../../hooks/useLogicalProjectSnapshots";
import { isPageShortcutKeystroke } from "../pullRequests/pullRequestsShortcuts";
import { shouldIgnoreGlobalNavigationShortcut } from "../../keybindings";
import { buildProjectCheckoutOptions, resolveProjectCheckout } from "../../projectCheckouts.logic";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../../store";
import { SidebarInset } from "../ui/sidebar";
import {
  buildProjectListRows,
  filterProjectListRows,
  findProjectCheckout,
} from "./projectsModel.logic";
import { useProjectsLayoutStore } from "./projectsLayoutStore";
import { createProjectsNavigation } from "./projectsNavigation";
import { ProjectsPageBody } from "./ProjectsPageBody";
import {
  deriveProjectsLayout,
  ProjectsListContext,
  ProjectsPageContext,
  type ProjectsListContextValue,
  type ProjectsCheckoutStatus,
  type ProjectsNavigation,
  type ProjectsPageContextValue,
  type ProjectsSelection,
  type ProjectsSelectionMotion,
} from "./ProjectsPageContext";
import type { ProjectsSearch } from "./projectsSearch";

export interface ProjectsPageProps {
  readonly search: ProjectsSearch;
  readonly onSearchChange: (next: ProjectsSearch, options?: { readonly replace?: boolean }) => void;
}

/** `j` / `k` move between projects and `/` focuses the filter, page-wide. */
function useProjectsPageKeys(nav: ProjectsNavigation, focusFilter: () => void) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isPageShortcutKeystroke(event)) return;
      if (shouldIgnoreGlobalNavigationShortcut(event)) return;
      if (event.key === "j" || event.key === "k") {
        event.preventDefault();
        nav.stepProject(event.key === "j" ? 1 : -1);
      } else if (event.key === "/") {
        event.preventDefault();
        focusFilter();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusFilter, nav]);
}

export function ProjectsPage({ search, onSearchChange }: ProjectsPageProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  // ── Projects and the checkout the URL names ─────────────────────────
  const { snapshots } = useLogicalProjectSnapshots();
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));
  const rows = useMemo(
    () => buildProjectListRows({ snapshots, threads, primaryEnvironmentId }),
    [primaryEnvironmentId, snapshots, threads],
  );
  const options = useMemo(() => buildProjectCheckoutOptions(snapshots), [snapshots]);
  const lastCheckoutKey = useProjectsLayoutStore((state) => state.lastCheckoutKey);
  const setLastCheckoutKey = useProjectsLayoutStore((state) => state.setLastCheckoutKey);
  const selectRecentKeys = useMemo(() => createRecentCheckoutKeysSelector(), []);
  const recentKeys = useStore(selectRecentKeys);
  const requestedEnvironment = useRequestedEnvironment(search.env);
  const resolution = useMemo(
    () =>
      resolveProjectCheckout({
        options,
        requested: { env: search.env, project: search.project },
        requestedEnvironmentSync: requestedEnvironment.sync,
        lastKey: lastCheckoutKey,
        recentKeys,
      }),
    [lastCheckoutKey, options, recentKeys, requestedEnvironment.sync, search.env, search.project],
  );
  // A default (no checkout in the URL) is pinned into the URL once, so later
  // thread activity re-ranking "recent" can never swap the project under the
  // reader. Only a checkout the user chose becomes next time's default.
  const fallbackKey =
    resolution.kind === "resolved" && resolution.source !== "url" ? resolution.option.key : null;
  const pinnedFallbackKeyRef = useRef<string | null>(null);
  const chosenKey =
    resolution.kind === "resolved" && resolution.source === "url" ? resolution.option.key : null;
  useEffect(() => {
    if (chosenKey !== null && chosenKey !== pinnedFallbackKeyRef.current) {
      setLastCheckoutKey(chosenKey);
    }
  }, [chosenKey, setLastCheckoutKey]);

  const selection = useMemo<ProjectsSelection | null>(() => {
    if (resolution.kind !== "resolved") return null;
    const found = findProjectCheckout(
      snapshots,
      resolution.option.environmentId,
      resolution.option.projectId,
    );
    if (!found) return null;
    return {
      index: snapshots.findIndex((snapshot) => snapshot.projectKey === found.snapshot.projectKey),
      snapshot: found.snapshot,
      member: found.member,
      checkoutKey: resolution.option.key,
    };
  }, [resolution, snapshots]);

  const waitStalled = useHeldFor(resolution.kind === "waiting", CHECKOUT_WAIT_GRACE_MS);
  const status = useMemo<ProjectsCheckoutStatus>(() => {
    switch (resolution.kind) {
      case "resolved":
        return { kind: "ready" };
      case "empty":
        return { kind: "empty" };
      case "waiting":
        return {
          kind: "waiting",
          requested: resolution.requested,
          environmentLabel: requestedEnvironment.label,
          stalled: waitStalled,
        };
      case "unavailable":
        return {
          kind: "unavailable",
          requested: resolution.requested,
          environmentLabel: requestedEnvironment.label,
          reason: resolution.reason,
        };
    }
  }, [requestedEnvironment.label, resolution, waitStalled]);

  // ── Filter ───────────────────────────────────────────────────────────
  const [filter, setFilter] = useState("");
  const visibleRows = useMemo(() => filterProjectListRows(rows, filter), [filter, rows]);

  // ── Layout ───────────────────────────────────────────────────────────
  const rootRef = useRef<HTMLDivElement>(null);
  const pageWidth = useElementWidth(rootRef);
  const drawerOpen = useProjectsLayoutStore((state) => state.drawerOpen);
  const setDrawerOpen = useProjectsLayoutStore((state) => state.setDrawerOpen);
  const hasSelection = selection !== null;
  const layout = useMemo(
    () =>
      deriveProjectsLayout({
        pageWidth,
        hasDetail: status.kind !== "empty" && (hasSelection || status.kind !== "ready"),
        drawerOpen,
        setDrawerOpen,
      }),
    [drawerOpen, hasSelection, pageWidth, setDrawerOpen, status.kind],
  );
  useEffect(() => {
    if (layout.listDocked || layout.listFillsPage) setDrawerOpen(false);
  }, [layout.listDocked, layout.listFillsPage, setDrawerOpen]);

  // ── Navigation ───────────────────────────────────────────────────────
  const [selectionMotion, setSelectionMotion] = useState<ProjectsSelectionMotion>({
    direction: 0,
    token: 0,
  });
  const getSearch = useEvent(() => search);
  const getRows = useEvent(() => rows);
  const getVisibleRows = useEvent(() => visibleRows);
  const getSelection = useEvent(() => selection);
  // Work that settles after the reader left (an applied workspace change, a
  // project removal) must not navigate back to this page.
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const commit = useEvent((next: ProjectsSearch, commitOptions: { readonly push: boolean }) =>
    !mountedRef.current
      ? undefined
      : onSearchChange(
          Object.fromEntries(
            Object.entries(next).filter(([, value]) => value !== undefined),
          ) as ProjectsSearch,
          { replace: !commitOptions.push },
        ),
  );
  const actions = useMemo(
    () =>
      createProjectsNavigation({
        getSearch,
        getRows,
        getVisibleRows,
        getSelection,
        commit,
        setSelectionMotion,
        closeDrawer: () => useProjectsLayoutStore.getState().setDrawerOpen(false),
      }),
    [commit, getRows, getSearch, getSelection, getVisibleRows],
  );
  const nav = useMemo<ProjectsNavigation>(() => ({ search, ...actions }), [actions, search]);
  const focusFilter = useEvent(() => {
    const input = document.querySelector<HTMLInputElement>("[data-projects-filter]");
    if (input) {
      input.focus();
      input.select();
      return;
    }
    // No list mounted (drawer closed): open it; the pane focuses on mount.
    useProjectsLayoutStore.getState().requestFilterFocus();
    setDrawerOpen(true);
  });
  useProjectsPageKeys(nav, focusFilter);
  useEffect(() => {
    if (fallbackKey === null) return;
    const option = options.find((candidate) => candidate.key === fallbackKey);
    if (!option) return;
    pinnedFallbackKeyRef.current = fallbackKey;
    commit(
      { ...getSearch(), env: option.environmentId, project: option.projectId },
      { push: false },
    );
  }, [commit, fallbackKey, getSearch, options]);

  const value = useMemo<ProjectsPageContextValue>(
    () => ({
      status,
      selection,
      nav,
      layout,
      selectionMotion,
      primaryEnvironmentId,
    }),
    [layout, nav, primaryEnvironmentId, selection, selectionMotion, status],
  );
  const listValue = useMemo<ProjectsListContextValue>(
    () => ({ rows, filter, setFilter }),
    [filter, rows],
  );

  return (
    <SidebarInset
      data-slot="projects-page"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground"
    >
      <ProjectsPageContext.Provider value={value}>
        <ProjectsListContext.Provider value={listValue}>
          <div
            ref={rootRef}
            className="projects-page @container/projects relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            <ProjectsPageBody />
          </div>
        </ProjectsListContext.Provider>
      </ProjectsPageContext.Provider>
    </SidebarInset>
  );
}
