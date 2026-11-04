/**
 * AgentControlOperationStore - Facade over durable operation persistence
 * that owns one-operation-per-proposal creation, legal state transitions,
 * and recovery listing.
 *
 * Operations exist only downstream of an executing proposal. Recovery
 * reads and winding-down transitions (compensating, terminal settles) stay
 * available while the feature gate is off so restart cleanup can always
 * settle stragglers — but operations cannot be created or moved into
 * `running` while disabled.
 *
 * @module AgentControlOperationStore
 */
import type {
  AgentControlOperation,
  AgentControlOperationId,
  AgentControlOperationState,
  AgentControlOperationStatus,
  AgentControlProposal,
  AgentControlResultEnvelope,
  IsoDateTime,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect, Option } from "effect";

import type { AgentControlOperationRepositoryError } from "../../persistence/Errors.ts";
import type {
  AgentControlDisabledError,
  AgentControlInvalidTransitionError,
  AgentControlOperationNotFoundError,
} from "../Errors.ts";
import type { AgentControlTransitionActor } from "../transitions.ts";

export interface CreateAgentControlOperationInput {
  /** Must be in `executing`; the operation records that execution durably. */
  readonly proposal: AgentControlProposal;
  readonly now: IsoDateTime;
  /**
   * The new operation's evidence from the start, e.g. a client-executed operation's executor
   * binding. Ignored when the proposal already owns an operation.
   */
  readonly state?: AgentControlOperationState | undefined;
}

export interface CreateAgentControlOperationResult {
  readonly operation: AgentControlOperation;
  /** `true` when the proposal already owned an operation (recovery/retry). */
  readonly replayed: boolean;
}

export interface TransitionAgentControlOperationInput {
  readonly operationId: AgentControlOperationId;
  readonly expectedStatus: AgentControlOperationStatus;
  readonly nextStatus: AgentControlOperationStatus;
  readonly actor: AgentControlTransitionActor;
  readonly attempt: number;
  readonly state: AgentControlOperationState;
  readonly result: AgentControlResultEnvelope | null;
  readonly updatedAt: IsoDateTime;
}

export interface CheckpointAgentControlOperationInput {
  readonly operationId: AgentControlOperationId;
  readonly expectedStatus: Extract<AgentControlOperationStatus, "running" | "compensating">;
  readonly attempt: number;
  readonly state: AgentControlOperationState;
  readonly updatedAt: IsoDateTime;
}

export type AgentControlOperationStoreError =
  | AgentControlDisabledError
  | AgentControlOperationNotFoundError
  | AgentControlInvalidTransitionError
  | AgentControlOperationRepositoryError;

/**
 * AgentControlOperationStoreShape - Service API for durable operations.
 */
export interface AgentControlOperationStoreShape {
  /** Create (or replay) the single durable operation for an executing proposal. */
  readonly createForProposal: (
    input: CreateAgentControlOperationInput,
  ) => Effect.Effect<CreateAgentControlOperationResult, AgentControlOperationStoreError>;

  readonly getByProposalId: (
    proposalId: AgentControlProposal["proposalId"],
  ) => Effect.Effect<Option.Option<AgentControlOperation>, AgentControlOperationRepositoryError>;

  /** Non-terminal operations for restart recovery, oldest update first. */
  readonly listRecoverable: () => Effect.Effect<
    ReadonlyArray<AgentControlOperation>,
    AgentControlOperationRepositoryError
  >;

  /** Validated, winner-takes-once operation transition. */
  readonly transition: (
    input: TransitionAgentControlOperationInput,
  ) => Effect.Effect<AgentControlOperation, AgentControlOperationStoreError>;

  /** Durably replace execution evidence without changing the operation status. */
  readonly checkpoint: (
    input: CheckpointAgentControlOperationInput,
  ) => Effect.Effect<AgentControlOperation, AgentControlOperationStoreError>;
}

/**
 * AgentControlOperationStore - Service tag for the operation facade.
 */
export class AgentControlOperationStore extends Context.Service<
  AgentControlOperationStore,
  AgentControlOperationStoreShape
>()("ryco/agentControl/Services/AgentControlOperationStore") {}
