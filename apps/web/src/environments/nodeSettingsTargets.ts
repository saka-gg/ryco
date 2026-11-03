import { WS_METHODS, type EnvironmentId } from "@ryco/contracts";
import {
  appAtomRegistry,
  getWsConnectionStatusForEnvironment,
  serverConfigAtom,
  subscribeEnvironmentServerConfigs,
  wsConnectionStatusForEnvironmentAtom,
} from "@ryco/client-runtime/rpc";
import { isSavedEnvironmentSwitchedOff } from "@ryco/client-runtime/connection";
import type { NodeSettingsTarget } from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import { useMemo } from "react";

import { isHostedHubMode } from "../env";
import { readNodeServerConfig } from "./nodeServerConfig";
import { readNodeRole, subscribeNodeRoles } from "./nodeRole";
import { getPrimaryKnownEnvironment, usePrimaryEnvironmentDescriptor } from "./primary";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
  updateEnvironmentServerSettings,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "./runtime";
import { readHostedRpcCapability } from "../hostedHub/capabilities";
import { useHostedHubStore } from "../hostedHub/state";
import { useDesktopWorkspaceState } from "../platform/desktopWorkspace";

/**
 * The web side of writing settings to every node (shared device settings):
 * which nodes this client knows, and each one as a write target. Outside the
 * settings route so the shared-settings runner can use it without loading the
 * settings page; nothing in the app shell imports it yet.
 */

export interface KnownSettingsNode {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/**
 * Whether this client may change the node's settings now: in hosted mode the
 * node's own session must allow the write (role and a ready session), else
 * the owner role. The primary counts as writable until its own role is known,
 * as on the settings page; the node still checks every write.
 */
function canWriteNodeSettings(environmentId: EnvironmentId): boolean {
  if (isHostedHubMode()) {
    return readHostedRpcCapability(WS_METHODS.serverUpdateSettings, environmentId).allowed;
  }
  const role = readNodeRole(environmentId);
  return (
    role === "owner" ||
    (role === undefined && environmentId === getPrimaryKnownEnvironment()?.environmentId)
  );
}

function readNodeConnected(environmentId: EnvironmentId): boolean {
  return (
    readEnvironmentConnection(environmentId) !== null &&
    getWsConnectionStatusForEnvironment(environmentId).phase === "connected"
  );
}

/**
 * A node as "Apply to all nodes" finds it now: its own last known config,
 * whether it is connected and whether this client may write to it, and a
 * write through its own connection.
 */
export function readNodeSettingsTarget(node: KnownSettingsNode): NodeSettingsTarget {
  return {
    ...node,
    config: readNodeServerConfig(node.environmentId),
    connected: readNodeConnected(node.environmentId),
    canWrite: canWriteNodeSettings(node.environmentId),
    write: (patch) => updateEnvironmentServerSettings(node.environmentId, patch),
  };
}

/**
 * Calls `listener` whenever what {@link readNodeSettingsTarget} reads for
 * these nodes may have changed: a config, a connection, its socket, or this
 * client's role there.
 */
export function subscribeNodeSettingsTargets(
  environmentIds: ReadonlyArray<EnvironmentId>,
  listener: () => void,
): () => void {
  const unsubscribes = [
    subscribeEnvironmentServerConfigs(listener),
    subscribeEnvironmentConnections(listener),
    useSavedEnvironmentRuntimeStore.subscribe(listener),
    appAtomRegistry.subscribe(serverConfigAtom, listener),
    // Write access follows the role, which arrives after the config (the primary counts as
    // writable until its role is known): a role that turns out not the owner's disables rows.
    subscribeNodeRoles(listener),
    ...environmentIds.map((environmentId) =>
      appAtomRegistry.subscribe(wsConnectionStatusForEnvironmentAtom(environmentId), listener),
    ),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/** What {@link listKnownSettingsNodes} reads: each source of known nodes. */
export interface KnownSettingsNodeSources {
  readonly hosted: boolean;
  readonly primary: { readonly environmentId: EnvironmentId; readonly label: string } | null;
  readonly hostedNodes: ReturnType<typeof useHostedHubStore.getState>["nodes"];
  readonly savedEnvironments: ReturnType<typeof useSavedEnvironmentRegistryStore.getState>["byId"];
  readonly desktopWorkspace: ReturnType<typeof useDesktopWorkspaceState>;
}

/**
 * Every node this client knows: the primary, then the hosted session's nodes,
 * or the saved environments and the Desktop workspace's machines.
 */
export function listKnownSettingsNodes(
  sources: KnownSettingsNodeSources,
): ReadonlyArray<KnownSettingsNode> {
  const { desktopWorkspace } = sources;
  const nodes = new Map<EnvironmentId, string>();
  if (sources.primary) nodes.set(sources.primary.environmentId, sources.primary.label);
  if (sources.hosted) {
    for (const node of sources.hostedNodes) {
      if (node.revokedAt !== null || node.capabilities?.nativeClientRequired === true) continue;
      if (!nodes.has(node.environmentId)) nodes.set(node.environmentId, node.label);
    }
  } else {
    for (const entry of Object.values(sources.savedEnvironments)) {
      if (entry.environmentId === desktopWorkspace.localEnvironmentId) continue;
      // Left out while switched off, as in the sidebar.
      if (isSavedEnvironmentSwitchedOff(entry)) continue;
      if (!nodes.has(entry.environmentId)) nodes.set(entry.environmentId, entry.label);
    }
    for (const machine of desktopWorkspace.machines) {
      if (machine.environmentId === desktopWorkspace.localEnvironmentId) continue;
      if (!nodes.has(machine.environmentId)) nodes.set(machine.environmentId, machine.label);
    }
  }
  return [...nodes].map(([environmentId, label]) => ({ environmentId, label }));
}

/** {@link listKnownSettingsNodes} as a hook, for settings rows. */
export function useKnownSettingsNodes(): ReadonlyArray<KnownSettingsNode> {
  const hosted = isHostedHubMode();
  const primary = usePrimaryEnvironmentDescriptor();
  const hostedNodes = useHostedHubStore((state) => state.nodes);
  const savedEnvironments = useSavedEnvironmentRegistryStore((state) => state.byId);
  const desktopWorkspace = useDesktopWorkspaceState();
  return useMemo(
    () =>
      listKnownSettingsNodes({ hosted, primary, hostedNodes, savedEnvironments, desktopWorkspace }),
    [desktopWorkspace, hosted, hostedNodes, primary, savedEnvironments],
  );
}
