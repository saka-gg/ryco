// FILE: agentControlCopyExecutor.ts
// Purpose: The web client's Agent Control executor for `copyProjectToNode`
//          proposals: the shared executor
//          (`@ryco/client-runtime/projectCopy/agentControlExecutor`) with this
//          client's node catalog, presentation tier, node acquisition, project
//          store, proposal stream and copy manager.
// Layer: Web, loaded on demand by `agent-control/agentControlClientExecutor`
//        (`useAgentControlClientExecutor`) the first time a card asks whether
//        it can approve a client-executed proposal, and by the copy runtime
//        when it resumes one; never in the app shell's static graph.

import {
  AGENT_CONTROL_COPY_ACCEPT_RETRY_DELAY_MS,
  AGENT_CONTROL_COPY_EXECUTING_TIMEOUT_MS,
  agentControlCopyNodeReads,
  rebuildAgentControlCopyPlanWith,
  startAgentControlCopyExecutor as startSharedAgentControlCopyExecutor,
  type AgentControlCopyExecutorDeps,
  type AgentControlCopyExecutorSource,
} from "@ryco/client-runtime/projectCopy/agentControlExecutor";
import type { ProjectCopyJobRecord, ProjectCopyRunPlan } from "@ryco/client-runtime/projectCopy";
import type { ProjectCopyAgentControlContext } from "@ryco/client-runtime/projectCopy/manager";

import { isHostedHubMode } from "../../env";
import { readEnvironmentApi } from "../../environmentApi";
import { readNodeCatalogSnapshot, subscribeNodeCatalog } from "../../environments/nodeCatalog";
import { readNodeServerConfig } from "../../environments/nodeServerConfig";
import { getPresentationTier, subscribeToPresentationTier } from "../../lib/presentationTier";
import { randomUUID } from "../../lib/utils";
import { selectProjectByRef, useStore } from "../../store";

export {
  canExecuteAgentControlCopy,
  type AgentControlCopyExecutorDeps,
  type AgentControlCopyExecutorSource,
} from "@ryco/client-runtime/projectCopy/agentControlExecutor";

function appDeps(): AgentControlCopyExecutorDeps {
  return {
    readCatalog: readNodeCatalogSnapshot,
    subscribeCatalog: subscribeNodeCatalog,
    readTier: getPresentationTier,
    subscribeTier: subscribeToPresentationTier,
    isHosted: isHostedHubMode,
    acquireForRead: async (environmentId, copyId) =>
      (await import("../../environments/acquireNode")).acquireNode(environmentId, {
        copyId,
        purpose: "follow",
      }),
    ...agentControlCopyNodeReads({
      readEnvironmentApi,
      readCachedServerConfig: readNodeServerConfig,
    }),
    readProjectUpdatedAt: (environmentId, projectId) =>
      selectProjectByRef(useStore.getState(), { environmentId, projectId })?.updatedAt ?? null,
    startCopy: async (options) =>
      (await import("./copyRuntime/copyManager")).startManagedProjectCopy(options),
    holdCopyStart: async (context) =>
      (await import("./copyRuntime/copyManager")).holdAgentControlCopyStart(context),
    uuid: randomUUID,
    executingTimeoutMs: AGENT_CONTROL_COPY_EXECUTING_TIMEOUT_MS,
    acceptRetryDelayMs: AGENT_CONTROL_COPY_ACCEPT_RETRY_DELAY_MS,
  };
}

/** Called once, the first time the executor is needed; lives for the app's lifetime. */
export function startAgentControlCopyExecutor(
  overrides: Partial<AgentControlCopyExecutorDeps> = {},
): AgentControlCopyExecutorSource {
  return startSharedAgentControlCopyExecutor({ ...appDeps(), ...overrides });
}

/** `copyManager`'s rebuild for resumed Agent Control copies, with the app's reads. */
export function rebuildAgentControlCopyPlan(
  record: ProjectCopyJobRecord,
  context: ProjectCopyAgentControlContext,
): Promise<ProjectCopyRunPlan | null> {
  return rebuildAgentControlCopyPlanWith(appDeps(), record, context);
}
