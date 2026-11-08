// FILE: hostedMutationLeases.ts
// Purpose: Mutation leases for Hub environments a client holds several of at
//          once (the phone): each environment session's readiness from the
//          shared session record, and a registry that grants a lease once that
//          readiness holds and revalidates it at the instant of each call.
// Layer: Client runtime, no platform code.

import type { EnvironmentId } from "@ryco/contracts";

import {
  canAdoptHostedEnvironmentSession,
  hostedBrowserRevalidated,
  type HostedEnvironmentSessionRecord,
} from "./hostedEnvironmentSessions.ts";
import {
  createNodeMutationLeaseAuthority,
  type NodeMutationLeaseAuthority,
  type NodeMutationReadiness,
} from "./nodeMutationLease.ts";
import type { HostedHubState } from "./state.ts";

export type HostedMutationReadiness = Omit<NodeMutationReadiness, "selectionGeneration">;

/**
 * One Hub environment session's mutation readiness: the account's directory is
 * current, the session is adoptable (its own fresh relay attempt and accepted
 * snapshot, `canAdoptHostedEnvironmentSession`), and the client holds that
 * snapshot's shell. The role and generation are the record's own, so a
 * renewed or downgraded session never keeps an older lease.
 */
export function hostedSessionMutationReadiness(
  record: HostedEnvironmentSessionRecord,
  hub: Pick<HostedHubState, "directoryStatus" | "browserStatus">,
  shellReady: boolean,
): HostedMutationReadiness {
  return {
    environmentId: record.environmentId,
    snapshotGeneration: record.generation,
    effectiveRole: record.effectiveRole,
    directoryReady: hub.directoryStatus === "ready" && hostedBrowserRevalidated(hub.browserStatus),
    relayReady: canAdoptHostedEnvironmentSession(record),
    shellReady: shellReady && record.snapshotAcceptedAt !== null,
  };
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
