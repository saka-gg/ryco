import { ProjectBrowserPreview } from "../../browser/ProjectBrowserPreview";
import type {
  ChangeRequest,
  EnvironmentId,
  ProjectId,
  SourceControlIssueSummary,
  WorkItemPriority,
  WorkItemSummary,
} from "@ryco/contracts";
import { useMemo, type ReactNode } from "react";
import {
  useSourceControlChangeRequestList,
  useSourceControlIssueList,
  useSourceControlWorkflowRuns,
} from "~/rpc/useSourceControl";
import {
  AlertTriangleIcon,
  CircleDotIcon,
  FlagIcon,
  GitPullRequestIcon,
  ListChecksIcon,
} from "lucide-react";
import { useAtlassianProjectLink } from "~/rpc/useAtlassian";
import { useWorkItemList } from "~/rpc/useWorkItems";
import { workItemStateLabel } from "~/lib/workItemState";
import { cn } from "~/lib/utils";
import { AtlassianJiraIcon } from "../Icons";
import { Button } from "../ui/button";
import { changeRequestStateKind, StateBadge } from "./StateBadge";

const OVERVIEW_LIST_LIMIT = 20;
const OVERVIEW_VISIBLE_LIMIT = 5;

type OverviewTabId = "issues" | "prs" | "actions" | "workItems";

interface ProjectOverviewTabProps {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly projectId: ProjectId | null;
  readonly onOpenTab: (tab: OverviewTabId) => void;
  readonly onSelectIssue: (issue: SourceControlIssueSummary) => void;
  readonly onSelectChangeRequest: (changeRequest: ChangeRequest) => void;
  readonly onSelectWorkItem: (workItem: WorkItemSummary) => void;
}

interface OverviewSectionProps<TItem> {
  readonly title: string;
  readonly description: string;
  readonly countLabel: string;
  readonly emptyText: string;
  readonly error: unknown;
  readonly isLoading: boolean;
  readonly items: ReadonlyArray<TItem>;
  readonly icon: ReactNode;
  readonly accentClassName: string;
  readonly onOpenTab: () => void;
  readonly keyForItem: (item: TItem) => string;
  readonly renderItem: (item: TItem) => ReactNode;
}

export function formatProjectOverviewCount(
  count: number,
  limit: number = OVERVIEW_LIST_LIMIT,
): string {
  return count >= limit ? `${limit}+` : String(count);
}

export function ProjectOverviewTab(props: ProjectOverviewTabProps) {
  const issueListQuery = useSourceControlIssueList({
    environmentId: props.environmentId,
    cwd: props.cwd,
    state: "open",
    limit: OVERVIEW_LIST_LIMIT,
  });
  const pullRequestListQuery = useSourceControlChangeRequestList({
    environmentId: props.environmentId,
    cwd: props.cwd,
    state: "open",
    limit: OVERVIEW_LIST_LIMIT,
  });
  const workflowRunsQuery = useSourceControlWorkflowRuns({
    environmentId: props.environmentId,
    cwd: props.cwd,
    limit: OVERVIEW_LIST_LIMIT,
  });
  const projectLinkQuery = useAtlassianProjectLink({
    environmentId: props.environmentId,
    projectId: props.projectId,
    enabled: props.environmentId !== null && props.projectId !== null,
  });

  const jiraConfigured =
    projectLinkQuery.data?.jiraConnectionId !== null &&
    projectLinkQuery.data?.jiraConnectionId !== undefined &&
    projectLinkQuery.data.jiraProjectKeys.length > 0;
  const workItemListQuery = useWorkItemList({
    environmentId: props.environmentId,
    projectId: props.projectId,
    state: "open",
    limit: OVERVIEW_LIST_LIMIT,
    enabled: jiraConfigured,
  });

  const issues = useMemo(() => issueListQuery.data ?? [], [issueListQuery.data]);
  const pullRequests = useMemo(() => pullRequestListQuery.data ?? [], [pullRequestListQuery.data]);
  const workflowRuns = useMemo(() => workflowRunsQuery.data?.runs ?? [], [workflowRunsQuery.data]);
  const workItems = useMemo(() => workItemListQuery.data ?? [], [workItemListQuery.data]);

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <div className="px-4 pt-3">
        <ProjectBrowserPreview environmentId={props.environmentId} cwd={props.cwd} />
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
        <OverviewMetric
          label="Open issues"
          value={formatProjectOverviewCount(issues.length)}
          icon={<CircleDotIcon className="size-3.5" />}
          accentClassName="border-emerald-500/18 bg-emerald-500/8 text-emerald-600 dark:text-emerald-300"
          onClick={() => props.onOpenTab("issues")}
        />
        <OverviewMetric
          label="Open pull requests"
          value={formatProjectOverviewCount(pullRequests.length)}
          icon={<GitPullRequestIcon className="size-3.5" />}
          accentClassName="border-emerald-500/18 bg-emerald-500/8 text-emerald-600 dark:text-emerald-300"
          onClick={() => props.onOpenTab("prs")}
        />
        <OverviewMetric
          label="Actions"
          value={formatProjectOverviewCount(workflowRuns.length)}
          icon={<ListChecksIcon className="size-3.5" />}
          accentClassName="border-amber-500/18 bg-amber-500/8 text-amber-600 dark:text-amber-300"
          onClick={() => props.onOpenTab("actions")}
        />
        <OverviewMetric
          label="Open Jira"
          value={jiraConfigured ? formatProjectOverviewCount(workItems.length) : "Not linked"}
          icon={<AtlassianJiraIcon className="size-3.5" />}
          accentClassName="border-violet-500/18 bg-violet-500/8 text-violet-600 dark:text-violet-300"
          onClick={() => props.onOpenTab("workItems")}
        />
      </div>

      <div className="divide-y divide-border/60 border-border/60 border-t">
        <OverviewSection
          title="Issues"
          description="Open source-control issues for this repository."
          countLabel={formatProjectOverviewCount(issues.length)}
          emptyText="No open issues."
          error={issueListQuery.error}
          isLoading={issueListQuery.isLoading}
          items={issues.slice(0, OVERVIEW_VISIBLE_LIMIT)}
          icon={<CircleDotIcon className="size-4" />}
          accentClassName="text-emerald-600 dark:text-emerald-300"
          onOpenTab={() => props.onOpenTab("issues")}
          keyForItem={(issue) => `${issue.provider}:${issue.number}`}
          renderItem={(issue) => (
            <button
              type="button"
              className="flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent/50 focus-visible:bg-accent/60 focus-visible:outline-none"
              onClick={() => props.onSelectIssue(issue)}
            >
              <span className="shrink-0 text-muted-foreground text-xs">#{issue.number}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{issue.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{issue.state}</span>
            </button>
          )}
        />

        <OverviewSection
          title="Pull requests"
          description="Open pull requests and review work for this repository."
          countLabel={formatProjectOverviewCount(pullRequests.length)}
          emptyText="No open pull requests."
          error={pullRequestListQuery.error}
          isLoading={pullRequestListQuery.isLoading}
          items={pullRequests.slice(0, OVERVIEW_VISIBLE_LIMIT)}
          icon={<GitPullRequestIcon className="size-4" />}
          accentClassName="text-emerald-600 dark:text-emerald-300"
          onOpenTab={() => props.onOpenTab("prs")}
          keyForItem={(pullRequest) => `${pullRequest.provider}:${pullRequest.number}`}
          renderItem={(pullRequest) => (
            <button
              type="button"
              className="flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent/50 focus-visible:bg-accent/60 focus-visible:outline-none"
              onClick={() => props.onSelectChangeRequest(pullRequest)}
            >
              <span className="shrink-0 text-muted-foreground text-xs">#{pullRequest.number}</span>
              <span className="min-w-0 flex-1 truncate text-sm">{pullRequest.title}</span>
              <StateBadge
                kind={changeRequestStateKind(pullRequest.state, pullRequest.isDraft)}
                className="shrink-0"
              />
            </button>
          )}
        />

        {jiraConfigured || projectLinkQuery.isLoading ? (
          <OverviewSection
            title="Jira"
            description="Open Jira work items linked to this project."
            countLabel={
              projectLinkQuery.isLoading ? "..." : formatProjectOverviewCount(workItems.length)
            }
            emptyText="No open Jira work items."
            error={workItemListQuery.error}
            isLoading={projectLinkQuery.isLoading || workItemListQuery.isLoading}
            items={workItems.slice(0, OVERVIEW_VISIBLE_LIMIT)}
            icon={<AtlassianJiraIcon className="size-4" />}
            accentClassName="text-violet-600 dark:text-violet-300"
            onOpenTab={() => props.onOpenTab("workItems")}
            keyForItem={(workItem) => `${workItem.provider}:${workItem.key}`}
            renderItem={(workItem) => (
              <button
                type="button"
                className="flex w-full min-w-0 items-start gap-2 rounded-sm px-2 py-1.5 text-left hover:bg-accent/50 focus-visible:bg-accent/60 focus-visible:outline-none"
                onClick={() => props.onSelectWorkItem(workItem)}
              >
                <span className="mt-0.5 shrink-0 text-muted-foreground text-xs">
                  {workItem.key}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{workItem.title}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                    {workItem.issueType ? <span>{workItem.issueType}</span> : null}
                    {workItem.assignee ? <span>{workItem.assignee}</span> : null}
                    {(workItem.priorityDetail ?? workItem.priority) ? (
                      <span className="inline-flex items-center gap-1">
                        <PriorityMini priority={workItem.priorityDetail ?? workItem.priority} />
                        {workItem.priority}
                      </span>
                    ) : null}
                  </span>
                </span>
                <span className="mt-0.5 shrink-0 text-[11px] text-muted-foreground">
                  {workItemStateLabel(workItem)}
                </span>
              </button>
            )}
          />
        ) : (
          <div className="flex items-center justify-between gap-4 px-4 py-4">
            <div className="flex min-w-0 items-start gap-3">
              <AtlassianJiraIcon className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0">
                <h3 className="font-medium text-sm">Jira is not linked to this project</h3>
                <p className="mt-1 text-muted-foreground text-xs">
                  Select the Jira tab to choose the connection and project key.
                </p>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0"
              onClick={() => props.onOpenTab("workItems")}
            >
              Configure
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function PriorityMini(props: { readonly priority: WorkItemPriority | string | undefined }) {
  const iconUrl = typeof props.priority === "string" ? undefined : props.priority?.iconUrl;
  if (iconUrl) {
    return <img src={iconUrl} alt="" className="size-3" loading="lazy" decoding="async" />;
  }
  return <FlagIcon className="size-3" />;
}

function OverviewMetric(props: {
  readonly label: string;
  readonly value: string;
  readonly icon: ReactNode;
  readonly accentClassName: string;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        props.accentClassName,
      )}
      onClick={props.onClick}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-background/70">
        {props.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-base leading-5">{props.value}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{props.label}</span>
      </span>
    </button>
  );
}

function OverviewSection<TItem>(props: OverviewSectionProps<TItem>) {
  return (
    <section className="px-4 py-4">
      <header className="mb-2 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className={cn("mt-0.5 shrink-0", props.accentClassName)}>{props.icon}</span>
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h3 className="font-medium text-sm">{props.title}</h3>
              <span className="text-muted-foreground text-xs">{props.countLabel}</span>
            </div>
            <p className="mt-0.5 text-muted-foreground text-xs">{props.description}</p>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={props.onOpenTab}
        >
          View all
        </Button>
      </header>

      {props.error ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-destructive text-xs">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>{props.error instanceof Error ? props.error.message : "Failed to load."}</span>
        </div>
      ) : props.isLoading && props.items.length === 0 ? (
        <p className="px-2 py-4 text-muted-foreground text-sm">Loading...</p>
      ) : props.items.length === 0 ? (
        <p className="px-2 py-4 text-muted-foreground text-sm">{props.emptyText}</p>
      ) : (
        <div className="grid gap-1">
          {props.items.map((item) => (
            <div key={props.keyForItem(item)}>{props.renderItem(item)}</div>
          ))}
        </div>
      )}
    </section>
  );
}
