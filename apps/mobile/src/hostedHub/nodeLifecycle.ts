import type { HostedNodeLifecycle } from "@ryco/client-runtime/authorization";
import type { EnvironmentId } from "@ryco/contracts";
import { hostedHubStore } from "@ryco/client-runtime/authorization";

import { getMobileHostedConnectionCoordinator } from "../connection/hostedConnectionCoordinator";
import { createMobileConnectionRegistry } from "../runtime/bootstrap";
import { mobileRuntimeStartupBarrier } from "../runtime/startupBarrier";
import { useStore } from "../state/threadsRuntime";
import { demoteMobileHostedEnvironmentState } from "./nodeStateCleanup";
import { writePrimaryEnvironmentDescriptor } from "./primaryEnvironment";

/**
 * The hosted plane's node lifecycle.
 *
 * The runtime owns teardown/turn-up ordering (`authorization/environment.ts`);
 * the app must not second-guess it. `activate`/`suspend`/`deactivate` are
 * intentionally no-ops, matching web: writing the descriptor and connecting the
 * primary environment is what actually does the work.
 */

function supervisor() {
  return createMobileConnectionRegistry().driver.supervisor;
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
  // Wave 3b retains non-selected hosted connections. The shared selection
  // transition still invokes this legacy teardown callback while moving its
  // cursor, but a registered connection proves the environment is alive and
  // must not be demoted. The coordinator calls this again after real removal.
  if (registry.driver.supervisor.read(environmentId)) return;
  registry.driver.supervisor.disposeThreadDetailSubscriptionsForEnvironment(environmentId);
  // Wave 2: demote instead of remove. A hosted node switch used to blank the
  // switched-away node's rows; they now stay rendered as last-known state
  // (sessions and liveness dropped, cache-provenance stamped). Revocation and
  // authorization removal purge fully via the roster mirror in
  // persistence/environmentSnapshotPersistence.ts.
  demoteMobileHostedEnvironmentState(environmentId);
}

export const mobileHostedNodeLifecycle: HostedNodeLifecycle = {
  activate: async () => undefined,
  suspend: async () => undefined,
  deactivate: async () => undefined,
  clearNodeScopedState,
  writePrimaryEnvironmentDescriptor,
  connectPrimaryEnvironment: () => {
    mobileRuntimeStartupBarrier.runAfterHydration(
      async () => {
        const state = hostedHubStore.getState();
        const node = state.selectedNode;
        if (
          !node ||
          node.revokedAt !== null ||
          state.accountStatus !== "authenticated" ||
          state.directoryStatus !== "ready" ||
          (state.browserStatus !== "current" && state.browserStatus !== "synchronizing")
        )
          return;
        const coordinator = getMobileHostedConnectionCoordinator();
        if (!coordinator.shouldActivate(node.environmentId)) return;
        const record = coordinator.ensureRecord(node);
        const existing = supervisor().read(node.environmentId);
        if (!existing) {
          supervisor().connectPrimary();
          return;
        }
        // A retained healthy channel is the whole point of multi-connect. A stale
        // retained channel is allowed to reconnect only after selection has moved
        // back to it, so its E2EE preparation and relay ticket remain node-bound.
        if (
          state.sessionStatus !== "ready" ||
          record.transportStatus !== "online" ||
          record.sessionStatus !== "ready"
        ) {
          // Ended RPC subscriptions cannot be restored by replacing only the
          // socket. The shared lifecycle owns this retry; replace its stale
          // connection while leaving healthy retained nodes alone.
          if (!(await coordinator.releaseEnvironment(node.environmentId))) return;
          const current = hostedHubStore.getState();
          if (
            current.generation !== state.generation ||
            current.accountStatus !== "authenticated" ||
            current.directoryStatus !== "ready" ||
            current.selectedNode?.id !== node.id ||
            current.selectedNode.environmentId !== node.environmentId ||
            current.selectedNode.revokedAt !== null ||
            (current.browserStatus !== "current" && current.browserStatus !== "synchronizing")
          ) {
            return;
          }
          coordinator.ensureRecord(current.selectedNode);
          if (coordinator.shouldActivate(node.environmentId)) supervisor().connectPrimary();
        }
      },
      (error: unknown) => {
        console.warn("[connection] hosted startup failed", error);
      },
    );
  },
  // Selection changes no longer own connection lifetime. Scope leases + LRU
  // do, via the mobile coordinator; sign-out and background release call it
  // explicitly. Keeping this callback inert prevents the shared cursor from
  // tearing down a live environment just because another thread was opened.
  disconnectPrimaryEnvironment: async () => undefined,
  setActiveEnvironmentId: (environmentId) => {
    useStore.getState().setActiveEnvironmentId(environmentId);
  },
};
