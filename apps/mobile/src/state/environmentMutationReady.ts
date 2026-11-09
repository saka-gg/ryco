import {
  getWsConnectionStatusForEnvironment,
  getWsConnectionUiState,
} from "@ryco/client-runtime/rpc";
import { selectEnvironmentShellLive, useStore } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId } from "@ryco/contracts";

/**
 * Whether a machine takes a change from this device now: its socket is connected and its
 * live shell snapshot has landed. Rows hydrated from the snapshot cache (or demoted after a
 * disconnect) are last-known state, not evidence of what the node holds now, and the socket
 * can open one round trip before the live snapshot arrives. The outbox, scheduled tasks and
 * task writes read readiness here, outside React.
 */
export function readEnvironmentShellLive(environmentId: EnvironmentId): boolean {
  return selectEnvironmentShellLive(useStore.getState(), environmentId);
}

export function readEnvironmentMutationReady(environmentId: EnvironmentId): boolean {
  return (
    readEnvironmentShellLive(environmentId) &&
    getWsConnectionUiState(getWsConnectionStatusForEnvironment(environmentId)) === "connected"
  );
}
