import type { AgentControlActionPlan, AgentControlPrincipal } from "@ryco/contracts";

/** Only the private, validated provider-session path can use routine authorization. */
export const isRoutineAgentControlAction = (
  principal: AgentControlPrincipal,
  plan: AgentControlActionPlan,
): boolean => {
  if (principal.kind !== "provider-session") return false;
  switch (plan.kind) {
    case "changeSettings":
    case "createThreads":
    case "sendMessage":
    case "interruptThread":
      // The validator checks caller runtime privileges and worktree isolation.
      return true;
    case "updateThread":
      return plan.runtimeMode === undefined && plan.archived !== true;
    case "updateProject":
      // Workspace changes and executable startup scripts remain reviewable.
      return (
        plan.after.workspaceRoot === plan.before.workspaceRoot &&
        JSON.stringify(plan.after.scripts) === JSON.stringify(plan.before.scripts) &&
        plan.after.customSystemPrompt === plan.before.customSystemPrompt
      );
    case "importProject":
    case "copyProjectToNode":
      // Always the user's decision: a network clone into a new folder, setup commands, and
      // for a copy, content leaving this node.
      return false;
    default:
      return false;
  }
};
