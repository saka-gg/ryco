import {
  hostedAccountStore,
  hostedHubController,
  hostedHubStore,
  markHostedSessionReady,
  markHostedSessionReplaying,
  reportHostedShellSnapshotFailure,
  setHostedRuntimeConfigurator,
  HOSTED_SESSION_SYNC_FAILURE_MESSAGE,
  type HostedAccountState,
  type HostedHubState,
} from "@ryco/client-runtime/authorization";
import { useStore } from "zustand";
import type { EnvironmentId } from "@ryco/contracts";

import {
  isMobileHostedModeAvailable,
  subscribeMobileHostedModeAvailability,
} from "./runtimeAvailability";
import {
  mobileHostedConnectionsStore,
  type MobileHostedConnectionState,
} from "../connection/hostedConnectionCoordinator";

/**
 * Register the mobile wiring as a lazy configurator rather than running it at
 * import. This is the ONE permitted module-scope call: importing the controller
 * or store for their React bindings must not touch SecureStore, expo-constants,
 * or the device-key module, so suites can mock those adapters.
 *
 * The runtime's configurator seam is synchronous while mobile configuration is
 * async (it must hydrate the selected Hub profile and resolve a hardware key),
 * so this kicks off the single ordered session entry point and lets it settle.
 * Screens call the same function and await the memoized work.
 */
setHostedRuntimeConfigurator(() => {
  void ensureMobileHostedSession();
});

/** Load native hosted adapters only when the configurator or a screen actually starts a session. */
export async function ensureMobileHostedSession(): Promise<void> {
  await (await import("./runtime")).ensureMobileHostedSession();
}

/**
 * First hosted use: the session setup defers the hardware key when no session
 * is stored, so hosted surfaces call this on mount to load it and settle
 * availability. Resolves false when hosted mode is unavailable.
 */
export async function ensureMobileHostedDeviceKey(): Promise<boolean> {
  return await (await import("./runtime")).ensureMobileHostedDeviceKey();
}

export { isMobileHostedModeAvailable, subscribeMobileHostedModeAvailability };

export {
  hostedAccountStore,
  hostedHubController,
  hostedHubStore,
  markHostedSessionReady,
  markHostedSessionReplaying,
  reportHostedShellSnapshotFailure,
  HOSTED_SESSION_SYNC_FAILURE_MESSAGE,
};
export type { HostedAccountState, HostedHubState };

type HostedHubSelector<T> = (state: HostedHubState) => T;

/** React binding for the package-owned hosted lifecycle state. */
export const useHostedHubStore = Object.assign(
  <T>(selector: HostedHubSelector<T>): T =>
    useStore(hostedHubStore as never, selector as never) as T,
  hostedHubStore,
);

type HostedAccountSelector<T> = (state: HostedAccountState) => T;

/**
 * React binding for the package-owned account-management state.
 *
 * A second store on purpose, not a widening of {@link useHostedHubStore}: the
 * relay/session store republishes on every transport transition, and an account
 * screen subscribing to that would re-render on traffic it does not read — while
 * a passkey list read would re-render every relay consumer. The runtime keeps
 * them apart for exactly that reason; the binding preserves it.
 */
export const useHostedAccountStore = Object.assign(
  <T>(selector: HostedAccountSelector<T>): T =>
    useStore(hostedAccountStore as never, selector as never) as T,
  hostedAccountStore,
);

type MobileHostedConnectionsSelector<T> = (state: {
  readonly selectedNodes: ReadonlyArray<MobileHostedConnectionState>;
  readonly deliveryUnknownEnvironmentIds: ReadonlyArray<EnvironmentId>;
}) => T;

/**
 * Wave 3b's selected-node set and per-environment relay/session projection.
 * The package store's singular `selectedNode` remains only the serialized
 * activation/reconnect cursor; mounted UI reads this bounded live set.
 */
export const useMobileHostedConnectionsStore = Object.assign(
  <T>(selector: MobileHostedConnectionsSelector<T>): T =>
    useStore(mobileHostedConnectionsStore as never, selector as never) as T,
  mobileHostedConnectionsStore,
);

export type { MobileHostedConnectionState };
