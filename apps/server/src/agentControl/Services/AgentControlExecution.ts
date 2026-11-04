import { Context } from "effect";
import type { Effect } from "effect";
import type {
  AgentControlClientExecutorId,
  AgentControlProposal,
  AgentControlProposalId,
  AgentControlReportClientExecutionInput,
} from "@ryco/contracts";

import type { AgentControlClientExecutionError } from "../Errors.ts";
import type { AgentControlOperationStoreError } from "./AgentControlOperationStore.ts";
import type { AgentControlProposalStoreError } from "./AgentControlProposalStore.ts";

export interface BeginAgentControlClientExecutionInput {
  readonly proposalId: AgentControlProposalId;
  /** Minted and kept by the approving client; the node stores only its hash. */
  readonly executorId: AgentControlClientExecutorId;
}

export type AgentControlClientExecutionFailure =
  | AgentControlProposalStoreError
  | AgentControlOperationStoreError
  | AgentControlClientExecutionError;

/** Lifecycle owner and sole consumer of approved Agent Control proposals. */
export interface AgentControlExecutionShape {
  /**
   * Idempotently attempt to consume one approved proposal. Client-executed kinds
   * (`AGENT_CONTROL_CLIENT_EXECUTED_PLAN_KINDS`) are skipped: the approving client runs them.
   */
  readonly executeApproved: (proposalId: AgentControlProposalId) => Effect.Effect<void>;
  /**
   * Conservatively settle operations left incomplete by a prior process. A client-executed
   * operation is left alone until its report deadline passed; an `importProject` settles from
   * its import job and is never compensated.
   */
  readonly recoverIncomplete: Effect.Effect<void>;
  /**
   * Binds an approved client-executed proposal to the client that accepted it: re-checks the
   * plan's digest and current validity, then in one transaction moves it to `executing` and
   * inserts its operation with the executor's hash and report deadline. The same executor gets
   * the current state again (and finishes a begin a crash left undone); another fails
   * `executor-mismatch`.
   */
  readonly beginClientExecution: (
    input: BeginAgentControlClientExecutionInput,
  ) => Effect.Effect<AgentControlProposal, AgentControlClientExecutionFailure>;
  /**
   * The approving client's report, accepted only from its executor while the proposal executes:
   * `started` records the target's import and extends the deadline; `completed` and `failed`
   * settle the operation and the proposal. Repeating the outcome that settled it answers with
   * the proposal as it is.
   */
  readonly reportClientExecution: (
    input: AgentControlReportClientExecutionInput,
  ) => Effect.Effect<AgentControlProposal, AgentControlClientExecutionFailure>;
  /** Fails client-executed operations whose report deadline passed. Never fails itself. */
  readonly sweepClientExecutions: Effect.Effect<void>;
}

export class AgentControlExecution extends Context.Service<
  AgentControlExecution,
  AgentControlExecutionShape
>()("ryco/agentControl/Services/AgentControlExecution") {}
