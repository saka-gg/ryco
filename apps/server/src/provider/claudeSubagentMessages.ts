/**
 * Messages a person sends a running Claude subagent from the Agents panel.
 *
 * A message for the main conversation becomes a turn, but nothing the SDK accepts reaches a
 * subagent that is already running, except a host-side PreToolUse hook: its input carries the
 * calling agent's `agent_id`, which equals the subagent's task id, and its
 * `hookSpecificOutput.additionalContext` lands in that agent's context. So a message waits here
 * and the agent reads it at its next tool call (the mechanism Synara ships). One the agent never
 * reads, because it finished first, is reported instead of dropped.
 *
 * Pure module: no services, no I/O.
 *
 * @module claudeSubagentMessages
 */
import { classifyTaskAgentKind } from "@ryco/shared/taskClassification";

/** Messages one agent may have waiting at once; a person typing more waits for the agent. */
export const CLAUDE_SUBAGENT_PENDING_MESSAGES_MAX = 5;

/** What the agent reads (Synara's wording). */
export function claudeSubagentMessageContext(message: string): string {
  return `The user sent you a message mid-task: ${message}. Address it and adjust your work accordingly.`;
}

export const CLAUDE_SUBAGENT_MESSAGE_UNDELIVERED =
  "Message not delivered: the agent finished before its next step, so it never read your message.";

/** The part of a task the rule reads. */
export interface ClaudeMessageableTask {
  readonly taskType: string | undefined;
  readonly owningAgentId: string | undefined;
}

/**
 * Whether a person can message this task: an agent that calls tools of its own. Shell and
 * monitor tasks have no agent to read anything, and a workflow's coordinator is not the agent
 * doing the work.
 */
export function isMessageableClaudeTask(task: ClaudeMessageableTask | undefined): boolean {
  return (
    task !== undefined &&
    task.taskType !== "local_workflow" &&
    classifyTaskAgentKind({ taskType: task.taskType, agentId: task.owningAgentId }) === "agent"
  );
}

/** Takes every message waiting for `taskId`, oldest first, joined; null when none wait. */
export function takeSubagentMessages(
  pending: Map<string, Array<string>>,
  taskId: string,
): string | null {
  const messages = pending.get(taskId);
  pending.delete(taskId);
  return messages === undefined || messages.length === 0 ? null : messages.join("\n\n");
}
