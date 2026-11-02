/**
 * Approval-card risk tags and prompt summaries for Agent Control plans.
 * Shared by every MCP ingress so a plan is presented identically to the
 * approving user regardless of which principal requested it.
 *
 * @module agentControl/proposalPresentation
 */
import {
  AGENT_CONTROL_RISK_TAGS,
  type AgentControlActionPlan,
  type AgentControlRiskTag,
} from "@ryco/contracts";

export const agentControlRiskTagsForPlan = (
  plan: AgentControlActionPlan,
): Array<AgentControlRiskTag> => {
  switch (plan.kind) {
    case "deleteLocalTask":
      return [AGENT_CONTROL_RISK_TAGS.removesLocalTask];
    case "pullRequestWatch":
      // Reads only; its wakes go through the same idle, scope and permission fences as any.
      return [];
    case "worktreeHandoff":
      // Its continuation is the chat's own next turn, queued like any of its follow-ups.
      return [AGENT_CONTROL_RISK_TAGS.modifiesThreadMetadata];
    case "createThreads": {
      const tags = [
        AGENT_CONTROL_RISK_TAGS.createsThreads,
        AGENT_CONTROL_RISK_TAGS.startsProviderTurn,
      ];
      if (plan.entries.some((entry) => entry.envMode === "local")) {
        tags.push(AGENT_CONTROL_RISK_TAGS.sharedLocalCheckout);
      }
      if (plan.entries.some((entry) => entry.runtimeMode === "full-access")) {
        tags.push(AGENT_CONTROL_RISK_TAGS.elevatedRuntimeMode);
      }
      return tags;
    }
    case "sendMessage":
      return [AGENT_CONTROL_RISK_TAGS.startsProviderTurn];
    case "interruptThread":
      return [AGENT_CONTROL_RISK_TAGS.interruptsThread];
    case "updateThread":
      return [AGENT_CONTROL_RISK_TAGS.modifiesThreadMetadata];
    case "workspaceLifecycle":
      return [AGENT_CONTROL_RISK_TAGS.workspaceLifecycle];
    case "createProject":
      return [AGENT_CONTROL_RISK_TAGS.createsProject];
    case "updateProject":
      return [AGENT_CONTROL_RISK_TAGS.modifiesProjectMetadata];
    case "removeProject":
      return [
        AGENT_CONTROL_RISK_TAGS.removesProject,
        ...(plan.expectedThreadIds.length > 0 ? [AGENT_CONTROL_RISK_TAGS.removesThreads] : []),
      ];
    case "changeSettings":
      return [AGENT_CONTROL_RISK_TAGS.changesSettings];
    case "createAutomation":
      return [AGENT_CONTROL_RISK_TAGS.createsAutomation];
    case "updateAutomation":
      return [AGENT_CONTROL_RISK_TAGS.modifiesAutomation];
    case "cancelAutomation":
      return [AGENT_CONTROL_RISK_TAGS.cancelsAutomation];
    case "automationRun":
      // A heartbeat queues into an existing chat; any other run creates one.
      return plan.execution.target === undefined
        ? [
            AGENT_CONTROL_RISK_TAGS.scheduledRun,
            AGENT_CONTROL_RISK_TAGS.createsThreads,
            AGENT_CONTROL_RISK_TAGS.startsProviderTurn,
          ]
        : [AGENT_CONTROL_RISK_TAGS.scheduledRun, AGENT_CONTROL_RISK_TAGS.startsProviderTurn];
    case "deviceOpenUrl":
      return [AGENT_CONTROL_RISK_TAGS.deviceMutation, AGENT_CONTROL_RISK_TAGS.deviceOpenWorld];
    case "deviceBoot":
    case "deviceAttach":
    case "deviceDetach":
    case "deviceStartRecording":
    case "deviceStopRecording":
    case "deviceShutdown":
      return [AGENT_CONTROL_RISK_TAGS.deviceMutation, AGENT_CONTROL_RISK_TAGS.deviceLifecycle];
    case "deviceInstall":
    case "deviceLaunch":
    case "deviceTap":
    case "deviceSwipe":
    case "devicePressButton":
    case "deviceControlConsent":
      return [AGENT_CONTROL_RISK_TAGS.deviceMutation];
  }
};

/** Where a heartbeat's runs go: the queue of an existing thread. */
const automationTargetSummary = (execution: {
  readonly target?: { readonly threadId: string } | undefined;
}) => (execution.target === undefined ? "" : `, queued in thread ${execution.target.threadId}`);

export const agentControlPromptSummaryForPlan = (plan: AgentControlActionPlan): string => {
  switch (plan.kind) {
    case "deleteLocalTask":
      return `Delete task "${plan.title.slice(0, 200)}" with its files; its chats are kept`;
    case "pullRequestWatch": {
      const pullRequest =
        plan.number !== undefined
          ? `pull request #${plan.number}`
          : plan.url !== undefined
            ? `pull request ${plan.url.slice(0, 200)}`
            : "the pull request";
      return plan.watching
        ? `Watch ${pullRequest} for thread ${plan.threadId}`
        : `Stop watching ${pullRequest} for thread ${plan.threadId}`;
    }
    case "worktreeHandoff":
      return `Move thread ${plan.threadId} into a new worktree on branch ${plan.branch.slice(0, 200)}`;
    case "createThreads": {
      const tasks = plan.entries.filter((entry) => entry.localTaskId !== undefined).length;
      const threads = `Create ${plan.entries.length} thread${plan.entries.length === 1 ? "" : "s"}`;
      const created = tasks === 0 ? threads : `${threads}, ${tasks} started from a task`;
      return plan.maxConcurrent === undefined
        ? created
        : `${created}. At most ${plan.maxConcurrent} run at once`;
    }
    case "sendMessage":
      return `Send a message to thread ${plan.threadId}`;
    case "interruptThread":
      return `Interrupt thread ${plan.threadId}`;
    case "updateThread":
      return `Update thread ${plan.threadId}`;
    case "workspaceLifecycle":
      return `${plan.action} workspace ${plan.expected.workspaceId}; ${plan.checkoutMode}; ${plan.sessions} sessions; ${plan.deleteBranch ? "delete" : "retain"} branch`;
    case "createProject":
      return `Create project ${plan.title}`;
    case "updateProject":
      return `Update project ${plan.projectId}`;
    case "removeProject":
      return `Unlink project ${plan.expected.title}; workspace files will be retained`;
    case "changeSettings":
      return plan.change.kind === "providerUpdateChecks" && plan.change.startsAutomaticUpdates
        ? "Turn on provider update checks; this node's automatic updates would start installing CLI updates (and, on a CLI service node, Ryco's own releases)"
        : `Change ${plan.change.kind}`;
    case "createAutomation":
      return `Create automation ${plan.automationId}${automationTargetSummary(plan.definition.execution)}; each run requires separate approval`;
    case "updateAutomation":
      return `Update automation ${plan.automationId} from revision ${plan.before.revision}${automationTargetSummary(plan.after.execution)}`;
    case "cancelAutomation":
      return `Cancel future runs for automation ${plan.automationId}`;
    case "automationRun":
      return `Approve scheduled run ${plan.runId}${automationTargetSummary(plan.execution)}`;
    case "deviceBoot":
    case "deviceAttach":
    case "deviceDetach":
    case "deviceInstall":
    case "deviceLaunch":
    case "deviceOpenUrl":
    case "deviceTap":
    case "deviceSwipe":
    case "devicePressButton":
    case "deviceStartRecording":
    case "deviceStopRecording":
    case "deviceShutdown":
      return plan.executionSummary;
    case "deviceControlConsent":
      return `Allow routine input on device ${plan.udid} for this task`;
  }
};
