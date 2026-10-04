/**
 * ProviderEffectIntentRepository - the open-intent ledger for provider-bound
 * side effects (migration 073).
 *
 * Rows are recorded and settled only as a function of committed orchestration
 * events (`applyEvent`, inside the engine's commit transaction), plus the
 * reactor's `dispatched_at` marker and startup recovery's explicit settles.
 * The repository never reads `orchestration_events` and never probes outcomes.
 *
 * @module ProviderEffectIntentRepository
 */
import type { MessageId, OrchestrationEvent, ThreadId } from "@ryco/contracts";
import { Context } from "effect";
import type { Effect, Option } from "effect";

import type { ProviderEffectIntentRecord } from "../../orchestration/providerEffectIntents.ts";
import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export interface ProviderEffectIntentRow extends ProviderEffectIntentRecord {
  /** Set immediately before the provider call: the provider may have received the intent. */
  readonly dispatchedAt: string | null;
  readonly recoveryAttempts: number;
}

export interface ProviderEffectIntentRepositoryShape {
  /**
   * Records and settles what this committed event plans. Must run inside the
   * caller's transaction. Issues no SQL for untracked, non-settling events.
   */
  readonly applyEvent: (event: OrchestrationEvent) => Effect.Effect<void, PersistenceSqlError>;
  /** Marks the intent handed to the provider. Keeps the first timestamp; zero rows is fine. */
  readonly markDispatched: (input: {
    readonly sequence: number;
    readonly dispatchedAt: string;
  }) => Effect.Effect<void, PersistenceSqlError>;
  /** Explicit settle, only where no outcome event can exist. */
  readonly settle: (input: {
    readonly sequence: number;
  }) => Effect.Effect<void, PersistenceSqlError>;
  readonly get: (input: {
    readonly sequence: number;
  }) => Effect.Effect<
    Option.Option<ProviderEffectIntentRow>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  /**
   * The open turn-start intent caused by this user message, if any: who still owns an
   * accepted but unbound turn start (this process's live entry, or the next boot's
   * recovery). None once an outcome settled it.
   */
  readonly findOpenTurnStart: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<
    Option.Option<ProviderEffectIntentRow>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  /** Every open row, in sequence order. */
  readonly listOpen: () => Effect.Effect<
    ReadonlyArray<ProviderEffectIntentRow>,
    PersistenceSqlError | PersistenceDecodeError
  >;
  /** Increments and returns the row's recovery attempts (0 when the row is gone). */
  readonly noteRecoveryAttempt: (input: {
    readonly sequence: number;
  }) => Effect.Effect<number, PersistenceSqlError>;
}

export class ProviderEffectIntentRepository extends Context.Service<
  ProviderEffectIntentRepository,
  ProviderEffectIntentRepositoryShape
>()("ryco/persistence/Services/ProviderEffectIntents/ProviderEffectIntentRepository") {}
