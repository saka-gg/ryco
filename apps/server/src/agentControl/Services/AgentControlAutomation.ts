import type {
  AgentControlActionPlan,
  AgentControlAutomation,
  AgentControlAutomationDefinition,
  AgentControlAutomationId,
  AgentControlAutomationRun,
  AgentControlProposal,
  ProjectId,
  ProviderInstanceId,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { AgentControlAutomationRepositoryError } from "../../persistence/Errors.ts";
import type { AgentControlPlanValidationError } from "../Errors.ts";
import type { AgentControlProposalStoreError } from "./AgentControlProposalStore.ts";

export type AgentControlAutomationServiceError =
  | AgentControlAutomationRepositoryError
  | AgentControlPlanValidationError
  | AgentControlProposalStoreError;

export interface AgentControlAutomationScope {
  readonly projectId: ProjectId;
  readonly providerInstanceId?: ProviderInstanceId;
}

export interface AgentControlAutomationShape {
  readonly list: (
    scope: AgentControlAutomationScope & {
      readonly includeDisabled: boolean;
      readonly limit: number;
    },
  ) => Effect.Effect<ReadonlyArray<AgentControlAutomation>, AgentControlAutomationServiceError>;
  readonly get: (
    automationId: AgentControlAutomationId,
    scope: AgentControlAutomationScope,
  ) => Effect.Effect<AgentControlAutomation, AgentControlAutomationServiceError>;
  readonly listRuns: (
    automationId: AgentControlAutomationId,
    scope: AgentControlAutomationScope & { readonly limit: number },
  ) => Effect.Effect<ReadonlyArray<AgentControlAutomationRun>, AgentControlAutomationServiceError>;
  readonly validateDefinition: (
    definition: AgentControlAutomationDefinition,
    now: string,
  ) => Effect.Effect<void, AgentControlPlanValidationError>;
  readonly validateLifecyclePlan: (
    plan: Extract<
      AgentControlActionPlan,
      { kind: "createAutomation" | "updateAutomation" | "cancelAutomation" }
    >,
  ) => Effect.Effect<void, AgentControlAutomationServiceError>;
  readonly applyLifecycle: (
    proposal: AgentControlProposal,
  ) => Effect.Effect<AgentControlAutomation, AgentControlAutomationServiceError>;
  readonly validateRun: (
    proposal: AgentControlProposal,
  ) => Effect.Effect<void, AgentControlAutomationServiceError>;
  readonly materializeDue: Effect.Effect<number, AgentControlAutomationServiceError>;
  /** Reconcile durable materialization and proposal state after restart. */
  readonly recover: Effect.Effect<void, AgentControlAutomationServiceError>;
  readonly reconcileProposal: (
    proposal: AgentControlProposal,
  ) => Effect.Effect<void, AgentControlAutomationServiceError>;
}

export class AgentControlAutomationService extends Context.Service<
  AgentControlAutomationService,
  AgentControlAutomationShape
>()("ryco/agentControl/Services/AgentControlAutomation") {}

/** Why an agent's plan may not let a schedule run without asking. */
export const UNATTENDED_OWNER_ONLY =
  "Only the project owner can let a schedule run without asking.";
