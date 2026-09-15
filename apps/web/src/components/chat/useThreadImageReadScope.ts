import { useMemo, useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@ryco/contracts";
import { hostedHubStore, resolveHostedRpcCapability } from "@ryco/client-runtime/authorization";
import {
  getWsConnectionStatusForEnvironment,
  wsConnectionStatusForEnvironmentAtom,
} from "@ryco/client-runtime/rpc";
import { isHostedHubMode } from "../../env";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../../environments/runtime";
import { isHostedEnvironmentQueryRefreshReady } from "../../rpc/environmentQueryRefresh";

/** Observe existing lifecycle authority; never reconnect, authorize, or publish readiness here. */
export function useThreadImageReadScope(environmentId: EnvironmentId) {
  const connection = useSyncExternalStore(subscribeEnvironmentConnections, () =>
    readEnvironmentConnection(environmentId),
  );
  const status = useAtomValue(wsConnectionStatusForEnvironmentAtom(environmentId));
  const hosted = isHostedHubMode();
  const state = useSyncExternalStore(hostedHubStore.subscribe, hostedHubStore.getState);
  const available =
    Boolean(connection) &&
    status.phase === "connected" &&
    (!hosted ||
      (isHostedEnvironmentQueryRefreshReady(state, environmentId, state.generation) &&
        resolveHostedRpcCapability({
          hosted,
          role: state.effectiveRole,
          fresh: state.directoryStatus === "ready" && state.transportStatus === "online",
          browserCurrent: state.browserStatus === "current",
          sessionReady: state.sessionStatus === "ready",
          method: "chatAttachments.readChunk",
        }).allowed));
  // A reconnect can retain the same client object. Socket epochs and hosted
  // generations therefore also invalidate all gallery-owned sources.
  const generation = hosted ? state.generation : null;
  const role = hosted ? state.effectiveRole : null;
  const lifetime = useMemo(
    () => ({
      environmentId,
      connection,
      connectedAt: status.connectedAt,
      disconnectedAt: status.disconnectedAt,
      available,
      generation,
      role,
    }),
    [
      environmentId,
      connection,
      status.connectedAt,
      status.disconnectedAt,
      available,
      generation,
      role,
    ],
  );
  const isCurrent = () => {
    const currentStatus = getWsConnectionStatusForEnvironment(environmentId);
    const currentHosted = hostedHubStore.getState();
    return (
      available &&
      readEnvironmentConnection(environmentId) === connection &&
      currentStatus.phase === "connected" &&
      currentStatus.connectedAt === status.connectedAt &&
      currentStatus.disconnectedAt === status.disconnectedAt &&
      (!hosted ||
        (isHostedEnvironmentQueryRefreshReady(currentHosted, environmentId, state.generation) &&
          currentHosted.effectiveRole === state.effectiveRole))
    );
  };
  return { available, lifetime, isCurrent };
}
