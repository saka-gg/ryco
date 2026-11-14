import type { EnvironmentId, SpaceRole } from "@ryco/contracts";

export type NodeMutationRole = SpaceRole;

export interface NodeMutationLease {
  readonly environmentId: EnvironmentId;
  readonly selectionGeneration: number;
  readonly snapshotGeneration: number;
  readonly effectiveRole: NodeMutationRole;
  readonly directoryReady: true;
  readonly relayReady: true;
  readonly shellReady: true;
}

export interface NodeMutationReadiness {
  readonly environmentId: EnvironmentId | null;
  readonly selectionGeneration: number;
  readonly snapshotGeneration: number;
  readonly effectiveRole: NodeMutationRole | null;
  readonly directoryReady: boolean;
  readonly relayReady: boolean;
  readonly shellReady: boolean;
}

function validGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

export function deriveNodeMutationLease(
  readiness: NodeMutationReadiness,
): NodeMutationLease | null {
  if (
    readiness.environmentId === null ||
    !validGeneration(readiness.selectionGeneration) ||
    !validGeneration(readiness.snapshotGeneration) ||
    readiness.effectiveRole !== "owner" ||
    !readiness.directoryReady ||
    !readiness.relayReady ||
    !readiness.shellReady
  ) {
    return null;
  }
  return {
    environmentId: readiness.environmentId,
    selectionGeneration: readiness.selectionGeneration,
    snapshotGeneration: readiness.snapshotGeneration,
    effectiveRole: readiness.effectiveRole,
    directoryReady: true,
    relayReady: true,
    shellReady: true,
  };
}

/** Revalidate at the instant of mutation; leases are never bearer authority. */
export function nodeMutationLeaseIsCurrent(
  lease: NodeMutationLease,
  targetEnvironmentId: EnvironmentId,
  current: NodeMutationReadiness,
): boolean {
  const fresh = deriveNodeMutationLease(current);
  return (
    fresh !== null &&
    lease.environmentId === targetEnvironmentId &&
    fresh.environmentId === targetEnvironmentId &&
    lease.selectionGeneration === fresh.selectionGeneration &&
    lease.snapshotGeneration === fresh.snapshotGeneration &&
    lease.effectiveRole === fresh.effectiveRole
  );
}

export interface NodeMutationLeaseAuthority {
  readonly update: (readiness: Omit<NodeMutationReadiness, "selectionGeneration">) => void;
  readonly read: () => NodeMutationReadiness;
  readonly lease: (environmentId: EnvironmentId) => NodeMutationLease | null;
  readonly validate: (lease: NodeMutationLease, environmentId: EnvironmentId) => boolean;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * One lifecycle owner. Any changed selection/readiness input invalidates every
 * previously issued lease synchronously by advancing the generation.
 */
export function createNodeMutationLeaseAuthority(): NodeMutationLeaseAuthority {
  const listeners = new Set<() => void>();
  let state: NodeMutationReadiness = {
    environmentId: null,
    selectionGeneration: 0,
    snapshotGeneration: 0,
    effectiveRole: null,
    directoryReady: false,
    relayReady: false,
    shellReady: false,
  };

  return {
    update(next) {
      const selectionChanged =
        state.environmentId !== next.environmentId ||
        state.effectiveRole !== next.effectiveRole ||
        state.directoryReady !== next.directoryReady ||
        state.relayReady !== next.relayReady ||
        state.shellReady !== next.shellReady;
      state = {
        ...next,
        selectionGeneration: selectionChanged
          ? state.selectionGeneration + 1
          : state.selectionGeneration,
      };
      for (const listener of Array.from(listeners)) listener();
    },
    read: () => state,
    lease(environmentId) {
      const lease = deriveNodeMutationLease(state);
      return lease?.environmentId === environmentId ? lease : null;
    },
    validate: (lease, environmentId) => nodeMutationLeaseIsCurrent(lease, environmentId, state),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
