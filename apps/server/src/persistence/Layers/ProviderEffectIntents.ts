import { EventId, MessageId, ThreadId } from "@ryco/contracts";
import { Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  PROVIDER_EFFECT_INTENT_KINDS,
  planProviderEffectIntent,
  type ProviderEffectIntentRecord,
  type ProviderEffectIntentSettlement,
} from "../../orchestration/providerEffectIntents.ts";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  ProviderEffectIntentRepository,
  type ProviderEffectIntentRepositoryShape,
} from "../Services/ProviderEffectIntents.ts";

const ProviderEffectIntentDbRow = Schema.Struct({
  sequence: Schema.Number,
  eventId: EventId,
  threadId: ThreadId,
  kind: Schema.Literals(PROVIDER_EFFECT_INTENT_KINDS),
  messageId: Schema.NullOr(MessageId),
  handoffId: Schema.NullOr(Schema.String),
  recordedAt: Schema.String,
  dispatchedAt: Schema.NullOr(Schema.String),
  recoveryAttempts: Schema.Number,
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ProviderEffectIntentDbRow));
const ROW_COLUMNS = `
  sequence,
  event_id AS "eventId",
  thread_id AS "threadId",
  kind,
  message_id AS "messageId",
  handoff_id AS "handoffId",
  recorded_at AS "recordedAt",
  dispatched_at AS "dispatchedAt",
  recovery_attempts AS "recoveryAttempts"
`;

const makeProviderEffectIntentRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const record = (row: ProviderEffectIntentRecord) =>
    sql`
      INSERT INTO provider_effect_intents (
        sequence, event_id, thread_id, kind, message_id, handoff_id, recorded_at
      )
      VALUES (
        ${row.sequence},
        ${row.eventId},
        ${row.threadId},
        ${row.kind},
        ${row.messageId},
        ${row.handoffId},
        ${row.recordedAt}
      )
      ON CONFLICT (sequence) DO NOTHING
    `;

  const settleWhere = (settlement: ProviderEffectIntentSettlement, beforeSequence: number) => {
    switch (settlement._tag) {
      case "ByMessage":
        return sql`
          DELETE FROM provider_effect_intents
          WHERE thread_id = ${settlement.threadId}
            AND kind = ${settlement.kind}
            AND message_id = ${settlement.messageId}
            AND sequence < ${beforeSequence}
        `;
      case "ByHandoff":
        return sql`
          DELETE FROM provider_effect_intents
          WHERE thread_id = ${settlement.threadId}
            AND kind = 'turn-start'
            AND handoff_id = ${settlement.handoffId}
            AND sequence < ${beforeSequence}
        `;
      case "DispatchedTurnStarts":
        return sql`
          DELETE FROM provider_effect_intents
          WHERE thread_id = ${settlement.threadId}
            AND kind = 'turn-start'
            AND dispatched_at IS NOT NULL
            AND sequence < ${beforeSequence}
        `;
      case "SessionStops":
        return sql`
          DELETE FROM provider_effect_intents
          WHERE thread_id = ${settlement.threadId}
            AND kind = 'session-stop'
            AND sequence < ${beforeSequence}
        `;
      case "Thread":
        return sql`
          DELETE FROM provider_effect_intents
          WHERE thread_id = ${settlement.threadId}
            AND sequence < ${beforeSequence}
        `;
    }
  };

  const applyEvent: ProviderEffectIntentRepositoryShape["applyEvent"] = (event) => {
    const plan = planProviderEffectIntent(event);
    if (plan.record === null && plan.settlements.length === 0) return Effect.void;
    return Effect.gen(function* () {
      if (plan.record !== null) yield* record(plan.record);
      for (const settlement of plan.settlements) {
        yield* settleWhere(settlement, plan.beforeSequence);
      }
    }).pipe(Effect.mapError(toPersistenceSqlError("ProviderEffectIntentRepository.applyEvent")));
  };

  const markDispatched: ProviderEffectIntentRepositoryShape["markDispatched"] = (input) =>
    sql`
      UPDATE provider_effect_intents
      SET dispatched_at = ${input.dispatchedAt}
      WHERE sequence = ${input.sequence} AND dispatched_at IS NULL
    `.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProviderEffectIntentRepository.markDispatched")),
    );

  const settle: ProviderEffectIntentRepositoryShape["settle"] = (input) =>
    sql`DELETE FROM provider_effect_intents WHERE sequence = ${input.sequence}`.pipe(
      Effect.asVoid,
      Effect.mapError(toPersistenceSqlError("ProviderEffectIntentRepository.settle")),
    );

  const readRows = (operation: string, query: Effect.Effect<ReadonlyArray<unknown>, SqlError>) =>
    query.pipe(
      Effect.mapError(toPersistenceSqlError(`ProviderEffectIntentRepository.${operation}:query`)),
      Effect.flatMap((rows) =>
        decodeRows(rows).pipe(
          Effect.mapError(
            toPersistenceDecodeError(`ProviderEffectIntentRepository.${operation}:decodeRows`),
          ),
        ),
      ),
    );

  const get: ProviderEffectIntentRepositoryShape["get"] = (input) =>
    readRows(
      "get",
      sql`SELECT ${sql.literal(ROW_COLUMNS)} FROM provider_effect_intents WHERE sequence = ${input.sequence}`,
    ).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])));

  const listOpen: ProviderEffectIntentRepositoryShape["listOpen"] = () =>
    readRows(
      "listOpen",
      sql`SELECT ${sql.literal(ROW_COLUMNS)} FROM provider_effect_intents ORDER BY sequence ASC`,
    );

  const noteRecoveryAttempt: ProviderEffectIntentRepositoryShape["noteRecoveryAttempt"] = (input) =>
    Effect.gen(function* () {
      yield* sql`
        UPDATE provider_effect_intents
        SET recovery_attempts = recovery_attempts + 1
        WHERE sequence = ${input.sequence}
      `;
      const rows = yield* sql<{ readonly attempts: number }>`
        SELECT recovery_attempts AS "attempts" FROM provider_effect_intents
        WHERE sequence = ${input.sequence}
      `;
      return rows[0]?.attempts ?? 0;
    }).pipe(
      Effect.mapError(toPersistenceSqlError("ProviderEffectIntentRepository.noteRecoveryAttempt")),
    );

  return {
    applyEvent,
    markDispatched,
    settle,
    get,
    listOpen,
    noteRecoveryAttempt,
  } satisfies ProviderEffectIntentRepositoryShape;
});

export const ProviderEffectIntentRepositoryLive = Layer.effect(
  ProviderEffectIntentRepository,
  makeProviderEffectIntentRepository,
);
