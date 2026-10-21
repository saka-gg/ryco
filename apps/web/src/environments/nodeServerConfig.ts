import { readEnvironmentServerConfig } from "@ryco/client-runtime/rpc";
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";

import { getServerConfig } from "../rpc/serverState";
import { getPrimaryKnownEnvironment } from "./primary";
import { useSavedEnvironmentRuntimeStore } from "./runtime";

/**
 * A node's last known server config, whatever kind of connection reported it:
 * the per-environment store every connection's config observer writes (primary,
 * saved, hosted and desktop workspace alike), else the primary's projected
 * config, else a saved environment's runtime snapshot. Null when nothing is
 * known. Notifies through `subscribeEnvironmentServerConfigs` and the saved
 * runtime store.
 */
export function readNodeServerConfig(environmentId: EnvironmentId): ServerConfig | null {
  return (
    readEnvironmentServerConfig(environmentId) ??
    (environmentId === getPrimaryKnownEnvironment()?.environmentId ? getServerConfig() : null) ??
    useSavedEnvironmentRuntimeStore.getState().byId[environmentId]?.serverConfig ??
    null
  );
}
