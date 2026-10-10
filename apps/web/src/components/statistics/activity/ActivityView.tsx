import {
  ActivityIcon,
  Clock3Icon,
  FileDiffIcon,
  GitPullRequestIcon,
  MessagesSquareIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { useMemo } from "react";

import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { getPrimaryKnownEnvironment } from "~/environments/primary";
import {
  formatDuration,
  formatInteger,
  formatTimestamp,
  formatTokens,
} from "~/lib/statisticsFormat";
import { cn } from "~/lib/utils";

import { ActivityHeatmap } from "../../settings/statistics/ActivityHeatmap";
import { CodeChangesChart, ProjectBars } from "../../settings/statistics/charts";
import { Panel, StatePanel, StatCard, StatSkeleton } from "../../settings/statistics/parts";
import { StatFilters } from "../../settings/statistics/StatFilters";
import {
  aggregateByProject,
  buildProjectTitleMap,
  buildTimeSeries,
  filterBuckets,
  sumTotals,
  type StatFilter,
  type DayPoint,
} from "../../settings/statistics/selectors";
import { useStatistics } from "../../settings/statistics/useStatistics";
import type { StatisticsSearch } from "../statisticsSearch";

export function ActivityView({
  search,
  onSearchChange,
}: {
  readonly search: StatisticsSearch;
  readonly onSearchChange: (next: StatisticsSearch) => void;
}) {
  const { snapshot, loading, error, refresh, refreshing } = useStatistics();
  const filter = useMemo<StatFilter>(
    () => ({
      range: search.range,
      projectId: search.projectId ?? null,
      model: search.model ?? null,
      provider: search.modelProvider ?? null,
    }),
    [search.model, search.modelProvider, search.projectId, search.range],
  );
  const derived = useMemo(() => {
    if (!snapshot) return null;
    const buckets = filterBuckets(snapshot, filter);
    const totals = sumTotals(buckets);
    return {
      buckets,
      totals,
      days: buildTimeSeries(snapshot, buckets, filter.range),
      projects: aggregateByProject(buckets, buildProjectTitleMap(snapshot)),
    };
  }, [filter, snapshot]);

  if (loading && !snapshot) return <StatSkeleton />;
  if (error && !snapshot) {
    return (
      <StatePanel
        icon={TriangleAlertIcon}
        title="Couldn’t load Ryco activity"
        description={error}
        action={
          <Button size="sm" variant="outline" onClick={refresh}>
            <RefreshCwIcon /> Try again
          </Button>
        }
      />
    );
  }
  if (!snapshot || !derived) return null;

  const { totals, days, projects } = derived;
  const environmentLabel = getPrimaryKnownEnvironment()?.label ?? "Current environment";
  const activitySummary = summarizeActivity(days, search.activityMetric);
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StatFilters
          filter={filter}
          projects={snapshot.projects}
          models={snapshot.models}
          onChange={(next) =>
            onSearchChange({
              ...search,
              range: next.range,
              projectId: next.projectId ?? undefined,
              model: next.model ?? undefined,
              modelProvider: next.provider ?? undefined,
            })
          }
        />
        <Button size="sm" variant="outline" onClick={refresh} disabled={refreshing}>
          <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
          {refreshing ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      <p className="max-w-4xl text-sm leading-relaxed text-muted-foreground">
        Activity includes work observed by Ryco on{" "}
        <span className="font-medium text-foreground">{environmentLabel}</span>. Usage from other
        CLI sessions appears in the Usage tab and is not assigned to projects.
      </p>

      {snapshot.dailyBuckets.length === 0 ? (
        <StatePanel
          icon={ActivityIcon}
          title="No Ryco activity yet"
          description="Project and agent activity will appear here after your first completed turns."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
            <StatCard
              label="Active time"
              icon={Clock3Icon}
              value={formatDuration(totals.activeMs)}
              sub={`${formatTokens(totals.totalTokens)} observed tokens`}
            />
            <StatCard
              label="Turns"
              icon={ActivityIcon}
              value={formatInteger(totals.turns)}
              sub="Completed agent turns"
            />
            <StatCard
              label="Chats"
              icon={MessagesSquareIcon}
              value={formatInteger(totals.threadsCreated)}
              sub="Conversations started"
            />
            <StatCard
              label="Tool uses"
              icon={WrenchIcon}
              value={formatInteger(totals.toolUses)}
              sub="Observed invocations"
            />
            <StatCard
              label="Files changed"
              icon={FileDiffIcon}
              value={formatInteger(totals.filesChanged)}
              sub={`+${formatInteger(totals.additions)} / −${formatInteger(totals.deletions)} lines`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <Panel
              title="Activity rhythm"
              icon={ActivityIcon}
              bodyClassName="p-5"
              action={<ActivityMetricControl search={search} onSearchChange={onSearchChange} />}
            >
              <ActivityHeatmap points={days} metric={search.activityMetric} />
              <div className="mt-5 grid grid-cols-3 gap-3 border-t border-border/60 pt-4">
                <MiniMetric label="Active days" value={formatInteger(activitySummary.activeDays)} />
                <MiniMetric
                  label="Current streak"
                  value={`${formatInteger(activitySummary.currentStreak)}d`}
                />
                <MiniMetric label="Busiest UTC day" value={activitySummary.busiestLabel} />
              </div>
            </Panel>
            <Panel title="Projects" icon={ActivityIcon} bodyClassName="p-4">
              <ProjectBars data={projects} metric={search.activityMetric} />
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Code changes" icon={FileDiffIcon} bodyClassName="p-4">
              <div className="mb-4 flex gap-6 text-sm">
                <MiniMetric label="Files" value={formatInteger(totals.filesChanged)} />
                <MiniMetric
                  label="Added"
                  value={`+${formatInteger(totals.additions)}`}
                  tone="positive"
                />
                <MiniMetric
                  label="Removed"
                  value={`−${formatInteger(totals.deletions)}`}
                  tone="negative"
                />
              </div>
              <CodeChangesChart data={days} />
            </Panel>
            <Panel
              title="Source control · all time"
              icon={GitPullRequestIcon}
              bodyClassName="overflow-hidden"
            >
              <div className="grid grid-cols-4 gap-3 border-b border-border/60 px-4 py-4">
                <MiniMetric label="Active" value={formatInteger(snapshot.worktrees.active)} />
                <MiniMetric label="Created" value={formatInteger(snapshot.worktrees.created)} />
                <MiniMetric label="Archived" value={formatInteger(snapshot.worktrees.archived)} />
                <MiniMetric label="Open PRs" value={formatInteger(snapshot.worktrees.openPrs)} />
              </div>
              {snapshot.recentPullRequests.length === 0 ? (
                <div className="flex h-[260px] items-center justify-center px-6 text-center text-xs text-muted-foreground">
                  No projected pull requests yet.
                </div>
              ) : (
                <div className="divide-y divide-border/60">
                  {snapshot.recentPullRequests.slice(0, 6).map((pullRequest) => (
                    <div
                      key={`${pullRequest.worktreeId}:${pullRequest.prNumber}`}
                      className="flex items-center gap-3 px-4 py-3.5"
                    >
                      <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        <GitPullRequestIcon className="size-4" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {pullRequest.prTitle || pullRequest.worktreeTitle || pullRequest.branch}
                        </p>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {pullRequest.projectTitle} · #{pullRequest.prNumber} ·{" "}
                          {formatTimestamp(pullRequest.updatedAt)}
                        </p>
                      </div>
                      <Badge
                        variant={
                          pullRequest.prState === "merged"
                            ? "success"
                            : pullRequest.active
                              ? "info"
                              : "secondary"
                        }
                      >
                        {pullRequest.prIsDraft
                          ? "Draft"
                          : (pullRequest.prState ?? (pullRequest.active ? "Open" : "Archived"))}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </>
      )}
    </div>
  );
}

function activityValue(point: DayPoint, metric: StatisticsSearch["activityMetric"]): number {
  return metric === "turns"
    ? point.turns
    : metric === "activeMs"
      ? point.activeMs
      : point.filesChanged;
}

function summarizeActivity(
  days: readonly DayPoint[],
  metric: StatisticsSearch["activityMetric"],
): { readonly activeDays: number; readonly currentStreak: number; readonly busiestLabel: string } {
  let activeDays = 0;
  let currentStreak = 0;
  let busiest: DayPoint | null = null;
  for (const day of days) {
    const value = activityValue(day, metric);
    if (value > 0) activeDays += 1;
    if (busiest === null || value > activityValue(busiest, metric)) busiest = day;
  }
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const day = days[index];
    if (day === undefined || activityValue(day, metric) <= 0) break;
    currentStreak += 1;
  }
  if (busiest === null || activityValue(busiest, metric) <= 0) {
    return { activeDays, currentStreak, busiestLabel: "—" };
  }
  const value = activityValue(busiest, metric);
  const formattedValue = metric === "activeMs" ? formatDuration(value) : formatInteger(value);
  return {
    activeDays,
    currentStreak,
    busiestLabel: `${busiest.date.slice(5)} · ${formattedValue}`,
  };
}

function ActivityMetricControl({
  search,
  onSearchChange,
}: {
  readonly search: StatisticsSearch;
  readonly onSearchChange: (next: StatisticsSearch) => void;
}) {
  return (
    <div className="inline-flex rounded-md bg-muted p-0.5">
      {(["turns", "activeMs", "files"] as const).map((metric) => (
        <button
          key={metric}
          type="button"
          onClick={() => onSearchChange({ ...search, activityMetric: metric })}
          className={cn(
            "h-6 rounded-sm px-2 text-[11px]",
            search.activityMetric === metric
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground",
          )}
        >
          {metric === "activeMs" ? "Time" : metric === "files" ? "Files" : "Turns"}
        </button>
      ))}
    </div>
  );
}

function MiniMetric({
  label,
  value,
  tone,
}: {
  readonly label: string;
  readonly value: string;
  readonly tone?: "positive" | "negative";
}) {
  return (
    <div>
      <p className="text-[10px] tracking-[0.08em] text-muted-foreground uppercase">{label}</p>
      <p
        className={cn(
          "mt-1 font-semibold tabular-nums",
          tone === "positive"
            ? "text-success-foreground"
            : tone === "negative"
              ? "text-destructive"
              : "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  );
}
