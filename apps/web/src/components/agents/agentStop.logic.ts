/**
 * Rules behind Stop on native agent rows: when it shows and why it can't be
 * used yet. What a failed stop says, the stop's key and how long it may go
 * unconfirmed are shared with the phone (`@ryco/client-runtime/state/session/subagentStop`).
 */
import type { HostedRpcCapability } from "@ryco/client-runtime/authorization/capabilities";
import type { SavedEnvironmentConnectionState } from "@ryco/client-runtime/connection";
import type { WsConnectionStatus } from "@ryco/client-runtime/rpc";

import { hostedCapabilityCopy } from "~/hostedHub/switchTarget";

const NOT_CONNECTED_REASON = "Not connected to this environment.";
const CONNECTION_REFUSES_REASON = "Stopping agents is unavailable on this connection.";

/**
 * Whether requests reach an environment now: its socket is connected and, for
 * a saved environment other than the primary one, so is its saved connection.
 * The same rule the chat view applies before it stops background work.
 */
export function isEnvironmentReachable(input: {
  readonly savedEnvironment: boolean;
  readonly savedConnectionState: SavedEnvironmentConnectionState | null;
  readonly wsPhase: WsConnectionStatus["phase"];
}): boolean {
  return (
    input.wsPhase === "connected" &&
    (!input.savedEnvironment || input.savedConnectionState === "connected")
  );
}

/** Why the hosted connection refuses a stop right now, or null when it takes one. */
export function subagentStopRefusal(
  capability: HostedRpcCapability,
  nodeLabel: string | null,
): string | null {
  if (capability.allowed) return null;
  return hostedCapabilityCopy(capability, nodeLabel) ?? CONNECTION_REFUSES_REASON;
}

/**
 * Whether agent rows offer Stop, and why it can't be used yet. A role that may
 * not stop agents never will, so Stop is hidden; a connection that is not
 * ready only disables it, with the reason.
 */
export function resolveSubagentStopAvailability(input: {
  readonly capability: HostedRpcCapability;
  readonly nodeLabel: string | null;
  readonly reachable: boolean;
}): "hidden" | { readonly unavailableReason: string | null } {
  if (input.capability.kind === "role") return "hidden";
  return {
    unavailableReason:
      subagentStopRefusal(input.capability, input.nodeLabel) ??
      (input.reachable ? null : NOT_CONNECTED_REASON),
  };
}
