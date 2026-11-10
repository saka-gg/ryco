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
  /**
   * One run of a webhook schedule for an accepted request (`docs/automation-webhooks.md`, step
   * 7): materialized exactly like a due timed run (`scheduledFor` = when the request arrived,
   * no coalesced occurrences), through the same run policy, with `prompt` (the schedule's prompt
   * and the request, framed) instead of the schedule's own. `not-accepting` when the schedule is
   * paused, cancelled or no longer a webhook schedule, or Agent Control is off; `busy` while a run
   * of it is still waiting for approval or starting (one at a time, like timed runs).
   */
  readonly triggerWebhookRun: (input: {
    readonly automationId: AgentControlAutomationId;
    readonly receivedAt: string;
    readonly prompt: string;
  }) => Effect.Effect<
    "started" | "awaiting-approval" | "not-accepting" | "busy",
    AgentControlAutomationServiceError
  >;
}

export class AgentControlAutomationService extends Context.Service<
  AgentControlAutomationService,
  AgentControlAutomationShape
>()("ryco/agentControl/Services/AgentControlAutomation") {}

/** Why an agent's plan may not give a schedule a webhook trigger. */
export const WEBHOOK_OWNER_ONLY = "Only the project owner can give a schedule a webhook trigger.";

/**
 * A plan that creates a webhook trigger or switches a schedule to one: the owner's alone. An
 * agent may still edit, pause or cancel a webhook schedule that keeps its trigger.
 */
export const planAddsWebhookTrigger = (
  plan: Extract<
    AgentControlActionPlan,
    { kind: "createAutomation" | "updateAutomation" | "cancelAutomation" }
  >,
): boolean =>
  plan.kind === "createAutomation"
    ? plan.definition.schedule.kind === "webhook"
    : plan.kind === "updateAutomation" &&
      plan.after.schedule.kind === "webhook" &&
      plan.before.definition.schedule.kind !== "webhook";

/** Why an agent's plan may not let a schedule run without asking. */
export const UNATTENDED_OWNER_ONLY =
  "Only the project owner can let a schedule run without asking.";
