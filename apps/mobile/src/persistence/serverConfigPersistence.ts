import {
  getEnvironmentServerConfigsSnapshot,
  isEnvironmentServerConfigSaved,
  subscribeEnvironmentServerConfigs,
  writeSavedEnvironmentServerConfig,
} from "@ryco/client-runtime/rpc";
import { serverConfigForDevice } from "@ryco/client-runtime/rpc/serverConfigForDevice";
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import { ServerConfig as ServerConfigSchema } from "@ryco/contracts/server";

import type { SavedQueryStore } from "../rpc/savedQueries";
import { schemaSavedQueryCodec } from "../rpc/savedQueryCodec";

/**
 * Each environment's server config (providers and their models and status,
 * settings, capabilities) kept on the device through the saved query store,
 * under its rules, so the model and provider pickers, provider status and the
 * settings screens render at cold start instead of waiting for the node. The
 * node's live config replaces the saved one as soon as it arrives. What is
 * kept passes `serverConfigForDevice`: no secret is ever written.
 */

export const SAVED_SERVER_CONFIG_KEY = "server-config";
const SAVED_SERVER_CONFIG = schemaSavedQueryCodec(ServerConfigSchema, 1);

/** Shows each environment's saved config while it has none of its own yet. */
export async function hydrateSavedServerConfigs(
  store: SavedQueryStore,
  environmentIds: Iterable<EnvironmentId>,
): Promise<void> {
  await Promise.all(
    Array.from(environmentIds, async (environmentId) => {
      if (getEnvironmentServerConfigsSnapshot().has(environmentId)) return;
      const saved = await store.load(
        environmentId,
        SAVED_SERVER_CONFIG_KEY,
        SAVED_SERVER_CONFIG.version,
      );
      if (saved === null) return;
      const config = SAVED_SERVER_CONFIG.decode(saved.payload);
      if (config !== null) writeSavedEnvironmentServerConfig(environmentId, config);
    }),
  );
}

/** Saves every live config the node sends (coalesced by the store). Returns the uninstaller. */
export function installServerConfigSaving(store: SavedQueryStore): () => void {
  let seen = new Map<EnvironmentId, ServerConfig>();
  const onChange = () => {
    const configs = getEnvironmentServerConfigsSnapshot();
    for (const [environmentId, config] of configs) {
      if (seen.get(environmentId) === config) continue;
      if (isEnvironmentServerConfigSaved(environmentId)) continue;
      store.save(environmentId, SAVED_SERVER_CONFIG_KEY, SAVED_SERVER_CONFIG.version, () =>
        SAVED_SERVER_CONFIG.encode(serverConfigForDevice(config)),
      );
    }
    seen = new Map(configs);
  };
  onChange();
  return subscribeEnvironmentServerConfigs(onChange);
}
