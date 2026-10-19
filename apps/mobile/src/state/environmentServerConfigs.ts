import { useSyncExternalStore } from "react";

import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import {
  getEnvironmentServerConfigsSnapshot,
  subscribeEnvironmentServerConfigs,
} from "@ryco/client-runtime/rpc";

// The per-environment config store lives in the shared client runtime; this
// module is the app's facade over it plus its React hook.
export {
  getEnvironmentServerConfigsSnapshot,
  patchEnvironmentServerSettings,
  readEnvironmentServerConfig,
  resetEnvironmentServerConfigsForTests,
  subscribeEnvironmentServerConfigs,
  writeEnvironmentServerConfig,
} from "@ryco/client-runtime/rpc";

export function useEnvironmentServerConfigs(): ReadonlyMap<EnvironmentId, ServerConfig> {
  return useSyncExternalStore(
    subscribeEnvironmentServerConfigs,
    getEnvironmentServerConfigsSnapshot,
    getEnvironmentServerConfigsSnapshot,
  );
}
