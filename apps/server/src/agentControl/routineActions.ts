import type { AgentControlActionPlan, AgentControlPrincipal } from "@ryco/contracts";

/** Only the private, validated provider-session path can use routine authorization. */
export const isRoutineAgentControlAction = (
  principal: AgentControlPrincipal,
  plan: AgentControlActionPlan,
): boolean => {
  if (principal.kind !== "provider-session") return false;
  switch (plan.kind) {
    case "changeSettings":
      // Turning provider update checks on while the owner's automatic updates are on would let
      // Ryco install provider CLIs on its own: that waits for the owner.
      return (
        plan.change.kind !== "providerUpdateChecks" || plan.change.startsAutomaticUpdates !== true
      );
    case "createThreads":
    case "sendMessage":
    case "interruptThread":
    case "pullRequestWatch":
    case "worktreeHandoff":
      // The validator checks caller runtime privileges and worktree isolation (and keeps a
      // handoff to the caller's own chat, out of the shared checkout into a new worktree).
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
    default:
      // Includes `deviceControlConsent`: the user grants routine device input for a task,
      // never the agent itself.
      return false;
  }
};
