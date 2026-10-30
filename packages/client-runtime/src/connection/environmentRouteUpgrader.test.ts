import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { createEnvironmentRouteUpgrader } from "./environmentRouteUpgrader.ts";
import {
  BETTER_ROUTE_CHECK_INTERVAL_MS,
  BETTER_ROUTE_HOLDBACK_MS,
  RELAY_ROUTE,
  type EnvironmentRoute,
  type RouteCheckResult,
} from "./environmentRoutes.ts";

const directId = EnvironmentId.make("direct-env");
const LAN: EnvironmentRoute = {
  kind: "direct",
  httpBaseUrl: "http://192.168.1.20:3773",
  wsBaseUrl: "ws://192.168.1.20:3773",
  reach: "lan",
  expectedDescriptorId: directId,
  source: "linked",
};

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function harness(input?: { readonly answers?: () => RouteCheckResult }) {
  let now = 1_000_000;
  let active: string | null = "relay";
  let routes: ReadonlyArray<EnvironmentRoute> = [LAN, RELAY_ROUTE];
  const reconnect = vi.fn();
  const checkRoutes = vi.fn(async (candidates: ReadonlyArray<EnvironmentRoute>) => {
    const answer = input?.answers?.() ?? { kind: "answered", descriptorId: directId };
    return new Map(
      candidates.map((route) => [route.kind === "relay" ? "relay" : route.httpBaseUrl, answer]),
    );
  });
  const upgrader = createEnvironmentRouteUpgrader({
    readRoutes: () => routes,
    readActiveRouteKey: () => active,
    checkRoutes,
    reconnect,
    nowMs: () => now,
  });
  return {
    upgrader,
    reconnect,
    checkRoutes,
    advance: (ms: number) => {
      now += ms;
    },
    land: (key: string | null) => {
      active = key;
    },
    setRoutes: (next: ReadonlyArray<EnvironmentRoute>) => {
      routes = next;
    },
  };
}

describe("environment route upgrader", () => {
  it("moves a relay connection to a better route that answers as the machine", async () => {
    const test = harness();
    test.upgrader.trigger("interval");
    await settle();
    expect(test.checkRoutes).toHaveBeenCalledWith([LAN], expect.anything());
    expect(test.reconnect).toHaveBeenCalledTimes(1);
  });

  it("checks nothing on the relay's best route, and nothing while a check runs", async () => {
    const test = harness();
    test.land(LAN.httpBaseUrl);
    test.upgrader.trigger("interval");
    await settle();
    expect(test.checkRoutes).not.toHaveBeenCalled();

    test.land("relay");
    test.upgrader.trigger("resume");
    test.upgrader.trigger("network-changed");
    await settle();
    expect(test.checkRoutes).toHaveBeenCalledTimes(1);
  });

  it("paces interval checks but checks at once on a network change or a resume", async () => {
    const test = harness({ answers: () => ({ kind: "unreachable" }) });
    test.upgrader.trigger("interval");
    await settle();
    test.upgrader.trigger("interval");
    await settle();
    expect(test.checkRoutes).toHaveBeenCalledTimes(1);
    expect(test.reconnect).not.toHaveBeenCalled();

    test.upgrader.trigger("network-changed");
    await settle();
    expect(test.checkRoutes).toHaveBeenCalledTimes(2);

    test.advance(BETTER_ROUTE_CHECK_INTERVAL_MS);
    test.upgrader.trigger("interval");
    await settle();
    expect(test.checkRoutes).toHaveBeenCalledTimes(3);
  });

  it("holds a route back once an upgrade aimed at it landed elsewhere", async () => {
    const test = harness();
    test.upgrader.trigger("resume");
    await settle();
    expect(test.reconnect).toHaveBeenCalledTimes(1);

    // The new attempt's own walk found the route gone and took the relay.
    test.land("relay");
    test.upgrader.trigger("resume");
    await settle();
    expect(test.reconnect).toHaveBeenCalledTimes(1);

    test.advance(BETTER_ROUTE_HOLDBACK_MS);
    test.upgrader.trigger("resume");
    await settle();
    expect(test.reconnect).toHaveBeenCalledTimes(2);
  });

  it("leaves a direct route the machine no longer has, so the next attempt walks again", () => {
    const test = harness();
    test.land(LAN.httpBaseUrl);
    // Its link aged out (renewal is due over the relay) or was removed.
    test.setRoutes([RELAY_ROUTE]);
    test.upgrader.trigger("interval");
    expect(test.reconnect).toHaveBeenCalledTimes(1);
    expect(test.checkRoutes).not.toHaveBeenCalled();
  });

  it("does nothing once disposed, even when a check it started answers", async () => {
    let answer!: (results: ReadonlyMap<string, RouteCheckResult>) => void;
    const reconnect = vi.fn();
    const upgrader = createEnvironmentRouteUpgrader({
      readRoutes: () => [LAN, RELAY_ROUTE],
      readActiveRouteKey: () => "relay",
      checkRoutes: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      reconnect,
      nowMs: () => 1,
    });
    upgrader.trigger("resume");
    upgrader.dispose();
    answer(
      new Map([
        [
          LAN.kind === "direct" ? LAN.httpBaseUrl : "",
          { kind: "answered", descriptorId: directId },
        ],
      ]),
    );
    await settle();
    expect(reconnect).not.toHaveBeenCalled();
  });
});
