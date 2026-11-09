// FILE: hostedMutationLeases.ts
// Purpose: The one rule for when a Hub environment session may hold a mutation
//          lease (the hosted web's coordinator and the phone both read it), and
//          a lease registry for a client that holds several Hub sessions at
//          once (the phone): it grants a lease once that readiness holds and
//          revalidates it at the instant of each call.
// Layer: Client runtime, no platform code.

import type { EnvironmentId } from "@ryco/contracts";

import { hostedSessionConnectionState } from "../state/workspace/hostedNodeCatalogInput.ts";
import {
  hostedBrowserRevalidated,
  type HostedEnvironmentSessionRecord,
} from "./hostedEnvironmentSessions.ts";
import {
  createNodeMutationLeaseAuthority,
  type NodeMutationLeaseAuthority,
  type NodeMutationReadiness,
} from "./nodeMutationLease.ts";
import type { HostedHubState } from "./state.ts";
import type { HostedHubNode } from "./types.ts";

export type HostedMutationReadiness = Omit<NodeMutationReadiness, "selectionGeneration">;

/** Which client opens the connection: the hosted web may not open a node that needs a native client. */
export type HostedConnectingClient = "web" | "native";

/** A directory node this client may open a connection to right now: not revoked, online, and open to it. */
export function isHostedConnectableNode(
  node: HostedHubNode,
  client: HostedConnectingClient,
): boolean {
  return (
    node.revokedAt === null &&
    node.presence.online &&
    (client === "native" || node.capabilities?.nativeClientRequired !== true)
  );
}

/**
 * What a session's lease may hold right now, read from the current directory,
 * the record itself and whether this client holds the session's shell
 * snapshot, never from a published catalog (which can trail a change):
 * - directory: the account's directory is ready and its browser revalidated;
 * - relay: the session's relay is online and its session established;
 * - shell: the snapshot is held, the node is in the directory and connectable
 *   by this client, and the session is connected.
 */
export function hostedSessionMutationReadiness(input: {
  readonly hub: Pick<HostedHubState, "directoryStatus" | "browserStatus" | "nodes">;
  readonly record: HostedEnvironmentSessionRecord;
  readonly client: HostedConnectingClient;
  readonly shellHeld: boolean;
}): Pick<HostedMutationReadiness, "directoryReady" | "relayReady" | "shellReady"> {
  const { hub, record } = input;
  const node = hub.nodes.find((entry) => entry.environmentId === record.environmentId);
  return {
    directoryReady: hub.directoryStatus === "ready" && hostedBrowserRevalidated(hub.browserStatus),
    relayReady: record.transportStatus === "online" && record.sessionEstablished,
    shellReady:
      input.shellHeld &&
      node !== undefined &&
      isHostedConnectableNode(node, input.client) &&
      hostedSessionConnectionState(record) === "connected",
  };
}

/** A published machine catalog shows the environment connected and open to changes: a lease may be granted. */
export function hostedCatalogAllowsMutation(
  machines: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly connectionState: string;
    readonly canMutate: boolean;
  }>,
  environmentId: EnvironmentId,
): boolean {
  return machines.some(
    (machine) =>
      machine.environmentId === environmentId &&
      machine.connectionState === "connected" &&
      machine.canMutate,
  );
}

export interface HostedMutationLeaseSource {
  /** Every Hub environment session's current readiness. */
  readonly readAll: () => ReadonlyArray<HostedMutationReadiness>;
  /** Calls `listener` whenever any input of `readAll` may have changed. */
  readonly subscribe: (listener: () => void) => () => void;
}

export interface HostedMutationLeases {
  /**
   * Resolves once `environmentId` grants a mutation lease, with a check that
   * revalidates it (any change to its readiness since revokes it for good);
   * rejects when `signal` aborts first.
   */
  readonly await: (environmentId: EnvironmentId, signal: AbortSignal) => Promise<() => boolean>;
}

const NO_READINESS = {
  environmentId: null,
  snapshotGeneration: 0,
  effectiveRole: null,
  directoryReady: false,
  relayReady: false,
  shellReady: false,
} as const;

function sameReadiness(left: NodeMutationReadiness, right: HostedMutationReadiness): boolean {
  return (
    left.environmentId === right.environmentId &&
    left.snapshotGeneration === right.snapshotGeneration &&
    left.effectiveRole === right.effectiveRole &&
    left.directoryReady === right.directoryReady &&
    left.relayReady === right.relayReady &&
    left.shellReady === right.shellReady
  );
}

/**
 * One lease authority per Hub environment, kept in step with `source` by one
 * subscription that starts with the first wait. A check also re-reads the
 * source first, so a lease is never trusted on a notification that has not
 * arrived yet.
 */
export function createHostedMutationLeases(
  source: HostedMutationLeaseSource,
): HostedMutationLeases {
  const authorities = new Map<EnvironmentId, NodeMutationLeaseAuthority>();
  const waiters = new Set<() => void>();
  let started = false;

  const sync = () => {
    const seen = new Set<EnvironmentId>();
    for (const readiness of source.readAll()) {
      const environmentId = readiness.environmentId;
      if (environmentId === null) continue;
      seen.add(environmentId);
      let authority = authorities.get(environmentId);
      if (!authority) {
        authority = createNodeMutationLeaseAuthority();
        authorities.set(environmentId, authority);
      }
      if (!sameReadiness(authority.read(), readiness)) authority.update(readiness);
    }
    for (const [environmentId, authority] of Array.from(authorities)) {
      if (seen.has(environmentId)) continue;
      authorities.delete(environmentId);
      authority.update(NO_READINESS);
    }
    for (const waiter of Array.from(waiters)) waiter();
  };

  const start = () => {
    if (started) return;
    started = true;
    source.subscribe(sync);
  };

  return {
    await: (environmentId, signal) => {
      start();
      sync();
      return new Promise((resolve, reject) => {
        const onAbort = () => {
          waiters.delete(check);
          reject(new Error("Stopped waiting for the machine to accept changes."));
        };
        function check() {
          const authority = authorities.get(environmentId);
          const lease = authority?.lease(environmentId) ?? null;
          if (authority === undefined || lease === null) return;
          waiters.delete(check);
          signal.removeEventListener("abort", onAbort);
          resolve(() => {
            sync();
            return (
              authorities.get(environmentId) === authority &&
              authority.validate(lease, environmentId)
            );
          });
        }
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        waiters.add(check);
        check();
      });
    },
  };
}
