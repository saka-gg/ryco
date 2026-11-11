import type { SavedEnvironmentConnectionState } from "@ryco/client-runtime/connection";
import {
  isSavedEnvironmentOutOfReach,
  type SavedEnvironmentFailureKind,
} from "@ryco/client-runtime/connection/connectFailure";
import type { WsConnectionUiState } from "@ryco/client-runtime/rpc";

import type { StatusTone } from "../../components/StatusPill";

// §3-26: status tone for a saved environment. Upstream keyed this on
// RemoteClientConnectionState (absent in runtime A); here it is keyed on the
// per-env SavedEnvironmentConnectionState with the single-socket WsConnectionUiState
// overlaid for the reconnecting/offline states that per-env state lacks.
export type ConnectionToneState =
  | "connected"
  | "connecting"
  | "reconnecting"
  | "error"
  | "offline"
  | "disconnected"
  | "switched-off";

export function resolveConnectionTone(state: ConnectionToneState): StatusTone {
  switch (state) {
    case "connected":
      return {
        label: "Connected",
        pillClassName: "bg-success-bg border border-success-border",
        textClassName: "text-success",
      };
    case "connecting":
      return {
        label: "Connecting",
        pillClassName: "bg-accent-bg border border-accent-border",
        textClassName: "text-accent-strong",
      };
    case "error":
      return {
        label: "Connection failed",
        pillClassName: "bg-danger border border-danger-border",
        textClassName: "text-danger-foreground",
      };
    case "reconnecting":
    case "offline":
      return {
        label: "Offline",
        pillClassName: "bg-subtle",
        textClassName: "text-foreground-muted",
      };
    case "disconnected":
      return {
        label: "Disconnected",
        pillClassName: "bg-subtle",
        textClassName: "text-foreground-muted",
      };
    case "switched-off":
      return {
        label: "Switched off",
        pillClassName: "bg-subtle",
        textClassName: "text-foreground-muted",
      };
  }
}

/**
 * A machine out of reach (off, asleep, on another network) is offline, not a
 * failed connection: it reads "Offline" while it fails and while the backoff
 * tries it again (`failureKind` is kept until a connect lands), so a dead
 * machine does not flash between connecting and failed on every retry.
 */
export function connectionToneForEnvironment(
  connectionState: SavedEnvironmentConnectionState,
  wsUiState: WsConnectionUiState,
  failureKind?: SavedEnvironmentFailureKind | null,
): StatusTone {
  if (wsUiState === "offline") return resolveConnectionTone("offline");
  if (
    (connectionState === "error" || connectionState === "connecting") &&
    isSavedEnvironmentOutOfReach(failureKind)
  ) {
    return resolveConnectionTone("offline");
  }
  if (wsUiState === "reconnecting" && connectionState === "connected") {
    return resolveConnectionTone("reconnecting");
  }
  return resolveConnectionTone(connectionState);
}
