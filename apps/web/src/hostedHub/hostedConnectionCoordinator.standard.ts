import { createWorkspaceConnectionDemandState } from "@ryco/client-runtime/state/workspace";

import { hostedOnly } from "./hostedOnly";

/**
 * Standard-build stand-in for `./hostedConnectionCoordinator` (wired by
 * `src/clientModeSeams.ts`). A standard build never starts the hosted workspace
 * coordinator, so its published workspace stays the signed-out snapshot, no
 * node mutation lease is ever granted, and no environment maps to a hosted
 * node. Starting a coordinator, and the demand policy that only a running one
 * consults, are hosted-only. Signatures are pinned to the real module below.
 */
type Hosted = typeof import("./hostedConnectionCoordinator");

export const MAX_HOSTED_WEB_CONNECTIONS: Hosted["MAX_HOSTED_WEB_CONNECTIONS"] = 3;
export const HOSTED_WEB_WAKE_STAGGER_MS: Hosted["HOSTED_WEB_WAKE_STAGGER_MS"] = 750;
export const HOME_DISCOVERY_CACHE_WAIT_MS: Hosted["HOME_DISCOVERY_CACHE_WAIT_MS"] = 1_500;

const SIGNED_OUT_WORKSPACE: ReturnType<Hosted["readHostedWorkspaceState"]> = {
  status: "signed-out",
  accountId: null,
  machines: [],
  workspace: {
    machines: [],
    snapshots: [],
    projects: [],
    worktrees: [],
    threads: [],
    logicalProjects: [],
  },
  homeDiscovery: { environmentId: null, failedEnvironmentIds: [] },
  demand: {
    demand: createWorkspaceConnectionDemandState(MAX_HOSTED_WEB_CONNECTIONS),
    queuedEnvironmentIds: [],
    activeConnectionCount: 0,
  },
};

export const readHostedWorkspaceState: Hosted["readHostedWorkspaceState"] = () =>
  SIGNED_OUT_WORKSPACE;

export const useHostedWorkspaceState: Hosted["useHostedWorkspaceState"] = () =>
  SIGNED_OUT_WORKSPACE;

export const readHostedNodeMutationLease: Hosted["readHostedNodeMutationLease"] = () => null;

export const waitForHostedNodeMutationLease: Hosted["waitForHostedNodeMutationLease"] = () =>
  Promise.resolve(null);

export const nodeIdForHostedEnvironment: Hosted["nodeIdForHostedEnvironment"] = () => null;

export const setHostedWorkspaceBackgrounded: Hosted["setHostedWorkspaceBackgrounded"] = () =>
  Promise.resolve();

export const isHostedEnvironmentDemanded: Hosted["isHostedEnvironmentDemanded"] = () => false;

export const canPreconnectHostedEnvironment: Hosted["canPreconnectHostedEnvironment"] = () => false;

export const requestHostedWorkspaceReconcile: Hosted["requestHostedWorkspaceReconcile"] = () =>
  undefined;

export const retryHostedHomeDiscovery: Hosted["retryHostedHomeDiscovery"] = () => undefined;

export const startHostedWorkspaceCoordinator: Hosted["startHostedWorkspaceCoordinator"] = () =>
  hostedOnly("startHostedWorkspaceCoordinator");

export const createHostedConnectionCoordinator: Hosted["createHostedConnectionCoordinator"] = () =>
  hostedOnly("createHostedConnectionCoordinator");

export const hostedNodeRequiresNativeClient: Hosted["hostedNodeRequiresNativeClient"] = () =>
  hostedOnly("hostedNodeRequiresNativeClient");

export const readHostedDemandReadiness: Hosted["readHostedDemandReadiness"] = () =>
  hostedOnly("readHostedDemandReadiness");

export const hostedDemandUnblocked: Hosted["hostedDemandUnblocked"] = () =>
  hostedOnly("hostedDemandUnblocked");

export const hostedDemandAwaitsPresence: Hosted["hostedDemandAwaitsPresence"] = () =>
  hostedOnly("hostedDemandAwaitsPresence");
