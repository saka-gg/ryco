import { describe, expect, it } from "vite-plus/test";

import {
  HUB_ROUTE_TOP_SEGMENTS,
  hubRoutePathname,
  hubRouteTitle,
  parseHubRoute,
  type HubRoute,
} from "./hubRoutes";
import { buildHostedNodeHref } from "./nodeRoutes";
import { RESERVED_TOP_SEGMENTS } from "./nodeRouteOrchestrator";

const ALL_ROUTES: readonly HubRoute[] = [
  { kind: "sign-in" },
  { kind: "sign-in-password" },
  { kind: "sign-in-recovery-code" },
  { kind: "sign-up" },
  { kind: "sign-up-verify" },
  { kind: "reset-password" },
  { kind: "invitation" },
  { kind: "setup" },
  { kind: "email-verification" },
  { kind: "nodes" },
  { kind: "nodes-enroll" },
  { kind: "account", section: "overview" },
  { kind: "account", section: "security" },
  { kind: "account", section: "appearance" },
];

describe("hub routes", () => {
  it("round-trips every route through its pathname", () => {
    for (const route of ALL_ROUTES) {
      expect(parseHubRoute(hubRoutePathname(route)), hubRoutePathname(route)).toEqual(route);
    }
  });

  it("gives every route a title", () => {
    for (const route of ALL_ROUTES) {
      expect(hubRouteTitle(route).length, hubRoutePathname(route)).toBeGreaterThan(0);
    }
  });

  it("tolerates a trailing slash", () => {
    expect(parseHubRoute("/sign-in/")).toEqual({ kind: "sign-in" });
    expect(parseHubRoute("/account/")).toEqual({ kind: "account", section: "overview" });
  });

  // `/` is the shared home whose meaning depends on account state — directory
  // when signed in, sign-in when not — so it is resolved by the surface, not here.
  it("leaves the node workspace's logical tree alone", () => {
    expect(parseHubRoute("/")).toBeNull();
    expect(parseHubRoute("/draft/abc")).toBeNull();
    expect(parseHubRoute("/env_123/thread_456")).toBeNull();
  });

  // An unknown account subpath must not fall through to the node tree, where
  // the legacy matcher would read it as an environment/thread pair.
  it("resolves an unknown account subpath to the overview", () => {
    expect(parseHubRoute("/account/nonsense")).toEqual({ kind: "account", section: "overview" });
  });

  // A compatible Hub builds these three in the mail it sends, from its
  // configured public origin. They are a server contract: a mailed link and the
  // page it lands on must be the same address, so changing one of these strings
  // breaks every link already in someone's inbox.
  it("keeps the Hub server's mail pathnames verbatim", () => {
    expect(hubRoutePathname({ kind: "email-verification" })).toBe("/email-verification");
    expect(hubRoutePathname({ kind: "reset-password" })).toBe("/password-reset");
    expect(hubRoutePathname({ kind: "sign-up-verify" })).toBe("/public-signup/verify");
  });

  it("declares a top segment for every route", () => {
    for (const route of ALL_ROUTES) {
      const segment = hubRoutePathname(route).slice(1).split("/", 1)[0];
      expect(HUB_ROUTE_TOP_SEGMENTS, hubRoutePathname(route)).toContain(segment);
    }
  });

  // The two agreements a Hub address depends on. Either one missing silently
  // reinterprets the address rather than failing loudly.
  it("is never prefixed with the routed node segment", () => {
    for (const route of ALL_ROUTES) {
      const pathname = hubRoutePathname(route);
      expect(buildHostedNodeHref(pathname, "node_abc"), pathname).toBe(pathname);
    }
    // Of the node workspace's own routes, a draft is still scoped; home is not.
    expect(buildHostedNodeHref("/", "node_abc")).toBe("/");
    expect(buildHostedNodeHref("/draft/d1", "node_abc")).toBe("/node/node_abc/draft/d1");
  });

  it("reserves every Hub top segment against the legacy thread matcher", () => {
    for (const segment of HUB_ROUTE_TOP_SEGMENTS) {
      expect(RESERVED_TOP_SEGMENTS.has(segment), segment).toBe(true);
    }
  });
});
