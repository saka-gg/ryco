import type { ServerEventLoopStall } from "@ryco/contracts";

import type { HostedConnectionStatusInput } from "../authorization/connectionStatus.ts";
import type { HostedRelayFailureKind } from "../authorization/types.ts";
import { describeHostFreeze, localClockTime } from "./hostFreeze.ts";

/**
 * nodeRoute - Which part of the way to a node failed, in order: this device,
 * the Hub, the node, then the node's acceptance of this device. Built only from
 * facts clients already hold (browser and selection status, the relay's last
 * failure kind, the directory's presence and last heartbeat), so it never
 * probes, reconnects or changes readiness: it is display only, and the hosted
 * lifecycle owner stays the only one that acts. Port of T3 Code's
 * `connection/diagnosis.ts` hop chain, on Ryco's hops.
 *
 * @module connection/nodeRoute
 */

export type NodeRouteHop = "device" | "hub" | "node" | "access";
export type NodeRouteHopResult = "ok" | "failed" | "unchecked";

export interface NodeRouteDiagnosis {
  /** In route order. A direct route has no Hub hop. */
  readonly hops: ReadonlyArray<{ readonly hop: NodeRouteHop; readonly result: NodeRouteHopResult }>;
  /** Names the failed part, e.g. "Studio is offline since 14:02"; null when nothing failed. */
  readonly headline: string | null;
  /** When the failed hop was last seen working (the node's last heartbeat), else null. */
  readonly since: number | null;
  /** The node's last long freeze (`describeHostFreeze`): a reason, never a hop. */
  readonly freezeNotice: string | null;
}

export interface NodeRouteInput {
  readonly nodeLabel: string;
  readonly via: "hub" | "direct";
  /** The hosted status inputs of this node's connection; null for a direct route. */
  readonly status: HostedConnectionStatusInput | null;
  /** The device's own network state, where the app knows it (a direct route has no browser status). */
  readonly deviceOffline?: boolean;
  /** A direct route's connection is up. Hub routes read it from `status`. */
  readonly directConnected?: boolean;
  /** The Hub directory's presence for the node. */
  readonly presence?: { readonly online: boolean; readonly lastHeartbeatAt: number | null };
  /** The directory marks the node revoked for this account. */
  readonly revoked?: boolean;
  /** The failure the connection is waiting out (`hostedOutageFailure` of its session record). */
  readonly outageFailure?: HostedRelayFailureKind | null;
  readonly lastEventLoopStall?: ServerEventLoopStall | null;
  readonly nowMs: number;
  readonly formatTime?: (ms: number) => string;
}

/** Local midnight of `ms`'s day. */
function startOfLocalDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Calendar days from `then` to `now`, by local dates: a DST night counts as one day. */
function localDaysBetween(then: number, now: number): number {
  return Math.round((startOfLocalDay(now) - startOfLocalDay(then)) / (24 * 60 * 60_000));
}

/**
 * "since 14:02", "since yesterday 14:02" or "for 3 days": how long a node has
 * been gone, from its last heartbeat. Null without one, or one in the future.
 */
export function describeOfflineSince(
  lastHeartbeatAt: number | null | undefined,
  options: { readonly nowMs: number; readonly formatTime?: (ms: number) => string },
): string | null {
  if (lastHeartbeatAt === null || lastHeartbeatAt === undefined) return null;
  if (!Number.isFinite(lastHeartbeatAt) || lastHeartbeatAt > options.nowMs) return null;
  const at = (options.formatTime ?? localClockTime)(lastHeartbeatAt);
  const days = localDaysBetween(lastHeartbeatAt, options.nowMs);
  if (days <= 0) return `since ${at}`;
  if (days === 1) return `since yesterday ${at}`;
  return `for ${days} days`;
}

const HUB_UNREACHABLE: Partial<Record<HostedRelayFailureKind, string>> = {
  network: "Can't reach the Hub",
  dns: "Can't reach the Hub (DNS)",
  tls: "Can't reach the Hub (secure connection failed)",
  authentication: "The Hub did not accept this device's sign-in",
  "session-expired": "The Hub sign-in on this device expired",
  "rate-limited": "The Hub is limiting this device's connections for a moment",
};

interface Located {
  readonly hop: NodeRouteHop;
  readonly headline: string;
  readonly since: number | null;
}

function locate(input: NodeRouteInput): Located | null {
  const node = input.nodeLabel;
  const status = input.status;
  const failure = input.outageFailure ?? null;
  if (input.deviceOffline === true || status?.browserStatus === "offline") {
    return { hop: "device", headline: "This device is offline", since: null };
  }
  // A connection that is up proves the Hub and the node answer, whatever a lagging directory says.
  const up = connected(input);
  // A suspended browser is a hidden page or app, not a Hub that can't be reached.
  if (input.via === "hub" && !up) {
    if (status?.browserStatus === "stale") {
      return { hop: "hub", headline: "Can't reach the Hub", since: null };
    }
    const hub = failure === null ? undefined : HUB_UNREACHABLE[failure];
    if (hub !== undefined) return { hop: "hub", headline: hub, since: null };
  }
  if (!up && input.presence?.online === false) {
    const since = describeOfflineSince(input.presence.lastHeartbeatAt, input);
    return {
      hop: "node",
      headline: since === null ? `${node} is offline` : `${node} is offline ${since}`,
      since: input.presence.lastHeartbeatAt,
    };
  }
  if (!up && (failure === "offline" || status?.selectionStatus === "offline")) {
    return { hop: "node", headline: `${node} is offline`, since: null };
  }
  if (!up && failure === "draining") {
    return { hop: "node", headline: `${node} is restarting`, since: null };
  }
  if (
    input.revoked === true ||
    failure === "revoked" ||
    failure === "authorization-removed" ||
    status?.selectionStatus === "revoked" ||
    status?.selectionStatus === "authorization-removed"
  ) {
    return { hop: "access", headline: `${node} did not accept this device`, since: null };
  }
  if (failure === "incompatible" || status?.selectionStatus === "incompatible") {
    return {
      hop: "access",
      headline: `${node} and this device run Ryco versions that can't connect`,
      since: null,
    };
  }
  return null;
}

/** Whether this node's connection is up: every hop answered. */
function connected(input: NodeRouteInput): boolean {
  if (input.status === null) return input.directConnected === true;
  return input.status.transportStatus === "online" && input.status.sessionStatus === "ready";
}

/** The hop chain for one node's route. Every word comes from bounded inputs: no ids or raw errors. */
export function diagnoseNodeRoute(input: NodeRouteInput): NodeRouteDiagnosis {
  const order: ReadonlyArray<NodeRouteHop> =
    input.via === "hub" ? ["device", "hub", "node", "access"] : ["device", "node", "access"];
  const located = locate(input);
  const freezeNotice = describeHostFreeze(input.lastEventLoopStall, input);
  if (located !== null) {
    const failedAt = order.indexOf(located.hop);
    return {
      hops: order.map((hop, index) => ({
        hop,
        result: index < failedAt ? "ok" : index === failedAt ? "failed" : "unchecked",
      })),
      headline: located.headline,
      since: located.since,
      freezeNotice,
    };
  }
  const up = connected(input);
  return {
    // Nothing failed: a connection still on its way has only shown this device works.
    hops: order.map((hop) => ({ hop, result: up || hop === "device" ? "ok" : "unchecked" })),
    headline: null,
    since: null,
    freezeNotice,
  };
}
