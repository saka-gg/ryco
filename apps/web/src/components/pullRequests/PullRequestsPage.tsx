import type { EnvironmentId } from "@ryco/contracts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import {
  usePrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentId,
} from "../../environments/primary";
import {
  hasSavedEnvironmentRegistryHydrated,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { useLogicalProjectSnapshots } from "../../hooks/useLogicalProjectSnapshots";
import {
  selectBootstrapCompleteForEnvironment,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
  type AppState,
} from "../../store";
import { readMotionDurationMs } from "../../lib/perf/motion";
import { SidebarInset } from "../ui/sidebar";
import {
  PullRequestsPageContext,
  type PullRequestSelectionMotion,
  type PullRequestsNavigation,
  type PullRequestsPageContextValue,
  type PullRequestsRepositoryStatus,
} from "./PullRequestsPageContext";
import { PullRequestsPageBody } from "./PullRequestsPageBody";
import {
  buildPullRequestRepositoryOptions,
  classifyPullRequestEnvironmentSync,
  rankRepositoryKeysByThreadActivity,
  resolvePullRequestRepository,
  type PullRequestEnvironmentSync,
} from "./pullRequestRepositories.logic";
import { pullRequestReaderKey, usePullRequestsLayoutStore } from "./pullRequestsLayoutStore";
import { createPullRequestsNavigation } from "./pullRequestsNavigation";
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

/**
 * How long a repository named in the URL may stay "waiting" before the page
 * offers other repositories (its environment may never finish connecting).
 */
const REPOSITORY_WAIT_GRACE_MS = 8_000;

function useElementWidth(ref: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1200 : Math.max(0, window.innerWidth - 260),
  );
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (next !== undefined) setWidth(next);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

function supportsViewTransitions(): boolean {
  return typeof document !== "undefined" && "startViewTransition" in document;
}

function withoutUndefined(search: PullRequestsSearch): PullRequestsSearch {
  return Object.fromEntries(
    Object.entries(search).filter(([, value]) => value !== undefined),
  ) as PullRequestsSearch;
}

/**
 * Repository keys by latest thread activity. Ranked only when a thread
 * summary actually changed, and the same array is returned while the ranking
 * holds, so thread traffic elsewhere does not re-render the page.
 */
function createRecentRepositoryKeysSelector(): (state: AppState) => readonly string[] {
  let lastThreads: ReturnType<typeof selectSidebarThreadsAcrossEnvironments> = [];
  let lastKeys: readonly string[] = [];
  return (state) => {
    const threads = selectSidebarThreadsAcrossEnvironments(state);
    if (
      threads.length === lastThreads.length &&
      threads.every((thread, index) => thread === lastThreads[index])
    ) {
      return lastKeys;
    }
    lastThreads = threads;
    const keys = rankRepositoryKeysByThreadActivity(threads);
    if (keys.length !== lastKeys.length || keys.some((key, index) => key !== lastKeys[index])) {
      lastKeys = keys;
    }
    return lastKeys;
  };
}

/** Whether the environment a URL names can still deliver its projects, and its label. */
function useRequestedEnvironment(env: string | undefined): {
  readonly sync: PullRequestEnvironmentSync;
  readonly label: string | null;
} {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const environmentId = (env ?? primaryEnvironmentId ?? null) as EnvironmentId | null;
  const bootstrapComplete = useStore((state) =>
    environmentId === null ? false : selectBootstrapCompleteForEnvironment(state, environmentId),
  );
  const savedRecord = useSavedEnvironmentRegistryStore((state) =>
    environmentId === null ? null : (state.byId?.[environmentId] ?? null),
  );
  const savedRuntime = useSavedEnvironmentRuntimeStore((state) =>
    environmentId === null ? null : (state.byId?.[environmentId] ?? null),
  );
  const isPrimary = environmentId !== null && environmentId === primaryEnvironmentId;
  const sync = classifyPullRequestEnvironmentSync({
    bootstrapComplete,
    isPrimary,
    saved: savedRuntime
      ? {
          connectionState: savedRuntime.connectionState,
          disconnectedAt: savedRuntime.disconnectedAt,
        }
      : null,
    savedKnown: savedRecord !== null,
    registryHydrated: hasSavedEnvironmentRegistryHydrated(),
  });
  const label =
    savedRuntime?.descriptor?.label ??
    savedRecord?.label ??
    (isPrimary ? (primaryDescriptor?.label ?? null) : null);
  return { sync, label };
}

/** True once `active` has held for `delayMs` (reset whenever it turns false). */
function useHeldFor(active: boolean, delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const timer = window.setTimeout(() => setElapsed(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [active, delayMs]);
  return active && elapsed;
}

export function PullRequestsPage({ search, onSearchChange }: PullRequestsPageProps) {
  // ── Repository ────────────────────────────────────────────────────
  const { snapshots } = useLogicalProjectSnapshots();
  const repositories = useMemo(() => buildPullRequestRepositoryOptions(snapshots), [snapshots]);
  const lastRepositoryKey = usePullRequestsLayoutStore((state) => state.lastRepositoryKey);
  const setLastRepositoryKey = usePullRequestsLayoutStore((state) => state.setLastRepositoryKey);
  const selectRecentRepositoryKeys = useMemo(createRecentRepositoryKeysSelector, []);
  const recentRepositoryKeys = useStore(selectRecentRepositoryKeys);
  const requestedEnvironment = useRequestedEnvironment(search.env);
  const resolution = useMemo(
    () =>
      resolvePullRequestRepository({
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
  const waitStalled = useHeldFor(resolution.kind === "waiting", REPOSITORY_WAIT_GRACE_MS);
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
  const pageWidth = useElementWidth(rootRef);
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
  const searchRef = useRef(search);
  searchRef.current = search;
  const modelRef = useRef(model);
  modelRef.current = model;
  const repositoryRef = useRef(repository);
  repositoryRef.current = repository;
  const onSearchChangeRef = useRef(onSearchChange);
  onSearchChangeRef.current = onSearchChange;

  const commit = useCallback<Parameters<typeof createPullRequestsNavigation>[0]["commit"]>(
    (next, options) =>
      onSearchChangeRef.current(withoutUndefined(next), {
        replace: !options.push,
        ...(options.viewTransitionTypes
          ? { viewTransitionTypes: options.viewTransitionTypes }
          : {}),
      }),
    [],
  );
  const actions = useMemo(
    () =>
      createPullRequestsNavigation({
        getSearch: () => searchRef.current,
        getModel: () => modelRef.current,
        getRepositoryParams: () => {
          const current = repositoryRef.current;
          return current ? { env: current.environmentId, project: current.projectId } : {};
        },
        commit,
        setSelectionMotion,
        closeDrawer: () => usePullRequestsLayoutStore.getState().setDrawerOpen(false),
        canRunPushTransition: () =>
          supportsViewTransitions() && readMotionDurationMs("--app-motion-duration-pane", 360) > 0,
      }),
    [commit],
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
