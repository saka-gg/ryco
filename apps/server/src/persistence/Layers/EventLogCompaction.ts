/**
 * EventLogCompaction - bounded, replay-equivalent removal of superseded latest-state activity
 * events, and pruning of command receipts nobody can dispatch again.
 *
 * Events. Only `thread.activity-appended` events of the latest-state kinds whose id the kind's
 * writer minted for that thread are candidates (`latestStateCompactionKey`), and one is deleted
 * only when a later event of the same `(thread, activity id)` stays. The equivalence argument is
 * in `@ryco/shared/latestStateActivities`: server projections rebuilt or caught up from any
 * cursor, and clients resumed from any cursor, reach the same state. Context-window samples are
 * never removed (statistics read every one).
 *
 * A pass walks the log from its stored cursor `G` up to the horizon `H` in windows of sequences:
 *
 * 1. `H`: offline the head; online the largest sequence whose event is at least `settleAgeMs` old,
 *    found by binary search over the sequence key (holes tolerated; a timestamp that does not
 *    parse counts as recent). Selection also drops any row newer than the cutoff, so a
 *    non-monotonic clock never lets a recent event go.
 * 2. Each window is selected on the read worker when there is one (`SqliteReadClient`) and
 *    resolved in JS against a carry of the newest version per key from earlier windows.
 * 3. Deletes run on the main connection in adaptive batches (each one transaction, timed against
 *    `deleteBatch.targetMs`, paused between batches). A batch first checks that every survivor it
 *    relies on still exists and is skipped with a warning otherwise.
 * 4. The cursor is written in the window's last delete transaction, so `G` only moves past
 *    deletions that committed; a crash rescans the window (deleted rows are simply gone).
 *
 * The guarantee is "no survivor is ever deleted", not "everything superseded is deleted online":
 * the carry starts empty each pass and is bounded, so a key whose versions straddle two passes
 * keeps one stale version. An offline pass from the beginning with an unbounded carry removes
 * those (`fromBeginning`).
 *
 * Receipts. Readers look receipts up by command id: engine re-dispatch, client outbox replays
 * (`priorCommandOutcome`), restart continuations, delegation returns, and code that relies on a
 * receipt being absent (`LocalTaskService.settleInterruptedLocalTaskStarts` marks a delegation
 * failed when its receipt is missing; `delegatedRunStatus`). Many ids are deterministic and need
 * their receipt forever. Only ids derived from a UUID minted per emission are pruned, and only once
 * older than the cutoff: `provider:<uuid>:…` (provider runtime events) and `history:<uuid>`
 * (history recovery). The rowid cursor never passes a recent receipt of those ids (other ids pass
 * whatever their timestamp, since they are never pruned) and is clamped to the table's largest
 * rowid, since rowids of a table without AUTOINCREMENT are reused after the largest one is
 * deleted. Receipts wait until the event phase of a pass has caught up.
 *
 * State lives in `lifecycle_markers` (`orchestration_event_compaction`; dry runs keep their own
 * key so switching a dry run to deleting never skips what it only counted).
 *
 * @module EventLogCompaction
 */
import {
  LOG_COMPACTION_ACTIVITY_KINDS,
  type LatestStateCarry,
  type LatestStateEventRow,
  selectSupersededLatestStateEvents,
} from "@ryco/shared/latestStateActivities";
import { Clock, Effect, Layer, Option, Schema } from "effect";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { toPersistenceSqlError } from "../Errors.ts";
import { readLifecycleMarker, writeLifecycleMarker } from "../lifecycleMarkers.ts";
import {
  type CompactionPassResult,
  CompactionState,
  type CompactionStopReason,
  EMPTY_COMPACTION_STATE,
  EventLogCompaction,
  type EventLogCompactionMode,
  type EventLogCompactionPassOptions,
  type EventLogCompactionShape,
} from "../Services/EventLogCompaction.ts";
import { SqliteReadClient } from "../SqliteReadClient.ts";

export const EVENT_COMPACTION_STATE_KEY = "orchestration_event_compaction";
export const EVENT_COMPACTION_DRY_RUN_STATE_KEY = "orchestration_event_compaction_dry_run";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Online defaults: a bounded slice every few minutes, never competing with live streaming. */
export const ONLINE_COMPACTION_PASS_OPTIONS: EventLogCompactionPassOptions = {
  horizon: "settled",
  settleAgeMs: DAY_MS,
  maxScanSequences: 250_000,
  maxWallMs: 120_000,
  selectionPageSequences: 2_000,
  // Deleting costs ~75 µs per event on the main connection (indexes, the statistics partial
  // index reads each payload, overflow pages): 200 events stay near 15 ms even when a batch of
  // large payloads follows a fast one.
  deleteBatch: { initial: 100, min: 20, max: 200, targetMs: 8 },
  interBatchPauseMs: 8,
  idleRatio: 3,
  carryCapacity: 50_000,
  receipts: { cutoffMs: 7 * DAY_MS, pageRows: 1_000, deleteBatch: 500, maxScanRows: 250_000 },
  mode: "delete",
};

/**
 * The largest selection window when selection runs on the main connection (no read worker):
 * there it blocks the event loop, so `runPass` caps `selectionPageSequences` at this.
 */
const MAIN_CONNECTION_SELECTION_PAGE_SEQUENCES = 500;

/** Without deletions, the cursor is still saved this often (sequences scanned). */
const CURSOR_SAVE_INTERVAL_SEQUENCES = 50_000;

/** Whether a pass left work behind: settled history or old receipts still to examine. */
export const hasCompactionBacklog = (pass: {
  readonly backlogSequences: number;
  readonly receiptBacklog: boolean;
}): boolean => pass.backlogSequences > 0 || pass.receiptBacklog;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PRUNABLE_RECEIPT_COMMAND_ID = new RegExp(`^(?:provider:${UUID}:|history:${UUID}$)`, "i");

/**
 * Whether a receipt may be pruned once old: its command id embeds a UUID minted for one emission,
 * so only the emitting process could re-dispatch it, within seconds. Everything else is kept.
 */
export const isPrunableReceiptCommandId = (commandId: string): boolean =>
  PRUNABLE_RECEIPT_COMMAND_ID.test(commandId);

const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(CompactionState));
const encodeState = Schema.encodeSync(Schema.fromJsonString(CompactionState));

const stateKeyOf = (mode: EventLogCompactionMode) =>
  mode === "delete" ? EVENT_COMPACTION_STATE_KEY : EVENT_COMPACTION_DRY_RUN_STATE_KEY;

const isOlderThan = (timestamp: string | null, cutoffMs: number) => {
  if (timestamp === null) return false;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) && ms <= cutoffMs;
};

interface SelectionRow extends LatestStateEventRow {
  readonly occurredAt: string | null;
}

/**
 * The first held event in `[from, to]`: one seek on the sequence key. Exported for the plan
 * guard in tests, like the two queries below.
 */
export const firstEventFromQuery = (client: SqlClient.SqlClient, from: number, to: number) =>
  client<{ readonly sequence: number; readonly occurredAt: string | null }>`
    SELECT sequence, occurred_at AS "occurredAt" FROM orchestration_events
    WHERE sequence >= ${from} AND sequence <= ${to}
    ORDER BY sequence LIMIT 1
  `;

/**
 * One selection window. No `aggregate_kind` predicate on purpose: with it, SQLite (no ANALYZE)
 * walks every thread entry of the stream index for each window instead of the rowid range;
 * `event_type` already implies a thread event.
 */
export const compactionWindowQuery = (client: SqlClient.SqlClient, from: number, to: number) =>
  client<SelectionRow>`
    SELECT
      sequence,
      stream_id AS "streamId",
      json_extract(payload_json, '$.activity.kind') AS "kind",
      json_extract(payload_json, '$.activity.id') AS "activityId",
      occurred_at AS "occurredAt",
      length(CAST(payload_json AS BLOB)) + length(CAST(metadata_json AS BLOB)) AS "bytes"
    FROM orchestration_events
    WHERE sequence > ${from} AND sequence <= ${to}
      AND event_type = 'thread.activity-appended'
      AND json_extract(payload_json, '$.activity.kind') IN ${client.in(LOG_COMPACTION_ACTIVITY_KINDS)}
    ORDER BY sequence
  `;

export const receiptPageQuery = (client: SqlClient.SqlClient, afterRowid: number, rows: number) =>
  client<{
    readonly rowid: number;
    readonly commandId: string;
    readonly acceptedAt: string | null;
  }>`
    SELECT rowid AS "rowid", command_id AS "commandId", accepted_at AS "acceptedAt"
    FROM orchestration_command_receipts
    WHERE rowid > ${afterRowid}
    ORDER BY rowid
    LIMIT ${rows}
  `;

const adaptBatchSize = (
  size: number,
  elapsedMs: number,
  batch: EventLogCompactionPassOptions["deleteBatch"],
) => {
  if (elapsedMs > batch.targetMs * 2) return Math.max(batch.min, Math.floor(size / 2));
  if (elapsedMs < batch.targetMs / 2) return Math.min(batch.max, Math.ceil(size * 1.5));
  return size;
};

export const makeEventLogCompaction = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const reader = Option.getOrElse(yield* Effect.serviceOption(SqliteReadClient), () => sql);
  const selectionOnMain = reader === sql;
  const passLock = yield* Semaphore.make(1);

  const readState = (mode: EventLogCompactionMode) =>
    readLifecycleMarker(stateKeyOf(mode)).pipe(
      Effect.map((stored) =>
        Option.isNone(stored)
          ? EMPTY_COMPACTION_STATE
          : Option.getOrElse(decodeState(stored.value), () => EMPTY_COMPACTION_STATE),
      ),
      Effect.provideService(SqlClient.SqlClient, sql),
      Effect.mapError(toPersistenceSqlError("EventLogCompaction.readState")),
    );

  const writeState = (mode: EventLogCompactionMode, state: CompactionState) =>
    writeLifecycleMarker(stateKeyOf(mode), encodeState(state)).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );

  const firstEventFrom = (from: number, to: number) =>
    firstEventFromQuery(sql, from, to).pipe(Effect.map((rows) => rows[0]));

  /** Largest sequence in `[low, head]` whose event is old enough; `low` is known to be settled. */
  const settledHorizon = (low: number, head: number, cutoffMs: number) =>
    Effect.gen(function* () {
      let lo = low;
      let hi = head;
      while (lo < hi) {
        const mid = lo + Math.ceil((hi - lo) / 2);
        const row = yield* firstEventFrom(mid, hi);
        if (row === undefined) {
          hi = mid - 1;
        } else if (isOlderThan(row.occurredAt, cutoffMs)) {
          lo = row.sequence;
        } else {
          hi = mid - 1;
        }
      }
      return lo;
    });

  const selectWindow = (from: number, to: number) => compactionWindowQuery(reader, from, to);

  const runPass: EventLogCompactionShape["runPass"] = (options) =>
    passLock
      .withPermits(1)(
        Effect.gen(function* () {
          const passStartedMs = performance.now();
          const nowMs = yield* Clock.currentTimeMillis;
          const persist = options.persistState !== false;
          const deleting = options.mode === "delete" && persist;
          const cutoffMs = nowMs - options.settleAgeMs;
          let mainThreadMs = 0;
          const onMain = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.gen(function* () {
              const startedAt = performance.now();
              const result = yield* effect;
              mainThreadMs += performance.now() - startedAt;
              return result;
            });

          const initial = persist ? yield* readState(options.mode) : EMPTY_COMPACTION_STATE;
          const [headRow] = yield* onMain(
            sql<{
              readonly head: number | null;
            }>`SELECT MAX(sequence) AS head FROM orchestration_events`,
          );
          const head = Number(headRow?.head ?? 0);
          // A cursor past the head belongs to another log (a restored or reset file): start over.
          const storedCursor =
            initial.compactedThroughSequence > head ? 0 : initial.compactedThroughSequence;
          const startSequence = options.fromBeginning === true ? 0 : storedCursor;
          const horizonSequence =
            options.horizon === "head"
              ? head
              : yield* onMain(settledHorizon(startSequence, head, cutoffMs));

          let cursor = startSequence;
          let receiptCursor = options.fromBeginning === true ? 0 : initial.receiptRowidCursor;
          let scannedSequences = 0;
          let selectedEvents = 0;
          let deletedEvents = 0;
          let deletedBytes = 0;
          let skippedBatches = 0;
          let scannedReceipts = 0;
          let deletedReceipts = 0;
          // Cleared only when the receipt walk reaches its end; a pass whose event phase stopped
          // at a budget never starts it, so its receipts are still waiting too.
          let receiptBacklog = options.receipts !== null;
          let maxBatchMs = 0;
          const batchDurationsMs: Array<number> = [];
          const receiptBatchDurationsMs: Array<number> = [];
          let batchSize = Math.max(1, options.deleteBatch.initial);
          let receiptBatchSize = Math.max(
            1,
            Math.min(options.deleteBatch.initial, options.receipts?.deleteBatch ?? 1),
          );
          let stopReason: CompactionStopReason = "complete";
          let sequencesSinceSave = 0;
          const carry: LatestStateCarry = new Map();
          const pageSequences = Math.max(
            1,
            selectionOnMain
              ? Math.min(options.selectionPageSequences, MAIN_CONNECTION_SELECTION_PAGE_SEQUENCES)
              : options.selectionPageSequences,
          );
          const overTime = () => performance.now() - passStartedMs >= options.maxWallMs;

          const stateAt = (input: {
            readonly completedAt: string | null;
            readonly lastPass: CompactionState["lastPass"];
          }): CompactionState => ({
            version: 1,
            compactedThroughSequence: cursor,
            receiptRowidCursor: receiptCursor,
            lastPassStartedAt: new Date(nowMs).toISOString(),
            lastPassCompletedAt: input.completedAt ?? initial.lastPassCompletedAt,
            totals: {
              scannedSequences: initial.totals.scannedSequences + scannedSequences,
              deletedEvents: initial.totals.deletedEvents + deletedEvents,
              deletedBytes: initial.totals.deletedBytes + deletedBytes,
              deletedReceipts: initial.totals.deletedReceipts + deletedReceipts,
            },
            lastPass: input.lastPass ?? initial.lastPass,
          });
          const saveProgress = Effect.suspend(() =>
            persist
              ? writeState(options.mode, stateAt({ completedAt: null, lastPass: null }))
              : Effect.void,
          );
          // Online passes keep the main connection mostly idle: after each delete transaction they
          // wait at least `interBatchPauseMs` and at least `idleRatio` times as long as it took,
          // so a slow transaction (a commit-time checkpoint) is followed by a longer pause.
          const idleRatio = options.idleRatio ?? 0;
          const pauseAfter = (elapsedMs: number) => {
            const pauseMs = Math.max(options.interBatchPauseMs, elapsedMs * idleRatio);
            return pauseMs > 0 ? Effect.sleep(Math.ceil(pauseMs)) : Effect.yieldNow;
          };

          while (cursor < horizonSequence) {
            if (scannedSequences >= options.maxScanSequences) {
              stopReason = "scan-budget";
              break;
            }
            if (overTime()) {
              stopReason = "time-budget";
              break;
            }
            const windowEnd = Math.min(
              cursor + pageSequences,
              horizonSequence,
              cursor + Math.max(1, options.maxScanSequences - scannedSequences),
            );
            const rows = selectionOnMain
              ? yield* onMain(selectWindow(cursor, windowEnd))
              : yield* selectWindow(cursor, windowEnd);
            const eligible =
              options.horizon === "settled"
                ? rows.filter((row) => isOlderThan(row.occurredAt, cutoffMs))
                : rows;
            const { deletions } = selectSupersededLatestStateEvents(
              eligible,
              carry,
              options.carryCapacity,
            );
            selectedEvents += deletions.length;
            const windowSequences = windowEnd - cursor;

            if (!deleting) {
              for (const deletion of deletions) {
                deletedEvents += 1;
                deletedBytes += deletion.bytes;
              }
              cursor = windowEnd;
              scannedSequences += windowSequences;
            } else if (deletions.length === 0) {
              cursor = windowEnd;
              scannedSequences += windowSequences;
              sequencesSinceSave += windowSequences;
              if (sequencesSinceSave >= CURSOR_SAVE_INTERVAL_SEQUENCES) {
                yield* onMain(saveProgress);
                sequencesSinceSave = 0;
              }
            } else {
              let index = 0;
              while (index < deletions.length) {
                const batch = deletions.slice(index, index + batchSize);
                index += batch.length;
                const isLastBatch = index >= deletions.length;
                const survivors = [...new Set(batch.map((deletion) => deletion.supersededBy))];
                // Timed from inside the transaction to its commit: the wait for the connection
                // while the engine writes is contention, not the cost of this batch.
                let startedAt = performance.now();
                const outcome = yield* sql.withTransaction(
                  Effect.gen(function* () {
                    startedAt = performance.now();
                    const [present] = yield* sql<{ readonly count: number }>`
                    SELECT count(*) AS count FROM orchestration_events
                    WHERE sequence IN ${sql.in(survivors)}
                  `;
                    const intact = Number(present?.count ?? 0) === survivors.length;
                    if (intact) {
                      const removed = yield* sql<{ readonly sequence: number }>`
                      DELETE FROM orchestration_events
                      WHERE sequence IN ${sql.in(batch.map((deletion) => deletion.sequence))}
                        AND event_type = 'thread.activity-appended'
                      RETURNING sequence
                    `;
                      // Counted here so the state written below includes this batch; a failed
                      // commit fails the pass, so these numbers are never reported then. Only
                      // rows this statement removed count, with their own sizes.
                      const removedSequences = new Set(removed.map((row) => Number(row.sequence)));
                      deletedEvents += removedSequences.size;
                      for (const deletion of batch) {
                        if (removedSequences.has(deletion.sequence)) deletedBytes += deletion.bytes;
                      }
                    }
                    if (isLastBatch) {
                      cursor = windowEnd;
                      scannedSequences += windowSequences;
                      sequencesSinceSave = 0;
                      yield* writeState(
                        options.mode,
                        stateAt({ completedAt: null, lastPass: null }),
                      );
                    }
                    return { intact };
                  }),
                );
                const elapsedMs = performance.now() - startedAt;
                mainThreadMs += elapsedMs;
                maxBatchMs = Math.max(maxBatchMs, elapsedMs);
                batchDurationsMs.push(elapsedMs);
                if (!outcome.intact) {
                  skippedBatches += 1;
                  yield* Effect.logWarning(
                    "event log compaction skipped a batch: an event it keeps was removed meanwhile",
                    { firstSequence: batch[0]?.sequence, events: batch.length },
                  );
                }
                batchSize = adaptBatchSize(batchSize, elapsedMs, options.deleteBatch);
                yield* pauseAfter(elapsedMs);
              }
            }

            if (options.onProgress !== undefined) {
              yield* options.onProgress({
                horizonSequence,
                compactedThroughSequence: cursor,
                scannedSequences,
                deletedEvents,
                deletedBytes,
              });
            }
            if (selectionOnMain || !deleting) yield* Effect.yieldNow;
          }

          if (options.receipts !== null && stopReason === "complete") {
            const receipts = options.receipts;
            const receiptCutoffMs = nowMs - receipts.cutoffMs;
            const pageRows = Math.max(1, receipts.pageRows);
            // A cursor past the largest rowid belongs to another table (a restored file, or a
            // VACUUM that renumbered the rows): start over, as the event cursor does.
            const [largest] = yield* onMain(
              sql<{
                readonly maxRowid: number | null;
              }>`SELECT MAX(rowid) AS "maxRowid" FROM orchestration_command_receipts`,
            );
            if (receiptCursor > Number(largest?.maxRowid ?? 0)) receiptCursor = 0;
            while (scannedReceipts < receipts.maxScanRows) {
              if (overTime()) {
                stopReason = "time-budget";
                break;
              }
              const readPage = receiptPageQuery(reader, receiptCursor, pageRows);
              const page = selectionOnMain ? yield* onMain(readPage) : yield* readPage;
              if (page.length === 0) {
                receiptBacklog = false;
                break;
              }
              let reachedRecent = false;
              let lastSettledRowid = receiptCursor;
              const prunable: Array<number> = [];
              for (const row of page) {
                // Only a receipt that may be pruned once old holds the cursor back. Every other
                // one is kept forever whatever its `accepted_at`, which is the command's own time
                // (imports and recovered history carry old or odd ones), not the clock's.
                const candidate = isPrunableReceiptCommandId(row.commandId);
                if (candidate && !isOlderThan(row.acceptedAt, receiptCutoffMs)) {
                  reachedRecent = true;
                  break;
                }
                lastSettledRowid = Number(row.rowid);
                scannedReceipts += 1;
                if (candidate) prunable.push(Number(row.rowid));
              }
              if (!deleting) {
                deletedReceipts += prunable.length;
                receiptCursor = lastSettledRowid;
              } else if (prunable.length === 0) {
                // Nothing to delete: no transaction. The cursor is an existing rowid, so it
                // never points past the largest; the pass end (or the next delete) saves it.
                receiptCursor = lastSettledRowid;
              } else {
                let index = 0;
                while (index < prunable.length) {
                  const batch = prunable.slice(index, index + receiptBatchSize);
                  index += batch.length;
                  const isLastBatch = index >= prunable.length;
                  let startedAt = performance.now();
                  yield* sql.withTransaction(
                    Effect.gen(function* () {
                      startedAt = performance.now();
                      yield* sql`DELETE FROM orchestration_command_receipts WHERE rowid IN ${sql.in(batch)}`;
                      const [changed] = yield* sql<{
                        readonly changes: number;
                      }>`SELECT changes() AS changes`;
                      deletedReceipts += Number(changed?.changes ?? 0);
                      if (isLastBatch) {
                        // Rowids are reused once the largest is deleted; never point past it.
                        const [max] = yield* sql<{ readonly maxRowid: number | null }>`
                        SELECT MAX(rowid) AS "maxRowid" FROM orchestration_command_receipts
                      `;
                        receiptCursor = Math.min(lastSettledRowid, Number(max?.maxRowid ?? 0));
                        yield* writeState(
                          options.mode,
                          stateAt({ completedAt: null, lastPass: null }),
                        );
                      }
                    }),
                  );
                  const elapsedMs = performance.now() - startedAt;
                  mainThreadMs += elapsedMs;
                  maxBatchMs = Math.max(maxBatchMs, elapsedMs);
                  receiptBatchDurationsMs.push(elapsedMs);
                  receiptBatchSize = adaptBatchSize(receiptBatchSize, elapsedMs, {
                    ...options.deleteBatch,
                    max: Math.max(1, receipts.deleteBatch),
                  });
                  yield* pauseAfter(elapsedMs);
                }
              }
              if (reachedRecent || page.length < pageRows) {
                receiptBacklog = false;
                break;
              }
            }
          }

          const durationMs = performance.now() - passStartedMs;
          const backlogSequences = Math.max(0, horizonSequence - cursor);
          if (persist) {
            yield* onMain(
              writeState(
                options.mode,
                stateAt({
                  completedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
                  lastPass: {
                    scannedSequences,
                    deletedEvents,
                    deletedBytes,
                    deletedReceipts,
                    maxBatchMs: Math.round(maxBatchMs * 100) / 100,
                    mainThreadMs: Math.round(mainThreadMs),
                    durationMs: Math.round(durationMs),
                    horizon: horizonSequence,
                    backlogSequences,
                    receiptBacklog,
                  },
                }),
              ),
            );
          }

          return {
            mode: options.mode,
            horizon: options.horizon,
            horizonSequence,
            headSequence: head,
            startSequence,
            compactedThroughSequence: cursor,
            backlogSequences,
            scannedSequences,
            selectedEvents,
            deletedEvents,
            deletedBytes,
            skippedBatches,
            scannedReceipts,
            deletedReceipts,
            receiptBacklog,
            durationMs,
            mainThreadMs,
            maxBatchMs,
            batchDurationsMs,
            receiptBatchDurationsMs,
            stopReason,
          } satisfies CompactionPassResult;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("EventLogCompaction.runPass")));

  return { runPass, readState } satisfies EventLogCompactionShape;
});

export const EventLogCompactionLive = Layer.effect(EventLogCompaction, makeEventLogCompaction);
