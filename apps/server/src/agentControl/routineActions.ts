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
    case "deviceBoot":
    case "deviceAttach":
      // A Full access chat may bring up a simulator or emulator for its own work: the validator
      // keeps the plan to the caller's own thread, project and provider, and execution rechecks
      // the device state the agent saw. Everything else on a device stays the user's call.
      return principal.originRuntimeMode === "full-access";
    case "importProject":
    case "copyProjectToNode":
      // Always the user's decision: a network clone into a new folder, setup commands, and
      // for a copy, content leaving this node.
      return false;
    default:
      // Includes `deviceControlConsent`: the user grants routine device input for a task,
      // never the agent itself (a Full access chat skips asking for it in `ryco_device`).
      return false;
  }
};
