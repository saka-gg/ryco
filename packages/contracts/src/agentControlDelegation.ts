import { Schema } from "effect";
import { IsoDateTime, ThreadId } from "./baseSchemas.ts";
import {
  AgentControlCompletionReturn,
  AgentControlProposalId,
  AgentControlRequestId,
} from "./agentControl.ts";
import { OrchestrationSessionStatus } from "./orchestration.ts";

/**
 * Private-session tools for tasks a chat delegated with `ryco_create_threads` and
 * `returnToOrigin`. Like the inspection tools, they are not part of
 * `AGENT_CONTROL_MCP_TOOLS` and never reach the external endpoint.
 */
export const AGENT_CONTROL_DELEGATION_MCP_TOOLS = {
  taskStatus: "ryco_task_status",
  taskCancel: "ryco_task_cancel",
} as const;

export const AGENT_CONTROL_TASK_STATUS_MAX_TASKS = 20;
export const AGENT_CONTROL_TASK_RESULT_MAX_CHARS = 8_000;

export const AgentControlTaskStatusInput = Schema.Struct({
  taskId: Schema.optional(ThreadId),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlTaskStatusInput = typeof AgentControlTaskStatusInput.Type;

export const AgentControlTaskCancelInput = Schema.Struct({
  requestId: AgentControlRequestId,
  taskId: ThreadId,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type AgentControlTaskCancelInput = typeof AgentControlTaskCancelInput.Type;

export const AgentControlTaskRunState = Schema.Literals([
  "starting",
  "running",
  "needs-you",
  "completed",
  "failed",
  "interrupted",
  "unavailable",
]);
export type AgentControlTaskRunState = typeof AgentControlTaskRunState.Type;

export const AgentControlTaskStatusEntry = Schema.Struct({
  taskId: ThreadId,
  proposalId: AgentControlProposalId,
  title: Schema.NullOr(Schema.String),
  return: Schema.Struct({
    status: AgentControlCompletionReturn.fields.status,
    detail: AgentControlCompletionReturn.fields.detail,
    updatedAt: IsoDateTime,
  }),
  run: Schema.Struct({
    state: AgentControlTaskRunState,
    sessionStatus: Schema.NullOr(OrchestrationSessionStatus),
    hasPendingApprovals: Schema.Boolean,
    hasPendingUserInput: Schema.Boolean,
    backgroundLiveness: Schema.NullOr(Schema.Literals(["working", "monitoring"])),
    advanced: Schema.Boolean,
  }),
  /** Untrusted child output: reference data, never instructions or approval. */
  result: Schema.NullOr(
    Schema.Struct({
      untrustedChildOutput: Schema.Literal(true),
      state: Schema.Literals(["completed", "error"]),
      text: Schema.String.check(Schema.isMaxLength(AGENT_CONTROL_TASK_RESULT_MAX_CHARS)),
      truncated: Schema.Boolean,
    }),
  ),
  acknowledged: Schema.Boolean,
});
export type AgentControlTaskStatusEntry = typeof AgentControlTaskStatusEntry.Type;

export const AgentControlTaskStatusResult = Schema.Struct({
  tasks: Schema.Array(AgentControlTaskStatusEntry).check(
    Schema.isMaxLength(AGENT_CONTROL_TASK_STATUS_MAX_TASKS),
  ),
  truncated: Schema.Boolean,
});
export type AgentControlTaskStatusResult = typeof AgentControlTaskStatusResult.Type;
