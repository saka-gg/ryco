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
  /** Only these event types; every type when absent. */
  eventTypes: Schema.optional(Schema.Array(OrchestrationEventType)),
});
const ReadStreamPageRequestSchema = Schema.Struct({
  aggregateKind: OrchestrationAggregateKind,
  streamId: Schema.String,
  sequenceExclusive: NonNegativeInt,
  limit: NonNegativeInt,
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

type PersistedEventRow = Schema.Schema.Type<typeof OrchestrationEventPersistedRowSchema>;

/**
 * One ordered page after a normalized exclusive cursor, for the global log and for one stream
 * alike. `readRows` is asked for one row more than the page holds; the extra row only reports
 * that more follow and is never decoded.
 */
function readEventPage<E>(input: {
  readonly operation: string;
  readonly sequenceExclusive: number;
  readonly limit: number;
  readonly readRows: (request: {
    readonly sequenceExclusive: number;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<PersistedEventRow>, E>;
}): Effect.Effect<
  {
    readonly events: ReadonlyArray<OrchestrationEvent>;
    readonly nextSequence: number;
    readonly hasMore: boolean;
  },
  OrchestrationEventStoreError
> {
  const limit = Math.max(0, Math.floor(input.limit));
  const sequenceExclusive = Math.max(0, Math.floor(input.sequenceExclusive));
  if (limit === 0) {
    return Effect.succeed({ events: [], nextSequence: sequenceExclusive, hasMore: false });
  }
  return input.readRows({ sequenceExclusive, limit: limit + 1 }).pipe(
    Effect.mapError(
      toPersistenceSqlOrDecodeError(`${input.operation}:query`, `${input.operation}:decodeRows`),
    ),
    Effect.flatMap((rows) =>
      Effect.forEach(rows.slice(0, limit), (row) =>
        decodeEvent(row).pipe(
          Effect.mapError(toPersistenceDecodeError(`${input.operation}:rowToEvent`)),
        ),
      ).pipe(
        Effect.map((events) => ({
          events,
          nextSequence:
            events.length === 0 ? sequenceExclusive : events[events.length - 1]!.sequence,
          hasMore: rows.length > limit,
        })),
      ),
    ),
  );
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

  // Served by the (aggregate_kind, stream_id, sequence) stream index.
  const readStreamEventRows = SqlSchema.findAll({
    Request: ReadStreamPageRequestSchema,
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
        WHERE aggregate_kind = ${request.aggregateKind}
          AND stream_id = ${request.streamId}
          AND sequence > ${request.sequenceExclusive}
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
          ${request.eventTypes === undefined ? sql`` : sql`AND event_type IN ${sql.in(request.eventTypes)}`}
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
    options,
  ) => {
    const normalizedStart = Math.max(0, Math.floor(sequenceExclusive));
    const normalizedEnd = Math.max(0, Math.floor(sequenceInclusive));
    const eventTypes = options?.eventTypes;
    if (normalizedEnd <= normalizedStart || eventTypes?.length === 0) {
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
          ...(eventTypes === undefined ? {} : { eventTypes }),
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

  const readPage: OrchestrationEventStoreShape["readPage"] = (sequenceExclusive, limit) =>
    readEventPage({
      operation: "OrchestrationEventStore.readPage",
      sequenceExclusive,
      limit,
      readRows: readEventRowsFromSequence,
    });

  const readStreamEventsPage: OrchestrationEventStoreShape["readStreamEventsPage"] = (input) =>
    readEventPage({
      operation: "OrchestrationEventStore.readStreamEventsPage",
      sequenceExclusive: input.fromSequenceExclusive,
      limit: input.limit,
      readRows: (page) =>
        readStreamEventRows({
          aggregateKind: input.aggregateKind,
          streamId: input.streamId,
          ...page,
        }),
    });

  const probeResume: NonNullable<OrchestrationEventStoreShape["probeResume"]> = (input) =>
    Effect.gen(function* () {
      const sequence = Math.max(0, Math.floor(input.sequence));
      const limit = Math.max(0, Math.floor(input.limit));
      // Both counts stop one row past their limit: an inner LIMIT over the
      // sequence key (or the stream index) never reads a payload.
      const [global] = yield* sql<{ readonly anchored: number; readonly eventsAfter: number }>`
        SELECT
          EXISTS(SELECT 1 FROM orchestration_events WHERE sequence = ${sequence}) AS "anchored",
          (
            SELECT count(*) FROM (
              SELECT 1 FROM orchestration_events WHERE sequence > ${sequence} LIMIT ${limit + 1}
            )
          ) AS "eventsAfter"
      `;
      let streamEventsAfter: number | null = null;
      if (input.stream !== undefined) {
        const streamLimit = Math.max(0, Math.floor(input.stream.limit));
        const [row] = yield* sql<{ readonly eventsAfter: number }>`
          SELECT count(*) AS "eventsAfter" FROM (
            SELECT 1 FROM orchestration_events
            WHERE aggregate_kind = ${input.stream.aggregateKind}
              AND stream_id = ${input.stream.streamId}
              AND sequence > ${sequence}
            LIMIT ${streamLimit + 1}
          )
        `;
        streamEventsAfter = Number(row?.eventsAfter ?? 0);
      }
      return {
        anchored: Number(global?.anchored ?? 0) === 1,
        eventsAfter: Number(global?.eventsAfter ?? 0),
        streamEventsAfter,
      };
    }).pipe(Effect.mapError(toPersistenceSqlError("OrchestrationEventStore.probeResume:query")));

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
    readStreamEventsPage,
    readRecent,
    probeResume,
    readFromSequence,
    readThroughSequence,
    latestSequence,
    readAll: () => readFromSequence(0, Number.MAX_SAFE_INTEGER),
    hasEventAfter,
  } satisfies OrchestrationEventStoreShape;
});

export const OrchestrationEventStoreLive = Layer.effect(OrchestrationEventStore, makeEventStore);
