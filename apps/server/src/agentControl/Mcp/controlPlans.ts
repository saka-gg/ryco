/**
 * Immutable plan builders shared by the private session catalog and the
 * standalone external catalog, so both principals submit byte-identical
 * plans (and plan digests) for the same tool input.
 *
 * @module agentControl/Mcp/controlPlans
 */
import type {
  AgentControlActionPlan,
  AgentControlMcpInterruptThreadInput,
  AgentControlMcpSendMessageInput,
  AgentControlMcpUpdateThreadInput,
  AgentControlPlanWorkspaceInput,
  AgentControlWorkspaceLifecyclePlan,
  ThreadId,
} from "@ryco/contracts";
import { Effect } from "effect";

import { computeAgentControlPlanDigest } from "../planDigest.ts";
import { workspacePlanBlockers, type AgentControlWorkspaces } from "../workspaceLifecycle.ts";

type Plan<K extends AgentControlActionPlan["kind"]> = Extract<AgentControlActionPlan, { kind: K }>;

export const sendMessagePlan = (input: AgentControlMcpSendMessageInput): Plan<"sendMessage"> => ({
  kind: "sendMessage",
  threadId: input.threadId,
  text: input.text,
  delivery: input.delivery,
});

export const interruptThreadPlan = (
  input: AgentControlMcpInterruptThreadInput,
): Plan<"interruptThread"> => ({
  kind: "interruptThread",
  threadId: input.threadId,
  ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
});

export const updateThreadPlan = (
  input: AgentControlMcpUpdateThreadInput,
): Plan<"updateThread"> => ({
  kind: "updateThread",
  threadId: input.threadId,
  ...(input.title === undefined ? {} : { title: input.title }),
  ...(input.archived === undefined ? {} : { archived: input.archived }),
  ...(input.persistentGoal === undefined ? {} : { persistentGoal: input.persistentGoal }),
  ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
  ...(input.runtimeMode === undefined ? {} : { runtimeMode: input.runtimeMode }),
  ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
  ...(input.tokenMode === undefined ? {} : { tokenMode: input.tokenMode }),
});

/**
 * Read-only lifecycle preflight: the exact plan, its digest, and blockers.
 * `caller` is the requesting thread, or `null` for a standalone integration.
 */
export const planWorkspaceLifecycle = (
  workspaces: typeof AgentControlWorkspaces.Service,
  input: typeof AgentControlPlanWorkspaceInput.Type,
  caller: ThreadId | null,
) =>
  workspaces.read(input.projectId, input.workspaceId, caller).pipe(
    Effect.map((expected) => {
      const plan: AgentControlWorkspaceLifecyclePlan = {
        kind: "workspaceLifecycle",
        projectId: input.projectId,
        expected,
        action: input.action,
        checkoutMode: input.checkoutMode,
        sessions: input.sessions,
        deleteBranch: input.deleteBranch,
      };
      return {
        plan,
        planDigest: computeAgentControlPlanDigest(plan),
        blockers: workspacePlanBlockers(plan),
      };
    }),
  );
