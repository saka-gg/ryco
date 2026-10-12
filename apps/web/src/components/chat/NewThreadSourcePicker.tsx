import type {
  ChangeRequest,
  EnvironmentId,
  ProjectId,
  SourceControlIssueSummary,
  WorkItemStateFilter,
  WorkItemSummary,
  VcsListRefsResult,
} from "@ryco/contracts";
import {
  ChevronDownIcon,
  CircleDotIcon,
  GitBranchIcon,
  GitPullRequestIcon,
  PlusIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import {
  preloadableLazy,
  useLazyComponentReady,
  type LazyComponentReadyOptions,
} from "../../lib/preloadableLazy";
import { Switch } from "../ui/switch";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import type {
  ChangeRequestStateFilter,
  IssueStateFilter,
} from "../projectExplorer/StateFilterButtons";
import { AtlassianJiraIcon } from "../Icons";
import { ContextPickerTabs } from "./ContextPickerTabs";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { notifyChatSurfaceLoadFailure } from "./chatViewLazySurfaces";

export type NewThreadSourceTab = "branches" | "prs" | "issues" | "jira";

/** What the user picked as the origin for the worktree about to be created. */
export type NewThreadSource =
  | { readonly kind: "branch"; readonly branchName: string }
  | { readonly kind: "pr"; readonly changeRequest: ChangeRequest }
  | { readonly kind: "issue"; readonly issue: SourceControlIssueSummary }
  | { readonly kind: "workItem"; readonly workItem: WorkItemSummary };

export interface NewThreadSourcePickerProps {
  readonly label: string;
  /**
   * Which kind of thing `label` names. A branch is the unremarkable default and
   * stays plain; a PR, issue, or work item is a deliberate, less common choice,
   * so each gets its provider glyph in its own colour — the sentence should say
   * *what* you picked at a glance, not just its title.
   */
  readonly sourceKind: "branch" | "pr" | "issue" | "workItem" | null;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly cwd: string | null;
  readonly fetchOrigin: boolean;
  readonly onFetchOriginChange: (enabled: boolean) => void;
  readonly branchName: string | null;
  readonly onBranchNameChange: (name: string | null) => void;
  readonly onSelect: (source: NewThreadSource) => void;
}

const BRANCH_LIMIT = 60;

/*
 * The pull request, issue and Jira lists (with their data hooks) load with the
 * picker's first open instead of with the chat route: the picker sits in the
 * new-thread hero, and most new worktrees branch off a branch.
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

function preloadSourceItemTabs(): void {
  void LazyPullRequestsTab.preload();
  void LazyIssuesTab.preload();
  void LazyWorkItemsTab.preload();
}

const SOURCE_ITEM_TABS_LOAD: LazyComponentReadyOptions = {
  onLoadError: (error, retry) => notifyChatSurfaceLoadFailure("source list", error, retry),
};

/**
 * The `from …` token of the work-location sentence, when the target is a new
 * worktree.
 *
 * One popover with four segments rather than four controls or a jump into the
 * worktree dialog: the question ("where does this branch off from?") is one
 * question, and branch / PR / issue / work item are four answers to it.
 *
 * Only offered in new-worktree mode. Working directly in a checkout is a real
 * `git switch`, and a PR head or an issue is not something you can switch to.
 */
export function NewThreadSourcePicker({
  label,
  sourceKind,
  environmentId,
  projectId,
  cwd,
  onSelect,
  fetchOrigin,
  onFetchOriginChange,
  branchName,
  onBranchNameChange,
}: NewThreadSourcePickerProps) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<NewThreadSourceTab>("branches");
  const [branchQuery, setBranchQuery] = useState("");
  const [prQuery, setPrQuery] = useState("");
  const [issueQuery, setIssueQuery] = useState("");
  const [workItemQuery, setWorkItemQuery] = useState("");
  const [prStateFilter, setPrStateFilter] = useState<ChangeRequestStateFilter>("open");
  const [issueStateFilter, setIssueStateFilter] = useState<IssueStateFilter>("open");
  const [workItemStateFilter, setWorkItemStateFilter] = useState<WorkItemStateFilter>("open");
  const branchInputRef = useRef<HTMLInputElement>(null);
  const prInputRef = useRef<HTMLInputElement>(null);
  const issueInputRef = useRef<HTMLInputElement>(null);
  const workItemInputRef = useRef<HTMLInputElement>(null);

  const choose = useCallback(
    (source: NewThreadSource) => {
      setOpen(false);
      onSelect(source);
    },
    [onSelect],
  );
  const handleOpenChange = useCallback((nextOpen: boolean) => {
    // Opening the picker is the intent: by the time a segment is picked, its
    // list has usually loaded.
    if (nextOpen) preloadSourceItemTabs();
    setOpen(nextOpen);
  }, []);
  const pullRequestsTabReady = useLazyComponentReady(
    LazyPullRequestsTab,
    open && tab === "prs",
    SOURCE_ITEM_TABS_LOAD,
  );
  const issuesTabReady = useLazyComponentReady(
    LazyIssuesTab,
    open && tab === "issues",
    SOURCE_ITEM_TABS_LOAD,
  );
  const workItemsTabReady = useLazyComponentReady(
    LazyWorkItemsTab,
    open && tab === "jira",
    SOURCE_ITEM_TABS_LOAD,
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        aria-label={`Change what this worktree branches from (currently ${label})`}
        className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 font-medium text-foreground/85 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        render={<button type="button" />}
      >
        <SourceKindGlyph kind={sourceKind} />
        <span className="min-w-0 max-w-[18rem] truncate">{label}</span>
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        side="bottom"
        className="w-[30rem] overflow-hidden p-0"
        viewportClassName="p-0 [--viewport-inline-padding:0px]"
      >
        <ContextPickerTabs
          tabs={[
            { id: "branches", label: "Branch" },
            { id: "prs", label: "Pull requests" },
            { id: "issues", label: "Issues" },
            { id: "jira", label: "Jira" },
          ]}
          activeId={tab}
          density="compact"
          onSelect={(id) => setTab(id as NewThreadSourceTab)}
        />
        <div className="h-72 min-h-0">
          {tab === "branches" ? (
            <BranchSourceList
              key={JSON.stringify([environmentId, cwd])}
              fetchOrigin={fetchOrigin}
              onFetchOriginChange={onFetchOriginChange}
              branchName={branchName}
              onBranchNameChange={onBranchNameChange}
              environmentId={environmentId}
              cwd={cwd}
              query={branchQuery}
              searchInputRef={branchInputRef}
              onQueryChange={setBranchQuery}
              onSelect={(branchName) => choose({ kind: "branch", branchName })}
            />
          ) : tab === "prs" ? (
            pullRequestsTabReady ? (
              <LazyPullRequestsTab
                environmentId={environmentId}
                cwd={cwd}
                searchInputRef={prInputRef}
                query={prQuery}
                onQueryChange={setPrQuery}
                density="compact"
                stateFilter={prStateFilter}
                onStateFilterChange={setPrStateFilter}
                onSelect={(changeRequest) => choose({ kind: "pr", changeRequest })}
              />
            ) : null
          ) : tab === "issues" ? (
            issuesTabReady ? (
              <LazyIssuesTab
                environmentId={environmentId}
                cwd={cwd}
                searchInputRef={issueInputRef}
                query={issueQuery}
                onQueryChange={setIssueQuery}
                density="compact"
                stateFilter={issueStateFilter}
                onStateFilterChange={setIssueStateFilter}
                onSelect={(issue) => choose({ kind: "issue", issue })}
              />
            ) : null
          ) : workItemsTabReady ? (
            <LazyWorkItemsTab
              environmentId={environmentId}
              cwd={cwd}
              projectId={projectId}
              searchInputRef={workItemInputRef}
              query={workItemQuery}
              onQueryChange={setWorkItemQuery}
              stateFilter={workItemStateFilter}
              onStateFilterChange={setWorkItemStateFilter}
              onSelect={(workItem) => choose({ kind: "workItem", workItem })}
            />
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function SourceKindGlyph({ kind }: { readonly kind: NewThreadSourcePickerProps["sourceKind"] }) {
  const className = "size-3.5 shrink-0";
  switch (kind) {
    case "pr":
      return (
        <GitPullRequestIcon
          aria-label="Pull request"
          className={cn(className, "text-emerald-500 dark:text-emerald-400")}
        />
      );
    case "issue":
      return (
        <CircleDotIcon
          aria-label="Issue"
          className={cn(className, "text-sky-500 dark:text-sky-400")}
        />
      );
    case "workItem":
      return (
        <AtlassianJiraIcon
          aria-label="Jira work item"
          className={cn(className, "text-violet-500 dark:text-violet-400")}
        />
      );
    case "branch":
      return <GitBranchIcon aria-hidden className={cn(className, "text-muted-foreground")} />;
    default:
      return null;
  }
}

function BranchSourceList({
  environmentId,
  cwd,
  query,
  searchInputRef,
  onQueryChange,
  onSelect,
  fetchOrigin,
  onFetchOriginChange,
  branchName,
  onBranchNameChange,
}: {
  readonly fetchOrigin: boolean;
  readonly onFetchOriginChange: (enabled: boolean) => void;
  readonly branchName: string | null;
  readonly onBranchNameChange: (name: string | null) => void;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly query: string;
  readonly searchInputRef: React.RefObject<HTMLInputElement | null>;
  readonly onQueryChange: (value: string) => void;
  readonly onSelect: (branchName: string) => void;
}) {
  const trimmedQuery = query.trim();
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [name, setName] = useState(branchName ?? "");
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
        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          Fetch Origin
          <Switch
            checked={fetchOrigin}
            onCheckedChange={(enabled) => {
              setCursor(0);
              onFetchOriginChange(enabled);
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
      </div>
      {creatingBranch ? (
        <form
          className="flex items-center gap-2 border-b border-border/40 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            onBranchNameChange(name.trim() || null);
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
