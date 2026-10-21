import {
  WS_METHODS,
  type AuthSessionRole,
  type EnvironmentId,
  type ServerConfig,
} from "@ryco/contracts";
import type { SidebarAutoSettleAfterDays } from "@ryco/contracts/settings";
import {
  getWsConnectionStatusForEnvironment,
  readEnvironmentServerConfig,
  subscribeEnvironmentServerConfigs,
} from "@ryco/client-runtime/rpc";
import {
  applyAutoSettleRuleToNodes,
  autoSettleRuleHandOverKey,
  autoSettleRuleTargetBlocker,
  changeAutoSettleRule,
  createAutoSettleRuleHandOver,
  describeAutoSettleRuleApplyResult,
  nodeAwaitsAutoSettleRule,
  readAutoSettleRuleHandOverKey,
  type AutoSettleRuleHandOverCandidate,
  type AutoSettleRuleHandOverListing,
  type AutoSettleRuleNodeView,
  type AutoSettleRuleTarget,
} from "@ryco/client-runtime/state/settings";
import { useEffect, useMemo } from "react";

import { isElectron, isHostedHubMode } from "./env";
import { fetchSessionState, getPrimaryKnownEnvironment } from "./environments/primary";
import {
  readEnvironmentConnection,
  updateEnvironmentServerSettings,
  useSavedEnvironmentRuntimeStore,
} from "./environments/runtime";
import { updateClientAutoSettleAfterDays } from "./hooks/useSettings";
import { readHostedRpcCapability } from "./hostedHub/capabilities";
import { useHostedHubStore } from "./hostedHub/state";
import { readDesktopWorkspaceState } from "./platform/desktopWorkspace";
import { getServerConfig } from "./rpc/serverState";

/**
 * The web side of node-owned automatic settlement: which nodes a rule can be
 * written to now, the one-time hand-over of this client's own rule, and the
 * settings writes. The decisions themselves are the client runtime's
 * (`state/settings`).
 */

export interface AutoSettleRuleNode {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

type NodeRole = AutoSettleRuleHandOverCandidate["role"];

/**
 * This page's own session role on the primary node, once asked. The desktop
 * app's session is its owner's; a browser asks the node once per page (again
 * only after asking failed) and tells its listeners the answer.
 */
let primarySessionRole: {
  readonly environmentId: EnvironmentId;
  readonly role: AuthSessionRole | null;
} | null = null;
let primarySessionRequest: Promise<void> | null = null;
const primarySessionRoleListeners = new Set<() => void>();

function readPrimarySessionRole(environmentId: EnvironmentId): NodeRole {
  if (isElectron) return "owner";
  if (primarySessionRole?.environmentId === environmentId) return primarySessionRole.role;
  primarySessionRequest ??= fetchSessionState().then(
    (session) => {
      primarySessionRequest = null;
      primarySessionRole = {
        environmentId,
        role: session.authenticated ? (session.role ?? null) : null,
      };
      for (const listener of Array.from(primarySessionRoleListeners)) listener();
    },
    () => {
      // Asked again on the next check, not in a loop.
      primarySessionRequest = null;
    },
  );
  return undefined;
}

/**
 * The role this client holds on a node: a hosted node's own role, a Desktop
 * workspace machine's, a saved environment's session role, or this page's own
 * session on the primary. Undefined while the primary's is being asked.
 */
function readNodeRole(environmentId: EnvironmentId): NodeRole {
  if (isHostedHubMode()) {
    return (
      useHostedHubStore.getState().nodes.find((node) => node.environmentId === environmentId)
        ?.effectiveRole ?? null
    );
  }
  if (environmentId === getPrimaryKnownEnvironment()?.environmentId) {
    return readPrimarySessionRole(environmentId);
  }
  const machine = readDesktopWorkspaceState().machines.find(
    (candidate) => candidate.environmentId === environmentId,
  );
  if (machine) return machine.canConnect ? machine.effectiveRole : null;
  return useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.role ?? null;
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

function readNodeConfig(environmentId: EnvironmentId): ServerConfig | null {
  return (
    readEnvironmentServerConfig(environmentId) ??
    (environmentId === getPrimaryKnownEnvironment()?.environmentId ? getServerConfig() : null) ??
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig ??
    null
  );
}

/** A node as "Apply to all connected nodes" finds it: writable now, or why not. */
export function readAutoSettleRuleTarget(node: AutoSettleRuleNode): AutoSettleRuleTarget {
  const connected =
    readEnvironmentConnection(node.environmentId) !== null &&
    getWsConnectionStatusForEnvironment(node.environmentId).phase === "connected";
  return {
    ...node,
    blocker: autoSettleRuleTargetBlocker({
      connected,
      config: readNodeConfig(node.environmentId),
      canWrite: canWriteNodeSettings(node.environmentId),
    }),
    write: (patch) => updateEnvironmentServerSettings(node.environmentId, patch),
  };
}

/** Writes one rule to every listed node it can and says what it did, naming the nodes it could not. */
export async function applyAutoSettleRuleToAllNodes(
  value: SidebarAutoSettleAfterDays,
  nodes: ReadonlyArray<AutoSettleRuleNode>,
): Promise<string> {
  return describeAutoSettleRuleApplyResult(
    await applyAutoSettleRuleToNodes(value, nodes.map(readAutoSettleRuleTarget)),
  );
}

/** Sets the rule on the node the settings show, or as this device's own for a node that keeps none. */
export function setAutoSettleRule(
  node: (AutoSettleRuleNodeView & { readonly environmentId: EnvironmentId }) | null,
  value: SidebarAutoSettleAfterDays,
): Promise<"node" | "device" | null> {
  return changeAutoSettleRule({
    node,
    value,
    writeNode: updateEnvironmentServerSettings,
    writeDevice: updateClientAutoSettleAfterDays,
  });
}

const handOver = createAutoSettleRuleHandOver(updateEnvironmentServerSettings);

/**
 * Hands this client's own rule to each listed node that keeps the rule but has
 * none yet, once while it stays ready, when this client owns it and may write
 * to it now. Only such a node needs this client's role and write access.
 */
export function handOverAutoSettleRule(
  environments: ReadonlyArray<AutoSettleRuleHandOverListing>,
  clientValue: SidebarAutoSettleAfterDays,
): ReadonlyArray<EnvironmentId> {
  return handOver.run(
    environments.map((environment) => {
      const config = readNodeConfig(environment.environmentId);
      const awaitsRule = environment.mutationReady && nodeAwaitsAutoSettleRule(config);
      return {
        environmentId: environment.environmentId,
        config,
        role: awaitsRule ? readNodeRole(environment.environmentId) : null,
        mutationReady:
          awaitsRule &&
          (!isHostedHubMode() ||
            readHostedRpcCapability(WS_METHODS.serverUpdateSettings, environment.environmentId)
              .allowed),
      };
    }),
    clientValue,
  );
}

/**
 * Runs {@link handOverAutoSettleRule} for the listed environments. It follows
 * which environments are listed and ready, not the list's identity, so thread
 * updates that rebuild the list do not run it; a node's config arriving, or
 * this page learning its own role on the primary, does.
 */
export function useAutoSettleRuleHandOver(
  environments: ReadonlyArray<AutoSettleRuleHandOverListing>,
  clientValue: SidebarAutoSettleAfterDays,
): void {
  // Roles are read per node when a hand-over is due, not taken from the list.
  const key = useMemo(
    () =>
      autoSettleRuleHandOverKey(
        environments.map(({ environmentId, mutationReady }) => ({ environmentId, mutationReady })),
        clientValue,
      ),
    [clientValue, environments],
  );
  useEffect(() => {
    if (key === null) return;
    const listed = readAutoSettleRuleHandOverKey(key);
    const run = () => {
      handOverAutoSettleRule(listed, clientValue);
    };
    run();
    const unsubscribe = subscribeEnvironmentServerConfigs(run);
    primarySessionRoleListeners.add(run);
    return () => {
      unsubscribe();
      primarySessionRoleListeners.delete(run);
    };
  }, [clientValue, key]);
}
