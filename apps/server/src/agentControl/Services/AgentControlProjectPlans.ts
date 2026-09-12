import type {
  AgentControlCreateProjectPlan,
  AgentControlProjectPreferences,
  AgentControlRemoveProjectPlan,
  AgentControlUpdateProjectPlan,
  IsoDateTime,
  ProjectId,
} from "@ryco/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

import type { AgentControlPlanValidationError } from "../Errors.ts";

export interface PrepareAgentControlProjectCreateInput {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

export interface PrepareAgentControlProjectUpdateInput extends AgentControlProjectPreferences {
  readonly projectId: ProjectId;
  readonly expectedUpdatedAt: IsoDateTime;
  readonly title?: string | undefined;
  readonly workspaceRoot?: string | undefined;
}

export interface PrepareAgentControlProjectRemoveInput {
  readonly projectId: ProjectId;
  readonly expectedUpdatedAt: IsoDateTime;
  readonly force?: boolean | undefined;
}

export type AgentControlProjectPlan =
  | AgentControlCreateProjectPlan
  | AgentControlUpdateProjectPlan
  | AgentControlRemoveProjectPlan;

export interface AgentControlProjectPlansShape {
  readonly prepareCreate: (
    input: PrepareAgentControlProjectCreateInput,
  ) => Effect.Effect<AgentControlCreateProjectPlan, AgentControlPlanValidationError>;
  readonly prepareUpdate: (
    input: PrepareAgentControlProjectUpdateInput,
  ) => Effect.Effect<AgentControlUpdateProjectPlan, AgentControlPlanValidationError>;
  readonly prepareRemove: (
    input: PrepareAgentControlProjectRemoveInput,
  ) => Effect.Effect<AgentControlRemoveProjectPlan, AgentControlPlanValidationError>;
  /** Recheck the immutable project plan immediately before execution. */
  readonly revalidate: (
    plan: AgentControlProjectPlan,
  ) => Effect.Effect<void, AgentControlPlanValidationError>;
}

export class AgentControlProjectPlans extends Context.Service<
  AgentControlProjectPlans,
  AgentControlProjectPlansShape
>()("ryco/agentControl/Services/AgentControlProjectPlans") {}
