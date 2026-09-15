import type {
  AgentControlActionPlan,
  AgentControlExternalIntegration,
  AgentControlExternalIntegrationPrincipal,
  AgentControlProviderSessionPrincipal,
  AgentControlProposal,
  OrchestrationThreadShell,
  ServerProvider,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { AgentControlPlanValidationError } from "../Errors.ts";
import type {
  AgentControlSessionRecord,
  AgentControlTurnAuthority,
} from "./AgentControlSessionRegistry.ts";

export interface ValidateAgentControlSubmissionInput {
  readonly session: AgentControlSessionRecord;
  readonly authority: AgentControlTurnAuthority;
  readonly plan: AgentControlActionPlan;
}

export interface ValidateAgentControlExternalSubmissionInput {
  readonly integration: AgentControlExternalIntegration;
  readonly plan: AgentControlActionPlan;
}

export interface AgentControlActionValidatorShape {
  readonly validateOwnerAutomation: (
    plan: Extract<
      AgentControlActionPlan,
      { kind: "createAutomation" | "updateAutomation" | "cancelAutomation" }
    >,
  ) => Effect.Effect<void, AgentControlPlanValidationError>;

  /** Validate live exact-turn authority and return immutable origin/target evidence. */
  readonly validateSubmission: (
    input: ValidateAgentControlSubmissionInput,
  ) => Effect.Effect<AgentControlProviderSessionPrincipal, AgentControlPlanValidationError>;

  readonly validateExternalSubmission: (
    input: ValidateAgentControlExternalSubmissionInput,
  ) => Effect.Effect<AgentControlExternalIntegrationPrincipal, AgentControlPlanValidationError>;

  /** Revalidate the exact approved plan against current server state. */
  readonly revalidateExecution: (
    proposal: AgentControlProposal,
    options?: { readonly allowTurnAdvance?: boolean },
  ) => Effect.Effect<void, AgentControlPlanValidationError>;
}

export class AgentControlActionValidator extends Context.Service<
  AgentControlActionValidator,
  AgentControlActionValidatorShape
>()("ryco/agentControl/Services/AgentControlActionValidator") {}

export const agentControlThreadEnvMode = (
  thread: OrchestrationThreadShell,
): "local" | "worktree" => (thread.worktreeId == null ? "local" : "worktree");

export const isAgentControlProviderReady = (provider: ServerProvider): boolean =>
  provider.enabled &&
  provider.installed &&
  provider.status === "ready" &&
  (provider.availability ?? "available") === "available";
