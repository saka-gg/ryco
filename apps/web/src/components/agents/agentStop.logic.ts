/**
 * Rules behind Stop on native agent rows: when it shows, why it can't be used
 * yet, and what a failed stop says.
 */
import type { HostedRpcCapability } from "@ryco/client-runtime/authorization/capabilities";
import type { SavedEnvironmentConnectionState } from "@ryco/client-runtime/connection";
import type { WsConnectionStatus } from "@ryco/client-runtime/rpc";
import type { SubagentStopIdentity } from "@ryco/client-runtime/state/session/subagentStop";
import type { ScopedThreadRef } from "@ryco/contracts";

import { hostedCapabilityCopy } from "~/hostedHub/switchTarget";

/** How long a stop the node accepted may go unconfirmed before Stop is offered again. */
export const STOP_UNCONFIRMED_MS = 20_000;

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

/**
 * What a rejected stop says. The node's classified reasons get agent copy (a
 * stale identity is refused as stop-failed); anything else keeps its message.
 */
export function describeSubagentStopFailure(cause: unknown): string {
  const failure = cause as {
    readonly _tag?: unknown;
    readonly reason?: unknown;
    readonly message?: unknown;
  } | null;
  if (failure?._tag === "OrchestrationStopBackgroundTaskError") {
    switch (failure.reason) {
      case "unsupported":
        return "This provider can't stop a single agent.";
      case "session-not-found":
        return "This agent's session has ended.";
      case "stop-failed":
        return "The agent did not stop. Try again.";
    }
  }
  return typeof failure?.message === "string" && failure.message.trim().length > 0
    ? failure.message
    : "Could not stop this agent.";
}

/** One activation of one task of one thread: a new runtime or attempt is a new stop. */
export function subagentStopKey(
  threadRef: ScopedThreadRef,
  identity: SubagentStopIdentity,
): string {
  return `${threadRef.environmentId}:${threadRef.threadId}:${identity.runtimeSessionId}:${identity.taskId}:${identity.attempt}`;
}
