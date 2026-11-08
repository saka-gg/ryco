import type {
  AtlassianConnectionId,
  AtlassianProjectLink,
  EnvironmentId,
  ProjectId,
  VcsRef,
  WorkItemPriority,
  WorkItemStateFilter,
  WorkItemSummary,
} from "@ryco/contracts";
import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import { DateTime, Option } from "effect";
import { useQuery } from "~/rpc/queryClient";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useShallow } from "zustand/react/shallow";
import { ExternalLinkIcon, FlagIcon, GitBranchIcon, RotateCwIcon, SearchIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import { readEnvironmentConnection } from "~/environments/runtime";
import { readEnvironmentApi } from "~/environmentApi";
import {
  buildJiraProjectLinkInput,
  buildJiraProjectUnlinkInput,
} from "~/lib/atlassianProjectLinks";
import {
  findLinkedWorkItemBranches,
  findLinkedWorkItemWorktrees,
  type LinkedWorkItemWorktree,
} from "~/lib/workItemLocalLinks";
import {
  invalidateAtlassian,
  useAtlassianConnections,
  useAtlassianProjectLink,
  useSaveAtlassianProjectLinkMutation,
} from "~/rpc/useAtlassian";
import { invalidateWorkItems, useWorkItemList, useWorkItemSearch } from "~/rpc/useWorkItems";
import { selectSidebarWorktreesForProjectRef, useStore } from "~/store";
import { cn } from "~/lib/utils";
import type { WsRpcClient } from "@ryco/client-runtime/rpc";
import type { SidebarWorktreeSummary } from "~/types";
import { workItemStateLabel } from "@ryco/shared/workItemState";
import { AtlassianJiraIcon } from "../Icons";
import { JiraProjectPicker } from "../atlassian/JiraProjectPicker";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { LabelChip } from "./LabelChip";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { stackedThreadToast, toastManager } from "../ui/toast";

const workItemStateOptions: ReadonlyArray<{ id: WorkItemStateFilter; label: string }> = [
  { id: "open", label: "Open" },
  { id: "in_progress", label: "In progress" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" },
];

const dateFmt = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "numeric",
});

interface WorkItemsTabProps {
  environmentId: EnvironmentId | null;
  cwd?: string | null | undefined;
  projectId: ProjectId | null;
  searchInputRef: RefObject<HTMLInputElement | null>;
  query: string;
  onQueryChange: (value: string) => void;
  stateFilter: WorkItemStateFilter;
  onStateFilterChange: (state: WorkItemStateFilter) => void;
  onSelect: (item: WorkItemSummary) => void;
}

function splitProjectKeys(value: string): string[] {
  return value
    .split(/[,\s]+/u)
    .map((part) => part.trim().toUpperCase())
    .filter(Boolean);
}

function connectionIdValue(value: AtlassianConnectionId | null | undefined): string {
  return value ?? "";
}

export function WorkItemsTab(props: WorkItemsTabProps) {
  const [debouncedQuery] = useDebouncedValue(props.query, { wait: 200 });
  const connection =
    props.environmentId !== null ? readEnvironmentConnection(props.environmentId) : null;
  const client = connection?.client ?? null;

  const projectLinkQuery = useAtlassianProjectLink({
    environmentId: props.environmentId,
    projectId: props.projectId,
    enabled: client !== null && props.projectId !== null,
  });

  const connectionsQuery = useAtlassianConnections({
    environmentId: props.environmentId,
    enabled: client !== null,
  });

  const jiraConnections = useMemo(
    () =>
      (connectionsQuery.data ?? []).filter(
        (item) => item.status === "connected" && item.products.includes("jira"),
      ),
    [connectionsQuery.data],
  );

  const projectLink = projectLinkQuery.data ?? null;
  const configured =
    projectLink?.jiraConnectionId !== null &&
    projectLink?.jiraConnectionId !== undefined &&
    projectLink.jiraProjectKeys.length > 0;

  const listQuery = useWorkItemList({
    environmentId: props.environmentId,
    projectId: props.projectId,
    state: props.stateFilter,
    limit: 100,
    enabled: configured,
  });

  const cachedItems = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const filteredItems = useMemo(() => {
    const needle = props.query.trim().toLowerCase();
    if (!needle) return cachedItems;
    return cachedItems.filter(
      (item) =>
        item.key.toLowerCase().includes(needle) ||
        item.title.toLowerCase().includes(needle) ||
        (item.issueType?.toLowerCase().includes(needle) ?? false),
    );
  }, [cachedItems, props.query]);

  const needsServerSearch = filteredItems.length === 0 && debouncedQuery.trim().length >= 2;
  const searchQuery = useWorkItemSearch({
    environmentId: props.environmentId,
    projectId: props.projectId,
    query: debouncedQuery,
    limit: 50,
    enabled: configured && needsServerSearch,
  });

  const items = useMemo(
    () => (needsServerSearch ? (searchQuery.data ?? []) : filteredItems),
    [filteredItems, needsServerSearch, searchQuery.data],
  );
  const isLoading = projectLinkQuery.isLoading || listQuery.isLoading || searchQuery.isLoading;
  const error = projectLinkQuery.error ?? listQuery.error ?? searchQuery.error;
  const projectWorktrees = useStore(
    useShallow((state) =>
      props.environmentId && props.projectId
        ? selectSidebarWorktreesForProjectRef(
            state,
            scopeProjectRef(props.environmentId, props.projectId),
          )
        : [],
    ),
  );
  const branchRefsQuery = useQuery({
    queryKey: ["workItems", "localBranches", props.environmentId, props.cwd ?? null] as const,
    environmentId: props.environmentId,
    queryFn: async () => {
      const api = props.environmentId ? readEnvironmentApi(props.environmentId) : null;
      if (!api || !props.cwd) return [];
      const result = await api.vcs.listRefs({ cwd: props.cwd, limit: 100 });
      return result.refs;
    },
    enabled:
      configured && props.environmentId !== null && props.cwd !== null && props.cwd !== undefined,
    staleTime: 30_000,
  });
  const localLinksByWorkItemKey = useMemo(
    () =>
      buildLocalLinksByWorkItemKey({
        items,
        refs: branchRefsQuery.data ?? [],
        worktrees: projectWorktrees,
      }),
    [branchRefsQuery.data, items, projectWorktrees],
  );
  const refreshWorkItemsData = () => {
    invalidateAtlassian({ environmentId: props.environmentId });
    invalidateWorkItems({ environmentId: props.environmentId, projectId: props.projectId });
  };
  const unlinkMutation = useSaveAtlassianProjectLinkMutation({
    environmentId: props.environmentId,
    onSuccess: () => {
      props.onQueryChange("");
      refreshWorkItemsData();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Jira project unlinked",
          description: "Jira work items are no longer loaded for this project.",
        }),
      );
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not unlink Jira project",
          description: error.message,
        }),
      );
    },
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {configured ? (
        <>
          <div className="flex items-center gap-2 border-border/60 border-b px-4 py-2.5">
            <div className="relative flex-1">
              <SearchIcon className="-translate-y-1/2 absolute top-1/2 left-2 size-3.5 text-muted-foreground" />
              <Input
                ref={props.searchInputRef}
                value={props.query}
                onChange={(event) => props.onQueryChange(event.target.value)}
                placeholder="Search Jira work items by key or title…"
                className="h-8 pl-7 text-sm"
              />
            </div>
            <WorkItemStateFilterButtons
              value={props.stateFilter}
              onChange={props.onStateFilterChange}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={() => listQuery.refetch()}
              disabled={listQuery.isFetching || unlinkMutation.isPending}
              aria-label="Refresh"
            >
              <RotateCwIcon
                className={listQuery.isFetching ? "size-3.5 animate-spin" : "size-3.5"}
              />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive-outline"
              className="h-8"
              disabled={unlinkMutation.isPending || props.projectId === null}
              onClick={() =>
                unlinkMutation.mutate(
                  buildJiraProjectUnlinkInput({
                    projectId: props.projectId as ProjectId,
                    existing: projectLink,
                  }),
                )
              }
            >
              {unlinkMutation.isPending ? <Spinner className="size-3.5" /> : null}
              Unlink Jira
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {error ? (
              <p className="px-4 py-6 text-destructive text-sm">
                {error instanceof Error ? error.message : "Failed to load Jira work items."}
              </p>
            ) : (
              <WorkItemList
                items={items}
                isLoading={isLoading}
                emptyText={
                  props.query.trim().length > 0
                    ? "No Jira work items match this search."
                    : "No Jira work items to show."
                }
                localLinksByWorkItemKey={localLinksByWorkItemKey}
                onSelect={props.onSelect}
              />
            )}
          </div>
        </>
      ) : (
        <JiraProjectSetup
          environmentId={props.environmentId}
          projectId={props.projectId}
          client={client}
          connections={jiraConnections}
          connectionsPending={connectionsQuery.isLoading}
          projectLink={projectLink}
          onSaved={refreshWorkItemsData}
        />
      )}
    </div>
  );
}

function WorkItemStateFilterButtons(props: {
  readonly value: WorkItemStateFilter;
  readonly onChange: (state: WorkItemStateFilter) => void;
}) {
  return (
    <div className="inline-flex rounded-md border border-border/70 bg-background p-0.5">
      {workItemStateOptions.map((option) => (
        <button
          key={option.id}
          type="button"
          className={cn(
            "h-6 rounded-sm px-2 text-xs transition",
            props.value === option.id
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => props.onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function WorkItemList(props: {
  readonly items: ReadonlyArray<WorkItemSummary>;
  readonly isLoading: boolean;
  readonly emptyText: string;
  readonly localLinksByWorkItemKey: ReadonlyMap<string, WorkItemLocalLinks>;
  readonly onSelect: (item: WorkItemSummary) => void;
}) {
  if (props.isLoading && props.items.length === 0) {
    return <div className="px-4 py-8 text-center text-muted-foreground text-sm">Loading…</div>;
  }
  if (props.items.length === 0) {
    return (
      <div className="px-4 py-8 text-center text-muted-foreground text-sm">{props.emptyText}</div>
    );
  }
  return (
    <ul role="listbox" className="divide-y divide-border/40">
      {props.items.map((item) => (
        <li key={`${item.provider}:${item.key}`} className="flex items-stretch">
          <button
            type="button"
            onClick={() => props.onSelect(item)}
            className={cn(
              "flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left",
              "hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-none",
            )}
          >
            <AtlassianJiraIcon className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-muted-foreground text-xs">{item.key}</span>
                <span className="min-w-0 flex-1 truncate font-medium text-sm">{item.title}</span>
                <Badge
                  variant={
                    item.state === "done" || item.state === "closed" ? "secondary" : "outline"
                  }
                  size="sm"
                >
                  {workItemStateLabel(item)}
                </Badge>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
                {item.issueType ? <span>{item.issueType}</span> : null}
                {item.reporter ? <span>reported by {item.reporter}</span> : null}
                {item.assignee ? <span>assigned to {item.assignee}</span> : null}
                {(item.priorityDetail ?? item.priority) ? (
                  <span className="inline-flex items-center gap-1">
                    <PriorityMini priority={item.priorityDetail ?? item.priority} />
                    {item.priority}
                  </span>
                ) : null}
                {item.dueDate ? <span>due {item.dueDate}</span> : null}
                <WorkItemLocalLinkChips links={props.localLinksByWorkItemKey.get(item.key)} />
                {item.labels?.slice(0, 3).map((label) => (
                  <LabelChip key={label} label={label} />
                ))}
                {item.labels && item.labels.length > 3 ? (
                  <span className="text-[10px]">+{item.labels.length - 3} labels</span>
                ) : null}
                {item.updatedAt && Option.isSome(item.updatedAt) ? (
                  <span className="ml-auto">
                    {dateFmt.format(DateTime.toDate(item.updatedAt.value))}
                  </span>
                ) : null}
              </div>
            </div>
          </button>
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex w-10 shrink-0 items-center justify-center text-muted-foreground hover:bg-accent/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={`Open ${item.key} in Jira`}
            aria-label={`Open ${item.key} in Jira`}
          >
            <ExternalLinkIcon className="size-3.5" />
          </a>
        </li>
      ))}
    </ul>
  );
}

function PriorityMini(props: { readonly priority: WorkItemPriority | string | undefined }) {
  const name = typeof props.priority === "string" ? props.priority : props.priority?.name;
  const iconUrl = typeof props.priority === "string" ? undefined : props.priority?.iconUrl;
  if (iconUrl) {
    return <img src={iconUrl} alt="" className="size-3" loading="lazy" decoding="async" />;
  }
  return <FlagIcon className="size-3" aria-label={name ?? "Priority"} />;
}

interface WorkItemLocalLinks {
  readonly branches: ReadonlyArray<VcsRef>;
  readonly worktrees: ReadonlyArray<LinkedWorkItemWorktree>;
}

function buildLocalLinksByWorkItemKey(input: {
  readonly items: ReadonlyArray<WorkItemSummary>;
  readonly refs: ReadonlyArray<VcsRef>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
}): ReadonlyMap<string, WorkItemLocalLinks> {
  const links = new Map<string, WorkItemLocalLinks>();
  for (const item of input.items) {
    const branches = findLinkedWorkItemBranches({ key: item.key, refs: input.refs });
    const worktrees = findLinkedWorkItemWorktrees({ key: item.key, worktrees: input.worktrees });
    if (branches.length > 0 || worktrees.length > 0) {
      links.set(item.key, { branches, worktrees });
    }
  }
  return links;
}

function WorkItemLocalLinkChips(props: { readonly links: WorkItemLocalLinks | undefined }) {
  if (!props.links || (props.links.branches.length === 0 && props.links.worktrees.length === 0)) {
    return null;
  }
  const branchCount = props.links.branches.length;
  const worktreeCount = props.links.worktrees.length;
  return (
    <>
      {branchCount > 0 ? (
        <span
          className="inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10px]"
          title={props.links.branches.map((branch) => branch.name).join(", ")}
        >
          <GitBranchIcon className="size-3" />
          {branchCount} branch{branchCount === 1 ? "" : "es"}
        </span>
      ) : null}
      {worktreeCount > 0 ? (
        <span
          className="inline-flex items-center gap-1 rounded border border-border/60 px-1.5 py-0.5 text-[10px]"
          title={props.links.worktrees.map((worktree) => worktree.branch).join(", ")}
        >
          <AtlassianJiraIcon className="size-3" />
          {worktreeCount} worktree{worktreeCount === 1 ? "" : "s"}
        </span>
      ) : null}
    </>
  );
}

function JiraProjectSetup(props: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly client: WsRpcClient | null;
  readonly connections: ReadonlyArray<{
    readonly connectionId: AtlassianConnectionId;
    readonly label: string;
    readonly baseUrl: string | null;
  }>;
  readonly connectionsPending: boolean;
  readonly projectLink: AtlassianProjectLink | null;
  readonly onSaved: () => void;
}) {
  const [connectionId, setConnectionId] = useState("");
  const [projectKeys, setProjectKeys] = useState("");
  const dirtyRef = useRef(false);
  const initializedProjectRef = useRef<ProjectId | null>(null);

  useEffect(() => {
    if (initializedProjectRef.current !== props.projectId) {
      initializedProjectRef.current = props.projectId;
      dirtyRef.current = false;
    }
    if (dirtyRef.current) return;
    const first = props.connections[0];
    setConnectionId(connectionIdValue(props.projectLink?.jiraConnectionId ?? first?.connectionId));
    setProjectKeys(props.projectLink?.jiraProjectKeys.join(", ") ?? "");
  }, [props.connections, props.projectId, props.projectLink]);

  const markDirty = () => {
    dirtyRef.current = true;
  };

  const saveMutation = useSaveAtlassianProjectLinkMutation({
    environmentId: props.environmentId,
    onSuccess: () => {
      dirtyRef.current = false;
      props.onSaved();
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Jira project linked",
          description: "Work items will now load in the project explorer.",
        }),
      );
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not link Jira project",
          description: error.message,
        }),
      );
    },
  });

  const canSave =
    props.client !== null &&
    props.projectId !== null &&
    connectionId.trim().length > 0 &&
    splitProjectKeys(projectKeys).length > 0 &&
    !saveMutation.isPending;
  const selectedJiraConnectionId =
    connectionId.trim().length > 0 ? (connectionId.trim() as AtlassianConnectionId) : null;
  const selectedJiraConnection = props.connections.find(
    (connection) => connection.connectionId === selectedJiraConnectionId,
  );
  const selectedJiraSiteUrl =
    selectedJiraConnection?.baseUrl ?? props.projectLink?.jiraSiteUrl ?? "";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <div className="mx-auto max-w-xl space-y-4">
        <div className="flex items-start gap-3">
          <div className="flex size-9 items-center justify-center rounded-md border border-border/70 bg-muted/50">
            <AtlassianJiraIcon className="size-4" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-sm">Link this project to Jira</h3>
            <p className="mt-1 text-muted-foreground text-xs leading-relaxed">
              Save a Jira token in Source Control settings, then choose the project keys that belong
              to this repository.
            </p>
          </div>
        </div>

        {props.connectionsPending ? (
          <div className="flex items-center gap-2 rounded-md border border-border/70 px-3 py-3 text-muted-foreground text-sm">
            <Spinner className="size-4" />
            Loading Jira connections…
          </div>
        ) : props.connections.length === 0 ? (
          <div className="rounded-md border border-border/70 px-3 py-3 text-muted-foreground text-sm">
            No Jira token is stored yet. Add one from Settings, Source Control, Atlassian Workflow.
          </div>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              if (!canSave || !props.projectId) return;
              const selectedConnectionId = connectionId.trim() as AtlassianConnectionId;
              const keys = splitProjectKeys(projectKeys);
              if (!selectedConnectionId || keys.length === 0) return;
              saveMutation.mutate(
                buildJiraProjectLinkInput({
                  projectId: props.projectId,
                  existing: props.projectLink,
                  jiraConnectionId: selectedConnectionId,
                  jiraSiteUrl: null,
                  jiraProjectKeys: keys,
                }),
              );
            }}
          >
            <div className="space-y-1.5">
              <Label className="text-xs">Jira connection</Label>
              <Select
                value={connectionId}
                onValueChange={(value) => {
                  if (typeof value === "string") {
                    markDirty();
                    setConnectionId(value);
                  }
                }}
              >
                <SelectTrigger size="sm">
                  <SelectValue placeholder="Select Jira connection" />
                </SelectTrigger>
                <SelectPopup>
                  {props.connections.map((connection) => (
                    <SelectItem key={connection.connectionId} value={connection.connectionId}>
                      {connection.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="work-item-jira-project-keys" className="text-xs">
                Project keys
              </Label>
              <JiraProjectPicker
                environmentId={props.environmentId}
                connectionId={selectedJiraConnectionId}
                siteUrl={selectedJiraSiteUrl}
                projectKeys={projectKeys}
                disabled={saveMutation.isPending}
                onProjectKeysChange={(value) => {
                  markDirty();
                  setProjectKeys(value);
                }}
              />
              <Input
                id="work-item-jira-project-keys"
                size="sm"
                value={projectKeys}
                onChange={(event) => {
                  markDirty();
                  setProjectKeys(event.currentTarget.value);
                }}
                placeholder="WEB, API"
              />
            </div>
            <Button type="submit" size="sm" className="h-8 justify-self-start" disabled={!canSave}>
              {saveMutation.isPending ? <Spinner className="size-3.5" /> : null}
              Link Jira Project
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
