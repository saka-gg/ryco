import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentId, ServerConfig } from "@ryco/contracts";

import type { InboxEnvironment } from "../inbox/inboxModel";
import { buildHomeEnvironments } from "./homeEnvironmentModel";
import type { NodeTrust } from "./nodeTrustModel";

describe("Home environments", () => {
  it("maps direct and hosted readiness into bounded presentation state", () => {
    const environments = buildHomeEnvironments({
      direct: [
        {
          environmentId: "direct-a" as EnvironmentId,
          label: "MacBook",
          connectionState: "connecting",
          role: "owner",
        },
      ],
      hosted: [
        {
          environmentId: "hosted-a" as EnvironmentId,
          label: "Studio",
          transportStatus: "online",
          sessionStatus: "ready",
          role: "viewer",
        },
      ],
    });

    expect(environments).toMatchObject([
      {
        environmentId: "direct-a",
        label: "MacBook",
        connectionState: "reconnecting",
        role: "owner",
      },
      {
        environmentId: "hosted-a",
        label: "Studio",
        connectionState: "read-only",
        role: "viewer",
      },
    ]);
  });

  it("uses the selected Hub node as the current label for a shared environment id", () => {
    const environmentId = "node-a" as EnvironmentId;
    const environments = buildHomeEnvironments({
      direct: [
        {
          environmentId,
          label: "LAN address",
          connectionState: "connected",
          role: "owner",
        },
      ],
      hosted: [
        {
          environmentId,
          label: "Studio",
          transportStatus: "reconnecting",
          sessionStatus: "stale",
          role: "owner",
        },
      ],
    });

    expect(environments).toMatchObject([
      {
        environmentId,
        label: "Studio",
        connectionState: "reconnecting",
        role: "owner",
      },
    ]);
  });

  it("projects several live hosted environments without a global selected-node row", () => {
    const environments = buildHomeEnvironments({
      direct: [],
      hosted: [
        {
          environmentId: "hosted-a" as EnvironmentId,
          label: "Studio",
          transportStatus: "online",
          sessionStatus: "ready",
          role: "owner",
        },
        {
          environmentId: "hosted-b" as EnvironmentId,
          label: "Laptop",
          transportStatus: "online",
          sessionStatus: "delivery-unknown",
          role: "operator",
        },
      ],
    });

    expect(environments.map((environment) => environment.environmentId)).toEqual([
      "hosted-a",
      "hosted-b",
    ]);
    expect(environments[0]?.deliveryUnknown).toBeUndefined();
    expect(environments[1]?.deliveryUnknown).toBe(true);
  });

  it("renders every cached Hub roster node with presence-derived stale detail", () => {
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const environments = buildHomeEnvironments({
      direct: [],
      hosted: [],
      cachedHubNodes: [
        {
          environmentId: "node-a" as EnvironmentId,
          label: "Work Mac",
          role: "operator",
          revokedAt: null,
          presenceOnline: false,
          lastHeartbeatAt: now - 2 * 60 * 60 * 1000,
          lastAuthenticatedAt: now - 3 * 60 * 60 * 1000,
        },
        {
          environmentId: "node-b" as EnvironmentId,
          label: "Build node",
          role: "owner",
          revokedAt: null,
          presenceOnline: true,
          lastHeartbeatAt: now,
          lastAuthenticatedAt: now,
        },
        {
          environmentId: "node-c" as EnvironmentId,
          label: "Revoked node",
          role: "viewer",
          revokedAt: 1,
          presenceOnline: false,
          lastHeartbeatAt: null,
          lastAuthenticatedAt: null,
        },
      ],
      cacheProvenanceEnvironmentIds: ["node-a" as EnvironmentId, "node-b" as EnvironmentId],
      now,
    });

    expect(environments).toMatchObject([
      {
        environmentId: "node-a",
        label: "Work Mac",
        connectionState: "offline",
        role: "operator",
        stale: true,
        staleDetail: "Offline · last seen 2h ago",
      },
      {
        environmentId: "node-b",
        label: "Build node",
        connectionState: "offline",
        role: "owner",
        stale: true,
        staleDetail: "Online · cached",
      },
    ]);
  });

  it("marks an offline direct environment with cached rows as stale", () => {
    const environments = buildHomeEnvironments({
      direct: [
        {
          environmentId: "direct-a" as EnvironmentId,
          label: "LAN Mac",
          connectionState: "disconnected",
          role: "owner",
        },
      ],
      hosted: [],
      cacheProvenanceEnvironmentIds: ["direct-a" as EnvironmentId],
      now: 0,
    });
    expect(environments[0]).toMatchObject({
      connectionState: "offline",
      stale: true,
      staleDetail: "Offline · cached",
    });
  });

  it("keeps cache-provenance rows stale whatever the transport claims (amendment B)", () => {
    // A dead node's transport can sit in "reconnecting" indefinitely — the
    // socket state must never lift the stale treatment; only a live snapshot
    // (which clears the provenance stamp) does.
    const now = Date.parse("2026-08-20T12:00:00.000Z");
    const environments = buildHomeEnvironments({
      direct: [
        {
          environmentId: "direct-a" as EnvironmentId,
          label: "LAN Mac",
          connectionState: "connected",
          role: "owner",
        },
      ],
      hosted: [
        {
          environmentId: "node-a" as EnvironmentId,
          label: "Work Mac",
          transportStatus: "reconnecting",
          sessionStatus: "synchronizing",
          role: "owner",
        },
      ],
      cachedHubNodes: [
        {
          environmentId: "node-a" as EnvironmentId,
          label: "Work Mac",
          role: "owner",
          revokedAt: null,
          presenceOnline: false,
          lastHeartbeatAt: now - 60 * 60 * 1000,
          lastAuthenticatedAt: null,
        },
      ],
      cacheProvenanceEnvironmentIds: ["direct-a" as EnvironmentId, "node-a" as EnvironmentId],
      now,
    });
    expect(environments).toMatchObject([
      expect.objectContaining({
        environmentId: "direct-a",
        connectionState: "connected",
        stale: true,
      }),
      expect.objectContaining({
        environmentId: "node-a",
        connectionState: "reconnecting",
        stale: true,
        staleDetail: "Offline · last seen 1h ago",
      }),
    ]);
  });

  it("drops the stale treatment once the environment is no longer cache-provenance", () => {
    const environments = buildHomeEnvironments({
      direct: [
        {
          environmentId: "direct-a" as EnvironmentId,
          label: "LAN Mac",
          connectionState: "connected",
          role: "owner",
        },
      ],
      hosted: [],
      cacheProvenanceEnvironmentIds: [],
      now: 0,
    });
    expect(environments[0]?.stale).toBeUndefined();
  });
});

describe("Home environment provenance (wave 4)", () => {
  const ROSTER_ONLY = "roster-a" as EnvironmentId;
  const DIRECT = "direct-a" as EnvironmentId;
  const HOSTED = "hosted-a" as EnvironmentId;

  function provenanceFixture(
    trustByEnvironmentId?: ReadonlyMap<string, NodeTrust> | null,
  ): ReadonlyArray<InboxEnvironment> {
    return buildHomeEnvironments({
      direct: [
        {
          environmentId: DIRECT,
          label: "LAN Mac",
          connectionState: "disconnected",
          role: "client",
        },
      ],
      hosted: [
        {
          environmentId: HOSTED,
          label: "Studio",
          transportStatus: "online",
          sessionStatus: "ready",
          role: "operator",
        },
      ],
      cachedHubNodes: [
        {
          environmentId: ROSTER_ONLY,
          label: "Build node",
          role: "viewer",
          revokedAt: null,
          presenceOnline: true,
          lastHeartbeatAt: 0,
          lastAuthenticatedAt: 0,
        },
      ],
      cacheProvenanceEnvironmentIds: [DIRECT, ROSTER_ONLY],
      ...(trustByEnvironmentId === undefined ? {} : { trustByEnvironmentId }),
      now: 0,
    });
  }

  it("threads the effective role from the direct, roster, and hosted planes", () => {
    const byId = new Map(
      provenanceFixture().map((environment) => [environment.environmentId, environment] as const),
    );

    expect(byId.get(DIRECT)?.role).toBe("client");
    expect(byId.get(ROSTER_ONLY)?.role).toBe("viewer");
    expect(byId.get(HOSTED)?.role).toBe("operator");
  });

  it("leaves the role absent when the plane reports none", () => {
    const environments = buildHomeEnvironments({
      direct: [
        {
          environmentId: DIRECT,
          label: "LAN Mac",
          connectionState: "connected",
          role: null,
        },
      ],
      hosted: [
        {
          environmentId: HOSTED,
          label: "Studio",
          transportStatus: "online",
          sessionStatus: "ready",
          role: null,
        },
      ],
    });

    expect(environments[0]).not.toHaveProperty("role");
    expect(environments[1]).not.toHaveProperty("role");
  });

  it("threads trust from the map and leaves unlisted environments unmarked", () => {
    const byId = new Map(
      provenanceFixture(
        new Map<string, NodeTrust>([
          [DIRECT, "verified"],
          [ROSTER_ONLY, "unverified"],
        ]),
      ).map((environment) => [environment.environmentId, environment] as const),
    );

    expect(byId.get(DIRECT)?.trust).toBe("verified");
    expect(byId.get(ROSTER_ONLY)?.trust).toBe("unverified");
    // Present in the fixture, absent from the map: no claim, not "unverified".
    expect(byId.get(HOSTED)).not.toHaveProperty("trust");
  });

  it("makes no trust claim at all when the map is null or absent", () => {
    for (const environments of [provenanceFixture(null), provenanceFixture()]) {
      for (const environment of environments) {
        expect(environment).not.toHaveProperty("trust");
      }
    }
  });

  it("leaves every pre-existing field byte-identical when provenance arrives", () => {
    // Role and trust are additive. In particular the hosted viewer's
    // "read-only" connectionState is derived exactly as before, and wave 2's
    // staleness text is untouched.
    const strip = (environments: ReadonlyArray<InboxEnvironment>) =>
      environments.map(
        ({
          role: _role,
          trust: _trust,
          threadSettlementSupported: _threadSettlementSupported,
          threadSnoozeSupported: _threadSnoozeSupported,
          mutationReady: _mutationReady,
          shellCurrent: _shellCurrent,
          ...rest
        }) => rest,
      );

    const withTrust = provenanceFixture(new Map<string, NodeTrust>([[HOSTED, "unverified"]]));
    expect(strip(withTrust)).toEqual(strip(provenanceFixture(null)));
    expect(strip(withTrust)).toEqual([
      {
        environmentId: DIRECT,
        label: "LAN Mac",
        connectionState: "offline",
        stale: true,
        staleDetail: "Offline · cached",
      },
      {
        environmentId: ROSTER_ONLY,
        label: "Build node",
        connectionState: "offline",
        stale: true,
        staleDetail: "Online · cached",
      },
      { environmentId: HOSTED, label: "Studio", connectionState: "connected" },
    ]);
  });
});

it("uses live node capabilities over stale Hub directory defaults without granting mutation readiness", () => {
  const environmentId = "hosted" as EnvironmentId;
  const hosted = [
    {
      environmentId,
      label: "Mac",
      transportStatus: "online" as const,
      sessionStatus: "ready" as const,
      role: "viewer" as const,
      threadSettlementSupported: false,
      threadSnoozeSupported: false,
      shellCurrent: true,
      apiAvailable: true,
    },
  ];
  const serverConfigs = new Map([
    [
      environmentId,
      {
        environment: { capabilities: { threadSettlement: true, threadSnooze: true } },
      } as ServerConfig,
    ],
  ]);
  expect(buildHomeEnvironments({ direct: [], hosted })[0]?.threadSettlementSupported).toBe(false);
  expect(buildHomeEnvironments({ direct: [], hosted, serverConfigs })[0]).toMatchObject({
    threadSettlementSupported: true,
    threadSnoozeSupported: true,
    mutationReady: false,
    connectionState: "read-only",
  });
});
