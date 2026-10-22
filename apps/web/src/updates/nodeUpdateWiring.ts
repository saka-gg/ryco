import type { NodeUpdateClient, NodeUpdateStore } from "@ryco/client-runtime/state/nodeUpdate";
import type { EnvironmentId } from "@ryco/contracts";

/** A connection the environment runtime owns; the wiring only reads it. */
export interface NodeUpdateWiringConnection {
  readonly environmentId: EnvironmentId;
  readonly client: NodeUpdateClient;
}

export interface NodeUpdateWiringSources {
  /** The connections the environment runtime holds now. */
  readonly listConnections: () => ReadonlyArray<NodeUpdateWiringConnection>;
  /**
   * Whether this environment's node advertises `capabilities.nodeSelfUpdate`
   * and this session may follow its update stream now.
   */
  readonly canFollow: (environmentId: EnvironmentId) => boolean;
  /** Each notifies when the answers above may have changed; returns its unsubscribe. */
  readonly subscriptions: ReadonlyArray<(listener: () => void) => () => void>;
}

export interface NodeUpdateWiring {
  /**
   * Follows every connection whose node can update itself until the returned
   * stop runs. Starting again while started only counts the start: the last
   * stop detaches everything.
   */
  readonly start: () => () => void;
  /** Environments the store follows now. */
  readonly attachedEnvironmentIds: () => ReadonlyArray<EnvironmentId>;
}

interface Attached {
  readonly client: NodeUpdateClient;
  readonly detach: () => void;
}

/**
 * Keeps a node update store attached to exactly the connections that can
 * report an update state: one per environment, on the connection's own
 * client, detached when the connection goes away or stops advertising the
 * capability. It never opens, recovers or selects a connection; it follows the
 * ones the runtime already owns.
 */
export function createNodeUpdateWiring(
  store: Pick<NodeUpdateStore, "attach">,
  sources: NodeUpdateWiringSources,
): NodeUpdateWiring {
  const attached = new Map<EnvironmentId, Attached>();
  let starts = 0;
  let unsubscribes: Array<() => void> = [];
  let reconciling = false;
  let again = false;

  const reconcileOnce = () => {
    // A listener may have stopped the wiring meanwhile: nothing is followed then.
    if (starts === 0) return;
    const desired = new Map<EnvironmentId, NodeUpdateClient>();
    for (const connection of sources.listConnections()) {
      if (desired.has(connection.environmentId)) continue;
      if (!sources.canFollow(connection.environmentId)) continue;
      desired.set(connection.environmentId, connection.client);
    }
    // Attach before detaching: a replaced client hands its stream over in the store.
    for (const [environmentId, client] of desired) {
      const current = attached.get(environmentId);
      if (current?.client === client) continue;
      attached.set(environmentId, { client, detach: store.attach(environmentId, client) });
      current?.detach();
    }
    for (const [environmentId, current] of attached) {
      if (desired.has(environmentId)) continue;
      attached.delete(environmentId);
      current.detach();
    }
  };

  const reconcile = () => {
    if (starts === 0) return;
    if (reconciling) {
      again = true;
      return;
    }
    reconciling = true;
    try {
      do {
        again = false;
        reconcileOnce();
      } while (again);
    } finally {
      reconciling = false;
    }
  };

  const stopAll = () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];
    for (const current of attached.values()) current.detach();
    attached.clear();
  };

  return {
    start: () => {
      starts += 1;
      if (starts === 1) {
        unsubscribes = sources.subscriptions.map((subscribe) => subscribe(reconcile));
        reconcile();
      }
      let stopped = false;
      return () => {
        if (stopped) return;
        stopped = true;
        starts -= 1;
        if (starts === 0) stopAll();
      };
    },
    attachedEnvironmentIds: () => [...attached.keys()],
  };
}
