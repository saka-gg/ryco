import { Schema } from "effect";
import {
  AgentControlAutomation,
  AgentControlAutomationDefinition,
  AgentControlAutomationId,
  AgentControlAutomationRun,
  AgentControlAutomationRunId,
  AgentControlProposal,
  AgentControlRequestId,
} from "./agentControl.ts";
import { ProjectId, ThreadId, PositiveInt, NonNegativeInt, IsoDateTime } from "./baseSchemas.ts";

export const AutomationCentreInput = Schema.Struct({ projectId: ProjectId });
export type AutomationCentreInput = typeof AutomationCentreInput.Type;
export const AutomationCentreRun = Schema.Struct({
  run: AgentControlAutomationRun,
  execution: Schema.NullOr(AgentControlAutomationDefinition.fields.execution),
  threadIds: Schema.Array(ThreadId),
  unread: Schema.Boolean,
  retryOfRunId: Schema.NullOr(AgentControlAutomationRunId),
});
export type AutomationCentreRun = typeof AutomationCentreRun.Type;
export const AutomationCentreSnapshot = Schema.Struct({
  automations: Schema.Array(AgentControlAutomation),
  runs: Schema.Array(AutomationCentreRun),
  proposals: Schema.Array(AgentControlProposal),
  unavailableRecords: NonNegativeInt,
  /** This bounded view does not imply complete history. */
  historyLimit: PositiveInt,
});
export type AutomationCentreSnapshot = typeof AutomationCentreSnapshot.Type;
const commandScope = { projectId: ProjectId, requestId: AgentControlRequestId };
export const AutomationCentreCommand = Schema.Union([
  Schema.Struct({
    ...commandScope,
    kind: Schema.Literal("save"),
    automationId: AgentControlAutomationId,
    expectedRevision: Schema.NullOr(PositiveInt),
    definition: AgentControlAutomationDefinition,
  }),
  Schema.Struct({
    ...commandScope,
    kind: Schema.Literal("cancel"),
    automationId: AgentControlAutomationId,
    expectedRevision: PositiveInt,
  }),
  Schema.Struct({
    ...commandScope,
    kind: Schema.Literal("retry"),
    runId: AgentControlAutomationRunId,
  }),
  Schema.Struct({
    ...commandScope,
    kind: Schema.Literal("read"),
    runId: AgentControlAutomationRunId,
    expectedUpdatedAt: IsoDateTime,
    unread: Schema.Boolean,
  }),
]).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AutomationCentreCommand = typeof AutomationCentreCommand.Type;
export interface AutomationCentreApi {
  readonly snapshot: (input: AutomationCentreInput) => Promise<AutomationCentreSnapshot>;
  readonly command: (input: AutomationCentreCommand) => Promise<AutomationCentreSnapshot>;
}
