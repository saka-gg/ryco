import type { StatisticsProjectRef, StatisticsSnapshot } from "@ryco/contracts";
import { formatBytes } from "@ryco/shared/byteSize";
import {
  ActivityIcon,
  AlertCircleIcon,
  CircleDollarSignIcon,
  Clock3Icon,
  FileDiffIcon,
  FolderIcon,
  GitPullRequestIcon,
  InfoIcon,
  MessagesSquareIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { requestSettingsReveal } from "~/components/settings/settingsSearchReveal";
import { STATISTICS_OUTSIDE_SESSIONS_TITLE } from "~/components/settings/statisticsOutsideSessionsTitle";
import { Button } from "~/components/ui/button";
import { Badge } from "~/components/ui/badge";
import { chartColor } from "~/components/ui/chart";
import { getPrimaryKnownEnvironment, usePrimaryEnvironmentId } from "~/environments/primary";
import {
  formatCost,
  formatDuration,
  formatInteger,
  formatModelLabel,
  formatProviderLabel,
  formatTimestamp,
  formatTokens,
} from "~/lib/statisticsFormat";
import { cn } from "~/lib/utils";
import { useServerConfigSelector } from "~/rpc/serverState";
import { useSettingsDialogStore } from "~/settingsDialogStore";

import { ActivityHeatmap } from "../../settings/statistics/ActivityHeatmap";
import { CodeChangesChart, ProjectBars } from "../charts";
import {
  Panel,
  StaleSnapshotNotice,
  StatePanel,
  StatCard,
  StatSkeleton,
} from "../../settings/statistics/parts";
import { StatFilters } from "../../settings/statistics/StatFilters";
import {
  aggregateByProject,
  aggregateTokenCostByOrigin,
  aggregateTokenCostRows,
  buildProjectTitleMap,
  buildTimeSeries,
  filterBuckets,
  sumTotals,
  type StatFilter,
  type DayPoint,
  type TokenCost,
  type TokenCostByOrigin,
  type TokenCostDimension,
  type TokenCostRow,
} from "../../settings/statistics/selectors";
import { useStatistics } from "../../settings/statistics/useStatistics";
import type { ActivityScope, StatisticsSearch } from "../statisticsSearch";

/** Ryco's usage (its threads and their subagents) and usage outside Ryco, in every chart of the split. */
const ORIGIN_COLORS = { ryco: chartColor(0), outside: chartColor(1) } as const;
/** Rows the tokens-and-cost breakdown lists before it sums up the rest. */
const BREAKDOWN_ROW_LIMIT = 8;

export function ActivityView({
  search,
  onSearchChange,
}: {
  readonly search: StatisticsSearch;
  readonly onSearchChange: (next: StatisticsSearch) => void;
}) {
  const scope = search.scope;
  const { snapshot, loading, error, refresh, refreshing } = useStatistics(scope);
  const machineScopeSupported = useServerConfigSelector(
    (config) => config?.environment.capabilities.statisticsMachineScope === true,
  );
  // Also shown while the address asks for the machine on a node without it, so the reader can
  // go back to Ryco's threads.
  const scopeControl =
    machineScopeSupported || scope === "machine" ? (
      <ScopeControl scope={scope} onChange={(next) => onSearchChange({ ...search, scope: next })} />
    ) : null;
  const [dimension, setDimension] = useState<TokenCostDimension>("model");
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
      // Sessions outside Ryco add tokens only: a folder they ran in has no turns, time or files.
      projects: aggregateByProject(buckets, buildProjectTitleMap(snapshot)).filter(
        (project) => project.turns > 0 || project.activeMs > 0 || project.filesChanged > 0,
      ),
      tokenCost: aggregateTokenCostByOrigin(buckets),
    };
  }, [filter, snapshot]);
  const breakdownRows = useMemo(
    () => (derived ? aggregateTokenCostRows(derived.buckets, dimension) : []),
    [derived, dimension],
  );

  if (loading && !snapshot) {
    return (
      <div className="space-y-8">
        {scopeControl}
        <StatSkeleton />
      </div>
    );
  }
  if (error && !snapshot) {
    return (
      <div className="space-y-8">
        {scopeControl}
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
      </div>
    );
  }
  if (!snapshot || !derived) return null;

  const { totals, days, projects } = derived;
  const environmentLabel = getPrimaryKnownEnvironment()?.label ?? "Current environment";
  const activitySummary = summarizeActivity(days, search.activityMetric);
  // A node without the machine scope ignores the request and answers for Ryco's threads.
  const machineAnswered = scope === "machine" && snapshot.scope === "machine";
  const machine = machineAnswered ? snapshot.machine : undefined;
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {scopeControl}
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
        </div>
        <Button size="sm" variant="outline" onClick={refresh} disabled={refreshing}>
          <RefreshCwIcon className={refreshing ? "animate-spin" : undefined} />
          {refreshing ? "Refreshing" : "Refresh"}
        </Button>
      </div>

      {error ? <StaleSnapshotNotice generatedAt={snapshot.generatedAt} error={error} /> : null}
      {scope === "machine" ? (
        <MachineScopeStatus machine={machine} answered={machineAnswered} />
      ) : null}

      <p className="max-w-4xl text-sm leading-relaxed text-muted-foreground">
        {scope === "machine" ? (
          <>
            Activity includes work observed by Ryco on{" "}
            <span className="font-medium text-foreground">{environmentLabel}</span>, and Claude Code
            and Codex sessions run on this machine outside Ryco, read from their session files.
            Those sessions add tokens and cost only. Ryco’s subagents are counted from the same
            files, because Ryco’s own records only count the main session.
          </>
        ) : (
          <>
            Activity includes work observed by Ryco on{" "}
            <span className="font-medium text-foreground">{environmentLabel}</span>.{" "}
            {machineScopeSupported
              ? "Choose This machine to also count Claude Code and Codex sessions run outside Ryco."
              : "Usage from other CLI sessions appears in the Usage tab and is not assigned to projects."}
          </>
        )}
      </p>

      {snapshot.dailyBuckets.length === 0 ? (
        <StatePanel
          icon={ActivityIcon}
          title={scope === "machine" ? "No activity yet" : "No Ryco activity yet"}
          description={
            scope === "machine"
              ? "Ryco’s threads and this machine’s Claude Code and Codex sessions will appear here."
              : "Project and agent activity will appear here after your first completed turns."
          }
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

          <div className="space-y-2">
            <TokenCostPanel
              split={derived.tokenCost}
              rows={breakdownRows}
              dimension={dimension}
              onDimensionChange={setDimension}
              showOrigins={machineAnswered}
              projects={snapshot.projects}
            />
            {machine ? <MachineReadSummary machine={machine} /> : null}
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

function ScopeControl({
  scope,
  onChange,
}: {
  readonly scope: ActivityScope;
  readonly onChange: (next: ActivityScope) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Sessions to count"
      className="inline-flex items-center rounded-lg border bg-card p-0.5 not-dark:bg-clip-padding"
    >
      {(["ryco", "machine"] as const).map((value) => {
        const active = scope === value;
        return (
          <button
            key={value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(value)}
            className={cn(
              "h-7 rounded-md px-2.5 font-medium text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {value === "ryco" ? "Ryco" : "This machine"}
          </button>
        );
      })}
    </div>
  );
}

type MachineUsage = NonNullable<StatisticsSnapshot["machine"]>;

/** How the node's read of the session files outside Ryco stands, when it needs a word. */
function MachineScopeStatus({
  machine,
  answered,
}: {
  readonly machine: MachineUsage | undefined;
  readonly answered: boolean;
}) {
  const environmentId = usePrimaryEnvironmentId();
  if (!answered) {
    return (
      <Notice tone="warning">Update Ryco on this node to include sessions outside Ryco.</Notice>
    );
  }
  switch (machine?.state) {
    case "reading":
      return <MachineReadProgress progress={machine.progress} />;
    case "disabled":
      return (
        <Notice
          tone="info"
          action={
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                useSettingsDialogStore.getState().openSettings("usage", environmentId);
                requestSettingsReveal(STATISTICS_OUTSIDE_SESSIONS_TITLE);
              }}
            >
              Open settings
            </Button>
          }
        >
          Counting sessions outside Ryco is turned off on this node.
        </Notice>
      );
    case "failed":
      return (
        <Notice tone="warning">
          Sessions outside Ryco couldn’t be read on this node. Ryco’s own activity is still shown.
        </Notice>
      );
    default:
      return null;
  }
}

function Notice({
  tone,
  action,
  children,
}: {
  readonly tone: "info" | "warning";
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  const Icon = tone === "warning" ? AlertCircleIcon : InfoIcon;
  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border px-3 py-2.5 text-xs text-muted-foreground",
        tone === "warning" ? "border-warning/30 bg-warning/8" : "border-border/70 bg-muted/30",
      )}
    >
      <span className="flex min-w-0 flex-1 gap-2">
        <Icon
          className={cn(
            "mt-0.5 size-3.5 shrink-0",
            tone === "warning" ? "text-warning" : undefined,
          )}
        />
        <span>{children}</span>
      </span>
      {action}
    </div>
  );
}

/** A slim line while the node reads the session files; the earlier data stays on screen. */
function MachineReadProgress({ progress }: { readonly progress: MachineUsage["progress"] }) {
  const fraction =
    progress === undefined
      ? null
      : progress.totalBytes > 0
        ? progress.readBytes / progress.totalBytes
        : progress.fileCount > 0
          ? progress.readFileCount / progress.fileCount
          : null;
  const percent = fraction === null ? null : Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div className="space-y-2" aria-live="polite">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Reading Claude Code and Codex sessions on this machine…</span>
        {progress === undefined ? null : (
          <span className="tabular-nums">
            {formatInteger(progress.readFileCount)} of {formatInteger(progress.fileCount)} files ·{" "}
            {formatBytes(progress.readBytes)} of {formatBytes(progress.totalBytes)}
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label="Reading session files"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full bg-primary/60 transition-[width] duration-500 ease-out",
            percent === null && "w-full animate-pulse bg-primary/25",
          )}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** "Read N files (X GB) · at <time>", with the read's problems when there were any. */
function MachineReadSummary({ machine }: { readonly machine: MachineUsage }) {
  if (machine.readAt === undefined) return null;
  const parts = [
    `Read ${plural(machine.fileCount, "session file")} (${formatBytes(machine.totalBytes)})`,
    `at ${formatTimestamp(machine.readAt)}`,
    machine.malformedLineCount > 0 ? `${plural(machine.malformedLineCount, "line")} skipped` : null,
    machine.failedFileCount > 0 ? `${plural(machine.failedFileCount, "file")} unreadable` : null,
    machine.unreadableDirectoryCount > 0
      ? `${plural(machine.unreadableDirectoryCount, "folder")} unreadable`
      : null,
  ].filter((part) => part !== null);
  return <p className="px-1 text-[11px] text-muted-foreground">{parts.join(" · ")}</p>;
}

function plural(count: number, noun: string): string {
  return `${formatInteger(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** A share of a whole, e.g. "42%", "<1%" for a sliver. */
function formatShare(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  const share = (part / whole) * 100;
  return share < 1 ? "<1%" : `${Math.round(share)}%`;
}

/** The node-priced cost, or "Unavailable" when nothing of it had a price. */
function costLabel(usage: TokenCost): string {
  return formatCost(usage.cost.priced ? usage.cost.usd : null);
}

function TokenCostPanel({
  split,
  rows,
  dimension,
  onDimensionChange,
  showOrigins,
  projects,
}: {
  readonly split: TokenCostByOrigin;
  readonly rows: readonly TokenCostRow[];
  readonly dimension: TokenCostDimension;
  readonly onDimensionChange: (next: TokenCostDimension) => void;
  /** Machine scope: split Ryco's usage from usage outside Ryco. */
  readonly showOrigins: boolean;
  readonly projects: readonly StatisticsProjectRef[];
}) {
  const { all } = split;
  const maxRowTokens = rows.reduce((max, row) => Math.max(max, row.totalTokens), 0);
  const hidden = rows.slice(BREAKDOWN_ROW_LIMIT);
  return (
    <Panel
      title="Tokens and cost"
      icon={CircleDollarSignIcon}
      action={<DimensionToggle dimension={dimension} onChange={onDimensionChange} />}
      bodyClassName="grid overflow-hidden lg:grid-cols-[minmax(16rem,0.75fr)_minmax(0,1.5fr)]"
    >
      <div className="flex flex-col gap-5 border-b border-border/60 p-5 lg:border-r lg:border-b-0">
        <div>
          <p className="text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
            Estimated cost
          </p>
          <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
            {costLabel(all)}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            At published API rates. Subscriptions and provider billing may differ.
          </p>
        </div>
        <div className="space-y-2 border-t border-border/60 pt-4 text-xs">
          <div className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">Total tokens</span>
            <span className="font-medium tabular-nums">{formatInteger(all.totalTokens)}</span>
          </div>
          {all.cost.unpricedTokens > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {formatTokens(all.cost.unpricedTokens)} tokens without a price
            </p>
          ) : null}
        </div>
        {showOrigins ? <OriginSplit split={split} /> : null}
      </div>
      <div className="min-w-0">
        {rows.length === 0 ? (
          <div className="flex h-full min-h-40 items-center justify-center px-6 text-center text-xs text-muted-foreground">
            No token usage in this range.
          </div>
        ) : (
          <ul aria-label={`Tokens and cost by ${dimension}`} className="divide-y divide-border/60">
            {rows.slice(0, BREAKDOWN_ROW_LIMIT).map((row) => (
              <TokenCostRowView
                key={row.key}
                row={row}
                dimension={dimension}
                total={all.totalTokens}
                maxTokens={maxRowTokens}
                showOrigins={showOrigins}
                projects={projects}
              />
            ))}
            {hidden.length > 0 ? (
              <li className="px-4 py-2.5 text-[11px] text-muted-foreground sm:px-5">
                {plural(hidden.length, `more ${dimension}`)} ·{" "}
                {formatTokens(hidden.reduce((sum, row) => sum + row.totalTokens, 0))} tokens
              </li>
            ) : null}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function OriginSplit({ split }: { readonly split: TokenCostByOrigin }) {
  const total = split.all.totalTokens;
  const origins = [
    { key: "ryco", label: "Ryco", usage: split.ryco },
    { key: "outside", label: "Outside Ryco", usage: split.outside },
  ] as const;
  return (
    <div className="space-y-3 border-t border-border/60 pt-4">
      <div aria-hidden className="flex h-2 gap-px overflow-hidden rounded-full bg-muted">
        {total > 0
          ? origins.map((origin) =>
              origin.usage.totalTokens > 0 ? (
                // Grow from a zero basis: the shares split what the 1px gap leaves.
                <div
                  key={origin.key}
                  className="h-full basis-0"
                  style={{
                    flexGrow: origin.usage.totalTokens / total,
                    backgroundColor: ORIGIN_COLORS[origin.key],
                  }}
                />
              ) : null,
            )
          : null}
      </div>
      <ul aria-label="Tokens and cost by source" className="space-y-1.5 text-xs">
        {origins.map((origin) => (
          <li key={origin.key} className="flex items-center justify-between gap-4">
            <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-sm"
                style={{ backgroundColor: ORIGIN_COLORS[origin.key] }}
              />
              {origin.label}
            </span>
            <span className="inline-flex items-baseline gap-2 tabular-nums">
              <span className="text-muted-foreground">
                {formatTokens(origin.usage.totalTokens)}
              </span>
              <span className="font-medium">{costLabel(origin.usage)}</span>
              <span className="w-9 text-right text-muted-foreground">
                {formatShare(origin.usage.totalTokens, total)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DimensionToggle({
  dimension,
  onChange,
}: {
  readonly dimension: TokenCostDimension;
  readonly onChange: (next: TokenCostDimension) => void;
}) {
  return (
    <div role="group" aria-label="Break down by" className="inline-flex rounded-md bg-muted p-0.5">
      {(["provider", "model", "project"] as const).map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={dimension === value}
          onClick={() => onChange(value)}
          className={cn(
            "h-6 rounded-sm px-2 text-[11px] capitalize",
            dimension === value
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground",
          )}
        >
          {value}
        </button>
      ))}
    </div>
  );
}

/** A folder's name from its synthetic `folder:<name>` id, when the snapshot lists no title. */
function projectRef(
  projectId: string,
  projects: readonly StatisticsProjectRef[],
): { readonly title: string; readonly folder: boolean } {
  const ref = projects.find((project) => project.id === projectId);
  if (ref) return { title: ref.title, folder: ref.kind === "folder" };
  if (projectId.startsWith("folder:")) return { title: projectId.slice(7), folder: true };
  return { title: projectId, folder: false };
}

function TokenCostRowView({
  row,
  dimension,
  total,
  maxTokens,
  showOrigins,
  projects,
}: {
  readonly row: TokenCostRow;
  readonly dimension: TokenCostDimension;
  readonly total: number;
  readonly maxTokens: number;
  readonly showOrigins: boolean;
  readonly projects: readonly StatisticsProjectRef[];
}) {
  const project =
    dimension === "project" && row.projectId !== undefined
      ? projectRef(row.projectId, projects)
      : null;
  const label =
    project !== null
      ? project.title
      : dimension === "model" && row.model !== undefined
        ? formatModelLabel(row.model)
        : formatProviderLabel(row.provider);
  const share = `${formatShare(row.totalTokens, total)} of tokens`;
  const detail =
    dimension === "model"
      ? formatProviderLabel(row.provider)
      : project?.folder
        ? `Folder outside Ryco projects · ${share}`
        : share;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-5 px-4 py-3 sm:px-5">
      <span className="block min-w-0">
        <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
          {project?.folder ? (
            <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          ) : null}
          <span className="truncate">{label}</span>
        </span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{detail}</span>
        {showOrigins ? (
          <OriginMiniBar
            rycoTokens={row.rycoTokens}
            outsideTokens={row.outsideTokens}
            maxTokens={maxTokens}
          />
        ) : null}
      </span>
      <span className="block text-right">
        <span className="block text-sm font-medium tabular-nums">
          {formatTokens(row.totalTokens)}
        </span>
        <span className="block text-[11px] text-muted-foreground">tokens</span>
      </span>
      <span className="block w-24 text-right">
        <span className="block text-sm font-medium tabular-nums">{costLabel(row)}</span>
        <span className="block text-[11px] text-muted-foreground">
          {row.cost.unpricedTokens > 0
            ? `${formatTokens(row.cost.unpricedTokens)} unpriced`
            : "estimated"}
        </span>
      </span>
    </li>
  );
}

/** Ryco's and outside tokens of one row, scaled to the largest row. */
function OriginMiniBar({
  rycoTokens,
  outsideTokens,
  maxTokens,
}: {
  readonly rycoTokens: number;
  readonly outsideTokens: number;
  readonly maxTokens: number;
}) {
  const width = (tokens: number) => `${maxTokens > 0 ? (tokens / maxTokens) * 100 : 0}%`;
  return (
    <span
      role="img"
      aria-label={`Ryco ${formatTokens(rycoTokens)} tokens, outside Ryco ${formatTokens(outsideTokens)} tokens`}
      className="mt-1.5 flex h-1.5 w-full max-w-48 gap-px overflow-hidden rounded-full bg-muted"
    >
      {rycoTokens > 0 ? (
        <span
          className="h-full shrink-0"
          style={{ width: width(rycoTokens), backgroundColor: ORIGIN_COLORS.ryco }}
        />
      ) : null}
      {outsideTokens > 0 ? (
        <span
          className="h-full shrink-0"
          style={{ width: width(outsideTokens), backgroundColor: ORIGIN_COLORS.outside }}
        />
      ) : null}
    </span>
  );
}
