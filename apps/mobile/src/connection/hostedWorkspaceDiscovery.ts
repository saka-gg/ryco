import type { EnvironmentId } from "@ryco/contracts";

export interface HostedWorkspaceDiscoveryCandidate {
  readonly environmentId: EnvironmentId;
  /** Authorized, trusted, online and not owned by the direct connection plane. */
  readonly eligible: boolean;
  /** This environment accepted its own current shell snapshot. */
  readonly ready: boolean;
  readonly failed: boolean;
}

/**
 * Home's metadata demand for every machine at once, not one machine after
 * another: up to `limit` machines are held together, so their relay attempts
 * and shell snapshots overlap instead of queueing behind each other. All
 * actual connections still go through the shared demand executor and lifecycle
 * owner, which bound and order them.
 *
 * While the account lists no more machines than `limit`, each one stays held
 * for as long as Home is in view: a held machine is demanded, so a relay drop
 * reconnects it instead of leaving its rows cached until the next visit. With
 * more machines than slots a hold is disposable: it ends once its machine
 * accepted its own shell snapshot, and completed reads are remembered for this
 * visit so eviction under the connection bound cannot cycle through them.
 */
export function createHostedWorkspaceDiscovery(
  retain: (environmentId: EnvironmentId) => () => void,
  limit: number,
) {
  const bound = Math.max(1, Math.floor(limit));
  let authority: string | null = null;
  let active = false;
  /** Held machines and their releases, in the order they were taken. */
  const held = new Map<EnvironmentId, () => void>();
  const completed = new Set<EnvironmentId>();
  const failed = new Set<EnvironmentId>();

  const release = (environmentId: EnvironmentId) => {
    const releaseHold = held.get(environmentId);
    held.delete(environmentId);
    releaseHold?.();
  };

  const releaseAll = () => {
    for (const environmentId of Array.from(held.keys())) release(environmentId);
  };

  const reset = () => {
    releaseAll();
    authority = null;
    active = false;
    completed.clear();
    failed.clear();
  };

  return {
    update(input: {
      readonly authority: string | null;
      readonly active: boolean;
      readonly candidates: ReadonlyArray<HostedWorkspaceDiscoveryCandidate>;
    }): void {
      if (input.authority !== authority) {
        reset();
        authority = input.authority;
      }
      const nextActive = input.active && authority !== null;
      if (nextActive && !active) {
        completed.clear();
        failed.clear();
      }
      active = nextActive;
      if (!active) {
        releaseAll();
        return;
      }
      const eligibleIds = new Set(
        input.candidates
          .filter((candidate) => candidate.eligible)
          .map((node) => node.environmentId),
      );
      // A machine returning online, regaining access or leaving the direct
      // plane needs a fresh read, even if it completed an earlier discovery.
      for (const environmentId of completed) {
        if (!eligibleIds.has(environmentId)) completed.delete(environmentId);
      }
      for (const environmentId of failed) {
        if (!eligibleIds.has(environmentId)) failed.delete(environmentId);
      }
      for (const candidate of input.candidates) {
        if (!candidate.eligible) continue;
        if (candidate.ready) completed.add(candidate.environmentId);
        if (candidate.failed) failed.add(candidate.environmentId);
      }
      const connectable = input.candidates.filter(
        (candidate) => candidate.eligible && !failed.has(candidate.environmentId),
      );
      // Every machine fits a slot: all of them stay held. Otherwise only the
      // ones still owed a read are.
      const wanted =
        connectable.length <= bound
          ? connectable
          : connectable.filter((candidate) => !completed.has(candidate.environmentId));
      const wantedIds = new Set(wanted.map((candidate) => candidate.environmentId));
      for (const environmentId of Array.from(held.keys())) {
        if (!wantedIds.has(environmentId)) release(environmentId);
      }
      for (const candidate of wanted) {
        if (held.size >= bound) break;
        if (held.has(candidate.environmentId)) continue;
        held.set(candidate.environmentId, retain(candidate.environmentId));
      }
    },
    reset,
  };
}
