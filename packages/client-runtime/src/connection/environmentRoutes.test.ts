import { EnvironmentId, type AdvertisedEndpoint } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BETTER_ROUTE_CHECK_INTERVAL_MS,
  BETTER_ROUTE_HOLDBACK_MS,
  INITIAL_BETTER_ROUTE_STATE,
  RELAY_ROUTE,
  directRoutesFromEndpoints,
  environmentRouteKey,
  mergeLearnedRoutes,
  orderEnvironmentRoutes,
  planBetterRouteCheck,
  recordCheckWithoutUpgrade,
  recordUpgradeOutcome,
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
