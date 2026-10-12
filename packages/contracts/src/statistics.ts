import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId } from "./baseSchemas.ts";
import { PullRequestState, WorktreeId } from "./worktree.ts";

/**
 * Usage statistics surfaced in Settings → Statistics.
 *
 * The server returns the finest sensible granularity — one bucket per
 * `(date, project, provider, model)` — and the client pivots/filters those
 * buckets into every chart (totals, per-model, per-project, time series)
 * without re-fetching.
 * Token counts and timings are derived on demand from the existing projection
 * tables; no dedicated statistics tables exist.
 */

/** Selectable time window for the dashboard (client-side slicing of buckets). */
export const StatisticsRange = Schema.Literals(["7d", "30d", "90d", "all"]);
export type StatisticsRange = typeof StatisticsRange.Type;

/**
 * Client filter state. The current RPC returns every bucket and the filter is
 * applied in the browser; kept in contracts so client and any future
 * server-side filtering share one shape.
 */
export const StatisticsFilter = Schema.Struct({
  // Nullable to match the panel's null-based filter state, so the same shape can
  // be reused for RPC payloads / persistence without a normalization pass.
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  provider: Schema.optional(Schema.NullOr(Schema.String)),
  range: Schema.optional(StatisticsRange),
});
export type StatisticsFilter = typeof StatisticsFilter.Type;

/**
 * A model that appears in the data, with its best-effort provider driver kind.
 * String fields are plain `Schema.String` (not non-empty): these are
 * server-derived display values, and relaxing them keeps a stray empty/legacy
 * value from failing success-encoding and crashing the whole RPC.
 */
export const StatisticsModelRef = Schema.Struct({
  model: Schema.String,
  provider: Schema.optional(Schema.String),
});
export type StatisticsModelRef = typeof StatisticsModelRef.Type;

export const StatisticsProjectRef = Schema.Struct({
  id: ProjectId,
  title: Schema.String,
});
export type StatisticsProjectRef = typeof StatisticsProjectRef.Type;

/**
 * One row per `(date, project, provider, model)`. Numeric fields are plain
 * numbers (sums) to stay permissive — a provider that reports fractional usage
 * will not fail decoding.
 */
export const StatisticsDailyBucket = Schema.Struct({
  /** Calendar day in UTC, formatted YYYY-MM-DD. */
  date: Schema.String,
  projectId: ProjectId,
  model: Schema.String,
  provider: Schema.optional(Schema.String),
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  reasoningTokens: Schema.Number,
  /** Provider-reported total when available; may exceed known input/output split. */
  totalTokens: Schema.Number,
  turns: Schema.Number,
  activeMs: Schema.Number,
  toolUses: Schema.Number,
  filesChanged: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
  commits: Schema.Number,
  pushes: Schema.Number,
  threadsCreated: Schema.Number,
});
export type StatisticsDailyBucket = typeof StatisticsDailyBucket.Type;

export const StatisticsWorktreeSummary = Schema.Struct({
  created: Schema.Number,
  archived: Schema.Number,
  active: Schema.Number,
  openPrs: Schema.Number,
});
export type StatisticsWorktreeSummary = typeof StatisticsWorktreeSummary.Type;

export const StatisticsTotals = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  reasoningTokens: Schema.Number,
  totalTokens: Schema.Number,
  turns: Schema.Number,
  activeMs: Schema.Number,
  toolUses: Schema.Number,
  filesChanged: Schema.Number,
  additions: Schema.Number,
  deletions: Schema.Number,
  commits: Schema.Number,
  pushes: Schema.Number,
  threads: Schema.Number,
  projects: Schema.Number,
});
export type StatisticsTotals = typeof StatisticsTotals.Type;

export const StatisticsRecentPullRequest = Schema.Struct({
  worktreeId: WorktreeId,
  worktreeTitle: Schema.optional(Schema.String),
  branch: Schema.String,
  projectId: ProjectId,
  projectTitle: Schema.String,
  prNumber: Schema.Number,
  prTitle: Schema.optional(Schema.String),
  prState: Schema.optional(PullRequestState),
  prIsDraft: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(IsoDateTime),
  active: Schema.Boolean,
});
export type StatisticsRecentPullRequest = typeof StatisticsRecentPullRequest.Type;

/**
 * How per-day/per-model token figures were attributed:
 *  - `per-turn-delta`: exact, one definitive delta per (thread, turn).
 *  - `thread-cumulative`: approximate, a thread's cumulative total attributed to
 *    its primary model and last-activity day (fallback when deltas are absent).
 *  - `mixed`: exact deltas for threads that have them, cumulative fallback for
 *    older/provider-limited threads.
 */
export const StatisticsTokenAttribution = Schema.Literals([
  "per-turn-delta",
  "thread-cumulative",
  "mixed",
]);
export type StatisticsTokenAttribution = typeof StatisticsTokenAttribution.Type;

export const StatisticsSnapshot = Schema.Struct({
  generatedAt: IsoDateTime,
  /** Earliest activity date observed, useful for the "all time" label. */
  earliestActivityAt: Schema.optional(IsoDateTime),
  projects: Schema.Array(StatisticsProjectRef),
  models: Schema.Array(StatisticsModelRef),
  dailyBuckets: Schema.Array(StatisticsDailyBucket),
  worktrees: StatisticsWorktreeSummary,
  totals: StatisticsTotals,
  tokenAttribution: Schema.optional(StatisticsTokenAttribution),
  recentPullRequests: Schema.Array(StatisticsRecentPullRequest).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type StatisticsSnapshot = typeof StatisticsSnapshot.Type;
