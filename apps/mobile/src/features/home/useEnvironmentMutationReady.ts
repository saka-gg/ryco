import type { EnvironmentId } from "@ryco/contracts";

import { useHomeEnvironments } from "./useHomeEnvironments";

/**
 * Whether the environment may take changes now: the shared readiness every
 * mutating surface checks (a hosted session revalidating, a stale relay
 * generation or a read-only role all say no).
 */
export function useEnvironmentMutationReady(environmentId: EnvironmentId | null): boolean {
  const environments = useHomeEnvironments();
  return (
    environmentId !== null &&
    environments.some(
      (environment) => environment.environmentId === environmentId && environment.mutationReady,
    )
  );
}
