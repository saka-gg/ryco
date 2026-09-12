/**
 * AgentControlProposalStore - Facade over proposal persistence that owns
 * idempotency, legal state transitions, expiry enforcement, and audit
 * emission.
 *
 * Invariants enforced here:
 *   - A proposal's plan payload and digest are immutable once written.
 *   - Retrying an identical plan under the same request id returns the
 *     original proposal; reusing a request id with a different plan fails
 *     and leaves an audit row.
 *   - Only the `executor` actor may move an accepted proposal into
 *     `executing`, and expired or cancelled proposals can never execute.
 *   - Every state change appends an audit row containing identifiers and
 *     an audit-safe summary only.
 *   - Every committed insert or transition publishes exactly one change
 *     event to `AgentControlProposalEvents` after the transaction commits,
 *     so approval surfaces observe all lifecycle changes without polling.
 *
 * @module AgentControlProposalStore
 */
import type {
  AgentControlActionPlan,
  AgentControlErrorEnvelope,
  AgentControlPrincipal,
  AgentControlPromptSummary,
  AgentControlProposal,
  AgentControlProposalId,
  AgentControlRequestId,
  AgentControlResultEnvelope,
  AgentControlRiskTag,
  IsoDateTime,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect, Option } from "effect";

import type {
  AgentControlAuditRepositoryError,
  AgentControlProposalRepositoryError,
} from "../../persistence/Errors.ts";
import type {
  AgentControlDisabledError,
  AgentControlDuplicateRequestError,
  AgentControlInvalidTransitionError,
  AgentControlProposalExpiredError,
  AgentControlProposalNotFoundError,
} from "../Errors.ts";
import type { AgentControlTransitionActor } from "../transitions.ts";

export interface SubmitAgentControlProposalInput {
  /** Set only after private session validation; the store independently classifies the plan. */
  readonly authorizeRoutine?: boolean;
  readonly principal: AgentControlPrincipal;
  readonly requestId: AgentControlRequestId;
  readonly plan: AgentControlActionPlan;
  readonly riskTags: ReadonlyArray<AgentControlRiskTag>;
  readonly promptSummary: AgentControlPromptSummary | null;
  readonly expiresAt: IsoDateTime;
  readonly now: IsoDateTime;
}

export interface SubmitAgentControlProposalResult {
  readonly proposal: AgentControlProposal;
  /** `true` when an identical request was replayed and no new row was written. */
  readonly replayed: boolean;
}

export type AgentControlProposalDecision = "approved" | "rejected" | "cancelled";

export interface DecideAgentControlProposalInput {
  readonly proposalId: AgentControlProposalId;
  readonly decision: AgentControlProposalDecision;
  readonly actor: AgentControlTransitionActor;
  readonly decidedAt: IsoDateTime;
}

export interface BeginAgentControlExecutionInput {
  readonly proposalId: AgentControlProposalId;
  /** Must be `executor`; every other actor is rejected. */
  readonly actor: AgentControlTransitionActor;
  readonly now: IsoDateTime;
}

export interface SettleAgentControlExecutionInput {
  readonly proposalId: AgentControlProposalId;
  readonly result: AgentControlResultEnvelope;
  readonly now: IsoDateTime;
}

export interface ExpireOverdueAgentControlProposalsInput {
  readonly now: IsoDateTime;
  /** Upper bound on proposals expired in one sweep pass. */
  readonly limit: number;
}

export type AgentControlProposalStoreError =
  | AgentControlDisabledError
  | AgentControlDuplicateRequestError
  | AgentControlProposalNotFoundError
  | AgentControlProposalExpiredError
  | AgentControlInvalidTransitionError
  | AgentControlProposalRepositoryError
  | AgentControlAuditRepositoryError;

/**
 * AgentControlProposalStoreShape - Service API for the proposal lifecycle.
 */
export interface AgentControlProposalStoreShape {
  /** Create a proposal in `pending-user-approval`, idempotently per request id. */
  readonly submit: (
    input: SubmitAgentControlProposalInput,
  ) => Effect.Effect<SubmitAgentControlProposalResult, AgentControlProposalStoreError>;

  readonly getById: (
    proposalId: AgentControlProposalId,
  ) => Effect.Effect<Option.Option<AgentControlProposal>, AgentControlProposalRepositoryError>;

  readonly listPending: (input: {
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<AgentControlProposal>, AgentControlProposalRepositoryError>;

  /** Non-terminal proposals, oldest first — the live approval queue. */
  readonly listActive: (input: {
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<AgentControlProposal>, AgentControlProposalRepositoryError>;

  /** Terminal proposals, most recently updated first — decision history. */
  readonly listRecent: (input: {
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<AgentControlProposal>, AgentControlProposalRepositoryError>;

  /**
   * Server-side expiry enforcement: transition every overdue expirable
   * proposal (pending-user-approval or approved past `expiresAt`) to
   * `expired` and return the proposals actually expired by this call.
   * Losing a transition race to a concurrent decision is not an error —
   * the winner's state stands and the proposal is simply skipped.
   *
   * Deliberately not gated on the feature flag: a proposal created while
   * Agent Control was enabled must still expire after the feature is
   * disabled, so the queue is already converged when it is re-enabled.
   */
  readonly expireOverdue: (
    input: ExpireOverdueAgentControlProposalsInput,
  ) => Effect.Effect<ReadonlyArray<AgentControlProposal>, AgentControlProposalStoreError>;

  /** Approve, reject, or cancel a proposal. Approval past expiry expires it instead. */
  readonly decide: (
    input: DecideAgentControlProposalInput,
  ) => Effect.Effect<AgentControlProposal, AgentControlProposalStoreError>;

  /**
   * Move an approved proposal into `executing`. The future executor is the
   * only permitted caller (`actor: "executor"`); an approved proposal whose
   * expiry has passed is expired instead and refuses execution.
   */
  readonly beginExecution: (
    input: BeginAgentControlExecutionInput,
  ) => Effect.Effect<AgentControlProposal, AgentControlProposalStoreError>;

  /** Settle an executing proposal with its terminal receipt. */
  readonly settleExecution: (
    input: SettleAgentControlExecutionInput,
  ) => Effect.Effect<AgentControlProposal, AgentControlProposalStoreError>;
}

export const agentControlFailureResult = (input: {
  readonly error: AgentControlErrorEnvelope;
  readonly failedAt: IsoDateTime;
}): AgentControlResultEnvelope => ({
  outcome: "failed",
  error: input.error,
  failedAt: input.failedAt,
});

/**
 * AgentControlProposalStore - Service tag for the proposal lifecycle facade.
 */
export class AgentControlProposalStore extends Context.Service<
  AgentControlProposalStore,
  AgentControlProposalStoreShape
>()("ryco/agentControl/Services/AgentControlProposalStore") {}
