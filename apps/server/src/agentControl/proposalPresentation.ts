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
      return [
        AGENT_CONTROL_RISK_TAGS.scheduledRun,
        AGENT_CONTROL_RISK_TAGS.createsThreads,
        AGENT_CONTROL_RISK_TAGS.startsProviderTurn,
      ];
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
      return [AGENT_CONTROL_RISK_TAGS.deviceMutation];
  }
};

export const agentControlPromptSummaryForPlan = (plan: AgentControlActionPlan): string => {
  switch (plan.kind) {
    case "createThreads":
      return `Create ${plan.entries.length} thread${plan.entries.length === 1 ? "" : "s"}`;
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
      return `Change ${plan.change.kind}`;
    case "createAutomation":
      return `Create automation ${plan.automationId}; each run requires separate approval`;
    case "updateAutomation":
      return `Update automation ${plan.automationId} from revision ${plan.before.revision}`;
    case "cancelAutomation":
      return `Cancel future runs for automation ${plan.automationId}`;
    case "automationRun":
      return `Approve scheduled run ${plan.runId}`;
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
  }
};
