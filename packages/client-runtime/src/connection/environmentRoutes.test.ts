import { EnvironmentId, type AdvertisedEndpoint } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { SavedEnvironmentRecord } from "./catalog.ts";

import {
  BETTER_ROUTE_CHECK_INTERVAL_MS,
  BETTER_ROUTE_HOLDBACK_MS,
  INITIAL_BETTER_ROUTE_STATE,
  RELAY_ROUTE,
  checkEnvironmentRoutes,
  directRouteAuthenticatesMachine,
  directRoutesFromEndpoints,
  environmentRouteKey,
  linkedDirectRoutes,
  mergeLearnedRoutes,
  orderEnvironmentRoutes,
  planBetterRouteCheck,
  recordCheckWithoutUpgrade,
  recordUpgradeOutcome,
  routeReachForBaseUrl,
  selectEnvironmentRoute,
  type EnvironmentRoute,
  type RouteCheckResult,
} from "./environmentRoutes.ts";

const directId = EnvironmentId.make("direct-env");

function endpoint(
  httpBaseUrl: string,
  reachability: AdvertisedEndpoint["reachability"],
  status: AdvertisedEndpoint["status"] = "available",
): AdvertisedEndpoint {
  return {
    id: httpBaseUrl,
    label: httpBaseUrl,
    provider: { id: "core", label: "Core", kind: "core", isAddon: false },
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace(/^http/u, "ws"),
    reachability,
    hostedHttpsCompatibility: "incompatible",
    status,
    isDefault: false,
    source: "server",
  } as unknown as AdvertisedEndpoint;
}

function direct(
  httpBaseUrl: string,
  reach: Extract<EnvironmentRoute, { kind: "direct" }>["reach"],
  source: Extract<EnvironmentRoute, { kind: "direct" }>["source"] = "linked",
): EnvironmentRoute {
  return {
    kind: "direct",
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace(/^http/u, "ws"),
    reach,
    expectedDescriptorId: directId,
    source,
  };
}

const lan = direct("http://192.168.1.20:3773", "lan");
const tailnet = direct("http://100.64.0.7:3773", "tailnet");
const magic = direct("https://box.tail1234.ts.net", "tailnet-https");

describe("environment routes", () => {
  it("orders tailnet HTTPS, tailnet, LAN, public, then the relay", () => {
    const pub = direct("https://box.example.com", "public");
    expect(orderEnvironmentRoutes([RELAY_ROUTE, pub, lan, tailnet, magic])).toEqual([
      magic,
      tailnet,
      lan,
      pub,
      RELAY_ROUTE,
    ]);
  });

  it("turns advertised endpoints into routes, never loopback or unavailable ones", () => {
    const routes = directRoutesFromEndpoints({
      endpoints: [
        endpoint("http://127.0.0.1:3773", "loopback"),
        endpoint("http://192.168.1.20:3773", "lan"),
        endpoint("http://100.64.0.7:3773", "private-network"),
        endpoint("https://box.tail1234.ts.net", "private-network"),
        endpoint("http://10.0.0.9:3773", "lan", "unavailable"),
      ],
      expectedDescriptorId: directId,
      source: "learned",
    });
    expect(routes.map((route) => (route.kind === "direct" ? route.reach : route.kind))).toEqual([
      "tailnet-https",
      "tailnet",
      "lan",
    ]);
  });

  it("replaces learned routes the machine stopped reporting and never touches linked or user ones", () => {
    const user = direct("http://my-box.local:3773", "lan", "user");
    const oldLearned = direct("http://192.168.1.99:3773", "lan", "learned");
    const newLearned = direct("http://100.64.0.8:3773", "tailnet", "learned");
    expect(
      mergeLearnedRoutes(
        [RELAY_ROUTE, oldLearned, user, magic],
        [newLearned, direct("https://box.tail1234.ts.net", "tailnet-https", "learned")],
      ),
    ).toEqual([magic, newLearned, user, RELAY_ROUTE]);
  });

  it("connects over the best route that answered as this machine, else the relay", () => {
    const routes = [RELAY_ROUTE, lan, tailnet];
    const results = new Map<string, RouteCheckResult>([
      [
        environmentRouteKey(tailnet),
        { kind: "answered", descriptorId: EnvironmentId.make("someone-else") },
      ],
      [environmentRouteKey(lan), { kind: "answered", descriptorId: directId }],
    ]);
    expect(selectEnvironmentRoute(routes, results)).toBe(lan);
    expect(selectEnvironmentRoute(routes, new Map())).toBe(RELAY_ROUTE);
    expect(
      selectEnvironmentRoute([lan], new Map([[environmentRouteKey(lan), { kind: "timeout" }]])),
    ).toBeNull();
  });

  it("checks better routes on a timer, at once on a network change, and one check at a time", () => {
    const routes = [RELAY_ROUTE, lan, tailnet];
    const checked = recordCheckWithoutUpgrade(INITIAL_BETTER_ROUTE_STATE, 1_000);
    const plan = (trigger: "interval" | "network-changed", nowMs: number, state = checked) =>
      planBetterRouteCheck({ routes, active: RELAY_ROUTE, state, trigger, nowMs });
    expect(plan("interval", 1_000 + BETTER_ROUTE_CHECK_INTERVAL_MS - 1)).toEqual([]);
    expect(plan("interval", 1_000 + BETTER_ROUTE_CHECK_INTERVAL_MS)).toEqual([tailnet, lan]);
    expect(plan("network-changed", 1_001)).toEqual([tailnet, lan]);
    expect(plan("network-changed", 1_001, { ...checked, checking: true })).toEqual([]);
    expect(
      planBetterRouteCheck({
        routes,
        active: tailnet,
        state: checked,
        trigger: "resume",
        nowMs: 2_000,
      }),
    ).toEqual([]);
  });

  it("holds back a route an upgrade could not land on, and clears it once it lands", () => {
    const routes = [RELAY_ROUTE, lan];
    const missed = recordUpgradeOutcome({
      state: INITIAL_BETTER_ROUTE_STATE,
      target: lan,
      landedOn: RELAY_ROUTE,
      nowMs: 5_000,
    });
    expect(
      planBetterRouteCheck({
        routes,
        active: RELAY_ROUTE,
        state: missed,
        trigger: "resume",
        nowMs: 5_001,
      }),
    ).toEqual([]);
    expect(
      planBetterRouteCheck({
        routes,
        active: RELAY_ROUTE,
        state: missed,
        trigger: "resume",
        nowMs: 5_000 + BETTER_ROUTE_HOLDBACK_MS,
      }),
    ).toEqual([lan]);
    const landed = recordUpgradeOutcome({
      state: missed,
      target: lan,
      landedOn: lan,
      nowMs: 6_000,
    });
    expect(landed.heldBackUntil.size).toBe(0);
  });
});

describe("linked direct routes", () => {
  const NOW = Date.parse("2026-10-30T12:00:00.000Z");
  const record = (overrides: Partial<SavedEnvironmentRecord>): SavedEnvironmentRecord => ({
    environmentId: "env-direct" as EnvironmentId,
    label: "Studio",
    wsBaseUrl: "wss://studio.tail1234.ts.net",
    httpBaseUrl: "https://studio.tail1234.ts.net",
    createdAt: "2026-10-20T00:00:00.000Z",
    lastConnectedAt: null,
    hubLink: {
      hubEnvironmentId: "env_hub",
      linkedAt: "2026-10-29T12:00:00.000Z",
      nodeIdentityPublicKey: "bm9kZQ",
    },
    ...overrides,
  });

  it("reads a route's reach from its address", () => {
    expect(routeReachForBaseUrl("https://studio.tail1234.ts.net")).toBe("tailnet-https");
    expect(routeReachForBaseUrl("http://100.101.102.103:3773")).toBe("tailnet");
    expect(routeReachForBaseUrl("http://192.168.1.20:3773")).toBe("lan");
    expect(routeReachForBaseUrl("http://studio.local:3773")).toBe("lan");
    expect(routeReachForBaseUrl("https://ryco.example.com")).toBe("public");
    expect(routeReachForBaseUrl("http://127.0.0.1:3773")).toBeNull();
    expect(routeReachForBaseUrl("not a url")).toBeNull();
  });

  it("gives a Hub machine only its own links that are young enough to use", () => {
    const routes = linkedDirectRoutes({
      hubEnvironmentId: "env_hub" as EnvironmentId,
      nowMs: NOW,
      records: [
        record({
          httpBaseUrl: "http://100.101.102.103:3773",
          wsBaseUrl: "ws://100.101.102.103:3773",
        }),
        record({}),
        record({
          environmentId: "env-other" as EnvironmentId,
          hubLink: { hubEnvironmentId: "env_other_hub", linkedAt: "2026-10-29T12:00:00.000Z" },
        }),
        // Due for renewal: the relay carries the machine until it is renewed.
        record({
          httpBaseUrl: "http://100.64.0.9:3773",
          hubLink: {
            hubEnvironmentId: "env_hub",
            linkedAt: "2026-10-27T11:59:00.000Z",
            nodeIdentityPublicKey: "bm9kZQ",
          },
        }),
        record({ hubLink: undefined, httpBaseUrl: "http://100.64.0.10:3773" }),
        // Linked before the identity proof: no key to prove, so never a route.
        record({
          httpBaseUrl: "http://100.64.0.11:3773",
          hubLink: { hubEnvironmentId: "env_hub", linkedAt: "2026-10-29T12:00:00.000Z" },
        }),
      ],
    });
    expect(routes.map((route) => (route.kind === "direct" ? route.httpBaseUrl : "relay"))).toEqual([
      "https://studio.tail1234.ts.net",
      "http://100.101.102.103:3773",
    ]);
    expect(routes[0]).toMatchObject({
      expectedDescriptorId: "env-direct",
      source: "linked",
      nodeIdentityPublicKey: "bm9kZQ",
    });
  });

  // The relay is end-to-end encrypted with a pinned identity; a direct address
  // may carry the Hub machine only when its transport proves who answers.
  it("never lets a plain LAN or public address carry a Hub machine", () => {
    const routes = linkedDirectRoutes({
      hubEnvironmentId: "env_hub" as EnvironmentId,
      nowMs: NOW,
      records: [
        record({ httpBaseUrl: "http://192.168.1.20:3773" }),
        record({ httpBaseUrl: "http://studio.local:3773" }),
        record({ httpBaseUrl: "http://ryco.example.com" }),
        record({ httpBaseUrl: "http://[fd12:3456::1]:3773" }),
        record({ httpBaseUrl: "http://[fd7a:115c:a1e0::5]:3773" }),
        record({ httpBaseUrl: "https://ryco.example.com" }),
      ],
    });
    expect(routes.map((route) => (route.kind === "direct" ? route.httpBaseUrl : ""))).toEqual([
      "http://[fd7a:115c:a1e0::5]:3773",
      "https://ryco.example.com",
    ]);
    expect(
      directRouteAuthenticatesMachine({
        kind: "direct",
        httpBaseUrl: "http://192.168.1.20:3773",
        wsBaseUrl: "ws://192.168.1.20:3773",
        reach: "lan",
        expectedDescriptorId: "env-direct" as EnvironmentId,
        source: "linked",
      }),
    ).toBe(false);
  });

  it("checks routes at once, sends no credential, and times out a silent one", async () => {
    vi.useFakeTimers();
    try {
      const routes = [
        direct("https://a.ts.net", "tailnet-https"),
        direct("http://192.168.1.20:3773", "lan"),
        direct("http://192.168.1.30:3773", "lan"),
      ];
      const fetchDescriptorId = vi.fn((httpBaseUrl: string) =>
        httpBaseUrl === "https://a.ts.net"
          ? new Promise<EnvironmentId>(() => undefined)
          : httpBaseUrl === "http://192.168.1.20:3773"
            ? Promise.resolve(directId)
            : Promise.reject(new Error("refused")),
      );
      const pending = checkEnvironmentRoutes({ routes, fetchDescriptorId, timeoutMs: 2_500 });
      expect(fetchDescriptorId).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(2_500);
      const results = await pending;
      expect(results.get("https://a.ts.net")).toEqual({ kind: "timeout" });
      expect(results.get("http://192.168.1.20:3773")).toEqual({
        kind: "answered",
        descriptorId: directId,
      });
      expect(results.get("http://192.168.1.30:3773")).toEqual({ kind: "unreachable" });
      expect(selectEnvironmentRoute([...routes, RELAY_ROUTE], results)).toBe(routes[1]);
    } finally {
      vi.useRealTimers();
    }
  });
});
