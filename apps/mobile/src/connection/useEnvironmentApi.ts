import type { EnvironmentApi, EnvironmentId } from "@ryco/contracts";
import { useCallback, useSyncExternalStore } from "react";

import { readEnvironmentApi, subscribeEnvironmentApis } from "./environmentApi";

/**
 * The environment's typed RPC surface while a live client is registered for it,
 * re-read whenever a connection registers, is replaced or goes away.
 *
 * A render-time `readEnvironmentApi` call reads mutable supervisor state, which
 * React Compiler memoizes on the environment id alone: a screen opened before
 * its node connected would keep `undefined` until it remounts. Each client maps
 * to one api object, so the snapshot only changes with the connection.
 */
export function useEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi | undefined {
  const read = useCallback(() => readEnvironmentApi(environmentId), [environmentId]);
  return useSyncExternalStore(subscribeEnvironmentApis, read, read);
}
