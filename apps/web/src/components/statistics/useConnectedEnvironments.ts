import { useSyncExternalStore } from "react";

import {
  listEnvironmentConnections,
  subscribeEnvironmentConnections,
} from "~/environments/runtime";

type EnvironmentConnections = ReturnType<typeof listEnvironmentConnections>;

let cachedConnections: EnvironmentConnections = [];

// `listEnvironmentConnections` returns a fresh array per call; keep one reference while the
// connections are the same so React sees a stable snapshot.
function readConnections(): EnvironmentConnections {
  const next = listEnvironmentConnections();
  const unchanged =
    next.length === cachedConnections.length &&
    next.every((connection, index) => connection === cachedConnections[index]);
  if (!unchanged) cachedConnections = next;
  return cachedConnections;
}

/**
 * Live list of connected environments. `useSyncExternalStore` re-reads after subscribing, so a
 * connection registered between the first render and the subscription is not missed.
 */
export function useConnectedEnvironments(): EnvironmentConnections {
  return useSyncExternalStore(subscribeEnvironmentConnections, readConnections, readConnections);
}

/** The connections named by `environmentIds`, or every connection when none are named. */
export function selectConnections<T extends { readonly environmentId: string }>(
  connections: readonly T[],
  environmentIds: readonly string[] | undefined,
): readonly T[] {
  if (environmentIds === undefined || environmentIds.length === 0) return connections;
  const selected = new Set(environmentIds);
  return connections.filter((connection) => selected.has(connection.environmentId));
}
