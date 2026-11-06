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
 * One disposable metadata demand, like hosted Web's Home discovery. All actual
 * connections still go through the shared demand executor and lifecycle owner.
 * Remember completed reads for this visit so eviction under the connection
 * bound cannot cycle indefinitely through more than three machines.
 */
export function createHostedWorkspaceDiscovery(
  retain: (environmentId: EnvironmentId) => () => void,
) {
  let authority: string | null = null;
  let active = false;
  let current: EnvironmentId | null = null;
  let release: (() => void) | null = null;
  const completed = new Set<EnvironmentId>();
  const failed = new Set<EnvironmentId>();

  const releaseCurrent = () => {
    const previous = release;
    release = null;
    current = null;
    previous?.();
  };

  const reset = () => {
    releaseCurrent();
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
        releaseCurrent();
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
      const eligible = input.candidates.filter(
        (candidate) =>
          candidate.eligible &&
          !completed.has(candidate.environmentId) &&
          !failed.has(candidate.environmentId),
      );
      if (current !== null && !eligible.some((node) => node.environmentId === current)) {
        releaseCurrent();
      }
      if (current === null && eligible[0]) {
        current = eligible[0].environmentId;
        release = retain(current);
      }
    },
    reset,
  };
}
