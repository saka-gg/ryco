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
export function useEnvironmentRpcReadScope(environmentId: EnvironmentId, method: string) {
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
          method,
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
  return useMemo(
    () => ({
      available: lifetime.available,
      lifetime,
      isCurrent: () => {
        const currentStatus = getWsConnectionStatusForEnvironment(lifetime.environmentId);
        const currentHosted = hostedHubStore.getState();
        return (
          lifetime.available &&
          readEnvironmentConnection(lifetime.environmentId) === lifetime.connection &&
          currentStatus.phase === "connected" &&
          currentStatus.connectedAt === lifetime.connectedAt &&
          currentStatus.disconnectedAt === lifetime.disconnectedAt &&
          (!hosted ||
            (isHostedEnvironmentQueryRefreshReady(
              currentHosted,
              lifetime.environmentId,
              lifetime.generation ?? -1,
            ) &&
              currentHosted.effectiveRole === lifetime.role &&
              resolveHostedRpcCapability({
                hosted,
                role: currentHosted.effectiveRole,
                fresh:
                  currentHosted.directoryStatus === "ready" &&
                  currentHosted.transportStatus === "online",
                browserCurrent: currentHosted.browserStatus === "current",
                sessionReady: currentHosted.sessionStatus === "ready",
                method,
              }).allowed))
        );
      },
    }),
    [lifetime, hosted, method],
  );
}

/** Gallery retains its existing read policy through the common observer. */
export function useThreadImageReadScope(environmentId: EnvironmentId) {
  return useEnvironmentRpcReadScope(environmentId, "chatAttachments.readChunk");
}
