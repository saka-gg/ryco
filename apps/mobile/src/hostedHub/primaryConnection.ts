import {
  createEnvironmentConnection,
  type EnvironmentConnection,
  type EnvironmentConnectionSupervisor,
  type OrchestrationHandlers,
} from "@ryco/client-runtime/connection";
import {
  hostedHubStore,
  hostedHubController,
  markHostedSessionReady,
  markHostedSessionReplaying,
  reportHostedShellSnapshotFailure,
} from "@ryco/client-runtime/authorization";
import {
  attachEnvironmentDescriptor,
  createKnownEnvironment,
} from "@ryco/client-runtime/knownEnvironment";
import {
  authorizeHostedRequestForState,
  HostedRelayAttemptFactory,
  recoverHostedRelayConnection,
} from "@ryco/client-runtime/relay";
import { createWsRpcClient } from "@ryco/client-runtime/rpc";

import { WsTransport } from "../rpc/wsTransport";
import { getMobileHostedConnectionCoordinator } from "../connection/hostedConnectionCoordinator";
import {
  disposeMobileRelaySocketContext,
  issueMobileRelayAttempt,
  prepareMobileRelaySocketContext,
  providerForMobileRelaySocketContext,
} from "./accountE2eeAttempt";
import { readPrimaryEnvironmentDescriptor } from "./primaryEnvironment";
import { MobileHostedRelaySocket, mobileHostedRelayUrl } from "./relaySocket";
import { getMobileHostedConfig } from "./runtimeConfig";
import { writeEnvironmentServerConfig } from "../state/environmentServerConfigs";
import { getMobileNativeE2eeEnrollmentCoordinator } from "./e2eeEnrollment";

/**
 * Builds the node connection that runs **through the Hub relay**.
 *
 * `nodeLifecycle.connectPrimaryEnvironment()` drives `supervisor.connectPrimary()`,
 * which calls this. The relay attempt factory owns the ticket lifecycle — it
 * issues a fresh ticket per attempt and throws on any reuse — so this module
 * only consumes it and never caches or replays one.
 *
 * Returns `null` when no hosted node is selected, which is the normal state and
 * includes supervisor `start()` on a direct-only build. That `null` is what
 * keeps the direct plane's behavior byte-identical when hosted mode is absent.
 */
export interface HostedPrimaryConnectionDeps extends Pick<
  OrchestrationHandlers,
  "applyShellEvent" | "resetShellProjection"
> {
  readonly syncShellSnapshot: EnvironmentConnectionSupervisor["syncShellSnapshot"];
  readonly pushSequenceMonitor: Parameters<
    typeof createEnvironmentConnection
  >[0]["pushSequenceMonitor"];
}

export function createHostedPrimaryConnection(
  deps: HostedPrimaryConnectionDeps,
): EnvironmentConnection | null {
  const descriptor = readPrimaryEnvironmentDescriptor();
  if (descriptor === null) return null;
  const selectedState = hostedHubStore.getState();
  const node = selectedState.selectedNode;
  if (!node || node.environmentId !== descriptor.environmentId) return null;
  const coordinator = getMobileHostedConnectionCoordinator();
  if (!coordinator.shouldActivate(descriptor.environmentId)) return null;
  const connectionState = coordinator.ensureRecord(node);
  const connectionGeneration = connectionState.generation;
  const acceptsEvent = () =>
    coordinator.isCurrentGeneration(descriptor.environmentId, connectionGeneration);
  const sharedSelectionGeneration = (): number | null => {
    if (!acceptsEvent()) return null;
    const state = hostedHubStore.getState();
    return state.selectedNode?.environmentId === descriptor.environmentId ? state.generation : null;
  };

  const attemptFactory = new HostedRelayAttemptFactory({
    nodeId: () => node.id,
    generation: () => connectionGeneration,
    isAuthenticated: () => hostedHubStore.getState().accountStatus === "authenticated",
    isCurrent: (generation) =>
      coordinator.isCurrentGeneration(descriptor.environmentId, generation),
    prepareSocketContext: async () => {
      const before = hostedHubStore.getState();
      if (
        before.accountStatus !== "authenticated" ||
        before.selectedNode?.environmentId !== descriptor.environmentId
      ) {
        throw new Error("Hosted environment is not the current reconnect target.");
      }
      const prepared = await prepareMobileRelaySocketContext();
      const after = hostedHubStore.getState();
      if (
        after.accountStatus !== "authenticated" ||
        after.selectedNode?.environmentId !== descriptor.environmentId
      ) {
        throw new Error("Hosted environment changed during E2EE preparation.");
      }
      return prepared;
    },
    issueRelayAttempt: (input) => issueMobileRelayAttempt(input),
    disposeSocketContext: disposeMobileRelaySocketContext,
    relayUrl: mobileHostedRelayUrl,
    createRelaySocket: (input) =>
      new MobileHostedRelaySocket({
        ...input,
        e2ee: providerForMobileRelaySocketContext(input.preparedSocketContext),
        disposePreparedContext: () => disposeMobileRelaySocketContext(input.preparedSocketContext),
      }),
    authorizeRequest: (info) => {
      const shared = hostedHubStore.getState();
      const current = coordinator.read(descriptor.environmentId);
      if (!current || current.generation !== connectionGeneration) return false;
      return authorizeHostedRequestForState(
        {
          effectiveRole: current.effectiveRole,
          directoryStatus: shared.directoryStatus,
          transportStatus: current.transportStatus,
          browserStatus: shared.browserStatus,
          sessionStatus: current.sessionStatus,
        },
        info,
      );
    },
    shouldReconnect: (generation) => {
      const shared = hostedHubStore.getState();
      const current = coordinator.read(descriptor.environmentId);
      return (
        current?.generation === generation &&
        shared.accountStatus === "authenticated" &&
        shared.selectedNode?.environmentId === descriptor.environmentId &&
        (shared.browserStatus === "current" || shared.browserStatus === "synchronizing") &&
        current.transportStatus !== "terminal-failure"
      );
    },
    transportStatus: (generation, status) => {
      coordinator.transportStatus(descriptor.environmentId, generation, status);
      const sharedGeneration = sharedSelectionGeneration();
      if (sharedGeneration !== null) hostedHubController.transportStatus(sharedGeneration, status);
    },
    sessionStatus: (generation, status) => {
      coordinator.sessionStatus(descriptor.environmentId, generation, status);
      const sharedGeneration = sharedSelectionGeneration();
      if (sharedGeneration !== null) hostedHubController.sessionStatus(sharedGeneration, status);
    },
    role: (generation, role) => {
      coordinator.role(descriptor.environmentId, generation, role);
      const sharedGeneration = sharedSelectionGeneration();
      if (sharedGeneration !== null) hostedHubController.role(sharedGeneration, role);
    },
    failure: (generation, failure) => {
      if (failure.kind === "revoked" && failure.closeReason !== "node_revoked") {
        void getMobileNativeE2eeEnrollmentCoordinator()?.invalidate("revoked");
      }
      coordinator.failure(descriptor.environmentId, generation, failure);
      const sharedGeneration = sharedSelectionGeneration();
      if (sharedGeneration !== null) hostedHubController.failure(sharedGeneration, failure);
    },
    markDeliveryUnknown: (generation) => {
      coordinator.markDeliveryUnknown(descriptor.environmentId, generation);
      const sharedGeneration = sharedSelectionGeneration();
      if (sharedGeneration !== null) hostedHubController.markDeliveryUnknown(sharedGeneration);
    },
    connectionRecovered: (generation) => {
      if (!coordinator.isCurrentGeneration(descriptor.environmentId, generation)) return;
      const sharedGeneration = sharedSelectionGeneration();
      if (sharedGeneration !== null) recoverHostedRelayConnection(sharedGeneration);
    },
    connectionClosed: (generation) => {
      coordinator.connectionClosed(descriptor.environmentId, generation);
      const sharedGeneration = sharedSelectionGeneration();
      if (sharedGeneration !== null) hostedHubController.connectionClosed(sharedGeneration);
    },
  });
  coordinator.registerPendingRequestReader(descriptor.environmentId, connectionGeneration, () =>
    attemptFactory.hasPendingRequests(),
  );
  const client = createWsRpcClient(
    new WsTransport(() => attemptFactory.nextUrl(), {
      ...attemptFactory.lifecycleHandlers(),
      getConnectionLabel: () => descriptor.label ?? null,
      getEnvironmentId: () => descriptor.environmentId,
    }),
  );

  // The node is reached only through the relay, so the "target" is the Hub's
  // relay endpoint rather than any node-owned address — the app never learns
  // one, which is the point of the hosted plane.
  const knownEnvironment = attachEnvironmentDescriptor(
    createKnownEnvironment({
      id: descriptor.environmentId,
      label: descriptor.label,
      source: "hub-hosted",
      target: {
        httpBaseUrl: getMobileHostedConfig()?.hubOrigin ?? "",
        wsBaseUrl: mobileHostedRelayUrl(),
      },
    }),
    descriptor,
  );

  return createEnvironmentConnection({
    // Must be "primary": `disconnectPrimary` finds the connection by this kind.
    kind: "primary",
    knownEnvironment,
    client,
    onConfigUpdated: (config) => {
      if (!acceptsEvent()) return;
      writeEnvironmentServerConfig(descriptor.environmentId, config);
    },
    pushSequenceMonitor: deps.pushSequenceMonitor,
    resetShellProjection: (environmentId) => {
      if (!acceptsEvent()) return;
      deps.resetShellProjection(environmentId);
    },
    onResubscribe: (environmentId) => {
      coordinator.markSessionReplaying(environmentId, connectionGeneration);
      const sharedGeneration = sharedSelectionGeneration();
      if (sharedGeneration !== null) markHostedSessionReplaying(environmentId, sharedGeneration);
    },
    onShellError: (environmentId) => {
      coordinator.reportShellSnapshotFailure(environmentId, connectionGeneration);
      const sharedGeneration = sharedSelectionGeneration();
      if (sharedGeneration !== null)
        reportHostedShellSnapshotFailure(environmentId, sharedGeneration);
    },
    applyShellEvent: (event, environmentId) => {
      if (!acceptsEvent()) return;
      deps.applyShellEvent(event, environmentId);
    },
    syncShellSnapshot: (snapshot, environmentId) => {
      if (!acceptsEvent()) return;
      deps.syncShellSnapshot(snapshot, environmentId, {
        onCurrent: () => {
          coordinator.markSessionReady(environmentId, connectionGeneration);
          const sharedGeneration = sharedSelectionGeneration();
          if (sharedGeneration !== null) markHostedSessionReady(environmentId, sharedGeneration);
        },
        onReady: () => {
          coordinator.markSessionReady(environmentId, connectionGeneration);
          const sharedGeneration = sharedSelectionGeneration();
          if (sharedGeneration !== null) markHostedSessionReady(environmentId, sharedGeneration);
        },
      });
    },
    // Terminal streaming is deferred, matching the direct plane.
    applyTerminalEvent: () => undefined,
  });
}
