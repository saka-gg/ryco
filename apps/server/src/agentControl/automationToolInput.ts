/**
 * The automation definition an agent's `ryco_propose_automation_create` or
 * `ryco_propose_automation_update` asks for, shared by the private and the external MCP tools.
 *
 * @module automationToolInput
 */
import type {
  AgentControlAutomation,
  AgentControlAutomationDefinition,
  AgentControlMcpProposeAutomationCreateInput,
  AgentControlMcpProposeAutomationUpdateInput,
} from "@ryco/contracts";

/** A new automation's definition from the create tool's input. */
export const automationDefinitionFromCreateInput = (
  input: AgentControlMcpProposeAutomationCreateInput,
): AgentControlAutomationDefinition => ({
  execution: {
    projectId: input.projectId,
    title: input.title,
    prompt: input.prompt,
    modelSelection: {
      instanceId: input.providerInstanceId,
      model: input.model,
      options: input.options,
    },
    runtimeMode: input.runtimeMode,
    ...(input.tokenMode === undefined ? {} : { tokenMode: input.tokenMode }),
    envMode: input.envMode,
    ...(input.baseRef === undefined ? {} : { baseRef: input.baseRef }),
    ...(input.targetThreadId === undefined
      ? {}
      : { target: { kind: "thread" as const, threadId: input.targetThreadId } }),
  },
  schedule: input.schedule,
  enabled: input.enabled ?? true,
});

/**
 * The definition after the update tool's input: every field it leaves out keeps its current
 * value. `baseRef: null` and `targetThreadId: null` clear theirs. The owner's "Run without
 * asking" is never carried over: an agent's edit always asks again.
 */
export const automationDefinitionAfterUpdateInput = (
  current: Pick<AgentControlAutomation, "definition">,
  input: AgentControlMcpProposeAutomationUpdateInput,
): AgentControlAutomationDefinition => {
  const execution = current.definition.execution;
  const nextOptions = input.options ?? execution.modelSelection.options;
  const nextBaseRef = input.baseRef === null ? undefined : (input.baseRef ?? execution.baseRef);
  const nextTarget =
    input.targetThreadId === null
      ? undefined
      : input.targetThreadId === undefined
        ? execution.target
        : { kind: "thread" as const, threadId: input.targetThreadId };
  return {
    execution: {
      projectId: execution.projectId,
      title: input.title ?? execution.title,
      prompt: input.prompt ?? execution.prompt,
      modelSelection: {
        instanceId: input.providerInstanceId ?? execution.modelSelection.instanceId,
        model: input.model ?? execution.modelSelection.model,
        ...(nextOptions === undefined ? {} : { options: nextOptions }),
      },
      runtimeMode: input.runtimeMode ?? execution.runtimeMode,
      ...(input.tokenMode !== undefined
        ? { tokenMode: input.tokenMode }
        : execution.tokenMode !== undefined
          ? { tokenMode: execution.tokenMode }
          : {}),
      envMode: input.envMode ?? execution.envMode,
      ...(nextBaseRef === undefined ? {} : { baseRef: nextBaseRef }),
      ...(nextTarget === undefined ? {} : { target: nextTarget }),
    },
    schedule: input.schedule ?? current.definition.schedule,
    enabled: input.enabled ?? current.definition.enabled,
  };
};
