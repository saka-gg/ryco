import type { EnvironmentId } from "@ryco/contracts";

/** A connection whose shell snapshot readiness can be followed. */
export interface ShellReadinessConnection {
  readonly shellSnapshotReadiness: {
    readonly subscribe: (listener: () => void) => () => void;
  };
}

export interface HubLeaseInputSources<C extends ShellReadinessConnection> {
  /** The environments with a Hub session now. */
  readonly environmentIds: () => Iterable<EnvironmentId>;
  readonly readConnection: (environmentId: EnvironmentId) => C | null | undefined;
  /** The other inputs (session records, directory, published machines, connections). */
  readonly sources: ReadonlyArray<(listener: () => void) => () => void>;
}

/**
 * Calls `listener` whenever an input of the Hub mutation leases may have
 * changed: any of `sources`, and each Hub session's connection's shell
 * snapshot. A session is marked ready before its connection records the
 * snapshot, so without the snapshot's own change a waiting copy would not
 * wake. A replaced connection is followed instead of the old one.
 */
export function subscribeHubLeaseInputs<C extends ShellReadinessConnection>(
  inputs: HubLeaseInputSources<C>,
  listener: () => void,
): () => void {
  const shells = new Map<EnvironmentId, { readonly connection: C; readonly stop: () => void }>();
  const followShells = () => {
    const seen = new Set<EnvironmentId>();
    for (const environmentId of inputs.environmentIds()) {
      const connection = inputs.readConnection(environmentId);
      if (!connection) continue;
      seen.add(environmentId);
      const held = shells.get(environmentId);
      if (held?.connection === connection) continue;
      held?.stop();
      shells.set(environmentId, {
        connection,
        stop: connection.shellSnapshotReadiness.subscribe(listener),
      });
    }
    for (const [environmentId, held] of Array.from(shells)) {
      if (seen.has(environmentId)) continue;
      held.stop();
      shells.delete(environmentId);
    }
  };
  const onChange = () => {
    followShells();
    listener();
  };
  const unsubscribes = inputs.sources.map((source) => source(onChange));
  followShells();
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    for (const held of shells.values()) held.stop();
    shells.clear();
  };
}
