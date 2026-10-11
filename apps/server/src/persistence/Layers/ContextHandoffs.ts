import { ContextHandoffId, ModelSelection } from "@ryco/contracts";
import { Effect, Layer, Option, Schema, Struct } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ContextHandoffRepositoryError,
} from "../Errors.ts";
import {
  CompareAndSetContextHandoffStatusInput,
  ContextHandoffRecord,
  ContextHandoffRepository,
  type ContextHandoffRepositoryShape,
  GetContextHandoffInput,
  ListContextHandoffsByThreadInput,
  StoreContextHandoffContextInput,
  StoreContextHandoffDeliveryArtifactInput,
} from "../Services/ContextHandoffs.ts";

const ContextHandoffDbRow = ContextHandoffRecord.mapFields(
  Struct.assign({
    sourceSelection: Schema.fromJsonString(ModelSelection),
    targetSelection: Schema.fromJsonString(ModelSelection),
    structuredContext: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
    deliveryArtifact: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  }),
);

const HandoffIdResult = Schema.Struct({ handoffId: ContextHandoffId });
const StoreContextHandoffContextDbInput = StoreContextHandoffContextInput.mapFields(
  Struct.assign({ structuredContext: Schema.fromJsonString(Schema.Unknown) }),
);
const StoreContextHandoffDeliveryArtifactDbInput =
  StoreContextHandoffDeliveryArtifactInput.mapFields(
    Struct.assign({ deliveryArtifact: Schema.fromJsonString(Schema.Unknown) }),
  );
const decodeRecord = Schema.decodeUnknownEffect(ContextHandoffRecord);

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ContextHandoffRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeContextHandoffRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRow = SqlSchema.findAll({
    Request: ContextHandoffDbRow,
    Result: HandoffIdResult,
    execute: (row) => sql`
      INSERT INTO provider_context_handoffs (
        handoff_id,
        thread_id,
        source_selection_json,
        target_selection_json,
        source_runtime_session_id,
        target_runtime_session_id,
        status,
        context_version,
        structured_context_json,
        context_digest,
        delivery_artifact_json,
        first_message_id,
        accepted_provider_turn_id,
        error,
        created_at,
        updated_at
      ) VALUES (
        ${row.handoffId},
        ${row.threadId},
        ${row.sourceSelection},
        ${row.targetSelection},
        ${row.sourceRuntimeSessionId},
        ${row.targetRuntimeSessionId},
        ${row.status},
        ${row.contextVersion},
        ${row.structuredContext},
        ${row.contextDigest},
        ${row.deliveryArtifact},
        ${row.firstMessageId},
        ${row.acceptedProviderTurnId},
        ${row.error},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (handoff_id) DO NOTHING
      RETURNING handoff_id AS "handoffId"
    `,
  });

  const getRow = SqlSchema.findOneOption({
    Request: GetContextHandoffInput,
    Result: ContextHandoffDbRow,
    execute: ({ handoffId }) => sql`
      SELECT
        handoff_id AS "handoffId",
        thread_id AS "threadId",
        source_selection_json AS "sourceSelection",
        target_selection_json AS "targetSelection",
        source_runtime_session_id AS "sourceRuntimeSessionId",
        target_runtime_session_id AS "targetRuntimeSessionId",
        status,
        context_version AS "contextVersion",
        structured_context_json AS "structuredContext",
        context_digest AS "contextDigest",
        delivery_artifact_json AS "deliveryArtifact",
        first_message_id AS "firstMessageId",
        accepted_provider_turn_id AS "acceptedProviderTurnId",
        error,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM provider_context_handoffs
      WHERE handoff_id = ${handoffId}
      LIMIT 1
    `,
  });

  const listRowsByThread = SqlSchema.findAll({
    Request: ListContextHandoffsByThreadInput,
    Result: ContextHandoffDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        handoff_id AS "handoffId",
        thread_id AS "threadId",
        source_selection_json AS "sourceSelection",
        target_selection_json AS "targetSelection",
        source_runtime_session_id AS "sourceRuntimeSessionId",
        target_runtime_session_id AS "targetRuntimeSessionId",
        status,
        context_version AS "contextVersion",
        structured_context_json AS "structuredContext",
        context_digest AS "contextDigest",
        delivery_artifact_json AS "deliveryArtifact",
        first_message_id AS "firstMessageId",
        accepted_provider_turn_id AS "acceptedProviderTurnId",
        error,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM provider_context_handoffs
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, handoff_id ASC
    `,
  });

  const listRecoverableRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ContextHandoffDbRow,
    execute: () => sql`
      SELECT
        handoff_id AS "handoffId",
        thread_id AS "threadId",
        source_selection_json AS "sourceSelection",
        target_selection_json AS "targetSelection",
        source_runtime_session_id AS "sourceRuntimeSessionId",
        target_runtime_session_id AS "targetRuntimeSessionId",
        status,
        context_version AS "contextVersion",
        structured_context_json AS "structuredContext",
        context_digest AS "contextDigest",
        delivery_artifact_json AS "deliveryArtifact",
        first_message_id AS "firstMessageId",
        accepted_provider_turn_id AS "acceptedProviderTurnId",
        error,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM provider_context_handoffs
      WHERE status IN ('preparing', 'dispatching')
      ORDER BY created_at ASC, handoff_id ASC
    `,
  });

  const compareAndSetRow = SqlSchema.findAll({
    Request: CompareAndSetContextHandoffStatusInput,
    Result: HandoffIdResult,
    execute: (input) => sql`
      UPDATE provider_context_handoffs
      SET status = ${input.nextStatus},
          target_runtime_session_id = ${input.targetRuntimeSessionId},
          accepted_provider_turn_id = ${input.acceptedProviderTurnId},
          error = ${input.error},
          updated_at = ${input.updatedAt}
      WHERE handoff_id = ${input.handoffId}
        AND status = ${input.expectedStatus}
      RETURNING handoff_id AS "handoffId"
    `,
  });

  const storeContextRow = SqlSchema.findAll({
    Request: StoreContextHandoffContextDbInput,
    Result: HandoffIdResult,
    execute: (input) => sql`
      UPDATE provider_context_handoffs
      SET context_version = ${input.contextVersion},
          structured_context_json = ${input.structuredContext},
          context_digest = ${input.contextDigest},
          updated_at = ${input.updatedAt}
      WHERE handoff_id = ${input.handoffId}
        AND (structured_context_json IS NULL OR structured_context_json = 'null')
        AND context_digest IS NULL
      RETURNING handoff_id AS "handoffId"
    `,
  });

  const storeDeliveryArtifactRow = SqlSchema.findAll({
    Request: StoreContextHandoffDeliveryArtifactDbInput,
    Result: HandoffIdResult,
    execute: (input) => sql`
      UPDATE provider_context_handoffs
      SET delivery_artifact_json = ${input.deliveryArtifact},
          updated_at = ${input.updatedAt}
      WHERE handoff_id = ${input.handoffId}
        AND (delivery_artifact_json IS NULL OR delivery_artifact_json = 'null')
      RETURNING handoff_id AS "handoffId"
    `,
  });

  const decodeRows = (rows: ReadonlyArray<typeof ContextHandoffDbRow.Type>, operation: string) =>
    Effect.forEach(rows, (row) =>
      decodeRecord(row).pipe(Effect.mapError(toPersistenceDecodeError(operation))),
    );

  const create: ContextHandoffRepositoryShape["create"] = (input) =>
    insertRow(input).pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toSqlOrDecodeError(
          "ContextHandoffRepository.create:query",
          "ContextHandoffRepository.create:encodeRequest",
        ),
      ),
    );

  const getById: ContextHandoffRepositoryShape["getById"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "ContextHandoffRepository.getById:query",
          "ContextHandoffRepository.getById:decodeRow",
        ),
      ),
      Effect.flatMap((row) =>
        Option.match(row, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (value) =>
            decodeRecord(value).pipe(
              Effect.mapError(toPersistenceDecodeError("ContextHandoffRepository.getById:record")),
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const listByThread: ContextHandoffRepositoryShape["listByThread"] = (input) =>
    listRowsByThread(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "ContextHandoffRepository.listByThread:query",
          "ContextHandoffRepository.listByThread:decodeRows",
        ),
      ),
      Effect.flatMap((rows) => decodeRows(rows, "ContextHandoffRepository.listByThread:record")),
    );

  const listRecoverable: ContextHandoffRepositoryShape["listRecoverable"] = () =>
    listRecoverableRows(undefined).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "ContextHandoffRepository.listRecoverable:query",
          "ContextHandoffRepository.listRecoverable:decodeRows",
        ),
      ),
      Effect.flatMap((rows) => decodeRows(rows, "ContextHandoffRepository.listRecoverable:record")),
    );

  const compareAndSetStatus: ContextHandoffRepositoryShape["compareAndSetStatus"] = (input) =>
    compareAndSetRow(input).pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toSqlOrDecodeError(
          "ContextHandoffRepository.compareAndSetStatus:query",
          "ContextHandoffRepository.compareAndSetStatus:encodeRequest",
        ),
      ),
    );

  const storeContextIfEmpty: ContextHandoffRepositoryShape["storeContextIfEmpty"] = (input) =>
    storeContextRow(input).pipe(
      Effect.map((rows) => rows.length === 1),
      Effect.mapError(
        toSqlOrDecodeError(
          "ContextHandoffRepository.storeContextIfEmpty:query",
          "ContextHandoffRepository.storeContextIfEmpty:encodeRequest",
        ),
      ),
    );

  const storeDeliveryArtifactIfEmpty: ContextHandoffRepositoryShape["storeDeliveryArtifactIfEmpty"] =
    (input) =>
      storeDeliveryArtifactRow(input).pipe(
        Effect.map((rows) => rows.length === 1),
        Effect.mapError(
          toSqlOrDecodeError(
            "ContextHandoffRepository.storeDeliveryArtifactIfEmpty:query",
            "ContextHandoffRepository.storeDeliveryArtifactIfEmpty:encodeRequest",
          ),
        ),
      );

  return {
    create,
    getById,
    listByThread,
    listRecoverable,
    compareAndSetStatus,
    storeContextIfEmpty,
    storeDeliveryArtifactIfEmpty,
  } satisfies ContextHandoffRepositoryShape;
});

export const ContextHandoffRepositoryLive = Layer.effect(
  ContextHandoffRepository,
  makeContextHandoffRepository,
);
