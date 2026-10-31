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
 * The node:sqlite client is synchronous and the writer owns one connection, so
 * rows are read in one transaction on the read-only worker connection
 * (SqliteReadClient) when the runtime has one, then decoded and aggregated on
 * the main thread in chunks. Reads are kept minimal: per-thread partial
 * aggregates are cached in memory and persisted (statistics_thread_partials),
 * and only threads with new orchestration events are re-read (see
 * {@link StatisticsState}), also on the first open after a restart. The RPC
 * serves the previous snapshot when a refresh takes longer than a short wait
 * (stale-while-revalidate).
 *
 * A fork's inherited turns and activities are display copies of its source's history: the work
 * is already counted once, on the source, so every reader here leaves them out.
 *
 * @module StatisticsQuery
 */
import { type StatisticsSnapshot } from "@ryco/contracts";
import { Context, Duration, Effect, Fiber, Layer, Option, Schema, Semaphore } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../persistence/Errors.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "../orchestration/projectorNames.ts";
import { SqliteReadClient } from "../persistence/SqliteReadClient.ts";
import {
  assembleStatisticsSnapshot,
  buildStatisticsThreadMeta,
  computeStatisticsThreadPartial,
  groupStatisticsRowsByThread,
  mergeStatisticsThreadPartials,
  normalizeStatisticsThreadPartial,
  StatisticsProjectRow,
  StatisticsThreadRow,
  StatisticsTokenActivityRow,
  StatisticsToolUseRow,
  StatisticsTurnRow,
  StatisticsWorktreeRow,
  statisticsThreadMetaKey,
  type StatisticsThreadPartial,
} from "./statisticsAggregation.ts";
import {
  selectStatisticsThreads,
  selectStatisticsTokenActivities,
  selectStatisticsToolUses,
  selectStatisticsTurns,
} from "./statisticsRows.ts";

export { selectStatisticsTokenActivities, selectStatisticsToolUses } from "./statisticsRows.ts";

/**
 * StatisticsQueryShape - service API.
 */
export interface StatisticsQueryShape {
  readonly getStatistics: (
    options?: GetStatisticsOptions,
  ) => Effect.Effect<StatisticsSnapshot, ProjectionRepositoryError>;
}

/**
 * StatisticsQuery - service tag.
 */
export class StatisticsQuery extends Context.Service<StatisticsQuery, StatisticsQueryShape>()(
  "ryco/statistics/StatisticsQuery",
) {}

/** Projectors that write the thread-scoped rows a partial is computed from. */
const THREAD_SCOPED_PROJECTORS = JSON.stringify([
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
]);

/** Above this many changed threads a full read is as cheap as a scoped one. */
const INCREMENTAL_THREAD_LIMIT = 256;
/** Partials written per transaction when persisting. */
const PERSIST_CHUNK_THREADS = 200;
/** Yield to other fibers between aggregation chunks of this many threads. */
const AGGREGATION_CHUNK_THREADS = 256;

interface StatisticsRevision {
  /** Writes on the main connection. Never reset by a rollback. */
  readonly writes: number;
  /** Commits from other processes, as seen by the main connection. */
  readonly externalVersion: number;
  readonly eventSequence: number;
  /** Lowest cursor of the thread-scoped projectors (0 while one has none). */
  readonly projectedSequence: number;
  /** The latest applied migration; persisted partials are only reused under the same schema. */
  readonly schemaVersion: string;
}

/**
 * Cached aggregation. Thread-scoped rows (context-window events, activities,
 * turns) are written only by the projection pipeline, in the same transaction
 * as the thread's orchestration event. So a thread whose partial is current
 * stays current until an event with a higher sequence appears on its stream.
 * Global rows (threads, sessions, projects, worktrees) are small and re-read on
 * every miss, which also catches thread meta changes that re-bucket a partial.
 */
interface StatisticsState {
  /** Null for partials restored from disk: they never match a live revision. */
  readonly writes: number | null;
  readonly externalVersion: number | null;
  readonly eventSequence: number;
  /** Every thread event up to this sequence is reflected in `partials`. */
  readonly coveredSequence: number;
  readonly partials: ReadonlyMap<string, StatisticsThreadPartial>;
  /** Undefined for partials restored from disk. */
  readonly snapshot: StatisticsSnapshot | undefined;
}

/**
 * Bump whenever {@link computeStatisticsThreadPartial} would produce different
 * partials for the same rows: persisted partials of another version are dropped.
 */
export const STATISTICS_PARTIAL_FORMAT_VERSION = 1;

/** How long the RPC waits for a refresh before it answers with the previous snapshot. */
export const STATISTICS_STALE_WHILE_REVALIDATE_WAIT_MS = 250;

export interface GetStatisticsOptions {
  /**
   * Stale-while-revalidate: when a previous snapshot exists and a refresh takes
   * longer than this, answer with the previous snapshot (its `generatedAt` says
   * how old it is) and let the refresh finish in the background for the next
   * request. Omit for a fresh answer.
   */
  readonly maxWaitMs?: number;
}

const decodeThreadRows = Schema.decodeUnknownEffect(Schema.Array(StatisticsThreadRow));
const decodeProjectRows = Schema.decodeUnknownEffect(Schema.Array(StatisticsProjectRow));
const decodeTokenRows = Schema.decodeUnknownEffect(Schema.Array(StatisticsTokenActivityRow));
const decodeToolUseRows = Schema.decodeUnknownEffect(Schema.Array(StatisticsToolUseRow));
const decodeTurnRows = Schema.decodeUnknownEffect(Schema.Array(StatisticsTurnRow));
const decodeWorktreeRows = Schema.decodeUnknownEffect(Schema.Array(StatisticsWorktreeRow));

const decodeError = (operation: string) =>
  toPersistenceDecodeError(`StatisticsQuery.getStatistics:${operation}:decodeRows`);

/** Keep decode errors raised while reading; everything else is a SQL failure. */
const readError = (operation: string) => (cause: SqlError | ProjectionRepositoryError) =>
  isPersistenceError(cause)
    ? (cause as ProjectionRepositoryError)
    : toPersistenceSqlError(`StatisticsQuery.getStatistics:${operation}`)(cause);

/**
 * The usage of deleted thread incarnations whose events retention removed
 * (`statistics_usage_rollups`), with the stream's newest sequence: a thread whose newest event is
 * still the deletion a rollup was taken at is frozen (its partial is the rollups alone); a later
 * event means the id was created again, and its live rows add to the rollups.
 */
const listUsageRollups = (db: SqlClient.SqlClient) =>
  db<{
    readonly threadId: string;
    readonly deletedSequence: number;
    readonly partialJson: string;
    readonly head: number | null;
  }>`
    SELECT
      r.thread_id AS "threadId",
      r.deleted_sequence AS "deletedSequence",
      r.partial_json AS "partialJson",
      (
        SELECT MAX(e.sequence) FROM orchestration_events e
        WHERE e.aggregate_kind = 'thread' AND e.stream_id = r.thread_id
      ) AS "head"
    FROM statistics_usage_rollups r
  `;

interface ThreadUsageRollup {
  readonly frozen: boolean;
  readonly partials: ReadonlyArray<StatisticsThreadPartial>;
}

const parsePartial = (json: string) => {
  try {
    return normalizeStatisticsThreadPartial(JSON.parse(json));
  } catch {
    return undefined;
  }
};

function groupUsageRollups(
  rows: ReadonlyArray<{
    readonly threadId: string;
    readonly deletedSequence: number;
    readonly partialJson: string;
    readonly head: number | null;
  }>,
): ReadonlyMap<string, ThreadUsageRollup> {
  const byThread = new Map<
    string,
    { latest: number; head: number | null; partials: StatisticsThreadPartial[] }
  >();
  for (const row of rows) {
    let entry = byThread.get(row.threadId);
    if (entry === undefined) {
      entry = { latest: 0, head: row.head === null ? null : Number(row.head), partials: [] };
      byThread.set(row.threadId, entry);
    }
    entry.latest = Math.max(entry.latest, Number(row.deletedSequence));
    const partial = parsePartial(row.partialJson);
    if (partial !== undefined) entry.partials.push(partial);
  }
  const rollups = new Map<string, ThreadUsageRollup>();
  for (const [threadId, entry] of byThread) {
    rollups.set(threadId, {
      frozen: entry.head === null || entry.head <= entry.latest,
      partials: entry.partials,
    });
  }
  return rollups;
}

export const makeStatisticsQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Row reads run on the read-only worker connection when the runtime has one, so neither the
  // event loop nor the writer's connection is held while SQLite reads the history.
  const reader = Option.getOrElse(yield* Effect.serviceOption(SqliteReadClient), () => sql);
  const scope = yield* Effect.scope;

  // Cheap (a few index probes) and on the main connection: total_changes() and data_version
  // are per-connection, and only the writer's values say whether anything changed.
  const readRevision = sql<StatisticsRevision>`
    SELECT
      total_changes() AS writes,
      (SELECT data_version FROM pragma_data_version) AS "externalVersion",
      COALESCE((SELECT MAX(sequence) FROM orchestration_events), 0) AS "eventSequence",
      (
        -- A projector without a cursor has applied nothing yet.
        SELECT CASE
          WHEN COUNT(*) < json_array_length(${THREAD_SCOPED_PROJECTORS}) THEN 0
          ELSE MIN(last_applied_sequence)
        END
        FROM projection_state
        WHERE projector IN (SELECT value FROM json_each(${THREAD_SCOPED_PROJECTORS}))
      ) AS "projectedSequence",
      COALESCE((SELECT CAST(MAX(migration_id) AS TEXT) FROM effect_sql_migrations), '0')
        AS "schemaVersion"
  `.pipe(Effect.map((rows) => rows[0]!));

  const listThreadRows = (db: SqlClient.SqlClient) =>
    selectStatisticsThreads(db, null).pipe(
      Effect.flatMap(decodeThreadRows),
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? decodeError("listThreads")(cause)
          : toPersistenceSqlError("StatisticsQuery.getStatistics:listThreads:query")(cause),
      ),
    );

  const listProjectRows = (db: SqlClient.SqlClient) => db`
    SELECT
      project_id AS "projectId",
      title,
      deleted_at AS "deletedAt"
    FROM projection_projects
  `;

  const listWorktreeRows = (db: SqlClient.SqlClient) => db`
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
      pr_is_draft AS "prIsDraft",
      pr_terminal_at AS "prTerminalAt",
      origin,
      pull_requests_json AS "pullRequests"
    FROM projection_worktrees
  `;

  const listThreadsWithEventsAfter = (db: SqlClient.SqlClient, sequence: number) =>
    db<{ readonly threadId: string }>`
      SELECT DISTINCT stream_id AS "threadId"
      FROM orchestration_events
      WHERE sequence > ${sequence} AND aggregate_kind = 'thread'
    `;

  /**
   * Everything one aggregation needs, read under one transaction of `db`.
   * `dirty` is null for a full rebuild.
   */
  const readRows = (
    db: SqlClient.SqlClient,
    state: StatisticsState | undefined,
    revision: StatisticsRevision,
  ) =>
    Effect.gen(function* () {
      const threadRows = yield* listThreadRows(db);
      const threadMeta = buildStatisticsThreadMeta(threadRows);
      // Thread-scoped rows change only together with an event on the thread's
      // stream, so new events (plus meta changes) name every thread to re-read.
      // A commit from another process seen by a live cache, events that
      // disappeared, or projections that were reset cannot be attributed:
      // rebuild everything. Partials restored from disk carry no connection
      // revision; they were validated against the schema and sequences on load.
      let dirty: Set<string> | null = null;
      if (
        state !== undefined &&
        (state.externalVersion === null || state.externalVersion === revision.externalVersion) &&
        revision.eventSequence >= state.eventSequence &&
        revision.projectedSequence >= state.coveredSequence
      ) {
        dirty = new Set<string>();
        for (const row of yield* listThreadsWithEventsAfter(db, state.coveredSequence)) {
          dirty.add(row.threadId);
        }
        for (const [threadId, meta] of threadMeta) {
          if (state.partials.get(threadId)?.metaKey !== statisticsThreadMetaKey(meta)) {
            dirty.add(threadId);
          }
        }
        for (const [threadId, partial] of state.partials) {
          if (!threadMeta.has(threadId) && partial.metaKey !== statisticsThreadMetaKey(undefined)) {
            dirty.add(threadId);
          }
        }
        if (dirty.size > Math.max(INCREMENTAL_THREAD_LIMIT, threadMeta.size / 4)) dirty = null;
      }
      const scope = dirty === null ? null : JSON.stringify([...dirty]);
      const readScoped = (
        read: (scope: string | null) => Effect.Effect<ReadonlyArray<unknown>, SqlError>,
      ) => (dirty !== null && dirty.size === 0 ? Effect.succeed([]) : read(scope));
      return {
        revision,
        threadMeta,
        dirty,
        projectRows: yield* listProjectRows(db),
        worktreeRows: yield* listWorktreeRows(db),
        tokenRows: yield* readScoped((scope) => selectStatisticsTokenActivities(db, scope)),
        toolRows: yield* readScoped((scope) => selectStatisticsToolUses(db, scope)),
        turnRows: yield* readScoped((scope) => selectStatisticsTurns(db, scope)),
        rollups: groupUsageRollups(yield* listUsageRollups(db)),
      };
    });

  type ReadRows = Effect.Success<ReturnType<typeof readRows>>;

  /** Decode and aggregate outside the transaction, yielding between thread chunks. */
  const aggregate = (state: StatisticsState | undefined, read: ReadRows) =>
    Effect.gen(function* () {
      const [projectRows, worktreeRows, tokenRows, toolRows, turnRows] = yield* Effect.all([
        decodeProjectRows(read.projectRows).pipe(Effect.mapError(decodeError("listProjects"))),
        decodeWorktreeRows(read.worktreeRows).pipe(Effect.mapError(decodeError("listWorktrees"))),
        decodeTokenRows(read.tokenRows).pipe(Effect.mapError(decodeError("listTokenActivities"))),
        decodeToolUseRows(read.toolRows).pipe(Effect.mapError(decodeError("listToolUses"))),
        decodeTurnRows(read.turnRows).pipe(Effect.mapError(decodeError("listTurns"))),
      ]);
      // A frozen thread's rows (projection rows outlive its removed events) are already in its
      // rollup: they are never counted again.
      const live = <Row extends { readonly threadId: string }>(rows: ReadonlyArray<Row>) =>
        read.rollups.size === 0
          ? rows
          : rows.filter((row) => read.rollups.get(row.threadId)?.frozen !== true);
      const groups = groupStatisticsRowsByThread({
        threadIds: read.dirty ?? new Set([...read.threadMeta.keys(), ...read.rollups.keys()]),
        tokens: live(tokenRows),
        turns: live(turnRows),
        tools: live(toolRows),
      });
      const partials = new Map(read.dirty === null || state === undefined ? [] : state.partials);
      const changed = new Set<string>();
      let processed = 0;
      for (const [threadId, rows] of groups) {
        const meta = read.threadMeta.get(threadId);
        const rollup = read.rollups.get(threadId);
        const computed = computeStatisticsThreadPartial(meta, rows);
        const partial =
          rollup === undefined
            ? computed
            : mergeStatisticsThreadPartials(statisticsThreadMetaKey(meta), [
                ...(rollup.frozen ? [] : [computed]),
                ...rollup.partials,
              ]);
        // A thread without meta or rows contributes nothing and never turns dirty.
        if (meta === undefined && partial.earliest === undefined) partials.delete(threadId);
        else partials.set(threadId, partial);
        changed.add(threadId);
        if (++processed % AGGREGATION_CHUNK_THREADS === 0) yield* Effect.yieldNow;
      }
      const snapshot = assembleStatisticsSnapshot({
        threadMeta: read.threadMeta,
        partials: partials.values(),
        projectRows,
        worktreeRows,
        generatedAt: new Date().toISOString(),
      });
      const { revision } = read;
      return {
        state: {
          writes: revision.writes,
          externalVersion: revision.externalVersion,
          eventSequence: revision.eventSequence,
          coveredSequence: Math.min(revision.eventSequence, revision.projectedSequence),
          partials,
          snapshot,
        } satisfies StatisticsState,
        /** Thread ids whose partial was recomputed; null when every partial was. */
        changed: read.dirty === null ? null : changed,
      };
    });

  /**
   * Restores the partials the previous process persisted, when they were
   * written under this schema and aggregation format and the history has not
   * moved backwards since. Anything else, including unreadable rows, means a
   * full recompute; the stored rows are a cache, never a source of truth.
   */
  const loadPersistedState = (revision: StatisticsRevision) =>
    Effect.gen(function* () {
      const [header] = yield* reader<{
        readonly formatVersion: number;
        readonly schemaVersion: string;
        readonly coveredSequence: number;
        readonly eventSequence: number;
      }>`
        SELECT
          format_version AS "formatVersion",
          schema_version AS "schemaVersion",
          covered_sequence AS "coveredSequence",
          event_sequence AS "eventSequence"
        FROM statistics_partials_state WHERE id = 1
      `;
      if (
        header === undefined ||
        header.formatVersion !== STATISTICS_PARTIAL_FORMAT_VERSION ||
        header.schemaVersion !== revision.schemaVersion ||
        header.eventSequence > revision.eventSequence ||
        header.coveredSequence > revision.projectedSequence
      ) {
        return undefined;
      }
      const rows = yield* reader<{ readonly threadId: string; readonly partialJson: string }>`
        SELECT thread_id AS "threadId", partial_json AS "partialJson"
        FROM statistics_thread_partials
      `;
      const partials = new Map<string, StatisticsThreadPartial>();
      for (const row of rows) {
        partials.set(row.threadId, JSON.parse(row.partialJson) as StatisticsThreadPartial);
      }
      return {
        writes: null,
        externalVersion: null,
        eventSequence: header.eventSequence,
        coveredSequence: header.coveredSequence,
        partials,
        snapshot: undefined,
      } satisfies StatisticsState;
    }).pipe(
      // Older schema (no table yet) or a corrupt row: recompute instead.
      Effect.catchCause(() => Effect.succeed(undefined)),
    );

  /**
   * Writes the recomputed partials, so the next process starts incremental.
   * Rows go in short transactions so the writer's connection is never held for
   * a whole rebuild; the header is removed first and written last, so an
   * interrupted write leaves no header and the next process recomputes.
   * Returns how many rows this wrote on the main connection, so the cached
   * revision can account for its own writes.
   */
  const persistState = (state: StatisticsState, changed: ReadonlySet<string> | null) =>
    Effect.gen(function* () {
      let ownWrites = 0;
      const writeChunk = <A, E>(effect: Effect.Effect<A, E>) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const [before] = yield* sql<{ readonly writes: number }>`
              SELECT total_changes() AS writes
            `;
            const result = yield* effect;
            const [after] = yield* sql<{ readonly writes: number }>`
              SELECT total_changes() AS writes
            `;
            ownWrites += (after?.writes ?? 0) - (before?.writes ?? 0);
            return result;
          }),
        );
      yield* writeChunk(
        Effect.gen(function* () {
          yield* sql`DELETE FROM statistics_partials_state`;
          if (changed === null) yield* sql`DELETE FROM statistics_thread_partials`;
        }),
      );
      const threadIds = [...(changed ?? state.partials.keys())];
      for (let offset = 0; offset < threadIds.length; offset += PERSIST_CHUNK_THREADS) {
        yield* writeChunk(
          Effect.forEach(
            threadIds.slice(offset, offset + PERSIST_CHUNK_THREADS),
            (threadId) => {
              const partial = state.partials.get(threadId);
              return partial === undefined
                ? sql`DELETE FROM statistics_thread_partials WHERE thread_id = ${threadId}`
                : sql`
                    INSERT INTO statistics_thread_partials (thread_id, partial_json)
                    VALUES (${threadId}, ${JSON.stringify(partial)})
                    ON CONFLICT (thread_id) DO UPDATE SET partial_json = excluded.partial_json
                  `;
            },
            { discard: true },
          ),
        );
      }
      yield* writeChunk(
        Effect.gen(function* () {
          const [schema] = yield* sql<{ readonly version: string }>`
            SELECT COALESCE(CAST(MAX(migration_id) AS TEXT), '0') AS version
            FROM effect_sql_migrations
          `;
          yield* sql`
            INSERT INTO statistics_partials_state (
              id, format_version, schema_version, covered_sequence, event_sequence, updated_at
            ) VALUES (
              1, ${STATISTICS_PARTIAL_FORMAT_VERSION}, ${schema?.version ?? "0"},
              ${state.coveredSequence}, ${state.eventSequence}, ${new Date().toISOString()}
            )
          `;
        }),
      );
      return ownWrites;
    }).pipe(
      // A cache write must never fail a read; the next process recomputes instead.
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to persist statistics partials", { cause }).pipe(Effect.as(0)),
      ),
    );

  // Keep only one aggregation state and serialize misses, so simultaneous
  // requests share the work without retaining historical analytics copies.
  const cacheLock = yield* Semaphore.make(1);
  let cached: StatisticsState | undefined;
  let restored = false;

  const refresh: Effect.Effect<StatisticsSnapshot, ProjectionRepositoryError> =
    cacheLock.withPermit(
      Effect.gen(function* () {
        const revision = yield* readRevision.pipe(Effect.mapError(readError("revision")));
        let state = cached;
        if (
          state?.snapshot !== undefined &&
          state.writes === revision.writes &&
          state.externalVersion === revision.externalVersion
        ) {
          return state.snapshot;
        }
        if (state === undefined && !restored) {
          restored = true;
          state = yield* loadPersistedState(revision);
        }
        const read = yield* reader
          .withTransaction(readRows(reader, state, revision))
          .pipe(Effect.mapError(readError("transaction")));
        const next = yield* aggregate(state, read);
        const ownWrites =
          next.changed === null || next.changed.size > 0
            ? yield* persistState(next.state, next.changed)
            : 0;
        cached = { ...next.state, writes: revision.writes + ownWrites };
        return next.state.snapshot!;
      }),
    );

  // One background refresh at a time for stale-while-revalidate callers.
  let backgroundRefresh: Fiber.Fiber<StatisticsSnapshot, ProjectionRepositoryError> | undefined;
  const sharedRefresh = Effect.suspend(() => {
    const running = backgroundRefresh;
    if (running !== undefined && running.pollUnsafe() === undefined) {
      return Effect.succeed(running);
    }
    return Effect.forkIn(refresh, scope).pipe(
      Effect.tap((fiber) =>
        Effect.sync(() => {
          // The forked refresh may already have finished when this runs (a
          // cache hit completes synchronously if this fiber yields right after
          // the fork). The observer fires at once in that case, so the slot is
          // always released and later callers never join a stale result.
          backgroundRefresh = fiber;
          fiber.addObserver(() => {
            if (backgroundRefresh === fiber) backgroundRefresh = undefined;
          });
        }),
      ),
    );
  });

  const getStatistics: StatisticsQueryShape["getStatistics"] = (options) =>
    Effect.gen(function* () {
      // A caller may inspect uncommitted data. Never publish that result into
      // the shared cache: a rollback does not reset SQLite's total_changes.
      if (Option.isSome(yield* Effect.serviceOption(sql.transactionService))) {
        const revision = yield* readRevision.pipe(Effect.mapError(readError("revision")));
        const read = yield* readRows(sql, undefined, revision).pipe(
          Effect.mapError(readError("query")),
        );
        return (yield* aggregate(undefined, read)).state.snapshot!;
      }
      const stale = cached?.snapshot;
      if (options?.maxWaitMs === undefined || stale === undefined) return yield* refresh;
      const fiber = yield* sharedRefresh;
      const fresh = yield* Fiber.join(fiber).pipe(
        Effect.timeoutOption(Duration.millis(options.maxWaitMs)),
      );
      return Option.getOrElse(fresh, () => stale);
    });

  return { getStatistics } satisfies StatisticsQueryShape;
});

export const StatisticsQueryLive = Layer.effect(StatisticsQuery, makeStatisticsQuery);
