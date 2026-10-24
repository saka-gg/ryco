import type { EnvironmentId } from "@ryco/contracts";
import { useMemo, useSyncExternalStore } from "react";

import { usePrimaryEnvironmentId } from "~/environments/primary";
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

export interface StatisticsEnvironments {
  /** The connections the view asks: those named by its filter, or all of them. */
  readonly selected: EnvironmentConnections;
  /** Every connected environment, whether or not the filter selects it, by label. */
  readonly availableEnvironments: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }[];
  /** No environment is registered yet, but this app's own node is about to connect. */
  readonly connecting: boolean;
}

/** The environments a view across connected environments offers and asks. */
export function useStatisticsEnvironments(
  environmentIds: readonly string[] | undefined,
): StatisticsEnvironments {
  const connections = useConnectedEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const availableEnvironments = useMemo(
    () =>
      connections
        .map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.knownEnvironment.label,
        }))
        .toSorted((left, right) => left.label.localeCompare(right.label)),
    [connections],
  );
  const selected = useMemo(
    () => selectConnections(connections, environmentIds),
    [connections, environmentIds],
  );
  return {
    selected,
    availableEnvironments,
    connecting: connections.length === 0 && primaryEnvironmentId !== null,
  };
}
