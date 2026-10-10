import type { SavedEnvironmentConnectionState } from "@ryco/client-runtime/connection";
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
  | "disconnected";

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
  }
}

export function connectionToneForEnvironment(
  connectionState: SavedEnvironmentConnectionState,
  wsUiState: WsConnectionUiState,
): StatusTone {
  if (wsUiState === "offline") return resolveConnectionTone("offline");
  if (wsUiState === "reconnecting" && connectionState === "connected") {
    return resolveConnectionTone("reconnecting");
  }
  return resolveConnectionTone(connectionState);
}
