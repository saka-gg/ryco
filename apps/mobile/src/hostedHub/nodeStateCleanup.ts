import { forgetEnvironmentServerConfig } from "@ryco/client-runtime/rpc";
import type { EnvironmentId } from "@ryco/contracts";

import { clearCheckpointDiffState } from "../rpc/checkpointDiffAtoms";
import { useStore } from "../state/threadsRuntime";

/** Demote one disconnected hosted environment without touching another plane. */
export function demoteMobileHostedEnvironmentState(environmentId: EnvironmentId): void {
  useStore.getState().demoteEnvironmentStateToCachedSnapshot(environmentId, Date.now());
  clearCheckpointDiffState();
  // The released node's config no longer speaks for it: what it reported stays
  // as the last known answer, and a newer cached snapshot's rule now applies.
  forgetEnvironmentServerConfig(environmentId);
}
