import {
  resolveEnvironmentThreadCapabilities,
  type EnvironmentThreadCapabilities,
  type ReportedThreadCapabilities,
} from "@ryco/client-runtime/rpc";
import type { EnvironmentId, ExecutionEnvironmentCapabilities } from "@ryco/contracts";
import type { SidebarAutoSettleAfterDays } from "@ryco/contracts/settings";

import type { InboxEnvironment } from "../inbox/inboxModel";
import type { NodeTrust } from "./nodeTrustModel";

export interface DirectHomeEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connectionState: "connecting" | "connected" | "disconnected" | "error";
  readonly role: "client" | "owner" | null;
  /** The capabilities in the descriptor the node sent, once it sent one. */
  readonly descriptorCapabilities?: Pick<
    ExecutionEnvironmentCapabilities,
    "threadSettlement" | "threadSnooze"
  > | null;
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

/**
 * The clock a cached Hub node's "last seen" text is computed against: the
 * screen's ticking clock at the minute precision the text shows, so the list
 * re-derives at most once a minute. `undefined` (read the wall clock while
 * building) when there is no ticking clock or no cached Hub node to describe.
 */
export function homeLastSeenClock(
  nowMs: number | undefined,
  cachedHubNodeCount: number,
): number | undefined {
  if (nowMs === undefined || cachedHubNodeCount === 0) return undefined;
  return Math.floor(nowMs / 60_000) * 60_000;
}

function capabilityFields(
  capabilities: EnvironmentThreadCapabilities,
): Pick<
  InboxEnvironment,
  "threadSettlementSupported" | "threadSnoozeSupported" | "autoSettleAfterDays"
> {
  return {
    threadSettlementSupported: capabilities.threadSettlement,
    threadSnoozeSupported: capabilities.threadSnooze,
    ...(capabilities.autoSettleAfterDays === undefined
      ? {}
      : { autoSettleAfterDays: capabilities.autoSettleAfterDays }),
  };
}

export function buildHomeEnvironments(input: {
  /**
   * What each node reported to this client (`getReportedThreadCapabilitiesSnapshot`).
   * Every environment's thread capabilities resolve from it first, the same
   * way on every client; a Hub node it has no answer for is unknown.
   */
  readonly reportedThreadCapabilities?: ReadonlyMap<EnvironmentId, ReportedThreadCapabilities>;
  /** The auto-settle rules shell snapshots carried (`getShellSettlementRulesSnapshot`). */
  readonly shellSettlementRules?: ReadonlyMap<EnvironmentId, SidebarAutoSettleAfterDays>;
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

  const reported = input.reportedThreadCapabilities ?? new Map();
  const shellSettlementRules = input.shellSettlementRules ?? new Map();
  const environments = new Map<EnvironmentId, InboxEnvironment>();
  for (const direct of input.direct) {
    environments.set(direct.environmentId, {
      environmentId: direct.environmentId,
      label: direct.label,
      connectionState: directState(direct),
      ...capabilityFields(
        resolveEnvironmentThreadCapabilities(direct.environmentId, {
          reported,
          shellSettlementRules,
          descriptor: direct.descriptorCapabilities,
        }),
      ),
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
      ...capabilityFields(
        resolveEnvironmentThreadCapabilities(node.environmentId, {
          reported,
          shellSettlementRules,
        }),
      ),
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
      // The Hub directory states no thread capabilities, and the selected
      // node's descriptor is a placeholder built from it: only the node's own
      // answer counts.
      ...capabilityFields(
        resolveEnvironmentThreadCapabilities(hosted.environmentId, {
          reported,
          shellSettlementRules,
        }),
      ),
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

/**
 * Whether each environment's shell is current — the one per-environment fact
 * Home reads from the threads store. Selected as a flat map compared shallowly:
 * `environmentStateById` itself gets a new identity on every shell and
 * orchestration event, and subscribing to it rebuilt the whole Home model on
 * each one.
 */
export function selectShellCurrentByEnvironmentId(state: {
  readonly environmentStateById: Readonly<
    Record<string, { readonly bootstrapComplete?: boolean } | undefined>
  >;
}): Readonly<Record<string, boolean>> {
  const shellCurrent: Record<string, boolean> = {};
  for (const [environmentId, environmentState] of Object.entries(state.environmentStateById)) {
    shellCurrent[environmentId] = environmentState?.bootstrapComplete === true;
  }
  return shellCurrent;
}
