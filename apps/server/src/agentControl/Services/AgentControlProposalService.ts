/**
 * AgentControlProposalService - User-facing approval lifecycle facade.
 *
 * This is the surface the owner-authorized RPC layer (and future MCP read
 * tools) consume: queue reads, single-proposal reads, accept/reject
 * decisions, and the queue subscription. It builds on the proposal store,
 * which owns transitions, idempotency, audit, and change-event publication.
 *
 * Behavior added on top of the store:
 *
 *   - Server-side expiry convergence: every queue/proposal read sweeps
 *     overdue proposals first, and the live layer runs a periodic sweep so
 *     expiry does not depend on clients or decision attempts.
 *   - Idempotent decisions: repeating a decision that already stands (or
 *     losing a race to an identical decision) succeeds with the current
 *     receipt instead of failing, so double-clicks and multi-device races
 *     stay calm. A conflicting decision still fails with the actual state.
 *   - Bounded receipts: decisions return `AgentControlProposalReceipt`, the
 *     stable shape future MCP read/wait tools will surface — never the plan
 *     payload or prompt text.
 *
 * The service deliberately has no execution API: the future executor owns
 * `executing`/`completed`/`failed` and dispatches through the store.
 *
 * @module AgentControlProposalService
 */
import type {
  AgentControlProposal,
  AgentControlPrincipal,
  AgentControlRequestId,
  AgentControlProposalId,
  AgentControlProposalQueue,
  AgentControlProposalReceipt,
  AgentControlProposalStreamEvent,
  IsoDateTime,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect, Option, Stream } from "effect";

import type {
  AgentControlProposalStoreError,
  SubmitAgentControlProposalInput,
  SubmitAgentControlProposalResult,
} from "./AgentControlProposalStore.ts";
import type { AgentControlSettingsChangeUnsupportedError } from "../Errors.ts";

export type AgentControlProposalDecisionError =
  | AgentControlProposalStoreError
  | AgentControlSettingsChangeUnsupportedError;

export interface AgentControlQueueLimitsInput {
  /** Capped at `AGENT_CONTROL_QUEUE_ACTIVE_LIMIT_MAX`. */
  readonly activeLimit?: number | undefined;
  /** Capped at `AGENT_CONTROL_QUEUE_RECENT_LIMIT_MAX`. */
  readonly recentLimit?: number | undefined;
}

export interface DecideAgentControlProposalRequest {
  readonly proposalId: AgentControlProposalId;
  readonly decidedAt: IsoDateTime;
}

/** Bounded lifecycle receipt for a proposal; see the contract's docs. */
export const toAgentControlProposalReceipt = (
  proposal: AgentControlProposal,
): AgentControlProposalReceipt => ({
  proposalId: proposal.proposalId,
  requestId: proposal.requestId,
  actionKind: proposal.plan.kind,
  planDigest: proposal.planDigest,
  riskTags: proposal.riskTags,
  status: proposal.status,
  createdAt: proposal.createdAt,
  updatedAt: proposal.updatedAt,
  expiresAt: proposal.expiresAt,
  decidedAt: proposal.decidedAt,
  result: proposal.result,
});

/**
 * AgentControlProposalServiceShape - Service API for the approval surface.
 */
export interface AgentControlProposalServiceShape {
  readonly findByRequest?: (
    principal: AgentControlPrincipal,
    requestId: AgentControlRequestId,
  ) => Effect.Effect<Option.Option<AgentControlProposal>, AgentControlProposalStoreError>;

  /** Create a proposal (delegates to the store; future MCP ingress entry). */
  readonly submit: (
    input: SubmitAgentControlProposalInput,
  ) => Effect.Effect<SubmitAgentControlProposalResult, AgentControlProposalStoreError>;

  /** Sweep overdue proposals, then read the queue snapshot. */
  readonly getQueue: (
    input: AgentControlQueueLimitsInput,
  ) => Effect.Effect<AgentControlProposalQueue, AgentControlProposalStoreError>;

  /** Sweep overdue proposals, then read one proposal. */
  readonly getProposal: (
    proposalId: AgentControlProposalId,
  ) => Effect.Effect<Option.Option<AgentControlProposal>, AgentControlProposalStoreError>;

  /** Accept a pending proposal (idempotent when it is already approved). */
  readonly accept: (
    input: DecideAgentControlProposalRequest,
  ) => Effect.Effect<AgentControlProposalReceipt, AgentControlProposalDecisionError>;

  /** Reject a pending proposal (idempotent when it is already rejected). */
  readonly reject: (
    input: DecideAgentControlProposalRequest,
  ) => Effect.Effect<AgentControlProposalReceipt, AgentControlProposalDecisionError>;

  /** One expiry sweep pass; returns the proposals expired by this call. */
  readonly expireOverdue: (
    now: IsoDateTime,
  ) => Effect.Effect<ReadonlyArray<AgentControlProposal>, AgentControlProposalStoreError>;

  /**
   * Snapshot-then-live queue subscription. The live subscription is
   * acquired before the snapshot read, so no change event between the two
   * can be lost; events already covered by the snapshot are filtered by
   * revision, and any overlap is an idempotent client-side upsert.
   */
  readonly subscribeQueue: (
    input: AgentControlQueueLimitsInput,
  ) => Stream.Stream<AgentControlProposalStreamEvent, AgentControlProposalStoreError>;
}

/**
 * AgentControlProposalService - Service tag for the approval surface.
 */
export class AgentControlProposalService extends Context.Service<
  AgentControlProposalService,
  AgentControlProposalServiceShape
>()("ryco/agentControl/Services/AgentControlProposalService") {}
