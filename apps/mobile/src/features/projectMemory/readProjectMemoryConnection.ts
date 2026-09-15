import { PROJECT_MEMORY_WS_METHODS, type EnvironmentId } from "@ryco/contracts";
import { hostedHubStore, resolveHostedRpcCapability } from "@ryco/client-runtime/authorization";
import { getWsConnectionStatusForEnvironment } from "@ryco/client-runtime/rpc";
import type { ProjectMemoryConnection } from "@ryco/client-runtime/state/project-memory";
import { readEnvironmentApi } from "../../connection/environmentApi";
import { mobileHostedConnectionsStore } from "../../connection/hostedConnectionCoordinator";
import { readEnvironmentDescriptor } from "../../hostedHub/primaryEnvironment";
import { getMobileE2eeSessionState } from "../../hostedHub/e2eeSession";
import { getMobileNativeE2eeEnrollmentState } from "../../hostedHub/e2eeEnrollment";
import { authoritativeNodeTrustSourceRevision } from "../home/authoritativeNodeTrustSource";
import { createMobileConnectionRegistry } from "../../runtime/bootstrap";
import { useStore } from "../../state/threadsRuntime";

/** Read existing owners only. Capability decisions stay in the shared authorization policy. */
export function readProjectMemoryConnection(
  environmentId: EnvironmentId,
): ProjectMemoryConnection | null {
  const api = readEnvironmentApi(environmentId)?.projectMemory;
  const connection = createMobileConnectionRegistry().driver.supervisor.read(environmentId);
  if (!api || !connection) return null;
  const socket = getWsConnectionStatusForEnvironment(environmentId);
  const hub = hostedHubStore.getState();
  const connections = mobileHostedConnectionsStore.getState();
  const selected = connections.selectedNodes.find((node) => node.environmentId === environmentId);
  const hosted = selected !== undefined || readEnvironmentDescriptor(environmentId) !== null;
  const capability = resolveHostedRpcCapability({
    hosted,
    role: selected?.effectiveRole ?? null,
    fresh: hub.directoryStatus === "ready" && selected?.transportStatus === "online",
    browserCurrent: hub.browserStatus === "current",
    sessionReady:
      selected?.sessionStatus === "ready" &&
      selected.sessionEstablished &&
      selected.attemptPrepared,
    method: PROJECT_MEMORY_WS_METHODS.mutate,
  });
  return {
    api,
    generation: hosted ? hub.generation : 0,
    lifetime: [
      connection,
      socket.connectedAt,
      socket.disconnectedAt,
      hosted ? selected?.generation : null,
      hosted ? selected?.effectiveRole : null,
      hosted ? hub.account?.id : null,
      hosted ? authoritativeNodeTrustSourceRevision() : null,
      hosted ? getMobileNativeE2eeEnrollmentState().generation : null,
      hosted ? getMobileE2eeSessionState(environmentId) : null,
    ],
    ready:
      socket.phase === "connected" &&
      capability.allowed &&
      useStore.getState().environmentStateById[environmentId]?.bootstrapComplete === true &&
      !connections.deliveryUnknownEnvironmentIds.includes(environmentId),
  };
}
