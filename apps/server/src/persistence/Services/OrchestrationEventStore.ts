/**
 * OrchestrationEventStore - Event store interface for orchestration events.
 *
 * Owns durable append/replay access to the orchestration event stream. It does
 * not reduce events into read models or apply command validation rules.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * persistence/decode errors for event append and replay operations.
 *
 * @module OrchestrationEventStore
 */
import { OrchestrationEvent } from "@ryco/contracts";
import { Context } from "effect";
import type { Effect, Stream } from "effect";

import type { OrchestrationEventStoreError } from "../Errors.ts";

/**
 * OrchestrationEventStoreShape - Service API for orchestration event persistence.
 */
export interface OrchestrationEventStoreShape {
  /**
   * Persist a new orchestration event.
   *
   * @param event - Event payload without sequence (assigned by storage).
   * @returns Effect containing the stored event with assigned sequence.
   *
   * Actor kind is inferred from command/metadata before persistence.
   */
  readonly append: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Replay events after the provided sequence.
   *
   * @param sequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to emit.
   * @returns Stream containing ordered events.
   *
   * Reads in fixed-size pages and normalizes non-integer/negative limits.
   */
  readonly readFromSequence: (
    sequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Replay a stable range without following events appended after the captured head.
   * `eventTypes` restricts the replay in SQL, so skipped events are never decoded.
   */
  readonly readThroughSequence: (
    sequenceExclusive: number,
    sequenceInclusive: number,
    options?: { readonly eventTypes?: ReadonlyArray<OrchestrationEvent["type"]> },
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /** Return the current durable event-stream head, or zero when the store is empty. */
  readonly latestSequence: Effect.Effect<number, OrchestrationEventStoreError>;

  /**
   * Read a single ordered page of events after the provided sequence.
   *
   * @param sequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to return.
   * @returns Effect containing the page, the next exclusive cursor, and whether more rows exist.
   */
  readonly readPage: (
    sequenceExclusive: number,
    limit: number,
  ) => Effect.Effect<
    {
      readonly events: ReadonlyArray<OrchestrationEvent>;
      readonly nextSequence: number;
      readonly hasMore: boolean;
    },
    OrchestrationEventStoreError
  >;

  /**
   * Read one ordered page of a single aggregate stream after the provided sequence, through the
   * `(aggregate_kind, stream_id, sequence)` index. Resuming a thread subscription replays its own
   * events from here instead of scanning (and decoding) pages of the global log.
   *
   * @returns The page, the next exclusive cursor (the last event's sequence, or the input cursor
   * when empty), and whether more events of this stream follow.
   */
  readonly readStreamEventsPage: (input: {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly streamId: string;
    readonly fromSequenceExclusive: number;
    readonly limit: number;
  }) => Effect.Effect<
    {
      readonly events: ReadonlyArray<OrchestrationEvent>;
      readonly nextSequence: number;
      readonly hasMore: boolean;
    },
    OrchestrationEventStoreError
  >;

  /**
   * Payload-free resume probe for replayable subscriptions: whether the event
   * at `sequence` is still held, and how many events follow it — in the whole
   * log and, optionally, in one aggregate stream — each counted only up to one
   * past its limit. Reads the sequence key and the stream index, never
   * `payload_json`.
   */
  readonly probeResume?: (input: {
    readonly sequence: number;
    readonly limit: number;
    readonly stream?: {
      readonly aggregateKind: OrchestrationEvent["aggregateKind"];
      readonly streamId: string;
      readonly limit: number;
    };
  }) => Effect.Effect<
    {
      readonly anchored: boolean;
      readonly eventsAfter: number;
      readonly streamEventsAfter: number | null;
    },
    OrchestrationEventStoreError
  >;

  /** Newest-first bounded operational read. Callers must authorization-filter aggregates. */
  readonly readRecent?: (input: {
    readonly since: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, OrchestrationEventStoreError>;

  /**
   * Read all events from the beginning of the stream.
   *
   * @returns Stream containing all stored events.
   */
  readonly readAll: () => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /**
   * Check whether an aggregate has an event of the requested type after a
   * sequence. Replay-time side effects use this to avoid acting on an event
   * that a later incarnation superseded.
   */
  readonly hasEventAfter: (input: {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: string;
    readonly type: OrchestrationEvent["type"];
    readonly sequenceExclusive: number;
  }) => Effect.Effect<boolean, OrchestrationEventStoreError>;
}

/**
 * OrchestrationEventStore - Service tag for orchestration event persistence.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const events = yield* OrchestrationEventStore
 *   return yield* Stream.runCollect(events.readAll())
 * })
 * ```
 */
export class OrchestrationEventStore extends Context.Service<
  OrchestrationEventStore,
  OrchestrationEventStoreShape
>()("ryco/persistence/Services/OrchestrationEventStore") {}
