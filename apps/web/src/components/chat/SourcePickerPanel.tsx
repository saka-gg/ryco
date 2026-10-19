import type {
  ChangeRequest,
  EnvironmentId,
  ProjectId,
  SourceControlIssueSummary,
  VcsListRefsResult,
  WorkItemStateFilter,
  WorkItemSummary,
} from "@ryco/contracts";
import { GitBranchIcon, PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import {
  preloadableLazy,
  useLazyComponentReady,
  type LazyComponentReadyOptions,
} from "../../lib/preloadableLazy";
import { cn } from "~/lib/utils";
import type {
  ChangeRequestStateFilter,
  IssueStateFilter,
} from "../projectExplorer/StateFilterButtons";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { notifySurfaceLoadFailure } from "../ui/surfaceLoadFailure";
import { Switch } from "../ui/switch";
import { ContextPickerTabs } from "./ContextPickerTabs";

/** What the user picked: a branch, a pull request, an issue or a Jira item. */
export type NewThreadSource =
  | { readonly kind: "branch"; readonly branchName: string }
  | { readonly kind: "pr"; readonly changeRequest: ChangeRequest }
  | { readonly kind: "issue"; readonly issue: SourceControlIssueSummary }
  | { readonly kind: "workItem"; readonly workItem: WorkItemSummary };

const SOURCE_TABS = [
  { id: "branches", label: "Branch" },
  { id: "prs", label: "Pull requests" },
  { id: "issues", label: "Issues" },
  { id: "jira", label: "Jira" },
] as const;

export type SourcePickerSourceTab = (typeof SOURCE_TABS)[number]["id"];

/** A tab a surface adds after the four sources (the Tasks page's chats and links). */
export interface SourcePickerExtraTab {
  readonly id: string;
  readonly label: string;
  readonly render: () => ReactNode;
}

const BRANCH_LIMIT = 60;

/*
 * The pull request, issue and Jira lists (with their data hooks) load with the
 * picker's first open instead of with the surface that shows it: most picks
 * are a branch.
 */
const LazyPullRequestsTab = preloadableLazy(() =>
  import("../projectExplorer/PullRequestsTab").then((module) => module.PullRequestsTab),
);
const LazyIssuesTab = preloadableLazy(() =>
  import("../projectExplorer/IssuesTab").then((module) => module.IssuesTab),
);
const LazyWorkItemsTab = preloadableLazy(() =>
  import("../projectExplorer/WorkItemsTab").then((module) => module.WorkItemsTab),
);

/** Starts loading the pull request, issue and Jira lists; call it when the picker opens. */
export function preloadSourceItemTabs(): void {
  void LazyPullRequestsTab.preload();
  void LazyIssuesTab.preload();
  void LazyWorkItemsTab.preload();
}

const SOURCE_ITEM_TABS_LOAD: LazyComponentReadyOptions = {
  onLoadError: (error, retry) => notifySurfaceLoadFailure("source list", error, retry),
};

/**
 * The picker's tab, searches and filters. Its popover unmounts the panel when
 * it closes, so the trigger keeps them: the picker opens again where it was.
 */
export function useSourcePickerState(initialTab: string = "branches") {
  const [tab, setTab] = useState(initialTab);
  const [branchQuery, setBranchQuery] = useState("");
  const [prQuery, setPrQuery] = useState("");
  const [issueQuery, setIssueQuery] = useState("");
  const [workItemQuery, setWorkItemQuery] = useState("");
  const [prStateFilter, setPrStateFilter] = useState<ChangeRequestStateFilter>("open");
  const [issueStateFilter, setIssueStateFilter] = useState<IssueStateFilter>("open");
  const [workItemStateFilter, setWorkItemStateFilter] = useState<WorkItemStateFilter>("open");
  return {
    tab,
    setTab,
    branchQuery,
    setBranchQuery,
    prQuery,
    setPrQuery,
    issueQuery,
    setIssueQuery,
    workItemQuery,
    setWorkItemQuery,
    prStateFilter,
    setPrStateFilter,
    issueStateFilter,
    setIssueStateFilter,
    workItemStateFilter,
    setWorkItemStateFilter,
  };
}

export type SourcePickerState = ReturnType<typeof useSourcePickerState>;

/** The branch tab's controls for a branch about to be created (the new-thread picker's). */
export interface SourcePickerBranchCreation {
  readonly fetchOrigin: boolean;
  readonly onFetchOriginChange: (enabled: boolean) => void;
  readonly branchName: string | null;
  readonly onBranchNameChange: (name: string | null) => void;
}

/**
 * One panel, four sources: a branch, a pull request, an issue or a Jira
 * item, as segments over one list. The new-thread picker asks where a new
 * worktree branches from; the Tasks page asks what a task links to (and adds
 * its own tabs). Render it inside a popover; it reads its lists while shown.
 */
export function SourcePickerPanel(props: {
  readonly state: SourcePickerState;
  /** Where the four sources are read; `null` leaves them out (only `extraTabs` show). */
  readonly repository: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId | null;
    readonly cwd: string | null;
  } | null;
  readonly onSelect: (source: NewThreadSource) => void;
  /** Lists fetched branches by default, with the switch and the new branch's name. */
  readonly branchCreation?: SourcePickerBranchCreation;
  readonly extraTabs?: ReadonlyArray<SourcePickerExtraTab>;
}) {
  const { state, repository, onSelect } = props;
  const extraTabs = props.extraTabs ?? [];
  const tabs = [...(repository ? SOURCE_TABS : []), ...extraTabs];
  const tab = tabs.some((each) => each.id === state.tab) ? state.tab : (tabs[0]?.id ?? "");
  const pullRequestsTabReady = useLazyComponentReady(
    LazyPullRequestsTab,
    tab === "prs",
    SOURCE_ITEM_TABS_LOAD,
  );
  const issuesTabReady = useLazyComponentReady(
    LazyIssuesTab,
    tab === "issues",
    SOURCE_ITEM_TABS_LOAD,
  );
  const workItemsTabReady = useLazyComponentReady(
    LazyWorkItemsTab,
    tab === "jira",
    SOURCE_ITEM_TABS_LOAD,
  );
  const prInputRef = useRef<HTMLInputElement>(null);
  const issueInputRef = useRef<HTMLInputElement>(null);
  const workItemInputRef = useRef<HTMLInputElement>(null);
  const branchInputRef = useRef<HTMLInputElement>(null);
  const extra = extraTabs.find((each) => each.id === tab);

  return (
    <>
      <ContextPickerTabs tabs={tabs} activeId={tab} density="compact" onSelect={state.setTab} />
      <div className="h-72 min-h-0">
        {extra ? (
          extra.render()
        ) : !repository ? null : tab === "branches" ? (
          <BranchSourceList
            key={JSON.stringify([repository.environmentId, repository.cwd])}
            {...(props.branchCreation ? { creation: props.branchCreation } : {})}
            environmentId={repository.environmentId}
            cwd={repository.cwd}
            query={state.branchQuery}
            searchInputRef={branchInputRef}
            onQueryChange={state.setBranchQuery}
            onSelect={(branchName) => onSelect({ kind: "branch", branchName })}
          />
        ) : tab === "prs" ? (
          pullRequestsTabReady ? (
            <LazyPullRequestsTab
              environmentId={repository.environmentId}
              cwd={repository.cwd}
              searchInputRef={prInputRef}
              query={state.prQuery}
              onQueryChange={state.setPrQuery}
              density="compact"
              stateFilter={state.prStateFilter}
              onStateFilterChange={state.setPrStateFilter}
              onSelect={(changeRequest) => onSelect({ kind: "pr", changeRequest })}
            />
          ) : null
        ) : tab === "issues" ? (
          issuesTabReady ? (
            <LazyIssuesTab
              environmentId={repository.environmentId}
              cwd={repository.cwd}
              searchInputRef={issueInputRef}
              query={state.issueQuery}
              onQueryChange={state.setIssueQuery}
              density="compact"
              stateFilter={state.issueStateFilter}
              onStateFilterChange={state.setIssueStateFilter}
              onSelect={(issue) => onSelect({ kind: "issue", issue })}
            />
          ) : null
        ) : tab === "jira" && workItemsTabReady ? (
          <LazyWorkItemsTab
            environmentId={repository.environmentId}
            cwd={repository.cwd}
            projectId={repository.projectId}
            searchInputRef={workItemInputRef}
            query={state.workItemQuery}
            onQueryChange={state.setWorkItemQuery}
            stateFilter={state.workItemStateFilter}
            onStateFilterChange={state.setWorkItemStateFilter}
            onSelect={(workItem) => onSelect({ kind: "workItem", workItem })}
          />
        ) : null}
      </div>
    </>
  );
}

/**
 * The branch list. With `creation` it lists the origin's branches (fetched
 * first) unless Fetch Origin is off, and names the branch about to be made;
 * without, it lists the checkout's branches as they are.
 */
function BranchSourceList({
  environmentId,
  cwd,
  query,
  searchInputRef,
  onQueryChange,
  onSelect,
  creation,
}: {
  readonly creation?: SourcePickerBranchCreation;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly query: string;
  readonly searchInputRef: React.RefObject<HTMLInputElement | null>;
  readonly onQueryChange: (value: string) => void;
  readonly onSelect: (branchName: string) => void;
}) {
  const fetchOrigin = creation?.fetchOrigin ?? false;
  const trimmedQuery = query.trim();
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [name, setName] = useState(creation?.branchName ?? "");
  const [page, setPage] = useState<VcsListRefsResult | null>(null);
  const [isPending, setPending] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const initialFetch = useRef<{ key: string; promise: Promise<VcsListRefsResult> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const api = readEnvironmentApi(environmentId);
    setPending(true);
    setPage(null);
    setError(null);
    if (!api || !cwd) {
      setPending(false);
      setError("Branches are unavailable.");
      return;
    }
    const key = JSON.stringify([environmentId, cwd, fetchOrigin]);
    if (initialFetch.current?.key !== key) {
      initialFetch.current = {
        key,
        promise: api.vcs.listRefs({
          cwd,
          fetchOrigin,
          originOnly: fetchOrigin,
          limit: BRANCH_LIMIT,
        }),
      };
    }
    const promise = initialFetch.current.promise;
    void (async () => {
      try {
        const initial = await promise;
        if (cancelled) return;
        const result =
          !trimmedQuery && cursor === 0
            ? initial
            : await api.vcs.listRefs({
                cwd,
                originOnly: fetchOrigin,
                ...(trimmedQuery ? { query: trimmedQuery } : {}),
                cursor,
                limit: BRANCH_LIMIT,
              });
        if (!cancelled) setPage(result);
      } catch (cause) {
        if (!cancelled) {
          initialFetch.current = null;
          setError(cause instanceof Error ? cause.message : "Could not load branches.");
        }
      } finally {
        if (!cancelled) setPending(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentId, cwd, fetchOrigin, trimmedQuery, cursor]);
  const visible = page?.refs ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-border/40 border-b px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <GitBranchIcon className="-translate-y-1/2 absolute top-1/2 left-2 size-3.5 text-muted-foreground" />
          <Input
            ref={searchInputRef}
            value={query}
            onChange={(event) => {
              setCursor(0);
              onQueryChange(event.target.value);
            }}
            placeholder="Search branches..."
            className="h-8 pl-7 text-sm"
          />
        </div>
        {creation ? (
          <>
            <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
              Fetch Origin
              <Switch
                checked={fetchOrigin}
                onCheckedChange={(enabled) => {
                  setCursor(0);
                  creation.onFetchOriginChange(enabled);
                }}
              />
            </label>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Create a new branch"
              onClick={() => setCreatingBranch((value) => !value)}
            >
              <PlusIcon className="size-4" />
            </Button>
          </>
        ) : null}
      </div>
      {creation && creatingBranch ? (
        <form
          className="flex items-center gap-2 border-b border-border/40 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            creation.onBranchNameChange(name.trim() || null);
            setCreatingBranch(false);
          }}
        >
          <Input
            aria-label="New branch name"
            placeholder="Automatic branch name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="h-8 min-w-0 flex-1"
          />
          <Button type="submit" size="sm">
            Use name
          </Button>
        </form>
      ) : null}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p role="alert" className="px-2.5 py-2 text-sm text-destructive">
            {error}{" "}
            {fetchOrigin
              ? "Turn off Fetch Origin to use local branches, or reopen to retry."
              : "Reopen to retry."}
          </p>
        ) : null}
        {error ? null : isPending && visible.length === 0 ? (
          <p className="px-2.5 py-4 text-sm text-muted-foreground">Loading branches...</p>
        ) : visible.length === 0 ? (
          <p className="px-2.5 py-4 text-sm text-muted-foreground">
            No branches match this search.
          </p>
        ) : (
          visible.map((ref) => (
            <button
              key={ref.name}
              type="button"
              onClick={() => onSelect(ref.name)}
              className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/60"
            >
              <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{ref.name}</span>
              {ref.isRemote ? (
                <span className={cn("shrink-0 text-[10px] text-muted-foreground/55")}>
                  {ref.remoteName ?? "remote"}
                </span>
              ) : ref.current ? (
                <span className={cn("shrink-0 text-[10px] text-muted-foreground/55")}>current</span>
              ) : ref.isDefault ? (
                <span className="shrink-0 text-[10px] text-muted-foreground/55">default</span>
              ) : null}
            </button>
          ))
        )}
        {cursor > 0 || (page?.nextCursor !== null && page?.nextCursor !== undefined) ? (
          <div className="flex justify-between p-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={isPending || cursor === 0}
              onClick={() => setCursor(Math.max(0, cursor - BRANCH_LIMIT))}
            >
              Previous
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={isPending || page?.nextCursor == null}
              onClick={() => setCursor(page?.nextCursor ?? 0)}
            >
              Next
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
