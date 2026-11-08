import type { EnvironmentId } from "@ryco/contracts";

/**
 * Device data kept outside the snapshot database that must go when an
 * environment's cached content goes: forgetting the node, Hub sign-out and
 * revocation, Settings' "Clear device cache". Features register what they
 * keep (pull request review drafts, for example); the snapshot purge runs
 * every registered purge with it, so all of it follows one rule.
 */
export type EnvironmentDevicePurge = (environmentId: EnvironmentId) => void | Promise<void>;

const purges = new Set<EnvironmentDevicePurge>();

export function registerEnvironmentDevicePurge(purge: EnvironmentDevicePurge): () => void {
  purges.add(purge);
  return () => {
    purges.delete(purge);
  };
}

/** Runs every registered purge; one that fails does not stop the others. */
export async function purgeEnvironmentDeviceData(environmentId: EnvironmentId): Promise<void> {
  await Promise.all(
    Array.from(purges, (purge) =>
      Promise.resolve()
        .then(() => purge(environmentId))
        .catch((error: unknown) => {
          console.warn("[device-data] could not purge environment data", error);
        }),
    ),
  );
}

export function resetEnvironmentDevicePurgesForTests(): void {
  purges.clear();
}
