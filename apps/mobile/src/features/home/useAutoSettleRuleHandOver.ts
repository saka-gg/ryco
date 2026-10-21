import { readEnvironmentServerConfig } from "@ryco/client-runtime/rpc";
import {
  autoSettleRuleHandOverKey,
  createAutoSettleRuleHandOver,
  readAutoSettleRuleHandOverKey,
} from "@ryco/client-runtime/state/settings";
import type { SidebarAutoSettleAfterDays } from "@ryco/contracts/settings";
import { resolveAutoSettleAfterDays } from "@ryco/shared/threadSettlement";
import { useEffect, useMemo } from "react";

import { updateEnvironmentServerSettings } from "../../connection/environmentApi";
import { subscribeEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import type { InboxEnvironment } from "../inbox/inboxModel";

const handOver = createAutoSettleRuleHandOver(updateEnvironmentServerSettings);

/**
 * Hands this device's own auto-settle rule to each listed node that keeps the
 * rule but has none yet, once while it stays ready, when this device owns it
 * and may write to it. It follows which nodes are listed, ready and owned, not
 * the list's identity; a node's config arriving runs it again.
 */
export function useAutoSettleRuleHandOver(
  environments: ReadonlyArray<InboxEnvironment>,
  deviceValue: SidebarAutoSettleAfterDays | undefined,
): void {
  const clientValue = resolveAutoSettleAfterDays(deviceValue);
  const key = useMemo(
    () =>
      autoSettleRuleHandOverKey(
        environments.map((environment) => ({
          environmentId: environment.environmentId,
          mutationReady: environment.mutationReady ?? false,
          role: environment.role,
        })),
        clientValue,
      ),
    [clientValue, environments],
  );
  useEffect(() => {
    if (key === null) return;
    const listed = readAutoSettleRuleHandOverKey(key);
    const run = () =>
      handOver.run(
        listed.map((environment) => ({
          environmentId: environment.environmentId,
          config: readEnvironmentServerConfig(environment.environmentId),
          role: environment.role,
          mutationReady: environment.mutationReady,
        })),
        clientValue,
      );
    run();
    return subscribeEnvironmentServerConfigs(run);
  }, [clientValue, key]);
}
