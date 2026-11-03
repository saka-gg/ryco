import type { EnvironmentApi, EnvironmentId } from "@ryco/contracts";
import { useCallback, useMemo, useSyncExternalStore } from "react";

import {
  readEnvironmentApi,
  readEnvironmentApiAvailability,
  subscribeEnvironmentApis,
} from "./environmentApi";

/**
 * The environment's typed RPC surface while a live client is registered for it,
 * re-read whenever a connection registers, is replaced or goes away. `null`
 * (no environment selected) reads `undefined`.
 *
 * A render-time `readEnvironmentApi` call reads mutable supervisor state, which
 * React Compiler memoizes on the environment id alone: a screen opened before
 * its node connected would keep `undefined` until it remounts. Each client maps
 * to one api object, so the snapshot only changes with the connection.
 */
export function useEnvironmentApi(environmentId: EnvironmentId | null): EnvironmentApi | undefined {
  const read = useCallback(
    () => (environmentId === null ? undefined : readEnvironmentApi(environmentId)),
    [environmentId],
  );
  return useSyncExternalStore(subscribeEnvironmentApis, read, read);
}

/**
 * The environments that have a live api, for views that only need to know
 * whether one does (for the same reason as `useEnvironmentApi`, never by
 * calling `readEnvironmentApi` while rendering). The set keeps its identity
 * until an environment gains or loses its connection.
 */
export function useEnvironmentsWithApi(): ReadonlySet<EnvironmentId> {
  const availability = useSyncExternalStore(
    subscribeEnvironmentApis,
    readEnvironmentApiAvailability,
    readEnvironmentApiAvailability,
  );
  return useMemo(
    () =>
      new Set(
        availability === ""
          ? []
          : availability.split("\n").map((environmentId) => environmentId as EnvironmentId),
      ),
    [availability],
  );
}
