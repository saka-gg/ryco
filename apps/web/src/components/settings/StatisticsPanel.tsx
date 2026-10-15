import { useMemo, useState } from "react";
import {
  ActivityIcon,
  BarChart3Icon,
  ClockIcon,
  CpuIcon,
  DollarSignIcon,
  FileDiffIcon,
  GitBranchIcon,
  LayersIcon,
  MessagesSquareIcon,
  PieChartIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { Button } from "../ui/button";
import { chartColor } from "../ui/chart";
import { formatUsd } from "~/lib/modelPricing";
import {
  formatDuration,
  formatInteger,
  formatModelLabel,
  formatProviderLabel,
  formatTimestamp,
  formatTokens,
} from "~/lib/statisticsFormat";
import { SettingsPageContainer } from "./settingsLayout";
import { ActivityHeatmap } from "./statistics/ActivityHeatmap";
import {
  CodeChangesChart,
  ProjectBars,
  ProviderDonut,
  TokensOverTimeChart,
} from "./statistics/charts";
import { ModelLeaderboard } from "./statistics/ModelLeaderboard";
import { Panel, StaleSnapshotNotice, StatCard, StatePanel, StatSkeleton } from "./statistics/parts";
import { StatFilters } from "./statistics/StatFilters";
import {
  aggregateByModel,
  aggregateByProject,
  aggregateByProvider,
  aggregateCostForModels,
  buildProjectTitleMap,
  buildTimeSeries,
  filterBuckets,
  percentChange,
  previousTotals,
  type StatFilter,
  sumTotals,
} from "./statistics/selectors";
import { useStatistics } from "./statistics/useStatistics";

export function StatisticsPanel() {
  const { snapshot, loading, error, refresh, refreshing } = useStatistics();
  const [filter, setFilter] = useState<StatFilter>({
    range: "30d",
    projectId: null,
    model: null,
    provider: null,
  });

  const derived = useMemo(() => {
    if (!snapshot) {
      return null;
    }
    const filtered = filterBuckets(snapshot, filter);
    const projectTitle = buildProjectTitleMap(snapshot);
    const models = aggregateByModel(filtered);
    const totalsAllModels = models.reduce((acc, entry) => acc + entry.totalTokens, 0);
    return {
      totals: sumTotals(filtered),
      previous: previousTotals(snapshot, filter),
      models,
      totalsAllModels,
      providers: aggregateByProvider(filtered),
      projects: aggregateByProject(filtered, projectTitle),
      series: buildTimeSeries(snapshot, filtered, filter.range),
      cost: aggregateCostForModels(models),
    };
  }, [snapshot, filter]);

  if (loading && !snapshot) {
    return (
      <SettingsPageContainer>
        <StatSkeleton />
      </SettingsPageContainer>
    );
  }

  if (error && !snapshot) {
    return (
      <SettingsPageContainer>
        <StatePanel
          icon={TriangleAlertIcon}
          title="Couldn’t load statistics"
          description={error}
          action={
            <Button size="sm" variant="outline" onClick={refresh}>
              <RefreshCwIcon /> Try again
            </Button>
          }
        />
      </SettingsPageContainer>
    );
  }

  if (!snapshot || !derived) {
    return null;
  }

  const hasAnyData = snapshot.dailyBuckets.length > 0;
  const { totals, previous, models, totalsAllModels, providers, projects, series, cost } = derived;
  const topModel = models[0];
  const topModelShare =
    topModel && totalsAllModels > 0
      ? Math.round((topModel.totalTokens / totalsAllModels) * 100)
      : 0;
  const tokenSpark = series.map((point) => point.totalTokens);
  const activeSpark = series.map((point) => point.activeMs);
  const uncategorizedTokens = Math.max(
    0,
    totals.totalTokens - totals.inputTokens - totals.outputTokens,
  );
  const tokenSubtitle =
    uncategorizedTokens > 0
      ? `${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out · ${formatTokens(uncategorizedTokens)} other`
      : `${formatTokens(totals.inputTokens)} in · ${formatTokens(totals.outputTokens)} out`;
  const hasUncategorizedSeries = series.some((point) => point.uncategorizedTokens > 0);
  const attributionNote =
    snapshot.tokenAttribution === "thread-cumulative"
      ? "Token figures use cumulative thread snapshots when providers or older sessions do not expose per-turn deltas."
      : snapshot.tokenAttribution === "mixed"
        ? "Token figures combine exact per-turn deltas where available with cumulative snapshots for older or provider-limited sessions."
        : "Token figures use exact per-turn deltas where providers report them.";

  return (
    <SettingsPageContainer>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-0.5">
            <h1 className="font-semibold text-foreground text-lg">Statistics</h1>
            <p className="text-muted-foreground text-xs">
              Usage across your projects · as of {formatTimestamp(snapshot.generatedAt)}
            </p>
          </div>
          <Button
            size="xs"
            variant="outline"
            onClick={refresh}
            disabled={refreshing}
            aria-label="Refresh statistics"
          >
            <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
            Refresh
          </Button>
        </div>
        <StatFilters
          filter={filter}
          onChange={setFilter}
          projects={snapshot.projects}
          models={snapshot.models}
        />
        {error ? <StaleSnapshotNotice generatedAt={snapshot.generatedAt} error={error} /> : null}
      </div>

      {!hasAnyData ? (
        <StatePanel
          icon={BarChart3Icon}
          title="No activity yet"
          description="Once you start chatting with agents, your token usage, models, and code changes will show up here."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatCard
              label="Total tokens"
              icon={CpuIcon}
              value={formatTokens(totals.totalTokens)}
              sub={tokenSubtitle}
              delta={percentChange(totals.totalTokens, previous?.totalTokens)}
              sparkline={tokenSpark}
            />
            <StatCard
              label="Est. cost"
              icon={DollarSignIcon}
              value={`~${formatUsd(cost.usd)}`}
              sub={cost.hasUnpriced ? "excludes unpriced models" : "estimated spend"}
            />
            <StatCard
              label="Most used model"
              icon={LayersIcon}
              value={
                <span
                  className="block max-w-full truncate text-lg"
                  title={topModel ? formatModelLabel(topModel.model) : undefined}
                >
                  {topModel ? formatModelLabel(topModel.model) : "—"}
                </span>
              }
              sub={
                topModel
                  ? `${formatProviderLabel(topModel.provider)} · ${topModelShare}% of tokens`
                  : "no usage in range"
              }
            />
            <StatCard
              label="Chats"
              icon={MessagesSquareIcon}
              value={formatInteger(totals.threadsCreated)}
              sub="threads started"
              delta={percentChange(totals.threadsCreated, previous?.threadsCreated)}
            />
            <StatCard
              label="Active time"
              icon={ClockIcon}
              value={formatDuration(totals.activeMs)}
              sub={`${formatInteger(totals.turns)} turns`}
              delta={percentChange(totals.activeMs, previous?.activeMs)}
              sparkline={activeSpark}
            />
          </div>

          <Panel title="Token usage over time" icon={BarChart3Icon} bodyClassName="p-4">
            <TokensOverTimeChart data={series} />
            <div className="mt-2 flex items-center gap-4 px-1 text-[11px] text-muted-foreground">
              <LegendDot colorIndex={0} label="Input" />
              <LegendDot colorIndex={1} label="Output" />
              {hasUncategorizedSeries ? <LegendDot colorIndex={2} label="Other" /> : null}
            </div>
          </Panel>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel
              title="Models"
              icon={LayersIcon}
              bodyClassName="overflow-hidden"
              action={
                <span className="text-[11px] text-muted-foreground">{models.length} total</span>
              }
            >
              <ModelLeaderboard models={models} />
            </Panel>
            <Panel title="Tokens by provider" icon={PieChartIcon} bodyClassName="p-4">
              <ProviderDonut data={providers} />
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Tokens by project" icon={BarChart3Icon} bodyClassName="p-4">
              <ProjectBars data={projects} />
            </Panel>
            <Panel title="Activity" icon={ActivityIcon} bodyClassName="p-4">
              <ActivityHeatmap points={series} metric="turns" />
              <p className="mt-3 text-[11px] text-muted-foreground">Turns per day</p>
            </Panel>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="Code changes" icon={FileDiffIcon} bodyClassName="p-4">
              <div className="mb-3 flex items-center gap-4 text-sm">
                <Metric label="Files" value={formatInteger(totals.filesChanged)} />
                <Metric
                  label="Added"
                  value={`+${formatInteger(totals.additions)}`}
                  tone="success"
                />
                <Metric
                  label="Removed"
                  value={`−${formatInteger(totals.deletions)}`}
                  tone="destructive"
                />
              </div>
              <CodeChangesChart data={series} />
            </Panel>
            <Panel title="Source control" icon={GitBranchIcon} bodyClassName="p-4">
              <div className="grid grid-cols-2 gap-3">
                <Metric label="Worktrees" value={formatInteger(snapshot.worktrees.created)} />
                <Metric label="Active" value={formatInteger(snapshot.worktrees.active)} />
                <Metric label="Open PRs" value={formatInteger(snapshot.worktrees.openPrs)} />
                <Metric label="Tool uses" value={formatInteger(totals.toolUses)} />
              </div>
              {totals.commits + totals.pushes > 0 ? (
                <div className="mt-3 grid grid-cols-2 gap-3 border-border/60 border-t pt-3">
                  <Metric label="Commits" value={formatInteger(totals.commits)} />
                  <Metric label="Pushes" value={formatInteger(totals.pushes)} />
                </div>
              ) : (
                <p className="mt-3 border-border/60 border-t pt-3 text-[11px] text-muted-foreground">
                  Commit & push counts aren’t recorded yet.
                </p>
              )}
            </Panel>
          </div>

          <p className="px-1 text-[11px] text-muted-foreground/80">
            {attributionNote} Costs are rough estimates from a built-in price table and exclude
            subscription-billed or breakdown-less usage.
          </p>
        </>
      )}
    </SettingsPageContainer>
  );
}

function LegendDot({ colorIndex, label }: { colorIndex: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className="size-2.5 rounded-[3px]"
        style={{ backgroundColor: chartColor(colorIndex) }}
      />
      {label}
    </span>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "success" | "destructive";
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground uppercase tracking-[0.06em]">{label}</span>
      <span
        className={
          tone === "success"
            ? "font-semibold text-base text-success-foreground tabular-nums"
            : tone === "destructive"
              ? "font-semibold text-base text-destructive tabular-nums"
              : "font-semibold text-base text-foreground tabular-nums"
        }
      >
        {value}
      </span>
    </div>
  );
}
