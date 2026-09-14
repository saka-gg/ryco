import type { EnvironmentId, ServerConfig } from "@ryco/contracts";

import type { InboxEnvironment } from "../inbox/inboxModel";
import type { NodeTrust } from "./nodeTrustModel";

export interface DirectHomeEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: "connecting" | "connected" | "disconnected" | "error";
  readonly role: "client" | "owner" | null;
  readonly threadSettlementSupported?: boolean;
  readonly threadSnoozeSupported?: boolean;
  readonly shellCurrent?: boolean;
  readonly apiAvailable?: boolean;
}

export interface HostedHomeEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly transportStatus:
    | "idle"
    | "requesting-ticket"
    | "connecting"
    | "authenticating"
    | "opening-channel"
    | "online"
    | "reconnecting"
    | "draining"
    | "terminal-failure";
  readonly sessionStatus:
    | "synchronizing"
    | "ready"
    | "stale"
    | "replaying"
    | "delivery-unknown"
    | "closed";
  readonly role: "viewer" | "operator" | "owner" | null;
  readonly threadSettlementSupported?: boolean;
  readonly threadSnoozeSupported?: boolean;
  readonly shellCurrent?: boolean;
  readonly apiAvailable?: boolean;
}

/**
 * A Hub node known from the persisted roster (wave 2 amendment A): rendered
 * even with zero sockets open so cached content has a label, role and
 * last-known presence to hang off. Liveness here is Hub directory presence,
 * never relay-socket state — wave 1 proved the socket does not track node
 * reachability.
 */
export interface CachedHubNodeHomeEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly role: "viewer" | "operator" | "owner";
  readonly revokedAt: number | null;
  readonly presenceOnline: boolean;
  readonly lastHeartbeatAt: number | null;
  readonly lastAuthenticatedAt: number | null;
}

function directState(input: DirectHomeEnvironmentInput): InboxEnvironment["connectionState"] {
  if (input.connectionState === "connected") return "connected";
  if (input.connectionState === "connecting") return "reconnecting";
  return "offline";
}

export function hostedState(
  input: HostedHomeEnvironmentInput,
): InboxEnvironment["connectionState"] {
  if (input.transportStatus === "online" && input.sessionStatus === "ready") {
    return input.role === "viewer" ? "read-only" : "connected";
  }
  if (
    input.transportStatus === "requesting-ticket" ||
    input.transportStatus === "connecting" ||
    input.transportStatus === "authenticating" ||
    input.transportStatus === "opening-channel" ||
    input.transportStatus === "reconnecting" ||
    input.sessionStatus === "synchronizing" ||
    input.sessionStatus === "replaying"
  ) {
    return "reconnecting";
  }
  return "offline";
}

function relativeLastSeen(timestamp: number, now: number): string {
  const deltaMinutes = Math.floor((now - timestamp) / 60_000);
  if (deltaMinutes < 2) return "just now";
  if (deltaMinutes < 60) return `${deltaMinutes}m ago`;
  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h ago`;
  return `${Math.floor(deltaHours / 24)}d ago`;
}

/**
 * The stale row treatment for a cached Hub node, from directory presence.
 * `lastHeartbeatAt === null` does not mean never — only a null
 * `lastAuthenticatedAt` does (same contract caveat the web display documents).
 */
export function cachedHubNodeStaleDetail(
  node: Pick<
    CachedHubNodeHomeEnvironmentInput,
    "presenceOnline" | "lastHeartbeatAt" | "lastAuthenticatedAt"
  >,
  now: number,
): string {
  if (node.presenceOnline) return "Online · cached";
  const lastSeenAt = node.lastHeartbeatAt ?? node.lastAuthenticatedAt;
  if (lastSeenAt === null) return "Offline · cached";
  return `Offline · last seen ${relativeLastSeen(lastSeenAt, now)}`;
}

export function buildHomeEnvironments(input: {
  /** Live node capabilities supersede the Hub directory descriptor. */
  readonly serverConfigs?: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly direct: ReadonlyArray<DirectHomeEnvironmentInput>;
  readonly hosted: ReadonlyArray<HostedHomeEnvironmentInput>;
  readonly cachedHubNodes?: ReadonlyArray<CachedHubNodeHomeEnvironmentInput>;
  /** Environments whose store rows are cache-provenance (no live snapshot yet). */
  readonly cacheProvenanceEnvironmentIds?: ReadonlyArray<EnvironmentId>;
  readonly deliveryUnknownEnvironmentIds?: ReadonlyArray<EnvironmentId>;
  /**
   * Wave 4: per-environment E2EE trust, display only (see `nodeTrustModel.ts`).
   * `null` or absent means this device has no evidence to render a claim from —
   * an unobtainable marker, or no hosted scope at all — and every row is then
   * left unmarked rather than marked unverified.
   */
  readonly trustByEnvironmentId?: ReadonlyMap<string, NodeTrust> | null;
  readonly now?: number;
}): ReadonlyArray<InboxEnvironment> {
  const now = input.now ?? Date.now();
  const cachedIds = new Set(input.cacheProvenanceEnvironmentIds ?? []);
  const deliveryUnknownIds = new Set(input.deliveryUnknownEnvironmentIds ?? []);
  // Staleness is cache provenance alone — never gated on the transport state.
  // Amendment B: relay-socket state provably does not track node reachability,
  // and a dead node's transport can sit in "reconnecting" indefinitely. Rows
  // stay marked until a live snapshot clears the provenance stamp, however
  // hopeful the socket looks.
  const staleFields = (
    environmentId: EnvironmentId,
    detail: string,
  ): Pick<InboxEnvironment, "stale" | "staleDetail"> =>
    cachedIds.has(environmentId) ? { stale: true, staleDetail: detail } : {};

  // Role and trust are ADDITIVE: neither feeds `connectionState`, whose
  // derivation (including the viewer -> "read-only" mapping) is unchanged. A row
  // that carried no role before carries none now — absent, not a default.
  const roleFields = (
    role: NonNullable<InboxEnvironment["role"]> | null,
  ): Pick<InboxEnvironment, "role"> => (role === null ? {} : { role });
  const trustFields = (environmentId: EnvironmentId): Pick<InboxEnvironment, "trust"> => {
    const trust = input.trustByEnvironmentId?.get(environmentId);
    return trust === undefined ? {} : { trust };
  };

  const environments = new Map<EnvironmentId, InboxEnvironment>();
  for (const direct of input.direct) {
    environments.set(direct.environmentId, {
      environmentId: direct.environmentId,
      label: direct.label,
      connectionState: directState(direct),
      threadSettlementSupported:
        input.serverConfigs?.get(direct.environmentId)?.environment.capabilities.threadSettlement ??
        direct.threadSettlementSupported ??
        false,
      threadSnoozeSupported:
        input.serverConfigs?.get(direct.environmentId)?.environment.capabilities.threadSnooze ??
        direct.threadSnoozeSupported ??
        false,
      mutationReady: direct.connectionState === "connected" && (direct.apiAvailable ?? false),
      shellCurrent: direct.shellCurrent ?? false,
      ...roleFields(direct.role),
      ...trustFields(direct.environmentId),
      ...(deliveryUnknownIds.has(direct.environmentId) ? { deliveryUnknown: true } : {}),
      ...staleFields(direct.environmentId, "Offline · cached"),
    });
  }
  for (const node of input.cachedHubNodes ?? []) {
    if (node.revokedAt !== null) continue;
    if (environments.has(node.environmentId)) continue;
    environments.set(node.environmentId, {
      environmentId: node.environmentId,
      label: node.label,
      connectionState: "offline",
      threadSettlementSupported: false,
      mutationReady: false,
      shellCurrent: false,
      ...roleFields(node.role),
      ...trustFields(node.environmentId),
      ...(deliveryUnknownIds.has(node.environmentId) ? { deliveryUnknown: true } : {}),
      ...staleFields(node.environmentId, cachedHubNodeStaleDetail(node, now)),
    });
  }
  for (const hosted of input.hosted) {
    const rosterNode = (input.cachedHubNodes ?? []).find(
      (node) => node.environmentId === hosted.environmentId,
    );
    environments.set(hosted.environmentId, {
      environmentId: hosted.environmentId,
      label: hosted.label,
      connectionState: hostedState(hosted),
      threadSettlementSupported:
        input.serverConfigs?.get(hosted.environmentId)?.environment.capabilities.threadSettlement ??
        hosted.threadSettlementSupported ??
        false,
      threadSnoozeSupported:
        input.serverConfigs?.get(hosted.environmentId)?.environment.capabilities.threadSnooze ??
        hosted.threadSnoozeSupported ??
        false,
      mutationReady:
        hostedState(hosted) === "connected" &&
        hosted.role !== "viewer" &&
        (hosted.apiAvailable ?? false),
      shellCurrent: hosted.shellCurrent ?? false,
      ...(hosted.sessionStatus === "delivery-unknown" ||
      deliveryUnknownIds.has(hosted.environmentId)
        ? { deliveryUnknown: true }
        : {}),
      ...roleFields(hosted.role),
      ...trustFields(hosted.environmentId),
      ...staleFields(
        hosted.environmentId,
        rosterNode ? cachedHubNodeStaleDetail(rosterNode, now) : "Offline · cached",
      ),
    });
  }
  return [...environments.values()];
}
