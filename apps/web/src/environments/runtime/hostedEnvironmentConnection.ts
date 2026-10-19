import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import type { HostedEnvironmentSessions } from "@ryco/client-runtime/authorization/hostedEnvironmentSessions";
import { createKnownEnvironment } from "@ryco/client-runtime/knownEnvironment";
import { createDeviceRpcClient } from "@ryco/client-runtime/rpc";
import type { EnvironmentId } from "@ryco/contracts";

import {
  hostedHubController,
  hostedHubStore,
  markHostedSessionReady,
  markHostedSessionReplaying,
  reportHostedShellSnapshotFailure,
} from "~/hostedHub/state";
import {
  bindHostedDispatchReplay,
  createHostedEnvironmentAttemptFactory,
  hostedDispatchLineage,
  webHostedEnvironmentAttemptPorts,
} from "~/hostedHub/transport";
import { isHostedRecordQueryRefreshReady } from "../../rpc/environmentQueryRefresh";
import { writeEnvironmentServerConfig } from "../../rpc/serverState";
import { HostedWsTransport } from "../../rpc/wsTransport";
import { createWsRpcClient } from "../../rpc/wsRpcClient";
import { readPrimaryEnvironmentTarget } from "../primary/target";
import { createEnvironmentConnection, type EnvironmentConnection } from "./connection";

/**
 * What a hosted connection's callbacks are fenced by, and where its session
 * readiness goes. A connection of a generation the lifecycle owner has moved
 * past delivers nothing: no shell, no readiness and no query refresh.
 */
export interface HostedConnectionFence {
  /** Whether the connection's generation is still the lifecycle owner's current one. */
  readonly accepts: () => boolean;
  /** The connection accepted a current shell snapshot. */
  readonly markReady: (environmentId: EnvironmentId) => void;
  /** The connection resubscribed and is replaying onto a fresh snapshot. */
  readonly markReplaying: (environmentId: EnvironmentId) => void;
  readonly reportShellError: (environmentId: EnvironmentId) => void;
  /** Whether the session behind the connection is current enough to refresh fenced queries. */
  readonly isQueryRefreshReady: (environmentId: EnvironmentId) => boolean;
}

type HostedConnectionHandlers = Omit<
  Parameters<typeof createEnvironmentConnection>[0],
  "kind" | "knownEnvironment" | "client" | "lifecycleGeneration" | "onConfigUpdated"
>;

/**
 * The fence of one environment's retained session generation: callbacks count
 * only while that generation is its record's own, and readiness is written to
 * that record and no other.
 */
export function hostedRecordFence(
  sessions: HostedEnvironmentSessions,
  environmentId: EnvironmentId,
  generation: number,
): HostedConnectionFence {
  return {
    accepts: () => sessions.isCurrentGeneration(environmentId, generation),
    markReady: (target) => markHostedSessionReady(target, generation),
    markReplaying: (target) => markHostedSessionReplaying(target, generation),
    reportShellError: (target) => reportHostedShellSnapshotFailure(target, generation),
    isQueryRefreshReady: (target) =>
      isHostedRecordQueryRefreshReady(
        { record: sessions.read(target), shared: hostedHubStore.getState() },
        target,
        generation,
      ),
  };
}

const connectionGenerations = new WeakMap<EnvironmentConnection, number>();

/** The session generation a hosted environment connection was created for; `null` for any other. */
export function hostedEnvironmentConnectionGeneration(
  connection: EnvironmentConnection,
): number | null {
  return connectionGenerations.get(connection) ?? null;
}

export interface HostedEnvironmentConnectionInput {
  readonly node: HostedHubNode;
  /** The record generation this connection serves; it stays inert once that is replaced. */
  readonly generation: number;
  readonly sessions: HostedEnvironmentSessions;
  /** The connection's stream handlers, fenced by the record generation. */
  readonly handlersFor: (fence: HostedConnectionFence) => HostedConnectionHandlers;
  /**
   * Whether the platform still wants the environment connected. A dropped
   * channel of an environment nothing demands stops instead of reconnecting.
   */
  readonly isDemanded: () => boolean;
}

/**
 * One environment's hosted connection for one record generation of its
 * session. Its relay attempts are admitted from, and report to, that record
 * alone, its E2EE attempt is resolved for its own node, and its config and
 * stream callbacks are fenced by the same generation, so the connection of a
 * replaced generation can publish nothing anywhere.
 *
 * Only the lifecycle owner's connect port creates one; see
 * `connectHostedEnvironment`.
 */
export function createHostedEnvironmentConnection(
  input: HostedEnvironmentConnectionInput,
): EnvironmentConnection {
  const { node, generation, sessions } = input;
  const environmentId = node.environmentId;
  const target = readPrimaryEnvironmentTarget();
  if (target === null) throw new Error("Unable to resolve the hosted environment target.");
  const { factory } = createHostedEnvironmentAttemptFactory({
    sessions,
    environmentId,
    nodeId: node.id,
    generation,
    readShared: () => hostedHubStore.getState(),
    subscribeShared: (listener) => hostedHubStore.subscribe(listener),
    ports: webHostedEnvironmentAttemptPorts({ nodeId: node.id, environmentId }),
    isDemanded: input.isDemanded,
  });
  const dispatchReplay = bindHostedDispatchReplay({
    environmentId,
    lineage: hostedDispatchLineage(hostedHubStore.getState()),
    markUncertain: () => hostedHubController.markEnvironmentDeliveryUnknown(environmentId),
  });
  const transport = new HostedWsTransport(() => factory.nextUrl(), {
    ...factory.lifecycleHandlers(dispatchReplay),
    getConnectionLabel: () => node.label,
    getEnvironmentId: () => environmentId,
  });
  const client = dispatchReplay.wrap(
    createWsRpcClient(transport, createDeviceRpcClient(transport, { manageTransport: false })),
  );
  const connection = createEnvironmentConnection({
    kind: "primary",
    knownEnvironment: {
      ...createKnownEnvironment({
        id: environmentId,
        label: node.label,
        source: "hub-hosted",
        target: target.target,
      }),
      environmentId,
    },
    client,
    // Config of a replaced generation is neither published nor read.
    lifecycleGeneration: {
      generation,
      readCurrent: () => sessions.read(environmentId)?.generation ?? null,
    },
    onConfigUpdated: (config, type) => writeEnvironmentServerConfig(environmentId, config, type),
    ...input.handlersFor(hostedRecordFence(sessions, environmentId, generation)),
  });
  connectionGenerations.set(connection, generation);
  return connection;
}
