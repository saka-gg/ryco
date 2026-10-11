import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationActorKind,
  OrchestrationAggregateKind,
  OrchestrationEvent,
  OrchestrationEventMetadata,
  OrchestrationEventType,
  ProjectId,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import { Effect, Layer, Option, Schema, Stream } from "effect";

import {
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type OrchestrationEventStoreError,
} from "../Errors.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../Services/OrchestrationEventStore.ts";

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);
const EventMetadataFromJsonString = Schema.fromJsonString(OrchestrationEventMetadata);

const AppendEventRequestSchema = Schema.Struct({
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  streamId: Schema.Union([ProjectId, ThreadId, WorktreeId]),
  type: OrchestrationEventType,
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  actorKind: OrchestrationActorKind,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  payloadJson: UnknownFromJsonString,
  metadataJson: EventMetadataFromJsonString,
});

const OrchestrationEventPersistedRowSchema = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  type: OrchestrationEventType,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId, WorktreeId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  payload: UnknownFromJsonString,
  metadata: EventMetadataFromJsonString,
});

const HasEventAfterRequestSchema = Schema.Struct({
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.String,
  type: OrchestrationEventType,
  sequenceExclusive: NonNegativeInt,
});

const ReadFromSequenceRequestSchema = Schema.Struct({
  sequenceExclusive: NonNegativeInt,
  limit: Schema.Number,
});
const ReadThroughSequenceRequestSchema = Schema.Struct({
  sequenceExclusive: NonNegativeInt,
  sequenceInclusive: NonNegativeInt,
  limit: Schema.Number,
});
const DEFAULT_READ_FROM_SEQUENCE_LIMIT = 1_000;
const READ_PAGE_SIZE = 500;

function inferActorKind(
  event: Omit<OrchestrationEvent, "sequence">,
): Schema.Schema.Type<typeof OrchestrationActorKind> {
  if (event.commandId !== null && event.commandId.startsWith("provider:")) {
    return "provider";
  }
  if (event.commandId !== null && event.commandId.startsWith("server:")) {
    return "server";
  }
  if (
    event.metadata.providerTurnId !== undefined ||
    event.metadata.providerItemId !== undefined ||
    event.metadata.adapterKey !== undefined
  ) {
    return "provider";
  }
  if (event.commandId === null) {
    return "server";
  }
  return "client";
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): OrchestrationEventStoreError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeEventStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendEventRow = SqlSchema.findOne({
    Request: AppendEventRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        INSERT INTO orchestration_events (
          event_id,
          aggregate_kind,
          stream_id,
          stream_version,
          event_type,
          occurred_at,
          command_id,
          causation_event_id,
          correlation_id,
          actor_kind,
          payload_json,
          metadata_json
        )
        VALUES (
          ${request.eventId},
          ${request.aggregateKind},
          ${request.streamId},
          COALESCE(
            (
              SELECT stream_version + 1
              FROM orchestration_events
              WHERE aggregate_kind = ${request.aggregateKind}
                AND stream_id = ${request.streamId}
              ORDER BY stream_version DESC
              LIMIT 1
            ),
            0
          ),
          ${request.type},
          ${request.occurredAt},
          ${request.commandId},
          ${request.causationEventId},
          ${request.correlationId},
          ${request.actorKind},
          ${request.payloadJson},
          ${request.metadataJson}
        )
        RETURNING
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
      `,
  });

  const readEventRowsFromSequence = SqlSchema.findAll({
    Request: ReadFromSequenceRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
        FROM orchestration_events
        WHERE sequence > ${request.sequenceExclusive}
        ORDER BY sequence ASC
        LIMIT ${request.limit}
      `,
  });

  const readEventRowsThroughSequence = SqlSchema.findAll({
    Request: ReadThroughSequenceRequestSchema,
    Result: OrchestrationEventPersistedRowSchema,
    execute: (request) =>
      sql`
        SELECT
          sequence,
          event_id AS "eventId",
          event_type AS "type",
          aggregate_kind AS "aggregateKind",
          stream_id AS "aggregateId",
          occurred_at AS "occurredAt",
          command_id AS "commandId",
          causation_event_id AS "causationEventId",
          correlation_id AS "correlationId",
          payload_json AS "payload",
          metadata_json AS "metadata"
        FROM orchestration_events
        WHERE sequence > ${request.sequenceExclusive}
          AND sequence <= ${request.sequenceInclusive}
        ORDER BY sequence ASC
        LIMIT ${request.limit}
      `,
  });

  const readLatestSequence = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ sequence: Schema.NullOr(NonNegativeInt) }),
    execute: () => sql`SELECT MAX(sequence) AS "sequence" FROM orchestration_events`,
  });

  const readRecentEventRows = SqlSchema.findAll({
    Request: Schema.Struct({ since: IsoDateTime, limit: Schema.Int }),
    Result: OrchestrationEventPersistedRowSchema,
    execute: ({ since, limit }) => sql`
      SELECT sequence, event_id AS "eventId", event_type AS "type",
        aggregate_kind AS "aggregateKind", stream_id AS "aggregateId",
        occurred_at AS "occurredAt", command_id AS "commandId",
        causation_event_id AS "causationEventId", correlation_id AS "correlationId",
        payload_json AS "payload", metadata_json AS "metadata"
      FROM orchestration_events
      WHERE occurred_at >= ${since}
      ORDER BY sequence DESC
      LIMIT ${limit}
    `,
  });

  const findEventAfter = SqlSchema.findOneOption({
    Request: HasEventAfterRequestSchema,
    Result: Schema.Struct({ sequence: NonNegativeInt }),
    execute: (request) =>
      sql`
        SELECT sequence
        FROM orchestration_events
        WHERE aggregate_kind = ${request.aggregateKind}
          AND stream_id = ${request.aggregateId}
          AND event_type = ${request.type}
          AND sequence > ${request.sequenceExclusive}
        ORDER BY sequence ASC
        LIMIT 1
      `,
  });

  const append: OrchestrationEventStoreShape["append"] = (event) =>
    appendEventRow({
      eventId: event.eventId,
      aggregateKind: event.aggregateKind,
      streamId: event.aggregateId,
      type: event.type,
      causationEventId: event.causationEventId,
      correlationId: event.correlationId,
      actorKind: inferActorKind(event),
      occurredAt: event.occurredAt,
      commandId: event.commandId,
      payloadJson: event.payload,
      metadataJson: event.metadata,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.append:insert",
          "OrchestrationEventStore.append:decodeRow",
        ),
      ),
      Effect.flatMap((row) =>
        decodeEvent(row).pipe(
          Effect.mapError(toPersistenceDecodeError("OrchestrationEventStore.append:rowToEvent")),
        ),
      ),
    );

  const readFromSequence: OrchestrationEventStoreShape["readFromSequence"] = (
    sequenceExclusive,
    limit = DEFAULT_READ_FROM_SEQUENCE_LIMIT,
  ) => {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedLimit === 0) {
      return Stream.empty;
    }
    const readPage = (
      cursor: number,
      remaining: number,
    ): Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError> =>
      Stream.fromEffect(
        readEventRowsFromSequence({
          sequenceExclusive: cursor,
          limit: Math.min(remaining, READ_PAGE_SIZE),
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "OrchestrationEventStore.readFromSequence:query",
              "OrchestrationEventStore.readFromSequence:decodeRows",
            ),
          ),
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              decodeEvent(row).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("OrchestrationEventStore.readFromSequence:rowToEvent"),
                ),
              ),
            ),
          ),
        ),
      ).pipe(
        Stream.flatMap((events) => {
          if (events.length === 0) {
            return Stream.empty;
          }
          const nextRemaining = remaining - events.length;
          if (nextRemaining <= 0) {
            return Stream.fromIterable(events);
          }
          return Stream.concat(
            Stream.fromIterable(events),
            readPage(events[events.length - 1]!.sequence, nextRemaining),
          );
        }),
      );

    return readPage(sequenceExclusive, normalizedLimit);
  };

  const readThroughSequence: OrchestrationEventStoreShape["readThroughSequence"] = (
    sequenceExclusive,
    sequenceInclusive,
  ) => {
    const normalizedStart = Math.max(0, Math.floor(sequenceExclusive));
    const normalizedEnd = Math.max(0, Math.floor(sequenceInclusive));
    if (normalizedEnd <= normalizedStart) {
      return Stream.empty;
    }

    const readPage = (
      cursor: number,
    ): Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError> =>
      Stream.fromEffect(
        readEventRowsThroughSequence({
          sequenceExclusive: cursor,
          sequenceInclusive: normalizedEnd,
          limit: READ_PAGE_SIZE,
        }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "OrchestrationEventStore.readThroughSequence:query",
              "OrchestrationEventStore.readThroughSequence:decodeRows",
            ),
          ),
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              decodeEvent(row).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    "OrchestrationEventStore.readThroughSequence:rowToEvent",
                  ),
                ),
              ),
            ),
          ),
        ),
      ).pipe(
        Stream.flatMap((events) => {
          if (events.length === 0) {
            return Stream.empty;
          }
          const nextCursor = events[events.length - 1]!.sequence;
          return Stream.concat(
            Stream.fromIterable(events),
            nextCursor < normalizedEnd ? readPage(nextCursor) : Stream.empty,
          );
        }),
      );

    return readPage(normalizedStart);
  };

  const latestSequence: OrchestrationEventStoreShape["latestSequence"] = readLatestSequence(
    undefined,
  ).pipe(
    Effect.map((row) => row.sequence ?? 0),
    Effect.mapError(
      toPersistenceSqlOrDecodeError(
        "OrchestrationEventStore.latestSequence:query",
        "OrchestrationEventStore.latestSequence:decodeRow",
      ),
    ),
  );

  const readPage: OrchestrationEventStoreShape["readPage"] = (sequenceExclusive, limit) => {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    const normalizedSequenceExclusive = Math.max(0, Math.floor(sequenceExclusive));
    if (normalizedLimit === 0) {
      return Effect.succeed({
        events: [],
        nextSequence: normalizedSequenceExclusive,
        hasMore: false,
      });
    }

    return readEventRowsFromSequence({
      sequenceExclusive: normalizedSequenceExclusive,
      limit: normalizedLimit + 1,
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.readPage:query",
          "OrchestrationEventStore.readPage:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows.slice(0, normalizedLimit), (row) =>
          decodeEvent(row).pipe(
            Effect.mapError(
              toPersistenceDecodeError("OrchestrationEventStore.readPage:rowToEvent"),
            ),
          ),
        ).pipe(
          Effect.map((events) => ({
            events,
            nextSequence:
              events.length === 0
                ? normalizedSequenceExclusive
                : events[events.length - 1]!.sequence,
            hasMore: rows.length > normalizedLimit,
          })),
        ),
      ),
    );
  };

  const readRecent: OrchestrationEventStoreShape["readRecent"] = (input) =>
    readRecentEventRows({
      since: input.since,
      limit: Math.min(Math.max(1, Math.floor(input.limit)), 500),
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.readRecent:query",
          "OrchestrationEventStore.readRecent:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeEvent(row).pipe(
            Effect.mapError(
              toPersistenceDecodeError("OrchestrationEventStore.readRecent:rowToEvent"),
            ),
          ),
        ),
      ),
    );

  const hasEventAfter: OrchestrationEventStoreShape["hasEventAfter"] = (input) =>
    findEventAfter(input).pipe(
      Effect.map(Option.isSome),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "OrchestrationEventStore.hasEventAfter:query",
          "OrchestrationEventStore.hasEventAfter:decodeRow",
        ),
      ),
    );

  return {
    append,
    readPage,
    readRecent,
    readFromSequence,
    readThroughSequence,
    latestSequence,
    readAll: () => readFromSequence(0, Number.MAX_SAFE_INTEGER),
    hasEventAfter,
  } satisfies OrchestrationEventStoreShape;
});

export const OrchestrationEventStoreLive = Layer.effect(OrchestrationEventStore, makeEventStore);
