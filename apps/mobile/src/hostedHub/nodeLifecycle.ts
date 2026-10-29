import {
  getHostedEnvironmentSessions,
  reportHostedShellSnapshotFailure,
  type HostedHubNode,
  type HostedNodeLifecycle,
} from "@ryco/client-runtime/authorization";
import type {
  EnvironmentConnection,
  EnvironmentConnectionSupervisor,
  PushSequenceMonitor,
} from "@ryco/client-runtime/connection";
import type { EnvironmentId } from "@ryco/contracts";

import { readMobileHostedConnectionCoordinator } from "../connection/hostedConnectionCoordinator";
import { createMobileConnectionRegistry } from "../runtime/bootstrap";
import { mobileRuntimeStartupBarrier } from "../runtime/startupBarrier";
import { useStore } from "../state/threadsRuntime";
import { demoteMobileHostedEnvironmentState } from "./nodeStateCleanup";
import type { HostedPrimaryConnectionDeps } from "./primaryConnection";
import { createHostedEnvironmentConnectionIfLoaded } from "./primaryConnectionFactory";
import { writePrimaryEnvironmentDescriptor } from "./primaryEnvironment";

/**
 * The hosted plane's node lifecycle, for retained environment sessions.
 *
 * The hosted controller owns every environment session and runs these ports
 * on that environment's own transition queue; the app must not second-guess
 * it. Selection is only a cursor (`writePrimaryEnvironmentDescriptor`,
 * `setActiveEnvironmentId`); connections are created only by
 * `connectEnvironment`, which only the controller's `acquireEnvironment`
 * reaches. Every port names the session generation it acts for and does
 * nothing when a newer generation owns the environment, so a late release or
 * suspension of an old generation never tears down a newer connection. Whether
 * a selected environment reuses its connection or starts over is the
 * controller's decision (adopt, join or restart), never this lifecycle's.
 */

function supervisor() {
  return createMobileConnectionRegistry().driver.supervisor;
}

/** Each hosted environment's connection, with the session generation it belongs to. */
const environmentConnections = new Map<
  EnvironmentId,
  { readonly generation: number; readonly connection: EnvironmentConnection }
>();

// The push-sequence monitor is diagnostics-only; mobile has no monitor UI.
const noPushSequenceMonitor: PushSequenceMonitor = {
  recordEvent: () => undefined,
  recordSnapshot: () => undefined,
};

/** The stream handlers that feed a connection into the supervisor registering it. */
function supervisorHandlers(target: EnvironmentConnectionSupervisor): HostedPrimaryConnectionDeps {
  return {
    pushSequenceMonitor: noPushSequenceMonitor,
    resetShellProjection: (environmentId) => target.resetShellProjection(environmentId),
    applyShellEvent: (event, environmentId) => target.applyShellEvent(event, environmentId),
    applyThreadPriorities: (item, environmentId) =>
      target.applyThreadPriorities(item, environmentId),
    syncShellSnapshot: (snapshot, environmentId, callbacks) =>
      target.syncShellSnapshot(snapshot, environmentId, callbacks),
  };
}

/** Remove a connection from the supervisor, or dispose it if it is no longer registered. */
async function removeConnection(
  target: EnvironmentConnectionSupervisor,
  environmentId: EnvironmentId,
  connection: EnvironmentConnection,
): Promise<void> {
  try {
    if (target.read(environmentId) === connection) await target.remove(environmentId);
    else await connection.dispose();
  } catch {
    // Local teardown: the connection is gone from the supervisor either way.
  }
}

function openEnvironmentConnection(node: HostedHubNode, generation: number): void {
  const { environmentId } = node;
  // A generation released, suspended or started over while this waited opens nothing.
  if (!getHostedEnvironmentSessions().isCurrentGeneration(environmentId, generation)) return;
  const current = environmentConnections.get(environmentId);
  if (current !== undefined && current.generation >= generation) return;
  const registry = createMobileConnectionRegistry();
  // Two-plane isolation: an environment the direct plane owns is never also
  // reached through the relay.
  if (registry.catalog.get(environmentId)) {
    throw new Error("The direct connection plane owns this environment.");
  }
  const connections = registry.driver.supervisor;
  if (current !== undefined) {
    // An older generation's connection, started over without a release. The
    // supervisor drops it at once; its transport closes on its own.
    environmentConnections.delete(environmentId);
    void removeConnection(connections, environmentId, current.connection);
  }
  const connection = createHostedEnvironmentConnectionIfLoaded({
    node,
    generation,
    ...supervisorHandlers(connections),
  });
  if (connection === null) throw new Error("The hosted relay connection is not loaded.");
  try {
    connections.register(connection);
  } catch (error) {
    void connection.dispose().catch(() => undefined);
    throw error;
  }
  environmentConnections.set(environmentId, { generation, connection });
}

/**
 * Close the environment's connection when it belongs to `generation` or an
 * older one. What it displayed stays: a release's node-scoped clear is the
 * controller's to run after this resolves, and a suspension keeps it.
 */
async function closeEnvironmentConnection(
  environmentId: EnvironmentId,
  generation: number,
): Promise<void> {
  const current = environmentConnections.get(environmentId);
  if (current === undefined || current.generation > generation) return;
  environmentConnections.delete(environmentId);
  await removeConnection(supervisor(), environmentId, current.connection);
}

/**
 * Clear only per-node UI/query caches.
 *
 * Two-plane isolation: this must never touch the direct plane's saved
 * -environment catalog, its registry/runtime stores, or its bearer tokens.
 * Those belong to the direct plane and survive a hosted node switch.
 */
function clearNodeScopedState(environmentId: EnvironmentId): void {
  // A node can be reachable on both planes at once — paired directly and also
  // enrolled in the Hub — and the Hub's descriptor reuses the same environment
  // id. Wiping this state on hosted teardown would then destroy the live direct
  // connection's threads and subscriptions. The direct plane owns anything in
  // its catalog, so leave that alone.
  const registry = createMobileConnectionRegistry();
  if (registry.catalog.get(environmentId)) return;
  // The controller clears an environment after its release port resolved, and
  // only when no newer session of it started meanwhile. A connection still
  // registered here belongs to such a session: it is alive and keeps its state.
  if (registry.driver.supervisor.read(environmentId)) return;
  registry.driver.supervisor.disposeThreadDetailSubscriptionsForEnvironment(environmentId);
  // Demote instead of remove: a released node's rows stay rendered as
  // last-known state (sessions and liveness dropped, cache-provenance
  // stamped). Revocation and authorization removal purge fully via the roster
  // mirror in persistence/environmentSnapshotPersistence.ts.
  demoteMobileHostedEnvironmentState(environmentId);
}

export const mobileHostedNodeLifecycle: HostedNodeLifecycle = {
  // Single-session ports. Retained sessions never use them: selection does not
  // own a connection's lifetime, the demand executor and the ports below do.
  activate: async () => undefined,
  suspend: async () => undefined,
  deactivate: async () => undefined,
  connectPrimaryEnvironment: () => undefined,
  disconnectPrimaryEnvironment: async () => undefined,
  clearNodeScopedState,
  writePrimaryEnvironmentDescriptor,
  setActiveEnvironmentId: (environmentId) => {
    useStore.getState().setActiveEnvironmentId(environmentId);
  },
  connectEnvironment: (node, generation) => {
    // Hosted connections wait for the cached roster and projections.
    if (mobileRuntimeStartupBarrier.isHydrated()) {
      openEnvironmentConnection(node, generation);
      return;
    }
    mobileRuntimeStartupBarrier.runAfterHydration(
      () => openEnvironmentConnection(node, generation),
      (error: unknown) => {
        console.warn("[connection] hosted startup failed", error);
        // Fenced: fails only a generation that is still current.
        reportHostedShellSnapshotFailure(node.environmentId, generation);
      },
    );
  },
  releaseEnvironment: closeEnvironmentConnection,
  // The transport goes; the environment's rows stay rendered until its next
  // session's snapshot replaces them.
  suspendEnvironment: closeEnvironmentConnection,
  requestEnvironmentReconcile: (request) => {
    readMobileHostedConnectionCoordinator()?.requestEnvironmentReconcile(request);
  },
};

/** Test seam: forget every environment's connection. */
export function resetMobileHostedEnvironmentConnectionsForTests(): void {
  environmentConnections.clear();
}
