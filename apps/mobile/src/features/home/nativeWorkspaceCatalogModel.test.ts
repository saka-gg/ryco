import type {
  HostedRelayTransportStatus,
  HostedRycoSessionStatus,
} from "@ryco/client-runtime/authorization";
import { hostedSessionConnectionState } from "@ryco/client-runtime/state/workspace";
import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MobileHostedConnectionState } from "../../connection/hostedConnectionCoordinator";
import type { CachedHubNodeRecord } from "../../hostedHub/nodeRoster";
import { buildMobileNativeWorkspaceCatalog } from "./nativeWorkspaceCatalogModel";

function node(
  environmentId: string,
  role: "viewer" | "operator" = "operator",
): CachedHubNodeRecord {
  return {
    nodeId: `node-${environmentId}`,
    environmentId: EnvironmentId.make(environmentId),
    label: environmentId,
    effectiveRole: role,
    revokedAt: null,
    presenceOnline: true,
    lastHeartbeatAt: 1,
    lastAuthenticatedAt: 1,
    observedAt: 2,
  };
}

function connection(
  environmentId: string,
  overrides: Partial<MobileHostedConnectionState> = {},
): MobileHostedConnectionState {
  return {
    environmentId: EnvironmentId.make(environmentId),
    nodeId: `node-${environmentId}`,
    label: environmentId,
    generation: 1,
    lastAccessedAt: 1,
    transportStatus: "online",
    sessionStatus: "ready",
    effectiveRole: "operator",
    attemptPrepared: true,
    sessionEstablished: true,
    sessionRecoveredAfterUnknown: false,
    errorMessage: null,
    ...overrides,
  };
}

const TRANSPORT_STATUSES: ReadonlyArray<HostedRelayTransportStatus> = [
  "idle",
  "requesting-ticket",
  "connecting",
  "authenticating",
  "opening-channel",
  "online",
  "reconnecting",
  "draining",
  "terminal-failure",
];

const SESSION_STATUSES: ReadonlyArray<HostedRycoSessionStatus> = [
  "synchronizing",
  "ready",
  "stale",
  "replaying",
  "delivery-unknown",
  "closed",
];

function onlyEntry(input: Parameters<typeof buildMobileNativeWorkspaceCatalog>[0]) {
  const [entry, ...rest] = buildMobileNativeWorkspaceCatalog(input);
  if (!entry || rest.length > 0) throw new Error("expected exactly one catalog entry");
  return entry;
}

describe("Mobile native workspace catalog adapter", () => {
  it("feeds durable trust into shared eligibility and locked-stale policy", () => {
    const catalog = buildMobileNativeWorkspaceCatalog({
      nodes: [node("verified"), node("pending"), node("conflict"), node("viewer", "viewer")],
      connections: [],
      trustByEnvironmentId: new Map([
        ["verified", "verified"],
        ["pending", "unverified"],
        ["conflict", "identity-conflict"],
        ["viewer", "verified"],
      ]),
    });
    const byId = new Map(catalog.map((entry) => [entry.environmentId, entry] as const));
    expect(byId.get(EnvironmentId.make("verified"))).toMatchObject({
      canReadMetadata: true,
      cacheDisposition: "available",
    });
    expect(byId.get(EnvironmentId.make("pending"))).toMatchObject({
      canReadMetadata: false,
      cacheDisposition: "purge",
    });
    expect(byId.get(EnvironmentId.make("conflict"))).toMatchObject({
      canReadMetadata: false,
      canMutate: false,
      cacheDisposition: "locked-stale",
    });
    expect(byId.get(EnvironmentId.make("viewer"))).toMatchObject({
      canReadMetadata: true,
      canMutate: false,
      accessReasons: expect.arrayContaining(["viewer"]),
    });
  });

  it("derives every connection state with the shared rule", () => {
    for (const transportStatus of TRANSPORT_STATUSES) {
      for (const sessionStatus of SESSION_STATUSES) {
        const entry = onlyEntry({
          nodes: [node("a")],
          connections: [connection("a", { transportStatus, sessionStatus })],
          trustByEnvironmentId: new Map([["a", "verified"]]),
        });
        expect(entry.connectionState, `${transportStatus} / ${sessionStatus}`).toBe(
          hostedSessionConnectionState({ transportStatus, sessionStatus }),
        );
      }
    }
  });

  it("reports a node without a hosted session as disconnected", () => {
    const entry = onlyEntry({
      nodes: [node("a")],
      connections: [connection("b")],
      trustByEnvironmentId: new Map([["a", "verified"]]),
    });
    expect(entry.connectionState).toBe(hostedSessionConnectionState(null));
    expect(entry.connectionState).toBe("disconnected");
  });

  it("takes the session's role over the roster's and keeps presence from the roster", () => {
    const entry = onlyEntry({
      nodes: [{ ...node("a", "viewer"), presenceOnline: false, lastHeartbeatAt: 7 }],
      connections: [connection("a", { effectiveRole: "owner" })],
      trustByEnvironmentId: new Map([["a", "verified"]]),
    });
    expect(entry).toMatchObject({
      effectiveRole: "owner",
      presence: { online: false, lastSeenAt: 7, observedAt: 2 },
    });
    const withoutRole = onlyEntry({
      nodes: [node("a", "viewer")],
      connections: [connection("a", { effectiveRole: null })],
      trustByEnvironmentId: new Map([["a", "verified"]]),
    });
    expect(withoutRole.effectiveRole).toBe("viewer");
  });

  it("falls back to the last authentication when the roster has no heartbeat", () => {
    const entry = onlyEntry({
      nodes: [{ ...node("a"), lastHeartbeatAt: null, lastAuthenticatedAt: 5 }],
      connections: [],
      trustByEnvironmentId: new Map([["a", "verified"]]),
    });
    expect(entry.presence.lastSeenAt).toBe(5);
  });

  it("marks delivery unknown from the session or the coordinator's uncertain set", () => {
    const trust = new Map([["a", "verified" as const]]);
    expect(
      onlyEntry({
        nodes: [node("a")],
        connections: [connection("a", { sessionStatus: "delivery-unknown" })],
        trustByEnvironmentId: trust,
      }).deliveryUnknown,
    ).toBe(true);
    expect(
      onlyEntry({
        nodes: [node("a")],
        connections: [],
        trustByEnvironmentId: trust,
        deliveryUnknownEnvironmentIds: [EnvironmentId.make("a")],
      }).deliveryUnknown,
    ).toBe(true);
    expect(
      onlyEntry({
        nodes: [node("a")],
        connections: [connection("a")],
        trustByEnvironmentId: trust,
      }).deliveryUnknown,
    ).toBe(false);
  });

  it("keeps a revoked roster node revoked whatever its session says", () => {
    const entry = onlyEntry({
      nodes: [{ ...node("a"), revokedAt: 9 }],
      connections: [connection("a")],
      trustByEnvironmentId: new Map([["a", "verified"]]),
    });
    expect(entry).toMatchObject({
      revokedAt: 9,
      canReadMetadata: false,
      cacheDisposition: "purge",
      connectionState: "connected",
    });
  });

  // The roster carries no capabilities or machine details, so the shared
  // defaults apply: repository identity is now assumed (it was absent before),
  // and settlement and the native-client requirement are not. Platform and
  // server version stay unknown.
  it("applies the shared capability defaults to a roster node (repository identity now assumed)", () => {
    const entry = onlyEntry({
      nodes: [node("a")],
      connections: [],
      trustByEnvironmentId: new Map([["a", "verified"]]),
    });
    expect(entry).toMatchObject({
      platform: { os: "unknown", arch: "other" },
      serverVersion: null,
      capabilities: {
        repositoryIdentity: true,
        nativeClientRequired: false,
      },
      removed: false,
    });
    // The roster records no settlement capability: unknown, not unsupported.
    expect(entry.capabilities).not.toHaveProperty("threadSettlement");
  });
});
