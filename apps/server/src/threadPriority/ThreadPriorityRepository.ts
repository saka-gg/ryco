import {
  ThreadId,
  ThreadPriorityBatchSnapshot,
  type ThreadPriorityRankedEntry,
} from "@ryco/contracts";
import { Context, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  toPersistenceDecodeCauseError,
  toPersistenceSqlError,
  type PersistenceDecodeError,
  type PersistenceSqlError,
} from "../persistence/Errors.ts";

export type ThreadPriorityRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export interface ThreadPriorityStoredBatch {
  readonly snapshot: ThreadPriorityBatchSnapshot;
  readonly inputFingerprint: string;
}

export interface ThreadPriorityRepositoryShape {
  readonly readLatest: () => Effect.Effect<
    Option.Option<ThreadPriorityStoredBatch>,
    ThreadPriorityRepositoryError
  >;
  readonly readUsable: (
    now: string,
  ) => Effect.Effect<Option.Option<ThreadPriorityStoredBatch>, ThreadPriorityRepositoryError>;
  readonly replace: (
    batch: ThreadPriorityStoredBatch,
  ) => Effect.Effect<void, ThreadPriorityRepositoryError>;
  readonly deleteThread: (threadId: ThreadId) => Effect.Effect<void, ThreadPriorityRepositoryError>;
  readonly inspectRows: () => Effect.Effect<
    ReadonlyArray<ThreadPriorityRankedEntry>,
    ThreadPriorityRepositoryError
  >;
}

export class ThreadPriorityRepository extends Context.Service<
  ThreadPriorityRepository,
  ThreadPriorityRepositoryShape
>()("ryco/threadPriority/ThreadPriorityRepository") {}

interface BatchRow {
  readonly batchId: string;
  readonly inputFingerprint: string;
  readonly modelSelectionJson: string;
  readonly modelFingerprint: string;
  readonly promptVersion: string;
  readonly rankedAt: string;
  readonly usableUntil: string;
  readonly checkedAt: string;
}

interface RankingRow {
  readonly threadId: string;
  readonly tier: string;
  readonly confidence: string;
  readonly reason: string;
  readonly inputFingerprint: string;
}

const makeThreadPriorityRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readSnapshot = (activeOnly: boolean) =>
    Effect.gen(function* () {
      const batches = yield* sql<BatchRow>`
        SELECT
          batch_id AS "batchId",
          input_fingerprint AS "inputFingerprint",
          model_selection_json AS "modelSelectionJson",
          model_fingerprint AS "modelFingerprint",
          prompt_version AS "promptVersion",
          ranked_at AS "rankedAt",
          usable_until AS "usableUntil",
          checked_at AS "checkedAt"
        FROM thread_priority_batches
        WHERE slot = 1
      `;
      const batch = batches[0];
      if (batch === undefined) return Option.none<ThreadPriorityStoredBatch>();

      const rows = activeOnly
        ? yield* sql<RankingRow>`
            SELECT
              ranking.thread_id AS "threadId",
              ranking.tier,
              ranking.confidence,
              ranking.reason,
              ranking.input_fingerprint AS "inputFingerprint"
            FROM thread_priority_rankings AS ranking
            INNER JOIN projection_threads AS thread ON thread.thread_id = ranking.thread_id
            WHERE ranking.batch_id = ${batch.batchId}
              AND thread.deleted_at IS NULL
              AND thread.archived_at IS NULL
              AND COALESCE(thread.settled_override, 'active') <> 'settled'
            ORDER BY ranking.thread_id ASC
          `
        : yield* sql<RankingRow>`
            SELECT
              thread_id AS "threadId",
              tier,
              confidence,
              reason,
              input_fingerprint AS "inputFingerprint"
            FROM thread_priority_rankings
            WHERE batch_id = ${batch.batchId}
            ORDER BY thread_id ASC
          `;

      const decoded = yield* Schema.decodeUnknownEffect(ThreadPriorityBatchSnapshot)({
        batchId: batch.batchId,
        modelSelection: JSON.parse(batch.modelSelectionJson) as unknown,
        modelFingerprint: batch.modelFingerprint,
        promptVersion: batch.promptVersion,
        freshness: {
          rankedAt: batch.rankedAt,
          usableUntil: batch.usableUntil,
          checkedAt: batch.checkedAt,
        },
        entries: rows,
      });
      return Option.some({ snapshot: decoded, inputFingerprint: batch.inputFingerprint });
    }).pipe(
      Effect.mapError((cause) =>
        Schema.isSchemaError(cause)
          ? toPersistenceDecodeCauseError("ThreadPriorityRepository.readSnapshot")(cause)
          : toPersistenceSqlError("ThreadPriorityRepository.readSnapshot")(cause),
      ),
    );

  const replace: ThreadPriorityRepositoryShape["replace"] = ({ snapshot, inputFingerprint }) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM thread_priority_rankings`;
          yield* sql`DELETE FROM thread_priority_batches WHERE slot = 1`;
          yield* sql`
            INSERT INTO thread_priority_batches (
              slot, batch_id, input_fingerprint, model_selection_json, model_fingerprint,
              prompt_version,
              ranked_at, usable_until, checked_at
            ) VALUES (
              1,
              ${snapshot.batchId},
              ${inputFingerprint},
              ${JSON.stringify(snapshot.modelSelection)},
              ${snapshot.modelFingerprint},
              ${snapshot.promptVersion},
              ${snapshot.freshness.rankedAt},
              ${snapshot.freshness.usableUntil},
              ${snapshot.freshness.checkedAt}
            )
          `;
          yield* Effect.forEach(
            snapshot.entries,
            (entry) => sql`
              INSERT INTO thread_priority_rankings (
                thread_id, batch_id, tier, confidence, reason, input_fingerprint
              ) VALUES (
                ${entry.threadId},
                ${snapshot.batchId},
                ${entry.tier},
                ${entry.confidence},
                ${entry.reason},
                ${entry.inputFingerprint}
              )
            `,
            { discard: true },
          );
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError("ThreadPriorityRepository.replace")));

  return {
    readLatest: () => readSnapshot(false),
    readUsable: (now) =>
      readSnapshot(true).pipe(
        Effect.map(
          Option.filter(
            (batch) => Date.parse(batch.snapshot.freshness.usableUntil) > Date.parse(now),
          ),
        ),
      ),
    replace,
    deleteThread: (threadId) =>
      sql`DELETE FROM thread_priority_rankings WHERE thread_id = ${threadId}`.pipe(
        Effect.asVoid,
        Effect.mapError(toPersistenceSqlError("ThreadPriorityRepository.deleteThread")),
      ),
    inspectRows: () =>
      readSnapshot(false).pipe(
        Effect.map(
          Option.match({
            onNone: () => [],
            onSome: (batch) => batch.snapshot.entries,
          }),
        ),
      ),
  } satisfies ThreadPriorityRepositoryShape;
});

export const ThreadPriorityRepositoryLive = Layer.effect(
  ThreadPriorityRepository,
  makeThreadPriorityRepository,
);
