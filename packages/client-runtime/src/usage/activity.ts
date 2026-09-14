// @effect-diagnostics globalDate:off
import type { StatisticsDailyBucket, StatisticsSnapshot } from "@ryco/contracts";

export type StatRange = "7d" | "30d" | "90d" | "all";

export interface StatFilter {
  readonly range: StatRange;
  readonly projectId: string | null;
  readonly model: string | null;
  readonly provider: string | null;
}

export interface MetricTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  turns: number;
  activeMs: number;
  toolUses: number;
  filesChanged: number;
  additions: number;
  deletions: number;
  commits: number;
  pushes: number;
  threadsCreated: number;
}

export function emptyTotals(): MetricTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    turns: 0,
    activeMs: 0,
    toolUses: 0,
    filesChanged: 0,
    additions: 0,
    deletions: 0,
    commits: 0,
    pushes: 0,
    threadsCreated: 0,
  };
}

function snapshotTotals(totals: MetricTotals): MetricTotals {
  return { ...totals };
}

export function accumulate(target: MetricTotals, bucket: StatisticsDailyBucket): void {
  target.inputTokens += bucket.inputTokens;
  target.outputTokens += bucket.outputTokens;
  target.cachedInputTokens += bucket.cachedInputTokens;
  target.reasoningTokens += bucket.reasoningTokens;
  target.totalTokens += bucket.totalTokens;
  target.turns += bucket.turns;
  target.activeMs += bucket.activeMs;
  target.toolUses += bucket.toolUses;
  target.filesChanged += bucket.filesChanged;
  target.additions += bucket.additions;
  target.deletions += bucket.deletions;
  target.commits += bucket.commits;
  target.pushes += bucket.pushes;
  target.threadsCreated += bucket.threadsCreated;
}

export function sumTotals(buckets: ReadonlyArray<StatisticsDailyBucket>): MetricTotals {
  const totals = emptyTotals();
  for (const bucket of buckets) {
    accumulate(totals, bucket);
  }
  return totals;
}

const RANGE_DAYS: Record<StatRange, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

function shiftDay(isoDate: string, deltaDays: number): string {
  const parsed = Date.parse(`${isoDate}T00:00:00Z`);
  const next = new Date(parsed + deltaDays * 86_400_000);
  return next.toISOString().slice(0, 10);
}

function todayFrom(snapshot: StatisticsSnapshot): string {
  return snapshot.generatedAt.slice(0, 10);
}

/** Inclusive start date for a range, or null for "all". */
export function cutoffDate(snapshot: StatisticsSnapshot, range: StatRange): string | null {
  const days = RANGE_DAYS[range];
  if (days === null) {
    return null;
  }
  return shiftDay(todayFrom(snapshot), -(days - 1));
}

export function filterBuckets(
  snapshot: StatisticsSnapshot,
  filter: StatFilter,
): Array<StatisticsDailyBucket> {
  const cutoff = cutoffDate(snapshot, filter.range);
  return snapshot.dailyBuckets.filter(
    (bucket) =>
      (cutoff === null || bucket.date >= cutoff) &&
      (filter.projectId === null || bucket.projectId === filter.projectId) &&
      (filter.model === null || bucket.model === filter.model) &&
      (filter.provider === null || bucket.provider === filter.provider),
  );
}

/** Totals for the window immediately preceding the active range (for deltas). */
export function previousTotals(
  snapshot: StatisticsSnapshot,
  filter: StatFilter,
): MetricTotals | null {
  const days = RANGE_DAYS[filter.range];
  if (days === null) {
    return null;
  }
  const today = todayFrom(snapshot);
  const currentStart = shiftDay(today, -(days - 1));
  const previousStart = shiftDay(today, -(2 * days - 1));
  const previousEnd = shiftDay(currentStart, -1);
  const totals = emptyTotals();
  for (const bucket of snapshot.dailyBuckets) {
    if (
      bucket.date >= previousStart &&
      bucket.date <= previousEnd &&
      (filter.projectId === null || bucket.projectId === filter.projectId) &&
      (filter.model === null || bucket.model === filter.model) &&
      (filter.provider === null || bucket.provider === filter.provider)
    ) {
      accumulate(totals, bucket);
    }
  }
  return totals;
}

export interface ProviderAggregate {
  readonly provider: string | undefined;
  readonly totalTokens: number;
}

export function aggregateByProvider(
  buckets: ReadonlyArray<StatisticsDailyBucket>,
): Array<ProviderAggregate> {
  const byProvider = new Map<string | undefined, number>();
  for (const bucket of buckets) {
    byProvider.set(bucket.provider, (byProvider.get(bucket.provider) ?? 0) + bucket.totalTokens);
  }
  return [...byProvider.entries()]
    .map(([provider, totalTokens]) => ({ provider, totalTokens }))
    .filter((entry) => entry.totalTokens > 0)
    .toSorted((a, b) => b.totalTokens - a.totalTokens);
}

export interface ProjectAggregate extends MetricTotals {
  readonly projectId: string;
  readonly title: string;
}

export function aggregateByProject(
  buckets: ReadonlyArray<StatisticsDailyBucket>,
  projectTitle: ReadonlyMap<string, string>,
): Array<ProjectAggregate> {
  const byProject = new Map<string, MetricTotals>();
  for (const bucket of buckets) {
    let totals = byProject.get(bucket.projectId);
    if (!totals) {
      totals = emptyTotals();
      byProject.set(bucket.projectId, totals);
    }
    accumulate(totals, bucket);
  }
  return [...byProject.entries()]
    .map(([projectId, totals]) =>
      Object.assign(snapshotTotals(totals), {
        projectId,
        title: projectTitle.get(projectId) ?? projectId,
      }),
    )
    .toSorted((a, b) => b.totalTokens - a.totalTokens);
}

export interface DayPoint {
  readonly date: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly uncategorizedTokens: number;
  readonly totalTokens: number;
  readonly turns: number;
  readonly activeMs: number;
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
}

/** Per-day series spanning the active range, with empty days filled in. */
export function buildTimeSeries(
  snapshot: StatisticsSnapshot,
  buckets: ReadonlyArray<StatisticsDailyBucket>,
  range: StatRange,
): Array<DayPoint> {
  const byDate = new Map<string, MetricTotals>();
  for (const bucket of buckets) {
    let totals = byDate.get(bucket.date);
    if (!totals) {
      totals = emptyTotals();
      byDate.set(bucket.date, totals);
    }
    accumulate(totals, bucket);
  }

  const end = todayFrom(snapshot);
  let start = cutoffDate(snapshot, range);
  if (start === null) {
    // "all": start at the earliest day present (fallback to today).
    const earliest = [...byDate.keys()].toSorted()[0];
    start = earliest ?? end;
  }
  // Cap the span so we never enumerate forever — but anchor the window to the
  // RECENT end (drop the oldest days, never the newest), otherwise a long "all"
  // history would hide today's activity.
  const MAX_DAYS = 372;
  const minStart = shiftDay(end, -(MAX_DAYS - 1));
  if (start < minStart) {
    start = minStart;
  }
  const points: Array<DayPoint> = [];
  let cursor = start;
  let guard = 0;
  while (cursor <= end && guard < MAX_DAYS) {
    const totals = byDate.get(cursor) ?? emptyTotals();
    const uncategorizedTokens = Math.max(
      0,
      totals.totalTokens - totals.inputTokens - totals.outputTokens,
    );
    points.push({
      date: cursor,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cachedInputTokens: totals.cachedInputTokens,
      uncategorizedTokens,
      totalTokens: totals.totalTokens,
      turns: totals.turns,
      activeMs: totals.activeMs,
      filesChanged: totals.filesChanged,
      additions: totals.additions,
      deletions: totals.deletions,
    });
    cursor = shiftDay(cursor, 1);
    guard += 1;
  }
  return points;
}

export function buildProjectTitleMap(snapshot: StatisticsSnapshot): Map<string, string> {
  const map = new Map<string, string>();
  for (const project of snapshot.projects) {
    map.set(project.id, project.title);
  }
  return map;
}

/** Percentage change of `current` vs `previous`, or null when undefined. */
export function percentChange(current: number, previous: number | undefined | null): number | null {
  if (previous === undefined || previous === null || previous === 0) {
    return null;
  }
  return ((current - previous) / previous) * 100;
}
