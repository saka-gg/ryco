import { WS_METHODS, type EnvironmentId } from "@ryco/contracts";
import type { SidebarAutoSettleAfterDays } from "@ryco/contracts/settings";
import { subscribeEnvironmentServerConfigs } from "@ryco/client-runtime/rpc";
import {
  autoSettleRuleHandOverKey,
  changeAutoSettleRule,
  createAutoSettleRuleHandOver,
  nodeAwaitsAutoSettleRule,
  readAutoSettleRuleHandOverKey,
  type AutoSettleRuleHandOverListing,
  type AutoSettleRuleNodeView,
} from "@ryco/client-runtime/state/settings";
import { useEffect, useMemo } from "react";

import { isHostedHubMode } from "./env";
import { readNodeServerConfig } from "./environments/nodeServerConfig";
import { readNodeRole, subscribePrimarySessionRole } from "./environments/nodeRole";
import { updateEnvironmentServerSettings } from "./environments/runtime";
import { updateClientAutoSettleAfterDays } from "./hooks/useSettings";
import { readHostedRpcCapability } from "./hostedHub/capabilities";

/**
 * The web side of node-owned automatic settlement: the one-time hand-over of
 * this client's own rule, and the settings writes. The decisions themselves are
 * the client runtime's (`state/settings`). Writing the rule to every node is
 * the settings route's (`components/settings/nodeSettingsTargets`), so the app
 * shell, which imports this module, never loads it.
 */

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
