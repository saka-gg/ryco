import {
  AGENT_CONTROL_COPY_ACCEPT_RETRY_DELAY_MS,
  AGENT_CONTROL_COPY_EXECUTING_TIMEOUT_MS,
  agentControlCopyNodeReads,
  rebuildAgentControlCopyPlanWith,
  startAgentControlCopyExecutor,
  type AgentControlClientExecutor,
  type AgentControlCopyExecutorDeps,
  type AgentControlCopyExecutorSource,
} from "@ryco/client-runtime/projectCopy/agentControlExecutor";
import type { ProjectCopyJobRecord, ProjectCopyRunPlan } from "@ryco/client-runtime/projectCopy";
import type { ProjectCopyAgentControlContext } from "@ryco/client-runtime/projectCopy/manager";
import { useSyncExternalStore } from "react";

import { readEnvironmentApi } from "../../connection/environmentApi";
import { getCachedHubNodeRoster } from "../../hostedHub/nodeRoster";
import { uuidv4 } from "../../lib/uuid";
import { readEnvironmentServerConfig } from "../../state/environmentServerConfigs";
import { selectProjectByRef, useStore } from "../../state/threadsRuntime";
import { acquireMobileNode } from "./mobileAcquireNode";
import { holdAgentControlCopyStart, startManagedProjectCopy } from "./mobileCopyManager";
import { readMobileNodeCatalog, subscribeMobileNodeCatalog } from "./mobileNodeCatalog";

/**
 * The phone's Agent Control executor for `copyProjectToNode` proposals: the
 * shared executor with the phone's node catalog, node acquisition, project
 * store, proposal stream and copy manager. The phone is a full client, so it
 * approves and runs copies like the desktop does; whether it can for one
 * proposal is the shared rule (`canExecuteAgentControlCopy`: the target is a
 * machine this phone knows and may write to).
 */

function mobileDeps(): AgentControlCopyExecutorDeps {
  return {
    readCatalog: readMobileNodeCatalog,
    subscribeCatalog: subscribeMobileNodeCatalog,
    // The native app has no frozen phone tier: it always runs copies.
    readTier: () => "native",
    subscribeTier: () => () => undefined,
    // A Hub machine is one this phone reaches through the relay.
    isHosted: (environmentId) =>
      getCachedHubNodeRoster().some((node) => node.environmentId === environmentId),
    acquireForRead: (environmentId, copyId) =>
      acquireMobileNode(environmentId, { copyId, purpose: "follow" }),
    ...agentControlCopyNodeReads({
      readEnvironmentApi,
      readCachedServerConfig: readEnvironmentServerConfig,
    }),
    readProjectUpdatedAt: (environmentId, projectId) =>
      selectProjectByRef(useStore.getState(), { environmentId, projectId })?.updatedAt ?? null,
    startCopy: async (options) => startManagedProjectCopy(options),
    holdCopyStart: async (context) => holdAgentControlCopyStart(context),
    uuid: uuidv4,
    executingTimeoutMs: AGENT_CONTROL_COPY_EXECUTING_TIMEOUT_MS,
    acceptRetryDelayMs: AGENT_CONTROL_COPY_ACCEPT_RETRY_DELAY_MS,
  };
}

let source: AgentControlCopyExecutorSource | null = null;

function executorSource(): AgentControlCopyExecutorSource {
  return (source ??= startAgentControlCopyExecutor(mobileDeps()));
}

function subscribeExecutor(listener: () => void): () => void {
  return executorSource().subscribe(listener);
}

function readExecutor(): AgentControlClientExecutor {
  return executorSource().getExecutor();
}

/** The phone's copy executor, subscribed: a new one whenever its answers change. */
export function useMobileAgentControlCopyExecutor(): AgentControlClientExecutor {
  return useSyncExternalStore(subscribeExecutor, readExecutor, readExecutor);
}

/** The copy manager's rebuild for resumed Agent Control copies. */
export function rebuildMobileAgentControlCopyPlan(
  record: ProjectCopyJobRecord,
  context: ProjectCopyAgentControlContext,
): Promise<ProjectCopyRunPlan | null> {
  return rebuildAgentControlCopyPlanWith(mobileDeps(), record, context);
}
