import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@ryco/contracts";

import { createFakeHistoryWindow } from "../../test/fakeHistoryWindow";
import {
  buildHostedNodeHref,
  clearHostedNodeRoute,
  dropHostedNodeRouteSegment,
  enterHostedHomeRoute,
  adoptRoutedHostedNode,
  getRoutedHostedNode,
  installHostedNodeHistory,
  isHostedNodeScopedPathname,
  isValidHostedNodeRouteSegment,
  parseHostedNodeHref,
  resetHostedNodeRoutesForTests,
  subscribeRoutedHostedNode,
  setHostedNodeRouteDraftResolver,
  setHostedNodeRouteEnvironmentResolver,
} from "./nodeRoutes";

afterEach(() => {
  resetHostedNodeRoutesForTests();
  vi.restoreAllMocks();
});

function install(initialUrl: string) {
  const win = createFakeHistoryWindow(initialUrl);
  const history = installHostedNodeHistory(win as unknown as Window & typeof globalThis);
  return { win, history };
}

describe("hosted node route segment parsing", () => {
  it("accepts only the bounded URL-safe segment charset", () => {
    expect(isValidHostedNodeRouteSegment("node_aaaaaaaaaaaaaaaaaaaaaa")).toBe(true);
    expect(isValidHostedNodeRouteSegment("A1-b_2")).toBe(true);
    expect(isValidHostedNodeRouteSegment("")).toBe(false);
    expect(isValidHostedNodeRouteSegment("..")).toBe(false);
    expect(isValidHostedNodeRouteSegment("a.b")).toBe(false);
    expect(isValidHostedNodeRouteSegment("a b")).toBe(false);
    expect(isValidHostedNodeRouteSegment("a/b")).toBe(false);
    expect(isValidHostedNodeRouteSegment("%2e%2e")).toBe(false);
    expect(isValidHostedNodeRouteSegment("x".repeat(129))).toBe(false);
    expect(isValidHostedNodeRouteSegment("x".repeat(128))).toBe(true);
  });

  it("passes non node-scoped hrefs through unchanged", () => {
    expect(parseHostedNodeHref("/")).toEqual({
      routed: { nodeId: null, malformed: false },
      logicalHref: "/",
    });
    expect(parseHostedNodeHref("/env_a/t_1?workspaceTab=diff#m")).toEqual({
      routed: { nodeId: null, malformed: false },
      logicalHref: "/env_a/t_1?workspaceTab=diff#m",
    });
    expect(parseHostedNodeHref("/nodeling/x").routed.nodeId).toBeNull();
    expect(parseHostedNodeHref("/nodeling/x").routed.malformed).toBe(false);
  });

  it("extracts the node segment and preserves the nested logical href", () => {
    expect(parseHostedNodeHref("/node/node_a")).toEqual({
      routed: { nodeId: "node_a", malformed: false },
      logicalHref: "/",
    });
    expect(parseHostedNodeHref("/node/node_a/env_a/t_1?workspaceTab=diff&diff=f#x")).toEqual({
      routed: { nodeId: "node_a", malformed: false },
      logicalHref: "/env_a/t_1?workspaceTab=diff&diff=f#x",
    });
    expect(parseHostedNodeHref("/node/node_a?x=1")).toEqual({
      routed: { nodeId: "node_a", malformed: false },
      logicalHref: "/?x=1",
    });
  });

  it("classifies unusable segments as malformed and fails closed to the root", () => {
    for (const href of [
      "/node",
      "/node/",
      "/node//env_a/t_1",
      "/node/a b/env_a/t_1",
      "/node/%2e%2e/env_a/t_1",
      `/node/${"x".repeat(129)}`,
    ]) {
      const parsed = parseHostedNodeHref(href);
      expect(parsed.routed).toEqual({ nodeId: null, malformed: true });
      expect(parsed.logicalHref).toBe("/");
    }
  });

  it("builds node-scoped hrefs without altering search or hash", () => {
    expect(buildHostedNodeHref("/env_a/t_1?workspaceTab=diff#m", "node_a")).toBe(
      "/node/node_a/env_a/t_1?workspaceTab=diff#m",
    );
    expect(buildHostedNodeHref("/draft/d_1?x=1", "node_a")).toBe("/node/node_a/draft/d_1?x=1");
    expect(buildHostedNodeHref("/env_a/t_1", null)).toBe("/env_a/t_1");
    expect(buildHostedNodeHref("/env_a/t_1", "not valid!")).toBe("/env_a/t_1");
  });

  it("names a node only on a thread or a draft, never on the pages no node owns", () => {
    for (const href of [
      "/",
      "/?x=1#y",
      "/settings",
      "/projects",
      "/tasks",
      "/statistics?environmentIds=env_a",
      "/pull-requests",
      "/diagnostics",
      "/pair",
      "/native/authorize/handoff_1",
    ]) {
      expect(buildHostedNodeHref(href, "node_a"), href).toBe(href);
    }
    expect(isHostedNodeScopedPathname("/env_a/t_1")).toBe(true);
    expect(isHostedNodeScopedPathname("/draft/d_1")).toBe(true);
    expect(isHostedNodeScopedPathname("/")).toBe(false);
    expect(isHostedNodeScopedPathname("/settings")).toBe(false);
    expect(isHostedNodeScopedPathname("/account/security")).toBe(false);
  });

  it("routes a draft through the environment it belongs to", () => {
    setHostedNodeRouteEnvironmentResolver((environmentId) =>
      environmentId === EnvironmentId.make("env_b") ? "node_b" : null,
    );
    setHostedNodeRouteDraftResolver((draftId) =>
      draftId === "d_b" ? EnvironmentId.make("env_b") : null,
    );
    // From a page that names no node, and from another node's thread.
    expect(buildHostedNodeHref("/draft/d_b", null)).toBe("/node/node_b/draft/d_b");
    expect(buildHostedNodeHref("/draft/d_b", "node_a")).toBe("/node/node_b/draft/d_b");
    // A draft no resolver places keeps the routed node, and without one names none.
    expect(buildHostedNodeHref("/draft/d_unknown", "node_a")).toBe("/node/node_a/draft/d_unknown");
    expect(buildHostedNodeHref("/draft/d_unknown", null)).toBe("/draft/d_unknown");
  });

  it("routes a logical environment through its own authorized node, not the current node", () => {
    setHostedNodeRouteEnvironmentResolver((environmentId) =>
      environmentId === EnvironmentId.make("env_b") ? "node_b" : null,
    );
    expect(buildHostedNodeHref("/env_b/colliding_thread", "node_a")).toBe(
      "/node/node_b/env_b/colliding_thread",
    );
    expect(buildHostedNodeHref("/env_a/colliding_thread", "node_a")).toBe(
      "/node/node_a/env_a/colliding_thread",
    );
  });
});

describe("hosted node history", () => {
  it("captures the routed node at install time and exposes the logical location", () => {
    const { history } = install("/node/node_a/env_a/t_1?workspaceTab=diff");
    expect(getRoutedHostedNode()).toEqual({
      nodeId: "node_a",
      malformed: false,
      logicalPathname: "/env_a/t_1",
    });
    expect(history.location.pathname).toBe("/env_a/t_1");
    expect(history.location.search).toBe("?workspaceTab=diff");
  });

  it("prefixes pushed logical hrefs with the routed segment", () => {
    const { win, history } = install("/node/node_a");
    history.push("/env_a/t_1?workspaceTab=diff");
    history.flush();
    expect(win.location.pathname).toBe("/node/node_a/env_a/t_1");
    expect(win.location.search).toBe("?workspaceTab=diff");
    expect(history.location.pathname).toBe("/env_a/t_1");
    expect(history.createHref("/env_a/t_1")).toBe("/node/node_a/env_a/t_1");
  });

  it("publishes the resolved node when a logical thread is pushed from the unified root", () => {
    const { win, history } = install("/");
    setHostedNodeRouteEnvironmentResolver((environmentId) =>
      environmentId === EnvironmentId.make("env_a") ? "node_a" : null,
    );
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeRoutedHostedNode(() => {
      seen.push(getRoutedHostedNode().nodeId);
    });

    history.push("/env_a/t_1");
    history.flush();

    expect(win.location.pathname).toBe("/node/node_a/env_a/t_1");
    expect(getRoutedHostedNode()).toEqual({
      nodeId: "node_a",
      malformed: false,
      logicalPathname: "/env_a/t_1",
    });
    expect(seen).toEqual(["node_a"]);
    unsubscribe();
  });

  it("publishes a cross-node logical push before the destination thread renders", () => {
    const { win, history } = install("/node/node_a/env_a/t_1");
    setHostedNodeRouteEnvironmentResolver((environmentId) =>
      environmentId === EnvironmentId.make("env_b") ? "node_b" : null,
    );

    history.push("/env_b/t_2");
    history.flush();

    expect(win.location.pathname).toBe("/node/node_b/env_b/t_2");
    expect(getRoutedHostedNode()).toEqual({
      nodeId: "node_b",
      malformed: false,
      logicalPathname: "/env_b/t_2",
    });
  });

  it("leaves a thread for the pages no node owns without carrying its node along", () => {
    const { win, history } = install("/node/node_a/env_a/t_1");
    for (const pathname of ["/", "/settings", "/tasks"]) {
      history.push(pathname);
      history.flush();
      expect(win.location.pathname, pathname).toBe(pathname);
      expect(getRoutedHostedNode(), pathname).toEqual({
        nodeId: null,
        malformed: false,
        logicalPathname: pathname,
      });
    }
  });

  it("enters home with a new history entry and clears a node route fail-closed", () => {
    const { win, history } = install("/node/node_a/env_a/t_1");
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeRoutedHostedNode(() => {
      seen.push(getRoutedHostedNode().nodeId);
    });
    expect(enterHostedHomeRoute()).toBe(true);
    history.flush();
    expect(win.location.pathname).toBe("/");
    expect(win.entries()).toHaveLength(2);
    // Already home: no second entry.
    expect(enterHostedHomeRoute()).toBe(true);
    history.flush();
    expect(win.entries()).toHaveLength(2);
    expect(seen).toEqual([null]);
    unsubscribe();

    history.back();
    history.flush();
    expect(getRoutedHostedNode().nodeId).toBe("node_a");
    clearHostedNodeRoute();
    history.flush();
    expect(win.location.pathname).toBe("/");
    expect(getRoutedHostedNode().nodeId).toBeNull();
  });

  it("rejects invalid segments for programmatic navigation", () => {
    const { win } = install("/env_a/t_1");
    expect(adoptRoutedHostedNode("not valid!")).toBe(false);
    expect(adoptRoutedHostedNode("..")).toBe(false);
    expect(win.entries()).toHaveLength(1);
    expect(getRoutedHostedNode().nodeId).toBeNull();
  });

  it("adopts nothing on a page no node owns", () => {
    const { win, history } = install("/settings?section=general");
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeRoutedHostedNode(() => {
      seen.push(getRoutedHostedNode().nodeId);
    });
    expect(adoptRoutedHostedNode("node_a")).toBe(false);
    history.flush();
    expect(win.location.pathname).toBe("/settings");
    expect(win.entries()).toHaveLength(1);
    expect(seen).toEqual([]);
    unsubscribe();
  });

  it("adopts nothing on another node's thread", () => {
    setHostedNodeRouteEnvironmentResolver((environmentId) =>
      environmentId === EnvironmentId.make("env_a") ? "node_a" : null,
    );
    const { win, history } = install("/node/node_a/env_a/t_1");
    expect(adoptRoutedHostedNode("node_b")).toBe(false);
    history.flush();
    expect(win.location.pathname).toBe("/node/node_a/env_a/t_1");
    expect(getRoutedHostedNode().nodeId).toBe("node_a");
  });

  it("routes the open draft in place to the device it is moving to, and back", () => {
    setHostedNodeRouteEnvironmentResolver((environmentId) =>
      environmentId === EnvironmentId.make("env_a") ? "node_a" : "node_b",
    );
    setHostedNodeRouteDraftResolver(() => EnvironmentId.make("env_a"));
    const { win, history } = install("/node/node_a/draft/d_1?x=1");

    expect(adoptRoutedHostedNode("node_b")).toBe(true);
    history.flush();
    expect(win.entries()).toHaveLength(1);
    expect(win.location.pathname).toBe("/node/node_b/draft/d_1");
    expect(win.location.search).toBe("?x=1");
    // A later in-place rewrite of the same draft keeps the device it moves to.
    history.replace("/draft/d_1?x=2");
    history.flush();
    expect(win.location.pathname).toBe("/node/node_b/draft/d_1");

    expect(adoptRoutedHostedNode("node_a")).toBe(true);
    history.flush();
    expect(win.location.pathname).toBe("/node/node_a/draft/d_1");
  });

  it("drops the segment of an entry whose page no node owns, in place", () => {
    const { win, history } = install("/node/node_a/settings?section=general");
    expect(getRoutedHostedNode()).toEqual({
      nodeId: "node_a",
      malformed: false,
      logicalPathname: "/settings",
    });

    dropHostedNodeRouteSegment();
    history.flush();
    expect(win.entries()).toHaveLength(1);
    expect(win.location.pathname).toBe("/settings");
    expect(win.location.search).toBe("?section=general");
    expect(getRoutedHostedNode()).toEqual({
      nodeId: null,
      malformed: false,
      logicalPathname: "/settings",
    });
  });

  it("adopts a legacy location in place without adding a history entry", () => {
    const { win, history } = install("/env_a/t_1?workspaceTab=diff");
    expect(getRoutedHostedNode().nodeId).toBeNull();
    expect(adoptRoutedHostedNode("node_a")).toBe(true);
    history.flush();
    expect(win.entries()).toHaveLength(1);
    expect(win.location.pathname).toBe("/node/node_a/env_a/t_1");
    expect(win.location.search).toBe("?workspaceTab=diff");
    expect(history.location.pathname).toBe("/env_a/t_1");
  });

  it("republishes the routed node across Back and Forward", () => {
    const { win, history } = install("/");
    setHostedNodeRouteEnvironmentResolver(() => "node_a");
    history.push("/env_a/t_1");
    history.flush();
    expect(getRoutedHostedNode().nodeId).toBe("node_a");

    win.history.back();
    expect(getRoutedHostedNode().nodeId).toBeNull();
    expect(win.location.pathname).toBe("/");

    win.history.forward();
    expect(getRoutedHostedNode().nodeId).toBe("node_a");
    expect(win.location.pathname).toBe("/node/node_a/env_a/t_1");
  });

  it("marks malformed browser locations and keeps the router on the root", () => {
    const { history } = install("/node/a%20b/env_a/t_1");
    expect(getRoutedHostedNode()).toEqual({
      nodeId: null,
      malformed: true,
      logicalPathname: "/",
    });
    expect(history.location.pathname).toBe("/");
  });

  it("publishes the logical pathname of the parsed entry across Back and Forward", () => {
    const { win, history } = install("/env_a/t_1?workspaceTab=diff");
    expect(getRoutedHostedNode().logicalPathname).toBe("/env_a/t_1");
    expect(adoptRoutedHostedNode("node_a")).toBe(true);
    history.flush();
    expect(getRoutedHostedNode().logicalPathname).toBe("/env_a/t_1");

    clearHostedNodeRoute();
    history.flush();
    expect(getRoutedHostedNode().logicalPathname).toBe("/");
    expect(win.location.pathname).toBe("/");
  });

  it("keeps history entry state free of application material", () => {
    const canary = "ticket-sensitive-route-canary";
    const { win, history } = install("/");
    setHostedNodeRouteEnvironmentResolver(() => "node_a");
    history.push(`/env_a/t_1`);
    history.push("/settings");
    history.flush();
    const serialized = JSON.stringify(win.entries());
    expect(serialized).not.toContain(canary);
    for (const entry of win.entries()) {
      const keys = Object.keys((entry.state ?? {}) as Record<string, unknown>);
      // TanStack history bookkeeping only: index and entry keys.
      expect(
        keys.every((key) => key === "__TSR_index" || key === "__TSR_key" || key === "key"),
      ).toBe(true);
    }
  });
});
