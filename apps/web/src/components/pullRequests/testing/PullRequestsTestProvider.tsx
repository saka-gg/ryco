/**
 * Renders any pull requests page area against the fixtures: a page context
 * whose model is derived exactly like `usePullRequestsModel` (ranked groups,
 * checks summary, next action, thread index, draft key), an in-memory
 * navigation that really switches tabs and selection (every call is logged in
 * `pullRequestsTestNavLog`), a layout computed from `width` with the page's
 * breakpoints, plus the shortcut registry, the diff worker pool, the app
 * sidebar context and the atom registry.
 *
 * Mock the rpc hooks too (areas call mutations and the Files/Checks reads
 * directly) — see `sourceControlRpcMock.ts` for the exact `vi.mock` lines:
 *
 * ```tsx
 * import "~/index.css";
 * import { afterEach, expect, it, vi } from "vite-plus/test";
 * import { page } from "vite-plus/test/browser";
 * import { render } from "vitest-browser-react";
 *
 * vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
 *   const { createSourceControlRpcMock } = await import(
 *     "~/components/pullRequests/testing/sourceControlRpcMock"
 *   );
 *   return createSourceControlRpcMock(await importOriginal());
 * });
 *
 * import {
 *   PullRequestsTestProvider,
 *   pullRequestsTestNavLog,
 *   resetPullRequestsTestState,
 *   sourceControlRpcMock,
 * } from "~/components/pullRequests/testing/PullRequestsTestProvider";
 * import { ChecksTab } from "~/components/pullRequests/checks/ChecksTab";
 *
 * afterEach(() => resetPullRequestsTestState());
 *
 * it("shows the failing job", async () => {
 *   await page.viewport(1280, 800);
 *   const screen = await render(
 *     <PullRequestsTestProvider selected={703} search={{ tab: "checks" }} width={1280}>
 *       <ChecksTab />
 *     </PullRequestsTestProvider>,
 *   );
 *   await expect.element(screen.getByText("Test · web")).toBeVisible();
 *   await page.screenshot({ path: "checks-703.png" });
 * });
 * ```
 *
 * Test-only — never import this from app code.
 */
import type {
  ChangeRequest,
  ChangeRequestActivity,
  SourceControlChangeRequestDetail,
  SourceControlProviderInfo,
  SourceControlProviderKind,
} from "@ryco/contracts";
import { reviewDraftKey } from "@ryco/client-runtime/state/pull-request-review";
import {
  getChangeRequestHostCapabilities,
  resolveChangeRequestPresentationForKind,
  type ChangeRequestHostCapabilities,
} from "@ryco/shared/sourceControl";
import { useMemo, useReducer, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { usePullRequestReviewDraftStore } from "../../../pullRequestReviewDraftStore";
import type { SourceControlQueryState } from "../../../rpc/sourceControlAtoms";
import { AppAtomRegistryProvider } from "../../../rpc/atomRegistry";
import { DiffWorkerPoolProvider } from "../../DiffWorkerPoolProvider";
import { SidebarProvider } from "../../ui/sidebar";
import {
  PullRequestsPageContext,
  type PullRequestSelectionMotion,
  type PullRequestsLayout,
  type PullRequestsNavigation,
  PULL_REQUESTS_PAGE_SURFACE,
  type PullRequestsPageContextValue,
  type PullRequestsRepositoryStatus,
} from "../PullRequestsPageContext";
import {
  PULL_REQUESTS_LIST_DEFAULT_WIDTH,
  pullRequestReaderKey,
  usePullRequestReaderStore,
  usePullRequestsLayoutStore,
} from "../pullRequestsLayoutStore";
import { createPullRequestsNavigation } from "../pullRequestsNavigation";
import {
  resolvePullRequestsStateFilter,
  resolvePullRequestsTab,
  type PullRequestsSearch,
} from "../pullRequestsSearch";
import { PullRequestsPageShortcuts } from "../PullRequestsPageShortcuts";
import { PullRequestsShortcutsProvider } from "../pullRequestsShortcuts";
import {
  derivePullRequestSelection,
  derivePullRequestsList,
  PULL_REQUESTS_LIST_LIMIT,
  type PullRequestSelectionModel,
  type PullRequestsListModel,
  type PullRequestsModel,
} from "../pullRequestsModel.logic";
import { usePullRequestsLayout } from "../usePullRequestsLayout";
import {
  FIXTURE_CWD,
  FIXTURE_ENVIRONMENT_ID,
  fixtureProvider,
  fixtureRepositoryOption,
} from "./pullRequestFixtures";
import { pullRequestFixtureStore, usePullRequestFixtureVersion } from "./pullRequestFixtureStore";
import { sourceControlRpcMock } from "./sourceControlRpcMock";

export * from "./pullRequestFixtures";
export { pullRequestFixtureStore, usePullRequestFixtureVersion } from "./pullRequestFixtureStore";
export {
  createPullRequestFilesViewedMock,
  createSourceControlRpcMock,
  sourceControlRpcMock,
  type SourceControlRpcMockCall,
  type SourceControlRpcMutationHook,
  type SourceControlRpcReadHook,
} from "./sourceControlRpcMock";

// ── Model ─────────────────────────────────────────────────────────────

export interface BuildTestPullRequestsModelInput {
  /** Selected change request (sugar for `search.pr`). */
  readonly selected?: number | undefined;
  readonly search?: Partial<PullRequestsSearch> | undefined;
  /**
   * The checkout's host (default "github"). The model gets that host's real
   * capability matrix entry, so another host renders exactly what it would on
   * the page: e.g. "gitlab" has no activity, involvement lists or mutations.
   */
  readonly host?: SourceControlProviderKind | undefined;
  /** Override single capabilities on top of the host's entry (e.g. GitHub without reactions). */
  readonly capabilities?: Partial<ChangeRequestHostCapabilities> | undefined;
  /** Patch the selected detail query (e.g. `{ data: null, isLoading: true }`). */
  readonly detailState?:
    | Partial<SourceControlQueryState<SourceControlChangeRequestDetail>>
    | undefined;
  /** Patch the selected activity query. */
  readonly activityState?: Partial<SourceControlQueryState<ChangeRequestActivity>> | undefined;
  /** Patch the list reads (e.g. `{ isLoading: true }` or `{ error: "…" }`). */
  readonly listState?:
    | Partial<Pick<PullRequestsListModel, "isLoading" | "isFetching" | "error">>
    | undefined;
  /** Folded list groups (the provider passes the layout store's). */
  readonly foldedGroups?: ReadonlyArray<string> | undefined;
  /**
   * Model a repository the URL names but the page cannot read (default
   * "ready"). Anything else clears the repository and the selection, exactly
   * like the page.
   */
  readonly repositoryStatus?: PullRequestsRepositoryStatus | undefined;
}

function initialSearch(input: BuildTestPullRequestsModelInput): PullRequestsSearch {
  return withoutUndefined({
    env: FIXTURE_ENVIRONMENT_ID,
    project: fixtureRepositoryOption.projectId,
    ...input.search,
    ...(input.selected !== undefined ? { pr: input.selected } : {}),
  });
}

function withoutUndefined(search: PullRequestsSearch): PullRequestsSearch {
  return Object.fromEntries(
    Object.entries(search).filter(([, value]) => value !== undefined),
  ) as PullRequestsSearch;
}

function settledQuery<T>(
  data: T | null,
  patch: Partial<SourceControlQueryState<T>> | undefined,
): SourceControlQueryState<T> {
  return { data, isLoading: false, isFetching: false, error: null, ...patch };
}

/**
 * The page model for the fixtures, derived the same way `usePullRequestsModel`
 * derives it from the rpc reads (state list + "authored" + "review requested"
 * lists, filters, readiness ranking, then the selection's checks, next
 * action, thread index and draft key). Reads the live `pullRequestFixtureStore`.
 */
/** The fixture checkout's provider on `host`. */
export function testProviderFor(host: SourceControlProviderKind): SourceControlProviderInfo {
  if (host === "github") return fixtureProvider;
  const presentation = resolveChangeRequestPresentationForKind(host);
  return { kind: host, name: presentation.providerName, baseUrl: `https://${host}.example` };
}

/** The host's capability matrix entry with the test's overrides applied. */
export function testCapabilitiesFor(
  host: SourceControlProviderKind,
  overrides?: Partial<ChangeRequestHostCapabilities>,
): ChangeRequestHostCapabilities {
  return { ...getChangeRequestHostCapabilities(host), ...overrides };
}

const READINESS_FIELDS = [
  "mergeability",
  "mergeStateStatus",
  "reviewDecision",
  "reviewerStates",
  "autoMerge",
  "mergeCapabilities",
  "deleteBranchOnMerge",
] as const;

/** What a `blockers` host's rows carry: conflicts and the votes it reports, no verdict. */
const BLOCKER_FIELDS: ReadonlySet<string> = new Set(["mergeability", "reviewDecision"]);

/**
 * A fixture list row or detail as `capabilities`' host would report it:
 * fields the host does not send there (check rollups, merge readiness,
 * stacks) are dropped, so a non-GitHub host renders from the same sparse data
 * the page would get. Rows and the detail differ (`listCheckRollup`,
 * `listReadiness` vs `checkRollup`, `mergeReadiness`).
 */
export function shapeFixtureForHost<T extends ChangeRequest>(
  entry: T,
  capabilities: ChangeRequestHostCapabilities,
  level: "row" | "detail",
): T {
  const shaped: Record<string, unknown> = { ...entry };
  const checkRollup = level === "row" ? capabilities.listCheckRollup : capabilities.checkRollup;
  if (!checkRollup) delete shaped.checkRollup;
  for (const key of READINESS_FIELDS) {
    const kept =
      level === "detail"
        ? capabilities.mergeReadiness
        : capabilities.listReadiness === "verdict" ||
          (capabilities.listReadiness === "blockers" && BLOCKER_FIELDS.has(key));
    if (!kept) delete shaped[key];
  }
  if (!capabilities.stacks) {
    for (const key of ["stack", "stackSummary", "stackMetadataIncomplete"]) delete shaped[key];
  }
  return shaped as T;
}

export function buildTestPullRequestsModel(
  input: BuildTestPullRequestsModelInput = {},
): PullRequestsModel {
  const search = initialSearch(input);
  const host = input.host ?? "github";
  const capabilities = testCapabilitiesFor(host, input.capabilities);
  const repositoryReady = (input.repositoryStatus?.kind ?? "ready") === "ready";
  const environmentId = FIXTURE_ENVIRONMENT_ID;
  const cwd = FIXTURE_CWD;
  const state = resolvePullRequestsStateFilter(search);

  // ── List and selection: the page's own pure derivations ──
  const shapeAs =
    (level: "row" | "detail") =>
    <T extends ChangeRequest>(entry: T): T =>
      host === "github" && input.capabilities === undefined
        ? entry
        : shapeFixtureForHost(entry, capabilities, level);
  const shapeRow = shapeAs("row");
  const shapeDetail = shapeAs("detail");
  const stateList = pullRequestFixtureStore
    .list({ state })
    .slice(0, PULL_REQUESTS_LIST_LIMIT)
    .map(shapeRow);
  const authoredList = capabilities.involvementFilters
    ? pullRequestFixtureStore
        .list({ state, involvement: "authored" })
        .slice(0, PULL_REQUESTS_LIST_LIMIT)
        .map(shapeRow)
    : null;
  const reviewRequestedList = capabilities.involvementFilters
    ? pullRequestFixtureStore
        .list({ state, involvement: "review-requested" })
        .slice(0, PULL_REQUESTS_LIST_LIMIT)
        .map(shapeRow)
    : null;
  const list: PullRequestsListModel = {
    ...derivePullRequestsList({
      stateList,
      authoredList,
      reviewRequestedList,
      involvementSupported: capabilities.involvementFilters,
      search,
      foldedGroups: input.foldedGroups,
    }),
    isLoading: false,
    isFetching: false,
    error: null,
    ...input.listState,
  };

  // No selection outside a resolved repository (the page never reads `#N`
  // through another checkout).
  const selectedNumber = repositoryReady ? (search.pr ?? null) : null;
  const selection: PullRequestSelectionModel | null =
    selectedNumber === null
      ? null
      : derivePullRequestSelection({
          number: selectedNumber,
          summary: list.byNumber.get(selectedNumber) ?? null,
          detail: settledQuery(
            ((detail) => (detail ? shapeDetail(detail) : null))(
              pullRequestFixtureStore.detail(selectedNumber),
            ),
            input.detailState,
          ),
          activity: settledQuery(
            capabilities.activity ? pullRequestFixtureStore.activity(selectedNumber) : null,
            input.activityState,
          ),
          environmentId,
          cwd,
        });

  return {
    environmentId,
    cwd,
    provider: testProviderFor(host),
    capabilities,
    list,
    selection,
  };
}

/** The review-draft store key the page uses for a fixture PR. */
export function fixtureReviewDraftKey(number: number): string {
  return reviewDraftKey({ environmentId: FIXTURE_ENVIRONMENT_ID, cwd: FIXTURE_CWD, number });
}

// ── Navigation log ────────────────────────────────────────────────────

export type PullRequestsNavMethod = Exclude<keyof PullRequestsNavigation, "search" | "tab">;

export interface PullRequestsTestNavCall {
  readonly method: PullRequestsNavMethod;
  readonly args: ReadonlyArray<unknown>;
}

/** Every navigation call made through the test provider, in order. */
export const pullRequestsTestNavLog = {
  calls: [] as PullRequestsTestNavCall[],
  callsTo(method: PullRequestsNavMethod): ReadonlyArray<PullRequestsTestNavCall> {
    return pullRequestsTestNavLog.calls.filter((call) => call.method === method);
  },
  last(): PullRequestsTestNavCall | undefined {
    return pullRequestsTestNavLog.calls.at(-1);
  },
  clear(): void {
    pullRequestsTestNavLog.calls.length = 0;
  },
};

/**
 * Resets everything the provider and mocks share across tests: fixture store,
 * rpc mock calls/overrides, nav log, layout + reader stores, review drafts.
 * Call it in `afterEach`.
 */
export function resetPullRequestsTestState(): void {
  sourceControlRpcMock.reset();
  pullRequestsTestNavLog.clear();
  usePullRequestsLayoutStore.setState({
    listWidth: PULL_REQUESTS_LIST_DEFAULT_WIDTH,
    listHidden: false,
    treeHidden: false,
    foldedGroups: [],
    lastRepositoryKey: null,
    drawerOpen: false,
    drawerOpener: null,
    shortcutsOpen: false,
    searchFocusRequested: false,
  });
  usePullRequestReaderStore.setState({
    visitedTabs: {},
    scrollTop: {},
    expandedJobs: {},
    mastheadHidden: {},
    titleEditRequest: {},
  });
  const drafts = usePullRequestReviewDraftStore.getState();
  for (const key of Object.keys(drafts.draftsByKey)) drafts.clear(key);
}

// ── Provider ──────────────────────────────────────────────────────────

const READY: PullRequestsRepositoryStatus = { kind: "ready" };

export interface PullRequestsTestProviderProps extends BuildTestPullRequestsModelInput {
  /** Page content width in px (excludes the app sidebar). Default 1280. */
  readonly width?: number | undefined;
  /** Page height in px. Default 800. */
  readonly height?: number | undefined;
  /** Override computed layout facts (e.g. `{ railDocked: false }`). */
  readonly layout?: Partial<PullRequestsLayout> | undefined;
  /** Replace individual nav methods (calls are still logged; the default is skipped). */
  readonly navOverrides?: Partial<Omit<PullRequestsNavigation, "search" | "tab">> | undefined;
  /** Motion the reader mounts with. Default `{ kind: "none" }`. */
  readonly selectionMotion?: PullRequestSelectionMotion | undefined;
  /** Model the collapsed app sidebar (bars then carry the leading inset). */
  readonly sidebarCollapsed?: boolean | undefined;
  /** Mount the page-wide J/K/[ ]/\\ defaults (`PullRequestsPageShortcuts`). Default true. */
  readonly pageShortcuts?: boolean | undefined;
  /** Observe URL-state changes made through nav. */
  readonly onSearchChange?: ((search: PullRequestsSearch) => void) | undefined;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}

/**
 * `selected` / `search` seed the initial URL state only; afterwards nav owns it
 * (remount with a new `key` to start over).
 */
export function PullRequestsTestProvider(props: PullRequestsTestProviderProps) {
  const [search, setSearchState] = useState<PullRequestsSearch>(() => initialSearch(props));
  const version = usePullRequestFixtureVersion();
  const { host, capabilities, detailState, activityState, listState, repositoryStatus } = props;
  const foldedGroups = usePullRequestsLayoutStore((state) => state.foldedGroups);
  const model = useMemo(
    () =>
      buildTestPullRequestsModel({
        search,
        host,
        capabilities,
        detailState,
        activityState,
        listState,
        foldedGroups,
        repositoryStatus,
      }),
    // `version` re-derives after mocked mutations write the fixture store.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [
      search,
      host,
      capabilities,
      detailState,
      activityState,
      listState,
      foldedGroups,
      repositoryStatus,
      version,
    ],
  );
  const tab = resolvePullRequestsTab(search);
  const repositoryReady = (repositoryStatus?.kind ?? "ready") === "ready";

  // ── Layout (the page's own hook) ──
  const pageWidth = props.width ?? 1280;
  const layout = usePullRequestsLayout({
    pageWidth,
    hasSelection: model.selection !== null,
    tab,
    overrides: props.layout,
  });

  // ── Navigation (the page's own rules, over in-memory URL state) ──
  const [selectionMotion, setSelectionMotion] = useState<PullRequestSelectionMotion>(
    props.selectionMotion ?? { kind: "none", token: 0 },
  );
  const [jobRevealToken, bumpJobRevealToken] = useReducer((count: number) => count + 1, 0);
  const searchRef = useRef(search);
  searchRef.current = search;
  const modelRef = useRef(model);
  modelRef.current = model;
  const propsRef = useRef(props);
  propsRef.current = props;

  const actions = useMemo(() => {
    const base = createPullRequestsNavigation({
      getSearch: () => searchRef.current,
      getModel: () => modelRef.current,
      getRepositoryParams: () => ({
        env: FIXTURE_ENVIRONMENT_ID,
        project: fixtureRepositoryOption.projectId,
      }),
      commit: (next) => {
        const cleaned = withoutUndefined(next);
        searchRef.current = cleaned;
        setSearchState(cleaned);
        propsRef.current.onSearchChange?.(cleaned);
      },
      setSelectionMotion,
      closeDrawer: () => usePullRequestsLayoutStore.getState().setDrawerOpen(false),
      // No view transitions in tests: the push still sets its motion.
      canRunPushTransition: () => false,
      onRevealJob: bumpJobRevealToken,
    });
    // One fixture repository: record the call, keep the selection.
    base.selectRepository = () => undefined;
    return Object.fromEntries(
      (Object.keys(base) as PullRequestsNavMethod[]).map((method) => [
        method,
        (...args: unknown[]) => {
          pullRequestsTestNavLog.calls.push({ method, args });
          const override = propsRef.current.navOverrides?.[method] as
            | ((...args: unknown[]) => void)
            | undefined;
          const fallback = base[method] as (...args: unknown[]) => void;
          (override ?? fallback)(...args);
        },
      ]),
    ) as unknown as Omit<PullRequestsNavigation, "search" | "tab">;
  }, []);
  const nav = useMemo<PullRequestsNavigation>(
    () => ({ search, tab, ...actions }),
    [actions, search, tab],
  );

  const readerKey = model.selection
    ? pullRequestReaderKey(fixtureRepositoryOption.key, model.selection.number)
    : null;
  const value = useMemo<PullRequestsPageContextValue>(
    () => ({
      surface: PULL_REQUESTS_PAGE_SURFACE,
      repository: repositoryReady ? fixtureRepositoryOption : null,
      repositoryStatus: repositoryStatus ?? READY,
      repositories: [fixtureRepositoryOption],
      model,
      nav,
      layout,
      selectionMotion,
      readerKey,
      jobRevealToken,
    }),
    [
      jobRevealToken,
      layout,
      model,
      nav,
      readerKey,
      repositoryReady,
      repositoryStatus,
      selectionMotion,
    ],
  );

  const frameStyle: CSSProperties = { width: pageWidth, height: props.height ?? 800 };
  return (
    <AppAtomRegistryProvider>
      <SidebarProvider
        open={!props.sidebarCollapsed}
        onOpenChange={() => undefined}
        className="min-h-0 w-auto"
      >
        <PullRequestsPageContext.Provider value={value}>
          <PullRequestsShortcutsProvider tab={tab} enabled>
            {props.pageShortcuts === false ? null : <PullRequestsPageShortcuts />}
            <DiffWorkerPoolProvider>
              <div
                data-testid="pull-requests-test-root"
                className={[
                  "pr-page @container/prs relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background text-foreground",
                  props.className ?? "",
                ].join(" ")}
                style={frameStyle}
              >
                {props.children}
              </div>
            </DiffWorkerPoolProvider>
          </PullRequestsShortcutsProvider>
        </PullRequestsPageContext.Provider>
      </SidebarProvider>
    </AppAtomRegistryProvider>
  );
}
