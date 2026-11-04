// FILE: useProjectSelectorProjects.ts
// Purpose: The project selector's logical projects, each with its checkout on every node and
//          whether a draft may move there, plus the narrow Hub workspace reads they need.
// Layer: Web hook. Grouping is the sidebar's (`useLogicalProjectSnapshots`), nodes are the
//        node catalog's; nothing here connects to, wakes or retains a node.

import type { EnvironmentId } from "@ryco/contracts";
import type { NodePathHints } from "@ryco/contracts/project-copy";
import { useMemo, useSyncExternalStore } from "react";

import { useNodeCatalog } from "../environments/nodeCatalog";
import { usePrimaryEnvironmentId } from "../environments/primary";
import {
  readHostedWorkspaceState,
  subscribeHostedWorkspaceState,
} from "../hostedHub/hostedConnectionCoordinator";
import { useLogicalProjectSnapshots } from "../hooks/useLogicalProjectSnapshots";
import {
  readDesktopWorkspaceState,
  subscribeDesktopWorkspaceState,
} from "../platform/desktopWorkspace";
import { withDirectDesktopExecutionMachine } from "../platform/desktopWorkspaceTarget";
import { buildProjectCheckoutOptions } from "../projectCheckouts.logic";
import { defaultQueryClient } from "../rpc/queryClient";
import { nodePathHintsQueryKey } from "./projectNodes/nodePathQueries";
import {
  buildProjectSelectorProjects,
  checkoutUnavailableReason,
  type ProjectSelectorNode,
  type ProjectSelectorProject,
} from "./ProjectSwitcher.logic";

const NO_PROJECTS: ReadonlyArray<ProjectSelectorProject> = [];

/**
 * A node's home directory from its path hints when a picker or dialog already
 * read them; this never asks the node.
 */
function cachedHomeDirectory(environmentId: EnvironmentId): string | null {
  return (
    defaultQueryClient.getQueryData<NodePathHints>(nodePathHintsQueryKey(environmentId))
      ?.homeDirectory ?? null
  );
}

// The hosted workspace republishes about every 100 ms while threads stream;
// its status and machine list keep their identity across those republishes,
// so reading only them re-renders nothing while a thread streams.
const readHostedStatus = () => readHostedWorkspaceState().status;
const readHostedMachines = () => readHostedWorkspaceState().machines;
const readDesktopStatus = () => readDesktopWorkspaceState().status;
const readDesktopMachines = () => readDesktopWorkspaceState().machines;
const readDesktopLocalEnvironmentId = () => readDesktopWorkspaceState().localEnvironmentId;

/** The hosted workspace's status: `signed-out` outside hosted mode. */
export function useHostedWorkspaceStatus() {
  return useSyncExternalStore(subscribeHostedWorkspaceState, readHostedStatus, readHostedStatus);
}

/**
 * Every logical project with its checkouts, in sidebar order, while `enabled`
 * (an empty list otherwise, so a closed selector builds nothing).
 *
 * A checkout is unavailable when its node is offline, or when the Hub
 * workspace (hosted, or Desktop signed in to the Hub) says this client cannot
 * start work there; that is the same gate the composer's device picker uses.
 * In hosted mode the other nodes' projects are the workspace index's cached
 * metadata (the hosted coordinator hydrates the store from it), so only nodes
 * the index lists are offered, and a node other than the draft's waits for the
 * workspace to be ready, since the move goes through the hosted draft-target
 * controller.
 */
export function useProjectSelectorProjects(input: {
  readonly enabled: boolean;
  /** The draft's node: moving within it needs no Hub switch. */
  readonly currentEnvironmentId: EnvironmentId;
}): ReadonlyArray<ProjectSelectorProject> {
  const { enabled, currentEnvironmentId } = input;
  const { snapshots } = useLogicalProjectSnapshots();
  const nodes = useNodeCatalog();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const hostedStatus = useHostedWorkspaceStatus();
  const hostedMachines = useSyncExternalStore(
    subscribeHostedWorkspaceState,
    readHostedMachines,
    readHostedMachines,
  );
  const desktopStatus = useSyncExternalStore(
    subscribeDesktopWorkspaceState,
    readDesktopStatus,
    readDesktopStatus,
  );
  const desktopMachines = useSyncExternalStore(
    subscribeDesktopWorkspaceState,
    readDesktopMachines,
    readDesktopMachines,
  );
  const desktopLocalEnvironmentId = useSyncExternalStore(
    subscribeDesktopWorkspaceState,
    readDesktopLocalEnvironmentId,
    readDesktopLocalEnvironmentId,
  );

  return useMemo(() => {
    if (!enabled) return NO_PROJECTS;
    const nodeById = new Map(nodes.map((node) => [node.environmentId, node] as const));
    const hosted = hostedStatus !== "signed-out";
    const hostedMachineById = new Map(
      hostedMachines.map((machine) => [machine.environmentId, machine] as const),
    );
    const desktopReady = !hosted && desktopStatus === "ready";
    const desktopMachineById = new Map(
      withDirectDesktopExecutionMachine({
        machines: desktopMachines,
        ready: desktopReady,
        primaryEnvironmentId,
        localHubEnvironmentId: desktopLocalEnvironmentId,
        primaryLabel: "",
      }).map((machine) => [machine.environmentId, machine] as const),
    );
    const canMutate = (environmentId: EnvironmentId): boolean | undefined => {
      if (hosted) {
        if (environmentId === currentEnvironmentId) return undefined;
        return hostedStatus === "ready" && hostedMachineById.get(environmentId)?.canMutate === true;
      }
      return desktopReady ? desktopMachineById.get(environmentId)?.canMutate === true : undefined;
    };
    return buildProjectSelectorProjects({
      options: buildProjectCheckoutOptions(snapshots),
      homeDirectoryOf: cachedHomeDirectory,
      resolveNode: (option): ProjectSelectorNode | null => {
        const node = nodeById.get(option.environmentId);
        if (hosted) {
          const machine = hostedMachineById.get(option.environmentId);
          if (!machine?.canReadMetadata) return null;
          return node ?? null;
        }
        // A checkout whose node the catalog does not know yet keeps a plain entry.
        return (
          node ?? {
            environmentId: option.environmentId,
            label: option.environmentLabel ?? "Unknown node",
            isThisDevice: false,
            iconKind: null,
            platformOs: null,
            presence: "connecting",
          }
        );
      },
      unavailableReason: (node) =>
        hosted && hostedStatus !== "ready" && node.environmentId !== currentEnvironmentId
          ? `Switching to ${node.label} waits for the Hub to connect`
          : checkoutUnavailableReason({
              node,
              canMutate: canMutate(node.environmentId),
              mutateBlockedReason: nodeById.get(node.environmentId)?.mutateBlockedReason,
            }),
    });
  }, [
    currentEnvironmentId,
    desktopLocalEnvironmentId,
    desktopMachines,
    desktopStatus,
    enabled,
    hostedMachines,
    hostedStatus,
    nodes,
    primaryEnvironmentId,
    snapshots,
  ]);
}
