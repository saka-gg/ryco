/**
 * StatisticsQuery - usage analytics over the orchestration projection tables.
 *
 * Aggregates the existing read models (threads, sessions, token-usage
 * activities, turns/checkpoints, worktrees) into a {@link StatisticsSnapshot}
 * on demand. No dedicated statistics tables exist; everything is derived from
 * data already persisted by the projection pipeline.
 *
 * Processed billing counters are read from indexed activity event history, with
 * projection-only/imported rows as a fallback. Session counters are differenced;
 * turn and request counters retain their final snapshots. Context-window gauges
 * remain a best-effort fallback for older/provider-limited data.
 *
 * @module StatisticsQuery
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
} from "@ryco/contracts";
import { Context, Effect, Layer, Option, Schema, Semaphore } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { collectProcessedTokenUsage } from "./processedTokenUsage.ts";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../persistence/Errors.ts";

/**
 * StatisticsQueryShape - service API.
 */
export interface StatisticsQueryShape {
  readonly getStatistics: () => Effect.Effect<StatisticsSnapshot, ProjectionRepositoryError>;
}

/**
 * StatisticsQuery - service tag.
 */
export class StatisticsQuery extends Context.Service<StatisticsQuery, StatisticsQueryShape>()(
  "ryco/statistics/StatisticsQuery",
) {}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const ThreadRow = Schema.Struct({
  threadId: Schema.String,
  projectId: ProjectId,
  model: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  providerName: Schema.NullOr(Schema.String),
});

const ProjectRow = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  deletedAt: Schema.NullOr(Schema.String),
});

const TokenActivityRow = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  sequence: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
  payloadJson: Schema.String,
});

const ToolUseRow = Schema.Struct({
  threadId: Schema.String,
  date: Schema.String,
  count: Schema.Number,
});

const TurnRow = Schema.Struct({
  threadId: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  completedAt: Schema.NullOr(Schema.String),
  checkpointTurnCount: Schema.NullOr(Schema.Number),
  filesJson: Schema.String,
});

const WorktreeRow = Schema.Struct({
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
});

interface MutableBucket {
  date: string;
  projectId: ProjectId;
  model: string;
  provider: string | undefined;
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

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dayOf(iso: string): string | null {
  return iso.length >= 10 ? iso.slice(0, 10) : null;
}

function bestPerTurnTotalTokenCount(payload: Record<string, unknown> | null): number {
  const reportedTotal = num(payload?.lastUsedTokens);
  if (reportedTotal > 0) {
    return reportedTotal;
  }
  return num(payload?.lastInputTokens) + num(payload?.lastOutputTokens);
}

function bestCumulativeTotalTokenCount(payload: Record<string, unknown> | null): number {
  const reportedTotal = num(payload?.usedTokens);
  if (reportedTotal > 0) {
    return reportedTotal;
  }
  return num(payload?.inputTokens) + num(payload?.outputTokens);
}

function hasExactPerTurnBreakdown(payload: Record<string, unknown> | null): boolean {
  return (
    num(payload?.lastInputTokens) +
      num(payload?.lastOutputTokens) +
      num(payload?.lastCachedInputTokens) +
      num(payload?.lastReasoningOutputTokens) >
    0
  );
}

function addPerTurnUsage(bucket: MutableBucket, payload: Record<string, unknown> | null): void {
  bucket.inputTokens += num(payload?.lastInputTokens);
  bucket.outputTokens += num(payload?.lastOutputTokens);
  bucket.cachedInputTokens += num(payload?.lastCachedInputTokens);
  bucket.reasoningTokens += num(payload?.lastReasoningOutputTokens);
  bucket.totalTokens += bestPerTurnTotalTokenCount(payload);
}

function addCumulativeUsage(bucket: MutableBucket, payload: Record<string, unknown> | null): void {
  bucket.inputTokens += num(payload?.inputTokens);
  bucket.outputTokens += num(payload?.outputTokens);
  bucket.cachedInputTokens += num(payload?.cachedInputTokens);
  bucket.reasoningTokens += num(payload?.reasoningOutputTokens);
  bucket.totalTokens += bestCumulativeTotalTokenCount(payload);
}

const makeStatisticsQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadRow,
    execute: () =>
      sql`
        SELECT
          t.thread_id AS "threadId",
          t.project_id AS "projectId",
          json_extract(t.model_selection_json, '$.model') AS "model",
          COALESCE(
            json_extract(t.model_selection_json, '$.instanceId'),
            json_extract(t.model_selection_json, '$.provider')
          ) AS "providerInstanceId",
          t.created_at AS "createdAt",
          COALESCE(
            s.provider_name,
            json_extract(t.model_selection_json, '$.instanceId'),
            json_extract(t.model_selection_json, '$.provider')
          ) AS "providerName"
        FROM projection_threads t
        LEFT JOIN projection_thread_sessions s ON s.thread_id = t.thread_id
      `,
  });

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectRow,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          deleted_at AS "deletedAt"
        FROM projection_projects
      `,
  });

  const listTokenActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: TokenActivityRow,
    execute: () =>
      sql`
        SELECT
          stream_id AS "threadId",
          json_extract(payload_json, '$.activity.turnId') AS "turnId",
          COALESCE(json_extract(payload_json, '$.activity.sequence'), sequence) AS sequence,
          json_extract(payload_json, '$.activity.createdAt') AS "createdAt",
          json_extract(payload_json, '$.activity.payload') AS "payloadJson"
        FROM orchestration_events
        WHERE event_type = 'thread.activity-appended'
          AND json_extract(payload_json, '$.activity.kind') = 'context-window.updated'
        UNION ALL
        SELECT
          thread_id AS "threadId", turn_id AS "turnId", sequence,
          created_at AS "createdAt", payload_json AS "payloadJson"
        FROM projection_thread_activities a
        WHERE kind = 'context-window.updated'
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_events e
            WHERE e.event_type = 'thread.activity-appended'
              AND json_extract(e.payload_json, '$.activity.kind') = 'context-window.updated'
              AND e.stream_id = a.thread_id
              AND json_extract(e.payload_json, '$.activity.id') = a.activity_id
              AND json_extract(e.payload_json, '$.activity.createdAt') = a.created_at
          )
        ORDER BY "threadId", "createdAt", sequence
      `,
  });

  const listToolUseRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ToolUseRow,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          substr(created_at, 1, 10) AS "date",
          COUNT(*) AS "count"
        FROM projection_thread_activities
        WHERE kind = 'tool.completed'
        GROUP BY thread_id, substr(created_at, 1, 10)
      `,
  });

  const listTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: TurnRow,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          started_at AS "startedAt",
          completed_at AS "completedAt",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_files_json AS "filesJson"
        FROM projection_turns
      `,
  });

  const listWorktreeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: WorktreeRow,
    execute: () =>
      sql`
        SELECT
          worktree_id AS "worktreeId",
          project_id AS "projectId",
          title,
          branch,
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          pr_number AS "prNumber",
          pr_title AS "prTitle",
          pr_state AS "prState",
          pr_is_draft AS "prIsDraft"
        FROM projection_worktrees
      `,
  });

  const computeStatistics: StatisticsQueryShape["getStatistics"] = () =>
    Effect.gen(function* () {
      const [threadRows, projectRows, tokenRows, toolRows, turnRows, worktreeRows] =
        yield* Effect.all(
          [
            listThreadRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "StatisticsQuery.getStatistics:listThreads:query",
                  "StatisticsQuery.getStatistics:listThreads:decodeRows",
                ),
              ),
            ),
            listProjectRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "StatisticsQuery.getStatistics:listProjects:query",
                  "StatisticsQuery.getStatistics:listProjects:decodeRows",
                ),
              ),
            ),
            listTokenActivityRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "StatisticsQuery.getStatistics:listTokenActivities:query",
                  "StatisticsQuery.getStatistics:listTokenActivities:decodeRows",
                ),
              ),
            ),
            listToolUseRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "StatisticsQuery.getStatistics:listToolUses:query",
                  "StatisticsQuery.getStatistics:listToolUses:decodeRows",
                ),
              ),
            ),
            listTurnRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "StatisticsQuery.getStatistics:listTurns:query",
                  "StatisticsQuery.getStatistics:listTurns:decodeRows",
                ),
              ),
            ),
            listWorktreeRows(undefined).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "StatisticsQuery.getStatistics:listWorktrees:query",
                  "StatisticsQuery.getStatistics:listWorktrees:decodeRows",
                ),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );

      // ── Thread metadata + model→provider mapping ──────────────────────────
      const threadMeta = new Map<
        string,
        { projectId: ProjectId; model: string; provider: string | undefined; createdAt: string }
      >();
      const modelRefs = new Map<string, StatisticsModelRef>();
      for (const row of threadRows) {
        // Coalesce blanks to safe display values: empty/whitespace strings would
        // fail success-encoding downstream and crash the RPC.
        const provider = row.providerName?.trim() || row.providerInstanceId?.trim() || undefined;
        const model = (row.model ?? "").trim() || "unknown";
        threadMeta.set(row.threadId, {
          projectId: row.projectId,
          model,
          provider,
          createdAt: row.createdAt,
        });
        const modelKey = `${provider ?? ""}\u0000${model}`;
        modelRefs.set(modelKey, provider ? { model, provider } : { model });
      }

      const buckets = new Map<string, MutableBucket>();
      const getBucket = (
        date: string,
        projectId: ProjectId,
        model: string,
        provider: string | undefined,
      ): MutableBucket => {
        modelRefs.set(
          `${provider ?? ""}\u0000${model}`,
          provider ? { model, provider } : { model },
        );
        const key = `${date}\u0000${projectId}\u0000${provider ?? ""}\u0000${model}`;
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = {
            date,
            projectId,
            model,
            provider,
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

      // ── Tokens: pick the final activity per (thread,turn) and per thread ───
      // Within a turn, rows iterate in (sequence, created_at) order so the last
      // write is the turn's final snapshot. Across turns we must NOT rely on
      // iteration order (turn_id is opaque/non-chronological), so the per-thread
      // pick uses an explicit latest-by-(createdAt, sequence) comparison.
      const processed = collectProcessedTokenUsage(
        tokenRows,
        (threadId) => threadMeta.get(threadId)?.provider,
      );
      let usedExactPerTurn = false;
      let usedCumulativeFallback = false;
      for (const entry of processed.entries) {
        const meta = threadMeta.get(entry.row.threadId);
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

      const lastPerTurn = new Map<string, (typeof tokenRows)[number]>();
      const isLater = (a: (typeof tokenRows)[number], b: (typeof tokenRows)[number]): boolean => {
        if (a.createdAt !== b.createdAt) {
          return a.createdAt > b.createdAt;
        }
        return (a.sequence ?? -1) >= (b.sequence ?? -1);
      };
      for (const row of tokenRows) {
        considerIso(row.createdAt);
        const turnKey = `${row.threadId}\u0000${row.turnId ?? ""}`;
        if (processed.sessionThreads.has(row.threadId) || processed.turns.has(turnKey)) continue;
        const prevTurn = lastPerTurn.get(turnKey);
        if (!prevTurn || isLater(row, prevTurn)) {
          lastPerTurn.set(turnKey, row);
        }
      }

      const firstExactPerThread = new Map<string, (typeof tokenRows)[number]>();
      for (const row of lastPerTurn.values()) {
        const payload = safeParse(row.payloadJson);
        if (hasExactPerTurnBreakdown(payload)) {
          const prev = firstExactPerThread.get(row.threadId);
          if (!prev || isLater(prev, row)) {
            firstExactPerThread.set(row.threadId, row);
          }
        }
      }
      const cumulativeFallbackByThread = new Map<string, (typeof tokenRows)[number]>();
      for (const row of lastPerTurn.values()) {
        const payload = safeParse(row.payloadJson);
        if (hasExactPerTurnBreakdown(payload)) continue;
        const firstExact = firstExactPerThread.get(row.threadId);
        if (firstExact && !isLater(firstExact, row)) {
          continue;
        }
        const prev = cumulativeFallbackByThread.get(row.threadId);
        if (!prev || isLater(row, prev)) {
          cumulativeFallbackByThread.set(row.threadId, row);
        }
      }
      for (const row of lastPerTurn.values()) {
        const payload = safeParse(row.payloadJson);
        if (!hasExactPerTurnBreakdown(payload)) continue;
        const meta = threadMeta.get(row.threadId);
        const date = dayOf(row.createdAt);
        if (!meta || !date) continue;
        addPerTurnUsage(getBucket(date, meta.projectId, meta.model, meta.provider), payload);
        usedExactPerTurn = true;
      }

      for (const row of cumulativeFallbackByThread.values()) {
        const meta = threadMeta.get(row.threadId);
        const date = dayOf(row.createdAt);
        if (!meta || !date) continue;
        const payload = safeParse(row.payloadJson);
        if (bestCumulativeTotalTokenCount(payload) <= 0) continue;
        addCumulativeUsage(getBucket(date, meta.projectId, meta.model, meta.provider), payload);
        usedCumulativeFallback = true;
      }

      const attribution: StatisticsTokenAttribution =
        usedExactPerTurn && usedCumulativeFallback
          ? "mixed"
          : usedCumulativeFallback
            ? "thread-cumulative"
            : "per-turn-delta";

      // ── Turns: counts, active time, and file/line changes ─────────────────
      for (const row of turnRows) {
        const meta = threadMeta.get(row.threadId);
        if (!meta) continue;
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
        const files = safeParseArray(row.filesJson);
        if (files.length > 0) {
          bucket.filesChanged += files.length;
          for (const file of files) {
            bucket.additions += num((file as Record<string, unknown> | null)?.additions);
            bucket.deletions += num((file as Record<string, unknown> | null)?.deletions);
          }
        }
      }

      // ── Tool uses (completed tool calls) ──────────────────────────────────
      for (const row of toolRows) {
        const meta = threadMeta.get(row.threadId);
        if (!meta) continue;
        const bucket = getBucket(row.date, meta.projectId, meta.model, meta.provider);
        bucket.toolUses += num(row.count);
      }

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
        } else if (row.prNumber !== null) {
          wtOpenPrs += 1;
        }
      }

      // ── Assemble output ───────────────────────────────────────────────────
      const dailyBuckets: Array<StatisticsDailyBucket> = [];
      const totals = {
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
      for (const row of projectRows) {
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
        (a, b) =>
          (a.provider ?? "").localeCompare(b.provider ?? "") || a.model.localeCompare(b.model),
      );
      const recentPullRequests: Array<StatisticsRecentPullRequest> = worktreeRows
        .filter((row): row is typeof row & { readonly prNumber: number } => row.prNumber !== null)
        .map((row) =>
          Object.assign(
            {
              worktreeId: row.worktreeId,
              branch: row.branch,
              projectId: row.projectId,
              projectTitle: projectTitle.get(row.projectId)?.trim() || row.projectId,
              prNumber: row.prNumber,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              active: row.archivedAt === null,
            },
            row.title === null ? {} : { worktreeTitle: row.title },
            row.prTitle === null ? {} : { prTitle: row.prTitle },
            row.prState === null ? {} : { prState: row.prState },
            row.prIsDraft === null ? {} : { prIsDraft: row.prIsDraft === 1 },
            row.archivedAt === null ? {} : { archivedAt: row.archivedAt },
          ),
        )
        .toSorted(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) ||
            left.worktreeId.localeCompare(right.worktreeId),
        )
        .slice(0, 20);

      const snapshot: StatisticsSnapshot = {
        generatedAt: new Date().toISOString(),
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
      return snapshot;
    });

  // This SQLite client owns one connection. total_changes observes writes on
  // that connection (including direct repository writes), while data_version
  // observes commits from other connections. Neither reads table contents.
  // Keep only one snapshot and serialize misses, so simultaneous requests share
  // the aggregation without retaining historical copies of analytics data.
  const cacheLock = yield* Semaphore.make(1);
  let cached: { writes: number; externalVersion: number; snapshot: StatisticsSnapshot } | undefined;
  const getStatistics: StatisticsQueryShape["getStatistics"] = () =>
    Effect.gen(function* () {
      // A caller may inspect uncommitted data. Never publish that result into
      // the shared cache: a rollback does not reset SQLite's total_changes.
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
        return yield* computeStatistics();
      }
      return yield* cacheLock.withPermit(
        sql
          .withTransaction(
            Effect.gen(function* () {
              const rows = yield* sql<{ writes: number; externalVersion: number }>`
              SELECT total_changes() AS writes, data_version AS "externalVersion"
              FROM pragma_data_version
            `;
              const revision = rows[0]!;
              if (
                cached?.writes === revision.writes &&
                cached.externalVersion === revision.externalVersion
              ) {
                return cached.snapshot;
              }
              const snapshot = yield* computeStatistics();
              cached = { ...revision, snapshot };
              return snapshot;
            }),
          )
          .pipe(
            Effect.mapError(toPersistenceSqlError("StatisticsQuery.getStatistics:transaction")),
          ),
      );
    });

  return { getStatistics } satisfies StatisticsQueryShape;
});

function safeParse(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function safeParseArray(json: string): ReadonlyArray<unknown> {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export const StatisticsQueryLive = Layer.effect(StatisticsQuery, makeStatisticsQuery);
