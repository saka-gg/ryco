/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `Context.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type { OrchestrationCommand, OrchestrationEvent } from "@ryco/contracts";
import { Context } from "effect";
import type { Effect, PubSub, Scope, Stream } from "effect";

import type { OrchestrationCommandAdmissionError, OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /**
   * Highest event sequence committed before this engine instance started (by
   * prior processes). Captured after projection bootstrap and before the
   * command worker forks, so every later event belongs to this process.
   */
  readonly bootSequence: number;

  /** Fail closed without synchronous authority; the returned fence must be checked in the PTY commit. */
  readonly captureThreadWorkspace?: (input: {
    readonly threadId: string;
    readonly cwd: string;
    readonly worktreePath: string | null;
  }) => (() => boolean) | undefined;

  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /**
   * Replay one persisted page of orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to return.
   * @returns Effect containing ordered events and pagination metadata.
   */
  readonly readEventsPage: (
    fromSequenceExclusive: number,
    limit: number,
  ) => Effect.Effect<
    {
      readonly events: ReadonlyArray<OrchestrationEvent>;
      readonly nextSequence: number;
      readonly hasMore: boolean;
    },
    OrchestrationEventStoreError,
    never
  >;

  /** Newest-first bounded persistence read for authorization-filtered summaries. */
  readonly readRecentEvents?: (input: {
    readonly since: string;
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, OrchestrationEventStoreError>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
    options?: {
      /** Acquire settings or other admission leases before the shared storage
       * lifecycle lock. Runs in the engine fiber; must not dispatch recursively. */
      readonly withCommitLease?: <A, E>(commit: Effect.Effect<A, E>) => Effect.Effect<A, E>;
      /** Server-owned wrapper for serialized commit admission. Accepted receipts bypass it. */
      readonly admit: <A, E>(
        commit: Effect.Effect<A, E>,
      ) => Effect.Effect<A, E | OrchestrationCommandAdmissionError>;
    },
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;

  /**
   * Acquire a live domain event subscription synchronously in the caller's fiber.
   *
   * Use this when follow-up work forks a consumer and must not miss a publish
   * between subscription setup and the forked consumer actually starting.
   */
  readonly subscribeDomainEvents: Effect.Effect<
    PubSub.Subscription<OrchestrationEvent>,
    never,
    Scope.Scope
  >;
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.dispatch(command)
 * })
 * ```
 */
export class OrchestrationEngineService extends Context.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("ryco/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
