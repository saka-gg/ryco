import type { HostedRpcCapability } from "../../authorization/capabilities.ts";
import type { SavedEnvironmentRuntimeState } from "../../connection/catalog.ts";

/**
 * Whether to ask a node for its recap now, from what this client already
 * knows about its session: `ask`; `pending` while the session is still being
 * set up, so the node is waited for and not reported; or the status to report
 * without asking, because the request could only wait out the deadline or be
 * refused.
 */
export type DailyRecapReadiness = "ask" | "pending" | "offline" | "forbidden";

/** A hosted node, from its own session's capability for the recap method. */
export function hostedDailyRecapReadiness(capability: HostedRpcCapability): DailyRecapReadiness {
  if (capability.allowed) return "ask";
  switch (capability.kind) {
    case "role":
      return "forbidden";
    case "establishing":
      return "pending";
    default:
      return "offline";
  }
}

/**
 * A saved node, from its connection's runtime state; undefined before the
 * connection reports any. The recap is owner-only, so a `client` pairing is
 * refused. Only its first connection is waited for: a node that dropped stays
 * offline through its reconnect attempts, which a sleeping machine repeats on
 * a backoff, instead of blinking between offline and pending on each one.
 */
export function savedDailyRecapReadiness(
  runtime: SavedEnvironmentRuntimeState | undefined,
): DailyRecapReadiness {
  if (runtime?.role === "client") return "forbidden";
  switch (runtime?.connectionState) {
    case "connected":
      return "ask";
    case "disconnected":
    case "error":
      return "offline";
    case "connecting":
      return runtime.disconnectedAt === null ? "pending" : "offline";
    default:
      return "pending";
  }
}
