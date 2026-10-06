import { useEffect, useMemo, useRef, useState } from "react";

import {
  CHECKOUT_WAIT_GRACE_MS,
  createRecentCheckoutKeysSelector,
  useHeldFor,
  useRequestedEnvironment,
} from "../../hooks/useCheckoutResolution";
import { useElementWidth } from "../../hooks/useElementWidth";
import { useEvent } from "../../hooks/useEvent";
import { useLogicalProjectSnapshots } from "../../hooks/useLogicalProjectSnapshots";
import { useStore } from "../../store";
import { readMotionDurationMs } from "../../lib/perf/motion";
import { SidebarInset } from "../ui/sidebar";
import {
  PULL_REQUESTS_PAGE_SURFACE,
  PullRequestsPageContext,
  type PullRequestSelectionMotion,
  type PullRequestsNavigation,
  type PullRequestsPageContextValue,
  type PullRequestsRepositoryStatus,
} from "./PullRequestsPageContext";
import { PullRequestsPageBody } from "./PullRequestsPageBody";
import { buildProjectCheckoutOptions, resolveProjectCheckout } from "../../projectCheckouts.logic";
import { pullRequestReaderKey, usePullRequestsLayoutStore } from "./pullRequestsLayoutStore";
import {
  createPullRequestsNavigation,
  type PullRequestsNavigationDeps,
} from "./pullRequestsNavigation";
import { resolvePullRequestsTab, type PullRequestsSearch } from "./pullRequestsSearch";
import { PullRequestsShortcutsProvider } from "./pullRequestsShortcuts";
import { PullRequestsPageShortcuts } from "./PullRequestsPageShortcuts";
import { usePullRequestsLayout } from "./usePullRequestsLayout";
import { usePullRequestsModel } from "./usePullRequestsModel";

export interface PullRequestsPageProps {
  readonly search: PullRequestsSearch;
  readonly onSearchChange: (
    next: PullRequestsSearch,
    options?: {
      readonly replace?: boolean;
      /** Run the navigation as a typed view transition (stack layer push). */
      readonly viewTransitionTypes?: ReadonlyArray<string>;
    },
  ) => void;
}

function supportsViewTransitions(): boolean {
  return typeof document !== "undefined" && "startViewTransition" in document;
}

function withoutUndefined(search: PullRequestsSearch): PullRequestsSearch {
  return Object.fromEntries(
    Object.entries(search).filter(([, value]) => value !== undefined),
  ) as PullRequestsSearch;
}

export function PullRequestsPage({ search, onSearchChange }: PullRequestsPageProps) {
  // ── Repository ────────────────────────────────────────────────────
  const { snapshots } = useLogicalProjectSnapshots();
  const repositories = useMemo(() => buildProjectCheckoutOptions(snapshots), [snapshots]);
  const lastRepositoryKey = usePullRequestsLayoutStore((state) => state.lastRepositoryKey);
  const setLastRepositoryKey = usePullRequestsLayoutStore((state) => state.setLastRepositoryKey);
  const selectRecentRepositoryKeys = useMemo(() => createRecentCheckoutKeysSelector(), []);
  const recentRepositoryKeys = useStore(selectRecentRepositoryKeys);
  const requestedEnvironment = useRequestedEnvironment(search.env);
  const resolution = useMemo(
    () =>
      resolveProjectCheckout({
        options: repositories,
        requested: { env: search.env, project: search.project },
        requestedEnvironmentSync: requestedEnvironment.sync,
        lastKey: lastRepositoryKey,
        recentKeys: recentRepositoryKeys,
      }),
    [
      lastRepositoryKey,
      recentRepositoryKeys,
      repositories,
      requestedEnvironment.sync,
      search.env,
      search.project,
    ],
  );
  const repository = resolution.kind === "resolved" ? resolution.option : null;
  // Only a repository the user chose (a link or the switcher, which writes the
  // URL) becomes the default for next time — never a fallback.
  const chosenRepositoryKey =
    resolution.kind === "resolved" && resolution.source === "url" ? resolution.option.key : null;
  useEffect(() => {
    if (chosenRepositoryKey !== null) setLastRepositoryKey(chosenRepositoryKey);
  }, [chosenRepositoryKey, setLastRepositoryKey]);
  const waitStalled = useHeldFor(resolution.kind === "waiting", CHECKOUT_WAIT_GRACE_MS);
  const environmentLabel = requestedEnvironment.label;
  const repositoryStatus = useMemo<PullRequestsRepositoryStatus>(() => {
    switch (resolution.kind) {
      case "resolved":
        return { kind: "ready" };
      case "empty":
        return { kind: "empty" };
      case "waiting":
        return {
          kind: "waiting",
          requested: resolution.requested,
          environmentLabel,
          stalled: waitStalled,
        };
      case "unavailable":
        return {
          kind: "unavailable",
          requested: resolution.requested,
          environmentLabel,
          reason: resolution.reason,
        };
    }
  }, [environmentLabel, resolution, waitStalled]);

  const model = usePullRequestsModel({ repository, search });
  const tab = resolvePullRequestsTab(search);

  // ── Layout ────────────────────────────────────────────────────────
  const rootRef = useRef<HTMLDivElement>(null);
  const pageWidth = useElementWidth(rootRef, () =>
    typeof window === "undefined" ? 1200 : Math.max(0, window.innerWidth - 260),
  );
  const layout = usePullRequestsLayout({
    pageWidth,
    hasSelection: model.selection !== null,
    tab,
  });
  const { listVisible, listFillsPage } = layout;
  const setDrawerOpen = usePullRequestsLayoutStore((state) => state.setDrawerOpen);
  useEffect(() => {
    if (listVisible || listFillsPage) setDrawerOpen(false);
  }, [listFillsPage, listVisible, setDrawerOpen]);

  // ── Navigation ────────────────────────────────────────────────────
  const [selectionMotion, setSelectionMotion] = useState<PullRequestSelectionMotion>({
    kind: "none",
    token: 0,
  });
  // Stable readers of the latest render, so the actions keep one identity.
  const getSearch = useEvent(() => search);
  const getModel = useEvent(() => model);
  const getRepositoryParams = useEvent(() =>
    repository ? { env: repository.environmentId, project: repository.projectId } : {},
  );
  const commit = useEvent(
    (next: PullRequestsSearch, options: Parameters<PullRequestsNavigationDeps["commit"]>[1]) =>
      onSearchChange(withoutUndefined(next), {
        replace: !options.push,
        ...(options.viewTransitionTypes
          ? { viewTransitionTypes: options.viewTransitionTypes }
          : {}),
      }),
  );
  const actions = useMemo(
    () =>
      createPullRequestsNavigation({
        getSearch,
        getModel,
        getRepositoryParams,
        commit,
        setSelectionMotion,
        closeDrawer: () => usePullRequestsLayoutStore.getState().setDrawerOpen(false),
        canRunPushTransition: () =>
          supportsViewTransitions() && readMotionDurationMs("--app-motion-duration-pane", 360) > 0,
      }),
    [commit, getModel, getRepositoryParams, getSearch],
  );
  const nav = useMemo<PullRequestsNavigation>(
    () => ({ search, tab, ...actions }),
    [actions, search, tab],
  );

  const readerKey =
    repository && model.selection
      ? pullRequestReaderKey(repository.key, model.selection.number)
      : null;

  const value = useMemo<PullRequestsPageContextValue>(
    () => ({
      surface: PULL_REQUESTS_PAGE_SURFACE,
      repository,
      repositoryStatus,
      repositories,
      model,
      nav,
      layout,
      selectionMotion,
      readerKey,
    }),
    [layout, model, nav, readerKey, repositories, repository, repositoryStatus, selectionMotion],
  );

  return (
    <SidebarInset
      data-slot="pull-requests-page"
      className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground"
    >
      <PullRequestsPageContext.Provider value={value}>
        <PullRequestsShortcutsProvider tab={tab} enabled>
          <PullRequestsPageShortcuts />
          <div
            ref={rootRef}
            className="pr-page @container/prs relative flex min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            <PullRequestsPageBody />
          </div>
        </PullRequestsShortcutsProvider>
      </PullRequestsPageContext.Provider>
    </SidebarInset>
  );
}
