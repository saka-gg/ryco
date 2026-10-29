import {
  createEnvironmentConnection,
  type EnvironmentConnection,
  type EnvironmentConnectionSupervisor,
  type OrchestrationHandlers,
} from "@ryco/client-runtime/connection";
import {
  getHostedEnvironmentSessions,
  hostedHubController,
  hostedHubStore,
  markHostedSessionReady,
  markHostedSessionReplaying,
  reportHostedShellSnapshotFailure,
  type HostedHubNode,
} from "@ryco/client-runtime/authorization";
import {
  createKnownEnvironment,
  type KnownEnvironment,
} from "@ryco/client-runtime/knownEnvironment";
import {
  bindHostedDispatchReplay,
  createHostedEnvironmentAttemptFactory,
  hostedDispatchLineage,
} from "@ryco/client-runtime/relay";
import { createWsRpcClient } from "@ryco/client-runtime/rpc";

import { WsTransport } from "../rpc/wsTransport";
import { readMobileHostedConnectionCoordinator } from "../connection/hostedConnectionCoordinator";
import {
  disposeMobileRelaySocketContext,
  issueMobileRelayAttempt,
  prepareMobileRelaySocketContext,
} from "./accountE2eeAttempt";
import type { MobileE2eeAttemptTarget } from "./e2eeAttempt";
import { mobileHostedRelayUrl, openMobileEarlyRelaySocket } from "./relaySocket";
import { getMobileHostedConfig } from "./runtimeConfig";
import { writeEnvironmentServerConfig } from "../state/environmentServerConfigs";
import { getMobileNativeE2eeEnrollmentCoordinator } from "./e2eeEnrollment";

/**
 * The supervisor's stream handlers a hosted node connection feeds. The
 * connection driver hands them to its primary connection factory; the hosted
 * node lifecycle builds them from the supervisor that registers the connection.
 */
export interface HostedPrimaryConnectionDeps extends Pick<
  OrchestrationHandlers,
  "applyShellEvent" | "resetShellProjection"
> {
  /**
   * Required, unlike on the shared handlers: supplying it makes the connection
   * ask for thread-priority deltas, so an AI Focus ranking batch reaches the
   * phone as a small item instead of a full shell snapshot over the relay.
   */
  readonly applyThreadPriorities: NonNullable<OrchestrationHandlers["applyThreadPriorities"]>;
  readonly syncShellSnapshot: EnvironmentConnectionSupervisor["syncShellSnapshot"];
  readonly pushSequenceMonitor: Parameters<
    typeof createEnvironmentConnection
  >[0]["pushSequenceMonitor"];
}

export interface HostedEnvironmentConnectionInput extends HostedPrimaryConnectionDeps {
  readonly node: HostedHubNode;
  /** The environment session's record generation this connection belongs to. */
  readonly generation: number;
}

/**
 * Builds one hosted environment's node connection, which runs **through the Hub
 * relay**.
 *
 * Only the hosted node lifecycle's `connectEnvironment` port calls this, and
 * only the hosted controller's `acquireEnvironment` reaches that port, so no
 * connection exists outside the controller's bounded connect path. The
 * connection belongs to one record generation of the environment's session:
 * its relay binding admits requests and reconnects from that record alone —
 * never from the selected node, so a warm environment that is not selected
 * keeps working — and every callback is fenced by the generation, so a
 * connection whose record was replaced or released publishes nothing. Its E2EE
 * attempt is prepared for its own node and generation. The relay attempt
 * factory owns the ticket lifecycle — a fresh ticket per attempt, never reused.
 */
export function createHostedEnvironmentConnection(
  input: HostedEnvironmentConnectionInput,
): EnvironmentConnection {
  const { node, generation } = input;
  const { environmentId } = node;
  const sessions = getHostedEnvironmentSessions();
  const acceptsEvent = () => sessions.isCurrentGeneration(environmentId, generation);
  const target: MobileE2eeAttemptTarget = {
    nodeId: node.id,
    nodeLabel: node.label,
    environmentId,
    generation,
    isCurrent: acceptsEvent,
  };

  const { factory: attemptFactory } = createHostedEnvironmentAttemptFactory({
    sessions,
    environmentId,
    nodeId: node.id,
    generation,
    readShared: () => hostedHubStore.getState(),
    subscribeShared: (listener) => hostedHubStore.subscribe(listener),
    // A dropped channel reconnects by itself only while the app still wants
    // this environment; otherwise the coordinator releases it.
    isDemanded: () => readMobileHostedConnectionCoordinator()?.isDemanded(environmentId) ?? true,
    // The channel's E2EE context and ticket are prepared for this node and
    // generation. The relay URL and the socket, which takes the §4.4 provider
    // from that context, are the hosted runtime's (`runtime.ts`).
    ports: {
      prepareSocketContext: () => prepareMobileRelaySocketContext(target),
      issueRelayAttempt: (attempt) => issueMobileRelayAttempt(attempt),
      disposeSocketContext: disposeMobileRelaySocketContext,
      openEarlyRelaySocket: () => openMobileEarlyRelaySocket(),
      // Only the Hub's enrollment frame speaks for this device, and only when it
      // names this device's enrollment. A `revoked`, `node_revoked`, or
      // `grant_revoked` close ends one node's channel — node removal, key
      // rotation, a grant change — and invalidating the device enrollment for
      // it took every other node down with it.
      onFailure: (failure) => {
        if (failure.enrollmentRevoked !== undefined) {
          getMobileNativeE2eeEnrollmentCoordinator()?.applyRevocation(failure.enrollmentRevoked);
        }
      },
    },
  });
  const dispatchReplay = bindHostedDispatchReplay({
    environmentId,
    lineage: hostedDispatchLineage(hostedHubStore.getState()),
    // Environment-scoped, not generation-scoped: the replay may give up after
    // this connection's generation has been replaced.
    markUncertain: () => hostedHubController.markEnvironmentDeliveryUnknown(environmentId),
  });
  const client = dispatchReplay.wrap(
    createWsRpcClient(
      new WsTransport(() => attemptFactory.nextUrl(), {
        ...attemptFactory.lifecycleHandlers(dispatchReplay),
        getConnectionLabel: () => node.label,
        getEnvironmentId: () => environmentId,
      }),
    ),
  );

  // The node is reached only through the relay, so the "target" is the Hub's
  // relay endpoint rather than any node-owned address — the app never learns
  // one, which is the point of the hosted plane.
  const knownEnvironment: KnownEnvironment = {
    ...createKnownEnvironment({
      id: environmentId,
      label: node.label,
      source: "hub-hosted",
      target: {
        httpBaseUrl: getMobileHostedConfig()?.hubOrigin ?? "",
        wsBaseUrl: mobileHostedRelayUrl(),
      },
    }),
    environmentId,
  };

  return createEnvironmentConnection({
    // The supervisor keeps hosted node connections as "primary" ones.
    kind: "primary",
    knownEnvironment,
    client,
    // The environment's session record owns the generation: once it is
    // replaced or released, this connection's config is neither published nor
    // read.
    lifecycleGeneration: {
      generation,
      readCurrent: () => sessions.read(environmentId)?.generation ?? null,
    },
    onConfigUpdated: (config) => {
      if (!acceptsEvent()) return;
      writeEnvironmentServerConfig(environmentId, config);
    },
    pushSequenceMonitor: input.pushSequenceMonitor,
    resetShellProjection: (eventEnvironmentId) => {
      if (!acceptsEvent()) return;
      input.resetShellProjection(eventEnvironmentId);
    },
    // Session callbacks name this record generation; the controller fences them
    // per environment.
    onResubscribe: (eventEnvironmentId) =>
      markHostedSessionReplaying(eventEnvironmentId, generation),
    onShellError: (eventEnvironmentId) =>
      reportHostedShellSnapshotFailure(eventEnvironmentId, generation),
    applyShellEvent: (event, eventEnvironmentId) => {
      if (!acceptsEvent()) return;
      input.applyShellEvent(event, eventEnvironmentId);
    },
    applyThreadPriorities: (item, eventEnvironmentId) => {
      if (!acceptsEvent()) return;
      input.applyThreadPriorities(item, eventEnvironmentId);
    },
    syncShellSnapshot: (snapshot, eventEnvironmentId) => {
      if (!acceptsEvent()) return;
      const ready = () => markHostedSessionReady(eventEnvironmentId, generation);
      input.syncShellSnapshot(snapshot, eventEnvironmentId, { onCurrent: ready, onReady: ready });
    },
    // Terminal streaming is deferred, matching the direct plane.
    applyTerminalEvent: () => undefined,
  });
}
