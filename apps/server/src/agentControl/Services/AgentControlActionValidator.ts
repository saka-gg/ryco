import {
  AGENT_CONTROL_CAPABILITIES,
  type AgentControlActionPlan,
  type AgentControlExternalIntegration,
  type AgentControlExternalIntegrationPrincipal,
  type AgentControlPrincipal,
  type AgentControlProviderSessionPrincipal,
  type AgentControlProposal,
  type AgentControlTargetThreadSnapshot,
  type OrchestrationThreadShell,
  type RuntimeMode,
  type ServerProvider,
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

export const agentControlTargetSnapshotOf = (
  thread: OrchestrationThreadShell,
): AgentControlTargetThreadSnapshot => ({
  threadId: thread.id,
  projectId: thread.projectId,
  runtimeMode: thread.runtimeMode,
  envMode: agentControlThreadEnvMode(thread),
  archived: thread.archivedAt !== null,
  activeTurnId: thread.session?.activeTurnId ?? null,
});

/** Target thread state captured at submission by principals that control existing threads. */
export const agentControlTargetSnapshots = (
  principal: AgentControlPrincipal,
): ReadonlyArray<AgentControlTargetThreadSnapshot> =>
  principal.kind === "automation-owner" ? [] : (principal.targetSnapshots ?? []);

/**
 * An external integration has no caller thread. Its thread-control ceiling is
 * what its grants let it create: approval-required in an isolated worktree,
 * raised only by the explicit full-access and shared-checkout grants.
 */
export const agentControlExternalCeiling = (
  integration: Pick<AgentControlExternalIntegration, "capabilities">,
): { readonly runtimeMode: RuntimeMode; readonly envMode: "local" | "worktree" } => ({
  runtimeMode: integration.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalFullAccess)
    ? "full-access"
    : "approval-required",
  envMode: integration.capabilities.includes(AGENT_CONTROL_CAPABILITIES.externalSharedCheckout)
    ? "local"
    : "worktree",
});

export const isAgentControlProviderReady = (provider: ServerProvider): boolean =>
  provider.enabled &&
  provider.installed &&
  provider.status === "ready" &&
  (provider.availability ?? "available") === "available";
