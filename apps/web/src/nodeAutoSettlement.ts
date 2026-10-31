import { WS_METHODS, type EnvironmentId } from "@ryco/contracts";
import type { SidebarAutoSettleAfterDays } from "@ryco/contracts/settings";
import {
  getWsConnectionStatusForEnvironment,
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
  type AutoSettleRuleHandOverListing,
  type AutoSettleRuleNodeView,
  type AutoSettleRuleTarget,
} from "@ryco/client-runtime/state/settings";
import { useEffect, useMemo } from "react";

import { isHostedHubMode } from "./env";
import { readNodeServerConfig } from "./environments/nodeServerConfig";
import { readNodeRole, subscribePrimarySessionRole } from "./environments/nodeRole";
import { getPrimaryKnownEnvironment } from "./environments/primary";
import { readEnvironmentConnection, updateEnvironmentServerSettings } from "./environments/runtime";
import { updateClientAutoSettleAfterDays } from "./hooks/useSettings";
import { readHostedRpcCapability } from "./hostedHub/capabilities";

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

/** A node as "Apply to all connected nodes" finds it: writable now, or why not. */
export function readAutoSettleRuleTarget(node: AutoSettleRuleNode): AutoSettleRuleTarget {
  const connected =
    readEnvironmentConnection(node.environmentId) !== null &&
    getWsConnectionStatusForEnvironment(node.environmentId).phase === "connected";
  return {
    ...node,
    blocker: autoSettleRuleTargetBlocker({
      connected,
      config: readNodeServerConfig(node.environmentId),
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
      const config = readNodeServerConfig(environment.environmentId);
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
    const unsubscribeRole = subscribePrimarySessionRole(run);
    return () => {
      unsubscribe();
      unsubscribeRole();
    };
  }, [clientValue, key]);
}
