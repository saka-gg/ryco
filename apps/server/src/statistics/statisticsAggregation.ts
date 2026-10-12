/**
 * Pure aggregation for {@link StatisticsQuery}.
 *
 * Every token, turn and tool-use contribution is scoped to one thread, so the
 * work is split into per-thread partials that can be recomputed independently
 * and summed into a snapshot. A full rebuild and an incremental refresh run the
 * same code, which keeps both paths producing identical snapshots.
 *
 * @module statisticsAggregation
 */
import {
  PullRequestState,
  ProjectId,
  type StatisticsDailyBucket,
  type StatisticsModelRef,
  type StatisticsProjectRef,
  type StatisticsRecentPullRequest,
  type StatisticsSnapshot,
  type StatisticsTokenAttribution,
  WorktreeId,
  WorktreePullRequestLink,
} from "@ryco/contracts";
import { readWorktreePullRequestLinks } from "@ryco/shared/worktreePullRequests";
import { Schema } from "effect";

import {
  collectParsedProcessedTokenUsage,
  parseTokenActivityPayload,
  type ParsedTokenActivity,
} from "./processedTokenUsage.ts";

export const StatisticsThreadRow = Schema.Struct({
  threadId: Schema.String,
  projectId: ProjectId,
  model: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  providerName: Schema.NullOr(Schema.String),
});
export type StatisticsThreadRow = typeof StatisticsThreadRow.Type;

export const StatisticsProjectRow = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
});
export type StatisticsProjectRow = typeof StatisticsProjectRow.Type;

export const StatisticsTokenActivityRow = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  sequence: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
  payloadJson: Schema.String,
});
export type StatisticsTokenActivityRow = typeof StatisticsTokenActivityRow.Type;

export const StatisticsToolUseRow = Schema.Struct({
  threadId: Schema.String,
  date: Schema.String,
  count: Schema.Number,
});
export type StatisticsToolUseRow = typeof StatisticsToolUseRow.Type;

export const StatisticsTurnRow = Schema.Struct({
  threadId: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  checkpointTurnCount: Schema.NullOr(Schema.Number),
  /** Checkpoint file totals, summed by SQLite (see selectStatisticsTurns). */
  filesChanged: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type StatisticsTurnRow = typeof StatisticsTurnRow.Type;

export const StatisticsWorktreeRow = Schema.Struct({
  worktreeId: WorktreeId,
  projectId: ProjectId,
  title: Schema.NullOr(Schema.String),
  branch: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  archivedAt: Schema.NullOr(Schema.String),
  prNumber: Schema.NullOr(Schema.Number),
  prTitle: Schema.NullOr(Schema.String),
  prState: Schema.NullOr(PullRequestState),
  prIsDraft: Schema.NullOr(Schema.Number),
  prTerminalAt: Schema.NullOr(Schema.String),
  origin: Schema.String,
  // NULL on rows written before links: derived from the flat `pr_*` columns.
  pullRequests: Schema.NullOr(Schema.fromJsonString(Schema.Array(WorktreePullRequestLink))),
});
export type StatisticsWorktreeRow = typeof StatisticsWorktreeRow.Type;

/** Every pull request a worktree row carried (dismissed ones left out). */
function worktreeRowLinks(row: StatisticsWorktreeRow) {
  return (
    row.pullRequests ??
    readWorktreePullRequestLinks({
      prNumber: row.prNumber,
      prTitle: row.prTitle,
      prState: row.prState,
      prIsDraft: row.prIsDraft === null ? null : row.prIsDraft === 1,
      prTerminalAt: row.prTerminalAt,
      origin: row.origin,
    })
  ).filter((link) => !link.dismissedAt);
}

export interface StatisticsThreadMeta {
  readonly projectId: ProjectId;
  readonly model: string;
  readonly provider: string | undefined;
  readonly createdAt: string;
}

interface BucketCounters {
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
}

interface MutableBucket extends BucketCounters {
  date: string;
  projectId: ProjectId;
  model: string;
  provider: string | undefined;
}

interface MutableSnapshotBucket extends MutableBucket {
  threadsCreated: number;
}

/** One thread's contribution. Its bucket keys depend on the meta it was computed with. */
export interface StatisticsThreadPartial {
  readonly metaKey: string;
  readonly buckets: ReadonlyArray<Readonly<MutableBucket>>;
  readonly usedExactPerTurn: boolean;
  readonly usedCumulativeFallback: boolean;
  readonly earliest: string | undefined;
}

const NO_THREAD_META = "\u0001";

/** Changes whenever a thread's partial would bucket its rows differently. */
export function statisticsThreadMetaKey(meta: StatisticsThreadMeta | undefined): string {
  return meta === undefined
    ? NO_THREAD_META
    : `${meta.projectId}\u0000${meta.provider ?? ""}\u0000${meta.model}`;
}

/** Coalesce blanks to safe display values: empty strings would fail RPC success-encoding. */
export function buildStatisticsThreadMeta(
  rows: ReadonlyArray<StatisticsThreadRow>,
): Map<string, StatisticsThreadMeta> {
  const threadMeta = new Map<string, StatisticsThreadMeta>();
  for (const row of rows) {
    const provider = row.providerName?.trim() || row.providerInstanceId?.trim() || undefined;
    const model = (row.model ?? "").trim() || "unknown";
    threadMeta.set(row.threadId, {
      projectId: row.projectId,
      model,
      provider,
      createdAt: row.createdAt,
    });
  }
  return threadMeta;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dayOf(iso: string): string | null {
  return iso.length >= 10 ? iso.slice(0, 10) : null;
}

function emptyCounters(): BucketCounters {
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
  };
}

function bucketKey(date: string, projectId: string, model: string, provider: string | undefined) {
  return `${date}\u0000${projectId}\u0000${provider ?? ""}\u0000${model}`;
}

type Payload = Record<string, unknown> | undefined;

function bestPerTurnTotalTokenCount(payload: Payload): number {
  const reportedTotal = num(payload?.lastUsedTokens);
  if (reportedTotal > 0) {
    return reportedTotal;
  }
  return num(payload?.lastInputTokens) + num(payload?.lastOutputTokens);
}

function bestCumulativeTotalTokenCount(payload: Payload): number {
  const reportedTotal = num(payload?.usedTokens);
  if (reportedTotal > 0) {
    return reportedTotal;
  }
  return num(payload?.inputTokens) + num(payload?.outputTokens);
}

function hasExactPerTurnBreakdown(payload: Payload): boolean {
  return (
    num(payload?.lastInputTokens) +
      num(payload?.lastOutputTokens) +
      num(payload?.lastCachedInputTokens) +
      num(payload?.lastReasoningOutputTokens) >
    0
  );
}

function addPerTurnUsage(bucket: BucketCounters, payload: Payload): void {
  bucket.inputTokens += num(payload?.lastInputTokens);
  bucket.outputTokens += num(payload?.lastOutputTokens);
  bucket.cachedInputTokens += num(payload?.lastCachedInputTokens);
  bucket.reasoningTokens += num(payload?.lastReasoningOutputTokens);
  bucket.totalTokens += bestPerTurnTotalTokenCount(payload);
}

function addCumulativeUsage(bucket: BucketCounters, payload: Payload): void {
  bucket.inputTokens += num(payload?.inputTokens);
  bucket.outputTokens += num(payload?.outputTokens);
  bucket.cachedInputTokens += num(payload?.cachedInputTokens);
  bucket.reasoningTokens += num(payload?.reasoningOutputTokens);
  bucket.totalTokens += bestCumulativeTotalTokenCount(payload);
}

/** Rows of one thread, in the token query's (createdAt, sequence) order. */
export interface StatisticsThreadRows {
  readonly tokens: Array<StatisticsTokenActivityRow>;
  readonly turns: Array<StatisticsTurnRow>;
  readonly tools: Array<StatisticsToolUseRow>;
}

/** Group thread-scoped rows; `threadIds` also gets entries for threads without rows. */
export function groupStatisticsRowsByThread(input: {
  readonly threadIds: Iterable<string>;
  readonly tokens: ReadonlyArray<StatisticsTokenActivityRow>;
  readonly turns: ReadonlyArray<StatisticsTurnRow>;
  readonly tools: ReadonlyArray<StatisticsToolUseRow>;
}): Map<string, StatisticsThreadRows> {
  const groups = new Map<string, StatisticsThreadRows>();
  const groupFor = (threadId: string) => {
    let group = groups.get(threadId);
    if (group === undefined) {
      group = { tokens: [], turns: [], tools: [] };
      groups.set(threadId, group);
    }
    return group;
  };
  for (const threadId of input.threadIds) groupFor(threadId);
  for (const row of input.tokens) groupFor(row.threadId).tokens.push(row);
  for (const row of input.turns) groupFor(row.threadId).turns.push(row);
  for (const row of input.tools) groupFor(row.threadId).tools.push(row);
  return groups;
}

/**
 * Aggregate one thread. Within a turn, rows iterate in (createdAt, sequence)
 * order so the last write is the turn's final snapshot. Across turns we must NOT
 * rely on iteration order (turn_id is opaque/non-chronological), so the
 * per-thread pick uses an explicit latest-by-(createdAt, sequence) comparison.
 */
export function computeStatisticsThreadPartial(
  meta: StatisticsThreadMeta | undefined,
  rows: StatisticsThreadRows,
): StatisticsThreadPartial {
  const buckets = new Map<string, MutableBucket>();
  let usedExactPerTurn = false;
  let usedCumulativeFallback = false;
  let earliest: string | undefined;
  const considerIso = (iso: string | null | undefined) => {
    if (iso && (earliest === undefined || iso < earliest)) earliest = iso;
  };
  const getBucket = (
    date: string,
    projectId: ProjectId,
    model: string,
    provider: string | undefined,
  ): MutableBucket => {
    const key = bucketKey(date, projectId, model, provider);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { date, projectId, model, provider, ...emptyCounters() };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  // Each payload is parsed exactly once and shared by every pass below.
  const parsed: Array<ParsedTokenActivity<StatisticsTokenActivityRow>> = rows.tokens.map((row) => ({
    row,
    payload: parseTokenActivityPayload(row.payloadJson),
  }));
  const processed = collectParsedProcessedTokenUsage(parsed, () => meta?.provider);
  for (const entry of processed.entries) {
    const date = dayOf(entry.row.createdAt);
    if (!meta || !date) continue;
    considerIso(entry.row.createdAt);
    const bucket = getBucket(
      date,
      meta.projectId,
      entry.model ?? meta.model,
      entry.provider ?? meta.provider,
    );
    bucket.inputTokens += entry.inputTokens;
    bucket.cachedInputTokens += entry.cachedInputTokens;
    bucket.outputTokens += entry.outputTokens;
    bucket.reasoningTokens += entry.reasoningTokens;
    bucket.totalTokens += entry.totalTokens;
    if (entry.approximate) usedCumulativeFallback = true;
    else usedExactPerTurn = true;
  }

  type Parsed = (typeof parsed)[number];
  const isLater = (a: Parsed, b: Parsed): boolean => {
    if (a.row.createdAt !== b.row.createdAt) {
      return a.row.createdAt > b.row.createdAt;
    }
    return (a.row.sequence ?? -1) >= (b.row.sequence ?? -1);
  };
  const lastPerTurn = new Map<string, Parsed>();
  for (const entry of parsed) {
    const row = entry.row;
    considerIso(row.createdAt);
    const turnKey = `${row.threadId}\u0000${row.turnId ?? ""}`;
    if (processed.sessionThreads.has(row.threadId) || processed.turns.has(turnKey)) continue;
    const prevTurn = lastPerTurn.get(turnKey);
    if (!prevTurn || isLater(entry, prevTurn)) {
      lastPerTurn.set(turnKey, entry);
    }
  }

  let firstExact: Parsed | undefined;
  for (const entry of lastPerTurn.values()) {
    if (hasExactPerTurnBreakdown(entry.payload) && (!firstExact || isLater(firstExact, entry))) {
      firstExact = entry;
    }
  }
  let cumulativeFallback: Parsed | undefined;
  for (const entry of lastPerTurn.values()) {
    if (hasExactPerTurnBreakdown(entry.payload)) continue;
    if (firstExact && !isLater(firstExact, entry)) continue;
    if (!cumulativeFallback || isLater(entry, cumulativeFallback)) {
      cumulativeFallback = entry;
    }
  }
  for (const entry of lastPerTurn.values()) {
    if (!hasExactPerTurnBreakdown(entry.payload)) continue;
    const date = dayOf(entry.row.createdAt);
    if (!meta || !date) continue;
    addPerTurnUsage(getBucket(date, meta.projectId, meta.model, meta.provider), entry.payload);
    usedExactPerTurn = true;
  }
  if (cumulativeFallback) {
    const date = dayOf(cumulativeFallback.row.createdAt);
    if (meta && date && bestCumulativeTotalTokenCount(cumulativeFallback.payload) > 0) {
      addCumulativeUsage(
        getBucket(date, meta.projectId, meta.model, meta.provider),
        cumulativeFallback.payload,
      );
      usedCumulativeFallback = true;
    }
  }

  if (meta) {
    // ── Turns: counts, active time, and file/line changes ───────────────
    for (const row of rows.turns) {
      considerIso(row.startedAt);
      considerIso(row.completedAt);
      const anchor = row.completedAt ?? row.startedAt;
      const date = anchor ? dayOf(anchor) : null;
      if (!date) continue;
      const bucket = getBucket(date, meta.projectId, meta.model, meta.provider);
      if (row.completedAt) {
        bucket.turns += 1;
        if (row.startedAt) {
          const delta = Date.parse(row.completedAt) - Date.parse(row.startedAt);
          if (Number.isFinite(delta) && delta > 0) {
            bucket.activeMs += delta;
          }
        }
      }
      bucket.filesChanged += row.filesChanged;
      bucket.additions += row.additions;
      bucket.deletions += row.deletions;
    }

    // ── Tool uses (completed tool calls) ────────────────────────────────
    for (const row of rows.tools) {
      getBucket(row.date, meta.projectId, meta.model, meta.provider).toolUses += num(row.count);
    }
  }

  return {
    metaKey: statisticsThreadMetaKey(meta),
    buckets: [...buckets.values()],
    usedExactPerTurn,
    usedCumulativeFallback,
    earliest,
  };
}

/** Sum per-thread partials with the global (non-thread-scoped) rows into a snapshot. */
export function assembleStatisticsSnapshot(input: {
  readonly threadMeta: ReadonlyMap<string, StatisticsThreadMeta>;
  readonly partials: Iterable<StatisticsThreadPartial>;
  readonly projectRows: ReadonlyArray<StatisticsProjectRow>;
  readonly worktreeRows: ReadonlyArray<StatisticsWorktreeRow>;
  readonly generatedAt: string;
}): StatisticsSnapshot {
  const { threadMeta, worktreeRows } = input;
  const modelRefs = new Map<string, StatisticsModelRef>();
  const addModelRef = (model: string, provider: string | undefined) =>
    modelRefs.set(`${provider ?? ""}\u0000${model}`, provider ? { model, provider } : { model });
  for (const meta of threadMeta.values()) addModelRef(meta.model, meta.provider);

  const buckets = new Map<string, MutableSnapshotBucket>();
  const getBucket = (
    date: string,
    projectId: ProjectId,
    model: string,
    provider: string | undefined,
  ): MutableSnapshotBucket => {
    addModelRef(model, provider);
    const key = bucketKey(date, projectId, model, provider);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { date, projectId, model, provider, ...emptyCounters(), threadsCreated: 0 };
      buckets.set(key, bucket);
    }
    return bucket;
  };

  let earliest: string | undefined;
  const considerIso = (iso: string | null | undefined) => {
    if (iso && (earliest === undefined || iso < earliest)) {
      earliest = iso;
    }
  };

  let usedExactPerTurn = false;
  let usedCumulativeFallback = false;
  for (const partial of input.partials) {
    considerIso(partial.earliest);
    if (partial.usedExactPerTurn) usedExactPerTurn = true;
    if (partial.usedCumulativeFallback) usedCumulativeFallback = true;
    for (const source of partial.buckets) {
      const bucket = getBucket(source.date, source.projectId, source.model, source.provider);
      bucket.inputTokens += source.inputTokens;
      bucket.outputTokens += source.outputTokens;
      bucket.cachedInputTokens += source.cachedInputTokens;
      bucket.reasoningTokens += source.reasoningTokens;
      bucket.totalTokens += source.totalTokens;
      bucket.turns += source.turns;
      bucket.activeMs += source.activeMs;
      bucket.toolUses += source.toolUses;
      bucket.filesChanged += source.filesChanged;
      bucket.additions += source.additions;
      bucket.deletions += source.deletions;
      bucket.commits += source.commits;
      bucket.pushes += source.pushes;
    }
  }

  const attribution: StatisticsTokenAttribution =
    usedExactPerTurn && usedCumulativeFallback
      ? "mixed"
      : usedCumulativeFallback
        ? "thread-cumulative"
        : "per-turn-delta";

  // ── Threads created ───────────────────────────────────────────────────
  for (const meta of threadMeta.values()) {
    considerIso(meta.createdAt);
    const date = dayOf(meta.createdAt);
    if (!date) continue;
    getBucket(date, meta.projectId, meta.model, meta.provider).threadsCreated += 1;
  }

  // ── Worktree summary ──────────────────────────────────────────────────
  let wtCreated = 0;
  let wtArchived = 0;
  let wtOpenPrs = 0;
  for (const row of worktreeRows) {
    considerIso(row.createdAt);
    wtCreated += 1;
    if (row.archivedAt) {
      wtArchived += 1;
    } else {
      // Merged or closed pull requests don't count; one not yet refreshed does.
      wtOpenPrs += worktreeRowLinks(row).filter(
        (link) => link.state !== "merged" && link.state !== "closed",
      ).length;
    }
  }

  // ── Assemble output ───────────────────────────────────────────────────
  const dailyBuckets: Array<StatisticsDailyBucket> = [];
  const totals = {
    ...emptyCounters(),
    threads: threadMeta.size,
    projects: 0,
  };
  for (const bucket of buckets.values()) {
    const { provider, ...rest } = bucket;
    dailyBuckets.push(provider ? { ...rest, provider } : rest);
    totals.inputTokens += bucket.inputTokens;
    totals.outputTokens += bucket.outputTokens;
    totals.cachedInputTokens += bucket.cachedInputTokens;
    totals.reasoningTokens += bucket.reasoningTokens;
    totals.turns += bucket.turns;
    totals.activeMs += bucket.activeMs;
    totals.toolUses += bucket.toolUses;
    totals.filesChanged += bucket.filesChanged;
    totals.additions += bucket.additions;
    totals.deletions += bucket.deletions;
    totals.commits += bucket.commits;
    totals.pushes += bucket.pushes;
    totals.totalTokens += bucket.totalTokens;
  }
  dailyBuckets.sort((a, b) =>
    a.date === b.date
      ? a.projectId === b.projectId
        ? (a.provider ?? "").localeCompare(b.provider ?? "") || a.model.localeCompare(b.model)
        : a.projectId.localeCompare(b.projectId)
      : a.date.localeCompare(b.date),
  );

  const projectTitle = new Map<ProjectId, string>();
  for (const row of input.projectRows) {
    projectTitle.set(row.projectId, row.title);
  }
  const projectIdsInData = new Set<ProjectId>();
  for (const meta of threadMeta.values()) {
    projectIdsInData.add(meta.projectId);
  }
  for (const bucket of buckets.values()) {
    projectIdsInData.add(bucket.projectId);
  }
  totals.projects = projectIdsInData.size;

  const projects: Array<StatisticsProjectRef> = [...projectIdsInData].map((id) => ({
    id,
    title: projectTitle.get(id)?.trim() || id,
  }));
  projects.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  const models: Array<StatisticsModelRef> = [...modelRefs.values()].toSorted(
    (a, b) => (a.provider ?? "").localeCompare(b.provider ?? "") || a.model.localeCompare(b.model),
  );
  // One row per pull request a workspace carried, so a shipped one and its
  // follow-up both stay listed.
  const recentPullRequests: Array<StatisticsRecentPullRequest> = worktreeRows
    .flatMap((row) =>
      worktreeRowLinks(row).map((link) => {
        const updatedAt = link.terminalAt ?? link.linkedAt ?? row.updatedAt;
        return Object.assign(
          {
            worktreeId: row.worktreeId,
            branch: link.headRefName ?? row.branch,
            projectId: row.projectId,
            projectTitle: projectTitle.get(row.projectId)?.trim() || row.projectId,
            prNumber: link.number,
            createdAt: link.linkedAt ?? row.createdAt,
            updatedAt,
            active: row.archivedAt === null,
          },
          row.title === null ? {} : { worktreeTitle: row.title },
          link.title === null ? {} : { prTitle: link.title },
          link.state === null ? {} : { prState: link.state },
          link.isDraft === null ? {} : { prIsDraft: link.isDraft },
          row.archivedAt === null ? {} : { archivedAt: row.archivedAt },
        );
      }),
    )
    .toSorted(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.worktreeId.localeCompare(right.worktreeId) ||
        right.prNumber - left.prNumber,
    )
    .slice(0, 20);

  return {
    generatedAt: input.generatedAt,
    ...(earliest ? { earliestActivityAt: earliest } : {}),
    projects,
    models,
    dailyBuckets,
    worktrees: {
      created: wtCreated,
      archived: wtArchived,
      active: wtCreated - wtArchived,
      openPrs: wtOpenPrs,
    },
    totals,
    tokenAttribution: attribution,
    recentPullRequests,
  };
}
