import type { EnvironmentId } from "@ryco/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  seedWsConnectionOnlineStatus,
  wsConnectionStatusAtom,
  wsConnectionStatusForEnvironmentAtom,
  wsConnectionOpenedCountAtom,
  type WsConnectionStatus,
} from "@ryco/client-runtime/rpc";

import { webAppLifecycle } from "../platform";

export * from "@ryco/client-runtime/rpc";

export function initializeWsConnectionState(): void {
  seedWsConnectionOnlineStatus(webAppLifecycle);
}

export function useWsConnectionStatus(): WsConnectionStatus {
  return useAtomValue(wsConnectionStatusAtom);
}

export function useWsConnectionOpenedCount(): number {
  return useAtomValue(wsConnectionOpenedCountAtom);
}

export function useWsConnectionStatusForEnvironment(
  environmentId: EnvironmentId,
): WsConnectionStatus {
  return useAtomValue(wsConnectionStatusForEnvironmentAtom(environmentId));
}
