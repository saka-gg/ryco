import type { EnvironmentId } from "@ryco/contracts";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import { getCachedHubNodeRoster, subscribeCachedHubNodeRoster } from "../../hostedHub/nodeRoster";
import { useEnvironmentServerConfigs } from "../../state/environmentServerConfigs";
import { useSavedEnvironments } from "../connection/useConnectionController";
import { useMobileNodeCatalog } from "../projectCopy/mobileNodeCatalog";
import {
  machinePickerFactsOf,
  type MachinePickerFactSources,
  type MachinePickerFacts,
} from "./machinePickerModel";

/** Each machine's kind, reach and last-seen time, from the stores that know them. */
export function useMachinePickerFacts(): (
  environmentId: EnvironmentId,
  label: string,
) => MachinePickerFacts {
  const { rows } = useSavedEnvironments();
  const configs = useEnvironmentServerConfigs();
  const catalog = useMobileNodeCatalog();
  const roster = useSyncExternalStore(subscribeCachedHubNodeRoster, getCachedHubNodeRoster);
  const sources = useMemo(
    (): MachinePickerFactSources => ({
      direct: new Map(
        rows
          .filter((row) => !row.switchedOff)
          .map((row) => [
            row.record.environmentId,
            {
              descriptor: row.runtime.descriptor,
              serverConfig: row.runtime.serverConfig,
              connectedAt: row.runtime.connectedAt,
              disconnectedAt: row.runtime.disconnectedAt,
            },
          ]),
      ),
      configs,
      catalog: new Map(catalog.nodes.map((node) => [node.environmentId, node])),
      hubLastSeen: new Map(
        roster.flatMap((node) => {
          const seen = node.lastHeartbeatAt ?? node.lastAuthenticatedAt;
          return seen === null ? [] : [[node.environmentId, seen] as const];
        }),
      ),
    }),
    [catalog, configs, roster, rows],
  );
  return useCallback(
    (environmentId, label) => machinePickerFactsOf(sources, environmentId, label),
    [sources],
  );
}
