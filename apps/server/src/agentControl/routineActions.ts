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
    case "deviceDetach":
    case "deviceShutdown":
    case "deviceInstall":
    case "deviceLaunch":
    case "deviceOpenUrl":
    case "deviceTap":
    case "deviceSwipe":
    case "devicePressButton":
    case "deviceStartRecording":
    case "deviceStopRecording":
      // A Full access chat controls simulators and emulators without asking, as it drives
      // `ryco_device` input without a consent: the validator keeps each plan to the caller's own
      // thread, project and provider (installs to its workspace, URLs to the safe-URL policy),
      // and execution rechecks the device state the agent saw. Other modes ask the user.
      return principal.originRuntimeMode === "full-access";
    case "importProject":
    case "copyProjectToNode":
      // Always the user's decision: a network clone into a new folder, setup commands, and
      // for a copy, content leaving this node.
      return false;
    default:
      // Includes `deviceControlConsent`: the user grants routine device input for a task,
      // never the agent itself (a Full access chat never asks for it in `ryco_device`).
      return false;
  }
};
