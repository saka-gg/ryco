import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId } from "./baseSchemas.ts";
import { UsagePricingState } from "./usage.ts";
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
  /**
   * `folder`: not a Ryco project. Sessions run outside Ryco whose directory lies in no project
   * are grouped by their folder's name under a synthetic id.
   */
  kind: Schema.optional(Schema.Literals(["folder"])),
});
export type StatisticsProjectRef = typeof StatisticsProjectRef.Type;

/**
 * Which sessions a snapshot counts: `ryco`, the threads Ryco ran (the default); `machine`, also
 * the Claude Code and Codex sessions recorded on this node, run outside Ryco.
 */
export const StatisticsScope = Schema.Literals(["ryco", "machine"]);
export type StatisticsScope = typeof StatisticsScope.Type;

/**
 * Where a bucket's usage was read, for buckets not from Ryco's own turn records:
 * - `outside`: a Claude Code or Codex session Ryco did not run (a terminal, an IDE, another app).
 * - `ryco-subagent`: subagents of a session Ryco ran. Ryco's turn records count the main session
 *   only, so their usage is read from the provider's session files and attributed to Ryco.
 */
export const StatisticsUsageSource = Schema.Literals(["outside", "ryco-subagent"]);
export type StatisticsUsageSource = typeof StatisticsUsageSource.Type;

/**
 * One row per `(date, project, provider, model)`. Numeric fields are plain
 * numbers (sums) to stay permissive — a provider that reports fractional usage
 * will not fail decoding.
 */
/** The billing speed a turn ran at; absent means standard. */
export const StatisticsSpeed = Schema.Literals(["fast", "ultrafast"]);
export type StatisticsSpeed = typeof StatisticsSpeed.Type;

export const StatisticsDailyBucket = Schema.Struct({
  /** Calendar day in UTC, formatted YYYY-MM-DD. */
  date: Schema.String,
  projectId: ProjectId,
  model: Schema.String,
  provider: Schema.optional(Schema.String),
  /**
   * Usage run at a faster, pricier speed gets its own bucket. Pivots add buckets up, so a
   * `(date, project, provider, model)` may have one bucket per speed.
   */
  speed: Schema.optional(StatisticsSpeed),
  /** Absent: Ryco's own turn records. Session-file usage gets its own bucket per source. */
  source: Schema.optional(StatisticsUsageSource),
  /** Includes cache reads (`cachedInputTokens`) and, where reported, cache writes. */
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cachedInputTokens: Schema.Number,
  /** Cache writes within `inputTokens`. Absent from nodes that do not record them. */
  cacheWriteInputTokens: Schema.optional(Schema.Number),
  /**
   * Estimated USD at published rates (the node's usage price list and custom prices). Absent
   * when the bucket has no tokens or its model has no known price.
   */
  costUsd: Schema.optional(Schema.Number),
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

export const StatisticsMachineUsageState = Schema.Literals([
  /** The node's setting turns reading sessions outside Ryco off. */
  "disabled",
  /** The first read (or a refresh) is still running; `progress` says how far. */
  "reading",
  "ready",
  /** The read failed as a whole (no directory could be listed). */
  "failed",
]);
export type StatisticsMachineUsageState = typeof StatisticsMachineUsageState.Type;

/**
 * How the node read the Claude Code and Codex session files of a `machine` snapshot. Counts
 * describe the last completed read; only token counts, model names, times and directory names
 * are taken from the files.
 */
export const StatisticsMachineUsage = Schema.Struct({
  state: StatisticsMachineUsageState,
  /** While `reading`: how much of the current read is done. */
  progress: Schema.optional(
    Schema.Struct({
      readFileCount: Schema.Number,
      fileCount: Schema.Number,
      readBytes: Schema.Number,
      totalBytes: Schema.Number,
    }),
  ),
  /** When the shown session-file usage was read. Absent before the first read completes. */
  readAt: Schema.optional(IsoDateTime),
  readDurationMs: Schema.optional(Schema.Number),
  fileCount: Schema.Number,
  totalBytes: Schema.Number,
  /** Files read (in full or from where an appended file stopped) by the last read. */
  parsedFileCount: Schema.Number,
  /** Unchanged files taken from the node's cache without reading them. */
  reusedFileCount: Schema.Number,
  /** Lines that were not valid JSON, and truncated or oversized lines. */
  malformedLineCount: Schema.Number,
  /** Files that vanished, changed during the read, or could not be read in full. */
  failedFileCount: Schema.Number,
  /** Directories that could not be listed. */
  unreadableDirectoryCount: Schema.Number,
  /** Responses a session file repeats (resumed or forked sessions), counted once. */
  duplicateResponseCount: Schema.Number,
  /** Responses of sessions Ryco ran, left to Ryco's own records so nothing counts twice. */
  rycoResponseCount: Schema.Number,
  /** Distinct sessions run outside Ryco, in all history. */
  outsideSessionCount: Schema.Number,
});
export type StatisticsMachineUsage = typeof StatisticsMachineUsage.Type;

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
  /** Where `costUsd` came from. Absent from nodes that do not price statistics. */
  pricing: Schema.optional(UsagePricingState),
  recentPullRequests: Schema.Array(StatisticsRecentPullRequest).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  /** The scope the node answered for. Absent: `ryco` (also every node without the scope). */
  scope: Schema.optional(StatisticsScope),
  /** With `scope: "machine"`: how the session files outside Ryco were read. */
  machine: Schema.optional(StatisticsMachineUsage),
});
export type StatisticsSnapshot = typeof StatisticsSnapshot.Type;

export const StatisticsRequest = Schema.Struct({
  /** Absent: `ryco`. Nodes without the scope ignore it and answer for `ryco`. */
  scope: Schema.optional(StatisticsScope),
});
export type StatisticsRequest = typeof StatisticsRequest.Type;
