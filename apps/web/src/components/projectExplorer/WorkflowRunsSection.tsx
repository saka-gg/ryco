import type {
  EnvironmentId,
  SourceControlWorkflowJob,
  SourceControlWorkflowRun,
  SourceControlWorkflowStep,
} from "@ryco/contracts";
import { DateTime, Option } from "effect";
import { useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  Clock3Icon,
  ExternalLinkIcon,
  FileTextIcon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  RotateCwIcon,
  UserIcon,
} from "lucide-react";
import {
  invalidateSourceControl,
  useRerunWorkflowMutation,
  useSourceControlChangeRequestList,
  useSourceControlWorkflowJobLog,
  useSourceControlWorkflowRunJobs,
  useSourceControlWorkflowRuns,
} from "~/rpc/useSourceControl";
import { cn } from "~/lib/utils";
import { useSettings } from "~/hooks/useSettings";
import { resolveSourceControlRefreshDelay } from "~/rpc/sourceControlRefreshPolicy";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { PrCheckStatusBadge } from "./PrCheckStatusBadge";
import {
  getCheckStatusFromRaw,
  getCheckStatusFromWorkflowRun,
  getPrCheckStatusForQuery,
  getPrCheckStatusFromWorkflowRuns,
  normalizeCheckToken,
  primaryFailedCheckUrl,
  shouldRefreshPrCheckStatus,
  sourceControlOptionValue,
} from "./prCheckStatus";
import { usePrCheckPassNotifications } from "./usePrCheckPassNotifications";
import { groupWorkflowRunsBySource, type WorkflowRunGroup } from "./workflowRunGroups";

const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const EMPTY_WORKFLOW_RUNS: ReadonlyArray<SourceControlWorkflowRun> = [];

interface WorkflowRunsSectionProps {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  pullRequestNumber?: number | null;
  /** The pull request's host URL: a watched pull request's checks notice comes from its watch. */
  pullRequestUrl?: string | undefined;
  title?: string;
  description?: string;
  groupRunsBySource?: boolean;
}

type WorkflowRerunFeedbackTone = "success" | "permission-denied" | "not-rerunnable" | "error";

interface WorkflowRerunFeedback {
  readonly tone: WorkflowRerunFeedbackTone;
  readonly message: string;
}

type WorkflowRerunPayload =
  | { readonly target: "failed-jobs" }
  | { readonly target: "job"; readonly jobId: string };

function isCompletedStatus(status: string): boolean {
  return normalizeCheckToken(status) === "completed";
}
function formatDate(value: Option.Option<DateTime.Utc>): string | null {
  const dateTime = sourceControlOptionValue(value);
  return dateTime ? dateTimeFmt.format(DateTime.toDate(dateTime)) : null;
}

function formatDuration(value: Option.Option<number>): string | null {
  const ms = sourceControlOptionValue(value);
  if (ms === null) return null;
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60)
    return remainderSeconds > 0 ? `${minutes}m ${remainderSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainderMinutes = minutes % 60;
  return remainderMinutes > 0 ? `${hours}h ${remainderMinutes}m` : `${hours}h`;
}

function errorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : fallback;
  const providerMatch = /^Source control provider [^ ]+ failed in [^:]+:\s*(.*)$/u.exec(raw);
  return providerMatch?.[1] ?? raw;
}

function workflowRerunTargetKey(payload: WorkflowRerunPayload): string {
  return payload.target === "job" ? `job:${payload.jobId}` : "failed-jobs";
}

function workflowRerunErrorFeedback(error: unknown): WorkflowRerunFeedback {
  const message = errorMessage(error, "Failed to request workflow rerun.");
  const lower = message.toLowerCase();

  if (
    lower.includes("not accessible") ||
    lower.includes("permission") ||
    lower.includes("forbidden") ||
    lower.includes("actions write") ||
    lower.includes("token")
  ) {
    return {
      tone: "permission-denied",
      message:
        "GitHub refused the rerun. Check repository permissions and that the token has Actions write access.",
    };
  }

  if (
    lower.includes("cannot rerun") ||
    lower.includes("cannot re-run") ||
    lower.includes("current state") ||
    lower.includes("no failed jobs") ||
    lower.includes("unprocessable") ||
    lower.includes("422")
  ) {
    return {
      tone: "not-rerunnable",
      message: "GitHub says this workflow run or job is not rerunnable in its current state.",
    };
  }

  return { tone: "error", message };
}

function useWorkflowRerunAction(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly runId: string;
}) {
  const rerunMutation = useRerunWorkflowMutation(input);
  const pendingTargetRef = useRef<string | null>(null);
  const [pendingTarget, setPendingTarget] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<WorkflowRerunFeedback | null>(null);

  const requestRerun = async (payload: WorkflowRerunPayload, successMessage: string) => {
    const targetKey = workflowRerunTargetKey(payload);
    if (pendingTargetRef.current === targetKey) return;

    pendingTargetRef.current = targetKey;
    setPendingTarget(targetKey);
    setFeedback(null);
    try {
      await rerunMutation.mutateAsync(payload);
      setFeedback({ tone: "success", message: successMessage });
    } catch (error) {
      setFeedback(workflowRerunErrorFeedback(error));
    } finally {
      pendingTargetRef.current = null;
      setPendingTarget(null);
    }
  };

  return {
    feedback,
    pendingTarget,
    requestRerun,
  };
}

function StatusPill(props: { status: string; conclusion: string | null }) {
  return (
    <PrCheckStatusBadge
      view={getCheckStatusFromRaw({
        name: "check",
        status: props.status,
        conclusion: props.conclusion,
      })}
      mode="compact"
    />
  );
}

function MetaItem(props: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
      {props.icon}
      <span className="truncate">{props.children}</span>
    </span>
  );
}

function formatRunTimestamp(run: SourceControlWorkflowRun): string | null {
  return formatDate(run.updatedAt) ?? formatDate(run.startedAt);
}

function formatRunCount(count: number): string {
  return `${count} ${count === 1 ? "run" : "runs"}`;
}

function isWorkflowRunGroupDefaultExpanded(group: WorkflowRunGroup): boolean {
  const status = getPrCheckStatusFromWorkflowRuns({ runs: group.runs });
  return status.kind === "failed" || status.kind === "running" || status.kind === "pending";
}

export function WorkflowRunsSection(props: WorkflowRunsSectionProps) {
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [expandedGroupOverrides, setExpandedGroupOverrides] = useState<Record<string, boolean>>({});
  const sourceControlRefreshMode = useSettings((settings) => settings.sourceControlRefreshMode);
  const shouldGroupRuns = props.groupRunsBySource === true && props.pullRequestNumber == null;
  const changeRequestsQuery = useSourceControlChangeRequestList({
    environmentId: props.environmentId,
    cwd: props.cwd,
    state: "all",
    limit: 100,
    enabled: shouldGroupRuns,
  });
  const runsQuery = useSourceControlWorkflowRuns(
    {
      environmentId: props.environmentId,
      cwd: props.cwd,
      ...(props.pullRequestNumber !== undefined
        ? { pullRequestNumber: props.pullRequestNumber }
        : {}),
      limit: 20,
    },
    (data) => {
      const status = data
        ? getPrCheckStatusFromWorkflowRuns({
            runs: data.runs,
            headSha: sourceControlOptionValue(data.headSha),
          })
        : null;
      return resolveSourceControlRefreshDelay({
        mode: sourceControlRefreshMode,
        phase: status && shouldRefreshPrCheckStatus(status) ? "active" : "settled",
      });
    },
  );

  const runs = runsQuery.data?.runs ?? EMPTY_WORKFLOW_RUNS;
  const runGroups = useMemo(
    () =>
      shouldGroupRuns
        ? groupWorkflowRunsBySource({
            runs,
            changeRequests: changeRequestsQuery.data ?? [],
          })
        : [],
    [changeRequestsQuery.data, runs, shouldGroupRuns],
  );
  const headSha = runsQuery.data ? sourceControlOptionValue(runsQuery.data.headSha) : null;
  const status = getPrCheckStatusForQuery({
    isLoading: runsQuery.isLoading,
    error: runsQuery.error,
    status: runsQuery.data
      ? getPrCheckStatusFromWorkflowRuns({
          runs,
          headSha,
        })
      : null,
  });
  const failedRuns = runs.filter((run) => getCheckStatusFromWorkflowRun(run).kind === "failed");
  const failedUrl = primaryFailedCheckUrl(status);
  const expandRun = (runId: string | null) => {
    setExpandedRunId(runId);
    if (!runId || !shouldGroupRuns) return;

    const group = runGroups.find((candidate) => candidate.runs.some((run) => run.runId === runId));
    if (!group) return;

    setExpandedGroupOverrides((current) => ({
      ...current,
      [group.id]: true,
    }));
  };

  usePrCheckPassNotifications(
    props.pullRequestNumber && runsQuery.data
      ? [
          {
            environmentId: props.environmentId,
            cwd: props.cwd,
            provider: runsQuery.data.provider,
            number: props.pullRequestNumber,
            title: `PR #${props.pullRequestNumber}`,
            url: props.pullRequestUrl,
            status,
          },
        ]
      : [],
  );

  return (
    <section className="flex h-full min-h-0 flex-col">
      <header className="flex items-start gap-3 border-border/60 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-sm">{props.title ?? "GitHub Actions"}</h3>
          <p className="mt-0.5 text-muted-foreground text-xs">
            {props.description ??
              (props.pullRequestNumber
                ? "Workflow runs for the pull request head commit."
                : "Recent workflow runs for this repository.")}
          </p>
          {runsQuery.data && Option.isSome(runsQuery.data.headSha) ? (
            <p className="mt-1 font-mono text-muted-foreground/80 text-[11px]">
              head {runsQuery.data.headSha.value.slice(0, 12)}
            </p>
          ) : null}
        </div>
        <PrCheckStatusBadge view={status} mode="compact" className="mt-0.5" />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => {
            if (props.environmentId !== null && props.cwd !== null) {
              invalidateSourceControl({ environmentId: props.environmentId, cwd: props.cwd });
            }
          }}
          disabled={runsQuery.isFetching}
        >
          <RotateCwIcon className={runsQuery.isFetching ? "size-3.5 animate-spin" : "size-3.5"} />
          Refresh
        </Button>
      </header>

      {failedRuns.length > 0 ? (
        <div className="flex items-center gap-2 border-rose-500/20 border-b bg-rose-500/8 px-4 py-2 text-rose-700 text-xs dark:text-rose-300">
          <span className="inline-flex items-center gap-1.5 font-medium">
            <AlertTriangleIcon className="size-3.5" />
            {failedRuns.length} failed workflow {failedRuns.length === 1 ? "run" : "runs"}
          </span>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ml-auto h-7 text-rose-700 hover:text-rose-800 dark:text-rose-300 dark:hover:text-rose-200"
            onClick={() => expandRun(failedRuns[0]?.runId ?? null)}
          >
            Show failed jobs
          </Button>
          {failedUrl ? (
            <a
              href={failedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-rose-700 hover:bg-rose-500/10 hover:text-rose-800 dark:text-rose-300 dark:hover:text-rose-200"
            >
              <ExternalLinkIcon className="size-3" />
              Open run
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {runsQuery.isLoading ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Spinner className="size-4" />
            Loading workflow runs…
          </div>
        ) : runsQuery.error ? (
          <WorkflowStateMessage
            tone="error"
            message={errorMessage(runsQuery.error, "Failed to load workflow runs.")}
          />
        ) : runs.length === 0 ? (
          <WorkflowStateMessage
            tone="empty"
            message={
              props.pullRequestNumber
                ? "No GitHub Actions runs were found for this pull request head commit."
                : "No recent GitHub Actions workflow runs were found."
            }
          />
        ) : shouldGroupRuns ? (
          <WorkflowRunGroupList
            groups={runGroups}
            expandedRunId={expandedRunId}
            expandedGroupOverrides={expandedGroupOverrides}
            environmentId={props.environmentId}
            cwd={props.cwd}
            onToggleGroup={(group) => {
              const isExpanded =
                expandedGroupOverrides[group.id] ?? isWorkflowRunGroupDefaultExpanded(group);
              setExpandedGroupOverrides((current) => ({
                ...current,
                [group.id]: !isExpanded,
              }));
            }}
            onToggleRun={(runId) => setExpandedRunId(expandedRunId === runId ? null : runId)}
          />
        ) : (
          <ol className="space-y-2">
            {runs.map((run) => (
              <WorkflowRunListItem
                key={run.runId}
                environmentId={props.environmentId}
                cwd={props.cwd}
                run={run}
                expanded={expandedRunId === run.runId}
                onToggle={() => setExpandedRunId(expandedRunId === run.runId ? null : run.runId)}
              />
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}

function WorkflowRunListItem(props: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  run: SourceControlWorkflowRun;
  expanded: boolean;
  onToggle: () => void;
}) {
  const runStatus = getCheckStatusFromWorkflowRun(props.run);

  return (
    <li
      className={cn(
        "overflow-hidden rounded-lg border border-border/70 bg-muted/12",
        runStatus.kind === "failed" ? "border-rose-500/30" : "",
      )}
    >
      <WorkflowRunRow
        environmentId={props.environmentId}
        cwd={props.cwd}
        run={props.run}
        status={runStatus}
        expanded={props.expanded}
        onToggle={props.onToggle}
      />
      {props.expanded ? (
        <WorkflowRunJobsPanel environmentId={props.environmentId} cwd={props.cwd} run={props.run} />
      ) : null}
    </li>
  );
}

function WorkflowRunGroupList(props: {
  groups: ReadonlyArray<WorkflowRunGroup>;
  expandedRunId: string | null;
  expandedGroupOverrides: Readonly<Record<string, boolean>>;
  environmentId: EnvironmentId | null;
  cwd: string | null;
  onToggleGroup: (group: WorkflowRunGroup) => void;
  onToggleRun: (runId: string) => void;
}) {
  return (
    <ol className="space-y-3">
      {props.groups.map((group) => {
        const status = getPrCheckStatusFromWorkflowRuns({ runs: group.runs });
        const isExpanded =
          props.expandedGroupOverrides[group.id] ?? isWorkflowRunGroupDefaultExpanded(group);

        return (
          <li
            key={group.id}
            className={cn(
              "overflow-hidden rounded-lg border border-border/70 bg-muted/10",
              status.kind === "failed" ? "border-rose-500/30" : "",
              status.kind === "running" || status.kind === "pending" ? "border-amber-500/30" : "",
            )}
          >
            <WorkflowRunGroupHeader
              group={group}
              status={status}
              expanded={isExpanded}
              onToggle={() => props.onToggleGroup(group)}
            />
            {isExpanded ? (
              <ol className="space-y-2 border-border/60 border-t bg-background/35 p-2">
                {group.runs.map((run) => (
                  <WorkflowRunListItem
                    key={run.runId}
                    environmentId={props.environmentId}
                    cwd={props.cwd}
                    run={run}
                    expanded={props.expandedRunId === run.runId}
                    onToggle={() => props.onToggleRun(run.runId)}
                  />
                ))}
              </ol>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function WorkflowRunGroupHeader(props: {
  group: WorkflowRunGroup;
  status: ReturnType<typeof getPrCheckStatusFromWorkflowRuns>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const source = props.group.source;
  const pullRequest = source.kind === "pull-request" ? source.changeRequest : null;
  const branchName =
    source.kind === "pull-request"
      ? (source.branchName ?? source.changeRequest.headRefName)
      : source.kind === "branch"
        ? source.branchName
        : null;
  const title = pullRequest ? `PR #${pullRequest.number}` : (branchName ?? "Unknown branch");
  const subtitle = pullRequest
    ? pullRequest.title
    : branchName
      ? "Branch workflow runs"
      : "Runs without branch metadata";
  const latestTimestamp = formatRunTimestamp(props.group.latestRun);

  return (
    <div className="flex items-start gap-2 px-3 py-2">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-start gap-2 rounded-md text-left outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={props.onToggle}
        aria-expanded={props.expanded}
        aria-label={`${props.expanded ? "Collapse" : "Expand"} ${title}`}
      >
        <ChevronRightIcon
          className={cn(
            "mt-1 size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
            props.expanded ? "rotate-90" : "",
          )}
        />
        {pullRequest ? (
          <GitPullRequestIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        ) : (
          <GitBranchIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium text-sm">{title}</span>
            {branchName ? (
              <span className="min-w-0 truncate font-mono text-muted-foreground text-xs">
                {branchName}
              </span>
            ) : null}
            <span className="rounded-md border border-border/60 px-1.5 py-0.5 text-muted-foreground text-[11px] leading-none">
              {formatRunCount(props.group.runs.length)}
            </span>
          </span>
          <span className="mt-0.5 block truncate text-muted-foreground text-xs">{subtitle}</span>
          <span className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[11px]">
            <MetaItem icon={<GitCommitIcon className="size-3" />}>
              <span className="font-mono">{props.group.latestRun.commit.shortOid}</span>
            </MetaItem>
            {latestTimestamp ? (
              <MetaItem icon={<Clock3Icon className="size-3" />}>{latestTimestamp}</MetaItem>
            ) : null}
          </span>
        </span>
      </button>
      <PrCheckStatusBadge view={props.status} mode="compact" className="mt-0.5" />
      {pullRequest ? (
        <a
          href={pullRequest.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-muted-foreground text-xs hover:bg-secondary hover:text-foreground"
        >
          <ExternalLinkIcon className="size-3.5" />
          PR
        </a>
      ) : null}
    </div>
  );
}

function WorkflowRunRow(props: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  run: SourceControlWorkflowRun;
  status: ReturnType<typeof getCheckStatusFromWorkflowRun>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const conclusion = sourceControlOptionValue(props.run.conclusion);
  const startedAt = formatDate(props.run.startedAt);
  const duration = formatDuration(props.run.durationMs);
  const actor = sourceControlOptionValue(props.run.actor);
  const branch = sourceControlOptionValue(props.run.branch);
  const canRerunFailedJobs = props.status.kind === "failed" && isCompletedStatus(props.run.status);
  const rerun = useWorkflowRerunAction({
    environmentId: props.environmentId,
    cwd: props.cwd,
    runId: props.run.runId,
  });
  const isRerunningFailedJobs = rerun.pendingTarget === "failed-jobs";

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          onClick={props.onToggle}
          aria-expanded={props.expanded}
        >
          <ChevronRightIcon
            className={cn(
              "mt-1 size-3.5 shrink-0 text-muted-foreground/70 transition-transform",
              props.expanded ? "rotate-90" : "",
            )}
          />
          <PrCheckStatusBadge view={props.status} mode="icon" className="mt-0.5 size-6" />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate font-medium text-sm">{props.run.workflowName}</span>
              <StatusPill status={props.run.status} conclusion={conclusion} />
            </span>
            {props.run.displayTitle && props.run.displayTitle !== props.run.workflowName ? (
              <span className="mt-0.5 block truncate text-muted-foreground text-xs">
                {props.run.displayTitle}
              </span>
            ) : null}
            <span className="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1 text-[11px]">
              {branch ? (
                <MetaItem icon={<GitBranchIcon className="size-3" />}>
                  <span className="font-mono">{branch}</span>
                </MetaItem>
              ) : null}
              <MetaItem icon={<GitCommitIcon className="size-3" />}>
                <span className="font-mono">{props.run.commit.shortOid}</span>
              </MetaItem>
              {actor ? <MetaItem icon={<UserIcon className="size-3" />}>{actor}</MetaItem> : null}
              {startedAt ? (
                <MetaItem icon={<Clock3Icon className="size-3" />}>{startedAt}</MetaItem>
              ) : null}
              {duration ? <span className="text-muted-foreground">{duration}</span> : null}
            </span>
          </span>
        </button>
        {canRerunFailedJobs ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isRerunningFailedJobs}
            onClick={() => {
              void rerun.requestRerun(
                { target: "failed-jobs" },
                "Rerun requested for failed jobs. Refreshing workflow status.",
              );
            }}
          >
            <RotateCwIcon
              className={isRerunningFailedJobs ? "size-3.5 animate-spin" : "size-3.5"}
            />
            {isRerunningFailedJobs ? "Rerunning..." : "Rerun failed jobs"}
          </Button>
        ) : null}
        <a
          href={props.run.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-muted-foreground text-xs hover:bg-secondary hover:text-foreground"
        >
          <ExternalLinkIcon className="size-3.5" />
          GitHub
        </a>
      </div>
      {rerun.feedback ? <WorkflowRerunFeedbackMessage feedback={rerun.feedback} compact /> : null}
    </>
  );
}

function WorkflowRunJobsPanel(props: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  run: SourceControlWorkflowRun;
}) {
  const sourceControlRefreshMode = useSettings((settings) => settings.sourceControlRefreshMode);
  const jobsQuery = useSourceControlWorkflowRunJobs(
    {
      environmentId: props.environmentId,
      cwd: props.cwd,
      runId: props.run.runId,
      enabled: true,
    },
    () =>
      resolveSourceControlRefreshDelay({
        mode: sourceControlRefreshMode,
        phase: shouldRefreshPrCheckStatus(getCheckStatusFromWorkflowRun(props.run))
          ? "active"
          : "settled",
      }),
  );

  const jobs = jobsQuery.data?.jobs ?? [];
  const failedJobs = jobs.filter(
    (job) =>
      getCheckStatusFromRaw({
        name: job.name,
        status: job.status,
        conclusion: sourceControlOptionValue(job.conclusion),
        url: sourceControlOptionValue(job.url),
      }).kind === "failed",
  );

  return (
    <div className="border-border/60 border-t bg-background/35 px-3 py-3">
      {jobsQuery.isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <Spinner className="size-3.5" />
          Loading jobs…
        </div>
      ) : jobsQuery.error ? (
        <WorkflowStateMessage
          tone="error"
          message={errorMessage(jobsQuery.error, "Failed to load workflow jobs.")}
          compact
        />
      ) : jobs.length === 0 ? (
        <WorkflowStateMessage
          tone="empty"
          message="No job details are available for this run."
          compact
        />
      ) : (
        <div className="space-y-2">
          {failedJobs.length > 0 ? (
            <div className="rounded-md border border-rose-500/25 bg-rose-500/8 px-2 py-1.5 text-rose-700 text-xs dark:text-rose-300">
              Failed jobs: {failedJobs.map((job) => job.name).join(", ")}
            </div>
          ) : null}
          <ol className="space-y-2">
            {jobs.map((job) => (
              <WorkflowJobItem
                key={job.jobId}
                job={job}
                runId={props.run.runId}
                environmentId={props.environmentId}
                cwd={props.cwd}
              />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function WorkflowJobItem(props: {
  job: SourceControlWorkflowJob;
  runId: string;
  environmentId: EnvironmentId | null;
  cwd: string | null;
}) {
  const [showLog, setShowLog] = useState(false);
  const conclusion = sourceControlOptionValue(props.job.conclusion);
  const startedAt = formatDate(props.job.startedAt);
  const duration = formatDuration(props.job.durationMs);
  const status = getCheckStatusFromRaw({
    name: props.job.name,
    status: props.job.status,
    conclusion,
    url: sourceControlOptionValue(props.job.url),
  });
  const failed = status.kind === "failed";
  const canRerunJob = failed && isCompletedStatus(props.job.status);
  const rerun = useWorkflowRerunAction({
    environmentId: props.environmentId,
    cwd: props.cwd,
    runId: props.runId,
  });
  const jobTargetKey = workflowRerunTargetKey({ target: "job", jobId: props.job.jobId });
  const isRerunningJob = rerun.pendingTarget === jobTargetKey;

  return (
    <li
      className={cn(
        "rounded-md border border-border/60 bg-muted/12",
        failed ? "border-rose-500/30 bg-rose-500/5" : "",
      )}
    >
      <div className="flex flex-wrap items-start gap-2 px-3 py-2">
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate font-medium text-xs">{props.job.name}</span>
            <StatusPill status={props.job.status} conclusion={conclusion} />
            {props.job.url && Option.isSome(props.job.url) ? (
              <a
                href={props.job.url.value}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-muted-foreground text-[11px] hover:text-foreground"
              >
                <ExternalLinkIcon className="size-3" />
                GitHub
              </a>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground text-[11px]">
            {startedAt ? <span>{startedAt}</span> : null}
            {duration ? <span>{duration}</span> : null}
          </div>
        </div>
        {canRerunJob ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={isRerunningJob}
            onClick={() => {
              void rerun.requestRerun(
                { target: "job", jobId: props.job.jobId },
                `Rerun requested for ${props.job.name}. Refreshing workflow status.`,
              );
            }}
          >
            <RotateCwIcon className={isRerunningJob ? "size-3.5 animate-spin" : "size-3.5"} />
            {isRerunningJob ? "Rerunning..." : "Rerun job"}
          </Button>
        ) : null}
        <Button type="button" size="sm" variant="outline" onClick={() => setShowLog((v) => !v)}>
          <FileTextIcon className="size-3.5" />
          {showLog ? "Hide log" : "Load log"}
        </Button>
      </div>
      {rerun.feedback ? <WorkflowRerunFeedbackMessage feedback={rerun.feedback} compact /> : null}
      <WorkflowStepList steps={props.job.steps} />
      {showLog ? (
        <WorkflowJobLog
          environmentId={props.environmentId}
          cwd={props.cwd}
          runId={props.runId}
          jobId={props.job.jobId}
        />
      ) : null}
    </li>
  );
}

function WorkflowStepList({ steps }: { steps: ReadonlyArray<SourceControlWorkflowStep> }) {
  if (steps.length === 0) {
    return (
      <div className="border-border/60 border-t px-3 py-2 text-muted-foreground/70 text-xs">
        No step summaries available.
      </div>
    );
  }

  return (
    <ol className="border-border/60 border-t divide-y divide-border/40">
      {steps.map((step) => {
        const conclusion = sourceControlOptionValue(step.conclusion);
        const duration = formatDuration(step.durationMs);
        return (
          <li
            key={`${step.number}-${step.name}`}
            className="flex items-center gap-2 px-3 py-1.5 text-xs"
          >
            <span className="w-6 shrink-0 font-mono text-muted-foreground text-[10px] tabular-nums">
              {step.number}
            </span>
            <span className="min-w-0 flex-1 truncate">{step.name}</span>
            {duration ? (
              <span className="shrink-0 text-muted-foreground text-[11px]">{duration}</span>
            ) : null}
            <StatusPill status={step.status} conclusion={conclusion} />
          </li>
        );
      })}
    </ol>
  );
}

function WorkflowJobLog(props: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  runId: string;
  jobId: string;
}) {
  const logQuery = useSourceControlWorkflowJobLog({
    environmentId: props.environmentId,
    cwd: props.cwd,
    runId: props.runId,
    jobId: props.jobId,
    enabled: true,
  });

  return (
    <div className="border-border/60 border-t bg-background/60">
      {logQuery.isLoading ? (
        <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-xs">
          <Spinner className="size-3.5" />
          Loading log…
        </div>
      ) : logQuery.error ? (
        <WorkflowStateMessage
          tone="error"
          message={errorMessage(logQuery.error, "Failed to load workflow log.")}
          compact
        />
      ) : logQuery.data && logQuery.data.log.length > 0 ? (
        <>
          {logQuery.data.truncated ? (
            <div className="border-amber-500/20 border-b bg-amber-500/8 px-3 py-1.5 text-amber-700 text-xs dark:text-amber-300">
              Log preview truncated to keep Ryco responsive.
            </div>
          ) : null}
          <pre className="max-h-80 overflow-auto px-3 py-2 font-mono text-[11px] leading-snug">
            {logQuery.data.log}
          </pre>
        </>
      ) : (
        <WorkflowStateMessage tone="empty" message="No log output returned for this job." compact />
      )}
    </div>
  );
}

function WorkflowRerunFeedbackMessage(props: {
  feedback: WorkflowRerunFeedback;
  compact?: boolean;
}) {
  const success = props.feedback.tone === "success";
  const notRerunnable = props.feedback.tone === "not-rerunnable";
  const permissionDenied = props.feedback.tone === "permission-denied";

  return (
    <div
      role={success ? "status" : "alert"}
      className={cn(
        "mx-3 mb-2 flex items-start gap-2 rounded-md border px-2",
        props.compact ? "py-1.5 text-xs" : "py-2 text-sm",
        success
          ? "border-emerald-500/25 bg-emerald-500/8 text-emerald-700 dark:text-emerald-300"
          : notRerunnable || permissionDenied
            ? "border-amber-500/25 bg-amber-500/8 text-amber-700 dark:text-amber-300"
            : "border-destructive/25 bg-destructive/8 text-destructive",
      )}
    >
      {success ? (
        <CheckCircle2Icon className="mt-0.5 size-3.5 shrink-0" />
      ) : (
        <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
      )}
      <span>{props.feedback.message}</span>
    </div>
  );
}

function WorkflowStateMessage(props: {
  tone: "empty" | "error";
  message: string;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-3 text-sm",
        props.compact ? "py-2 text-xs" : "py-4",
        props.tone === "error"
          ? "border-destructive/25 bg-destructive/8 text-destructive"
          : "border-border/70 bg-muted/20 text-muted-foreground",
      )}
    >
      {props.message}
    </div>
  );
}
