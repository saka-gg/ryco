import { useAtomValue } from "@effect/atom-react";
import {
  getWsConnectionUiState,
  seedWsConnectionOnlineStatus,
  wsConnectionOpenedCountAtom,
  wsConnectionStatusAtom,
  wsConnectionStatusForEnvironmentAtom,
  wsConnectionStatusesForEnvironmentsAtom,
  type WsConnectionStatus,
  type WsConnectionUiState,
} from "@ryco/client-runtime/rpc";
import type { EnvironmentId } from "@ryco/contracts";

import { mobileAppLifecycle } from "../platform";

export * from "@ryco/client-runtime/rpc";

// Seed the runtime's online-status atom from the RN AppLifecycle adapter. Called
// from the bootstrap, not at import time.
export function initializeWsConnectionState(): void {
  seedWsConnectionOnlineStatus(mobileAppLifecycle);
}

export function useWsConnectionStatus(): WsConnectionStatus {
  return useAtomValue(wsConnectionStatusAtom);
}

/** This environment's own socket status — never another node's last write. */
export function useWsConnectionStatusForEnvironment(
  environmentId: EnvironmentId,
): WsConnectionStatus {
  return useAtomValue(wsConnectionStatusForEnvironmentAtom(environmentId));
}

/**
 * Each listed environment's own socket status, re-rendering when any of them
 * changes. Per-node rows read their status from here: a
 * `getWsConnectionStatusForEnvironment` call in render is cached by React
 * Compiler on the row inputs and never sees the node drop.
 */
export function useWsConnectionStatusesForEnvironments(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyMap<EnvironmentId, WsConnectionStatus> {
  return useAtomValue(wsConnectionStatusesForEnvironmentsAtom(environmentIds));
}

export function useWsConnectionOpenedCount(): number {
  return useAtomValue(wsConnectionOpenedCountAtom);
}

/**
 * UI state for one environment's slot with the device-level online signal
 * overlaid. A keyed slot's `online: false` is inert in getWsConnectionUiState
 * unless that socket also recorded a disconnect, so an environment that never
 * attempted a connection (or whose slot was cleared on dispose) would read
 * "connecting" in airplane mode. Device-level connectivity outranks per-socket
 * phase for everything except a live socket. The slot's own `online` is the
 * device-level flag: a slot is seeded from the global and
 * setBrowserOnlineStatus writes every slot. Reading it from the slot keeps this
 * a pure function of its argument, so a compiled caller that caches it on the
 * subscribed status still sees the device go offline.
 */
export function wsUiStateForEnvironment(status: WsConnectionStatus): WsConnectionUiState {
  const uiState = getWsConnectionUiState(status);
  if (uiState === "connected") return uiState;
  return status.online ? uiState : "offline";
}
