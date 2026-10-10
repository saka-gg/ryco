import { useEffect, useEffectEvent, useRef } from "react";
import {
  getWsConnectionStatus,
  getWsConnectionUiState,
  setBrowserOnlineStatus,
  type WsConnectionStatus,
  useWsConnectionStatus,
} from "../rpc/wsConnectionState";
import { getPrimaryEnvironmentConnection } from "../environments/runtime";

const FORCED_WS_RECONNECT_DEBOUNCE_MS = 5_000;
type WsAutoReconnectTrigger = "focus" | "online";
export type ConnectionRecoveryOwner = "generic" | "hosted-lifecycle";

export function allowsGenericConnectionRecovery(owner: ConnectionRecoveryOwner): boolean {
  return owner === "generic";
}

export function shouldAutoReconnect(
  status: WsConnectionStatus,
  trigger: WsAutoReconnectTrigger,
): boolean {
  const uiState = getWsConnectionUiState(status);

  if (trigger === "online") {
    return (
      uiState === "offline" ||
      uiState === "reconnecting" ||
      uiState === "error" ||
      status.reconnectPhase === "exhausted"
    );
  }

  return (
    status.online &&
    status.hasConnected &&
    (uiState === "reconnecting" || status.reconnectPhase === "exhausted")
  );
}

export function shouldRestartStalledReconnect(
  status: WsConnectionStatus,
  expectedNextRetryAt: string,
): boolean {
  return (
    status.reconnectPhase === "waiting" &&
    status.nextRetryAt === expectedNextRetryAt &&
    status.online &&
    status.hasConnected
  );
}

/** Recovery is background work; transport diagnostics never create application toasts. */
export function WebSocketConnectionCoordinator({
  recoveryOwner = "generic",
}: {
  readonly recoveryOwner?: ConnectionRecoveryOwner;
}) {
  const genericRecoveryEnabled = allowsGenericConnectionRecovery(recoveryOwner);
  const status = useWsConnectionStatus();
  const lastForcedReconnectAtRef = useRef(0);
  const runReconnect = useEffectEvent(() => {
    if (!genericRecoveryEnabled) return;
    lastForcedReconnectAtRef.current = Date.now();
    void getPrimaryEnvironmentConnection()
      .reconnect()
      .catch((error) => {
        console.warn("Automatic WebSocket reconnect failed", { error });
      });
  });
  const syncBrowserOnlineStatus = useEffectEvent(() => {
    setBrowserOnlineStatus(navigator.onLine !== false);
  });
  const triggerAutoReconnect = useEffectEvent((trigger: WsAutoReconnectTrigger) => {
    const currentStatus =
      trigger === "online" ? setBrowserOnlineStatus(true) : getWsConnectionStatus();

    if (!genericRecoveryEnabled) return;
    if (!shouldAutoReconnect(currentStatus, trigger)) {
      return;
    }
    if (Date.now() - lastForcedReconnectAtRef.current < FORCED_WS_RECONNECT_DEBOUNCE_MS) {
      return;
    }

    runReconnect();
  });

  useEffect(() => {
    const handleOnline = () => {
      triggerAutoReconnect("online");
    };
    const handleFocus = () => {
      triggerAutoReconnect("focus");
    };

    syncBrowserOnlineStatus();
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", syncBrowserOnlineStatus);
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", syncBrowserOnlineStatus);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  useEffect(() => {
    if (
      !genericRecoveryEnabled ||
      status.reconnectPhase !== "waiting" ||
      status.nextRetryAt === null ||
      !status.online ||
      !status.hasConnected
    ) {
      return;
    }

    const nextRetryAt = status.nextRetryAt;
    const timeoutMs = Math.max(0, new Date(nextRetryAt).getTime() - Date.now()) + 1_500;
    const timeoutId = window.setTimeout(() => {
      const currentStatus = getWsConnectionStatus();
      if (!shouldRestartStalledReconnect(currentStatus, nextRetryAt)) {
        return;
      }

      runReconnect();
    }, timeoutMs);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [
    genericRecoveryEnabled,
    status.hasConnected,
    status.nextRetryAt,
    status.online,
    status.reconnectPhase,
  ]);

  return null;
}
