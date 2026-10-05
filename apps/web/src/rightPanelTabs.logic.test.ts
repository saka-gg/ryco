import { describe, expect, it } from "vite-plus/test";

import {
  buildRightPanelTargetSearch,
  closeRightPanelTab,
  markRightPanelTabOpened,
  openedTabsFromRoute,
  rememberActiveAgentTab,
  resolveRightPanelReopenTarget,
  shouldMountRightPanelContent,
  visibleRightPanelTabs,
  type RightPanelOpenedTabs,
  type RightPanelRouteTabs,
} from "./rightPanelTabs.logic";

const route = (
  mode: RightPanelRouteTabs["mode"],
  activeAgentKey: string | null = null,
  scopeKey = "env:thread-1",
): RightPanelRouteTabs => ({ scopeKey, mode, activeAgentKey });

function opened(
  modes: RightPanelOpenedTabs["modes"],
  agentKeys: ReadonlyArray<string> = [],
): RightPanelOpenedTabs {
  return { scopeKey: "env:thread-1", modes, agentKeys };
}

describe("right panel tabs", () => {
  it("remembers shown tabs in fallback order and keeps identity when nothing changes", () => {
    let state = openedTabsFromRoute(route("terminal"));
    state = markRightPanelTabOpened(state, route("pullRequest"), "pullRequest");
    state = markRightPanelTabOpened(state, route("files"), "files");
    expect(state.modes).toEqual(["files", "terminal", "pullRequest"]);
    expect(markRightPanelTabOpened(state, route("files"), "files")).toBe(state);
  });

  it("starts over from the route when the scope changes", () => {
    const state = opened(["files", "review"], ["subagent:a"]);
    const otherThread = route("terminal", null, "env:thread-2");
    expect(
      visibleRightPanelTabs(markRightPanelTabOpened(state, otherThread, "terminal"), otherThread),
    ).toEqual({ modes: ["terminal"], agentKeys: [] });
  });

  it("shows the route's tab even before it is remembered", () => {
    expect(visibleRightPanelTabs(opened(["files"]), route("pullRequest", null))).toEqual({
      modes: ["files", "pullRequest"],
      agentKeys: [],
    });
  });

  it("falls back to the first open sibling when the active tab closes", () => {
    const { next, target } = closeRightPanelTab(
      opened(["review", "pullRequest"]),
      route("pullRequest"),
      { mode: "pullRequest" },
    );
    expect(next.modes).toEqual(["review"]);
    expect(target).toEqual({ kind: "tab", mode: "review" });
  });

  it("closes a background tab without navigating", () => {
    const { next, target } = closeRightPanelTab(opened(["files", "terminal"]), route("terminal"), {
      mode: "files",
    });
    expect(next.modes).toEqual(["terminal"]);
    expect(target).toBeNull();
  });

  it("lands on the launcher when the last tab closes", () => {
    expect(
      closeRightPanelTab(opened(["browser"]), route("browser"), { mode: "browser" }).target,
    ).toEqual({ kind: "launcher" });
  });

  it("closing the active agent transcript moves to the previous transcript, then tabs", () => {
    const state = opened(["review"], ["subagent:a", "subagent:b"]);
    expect(
      closeRightPanelTab(state, route("agent", "subagent:b"), {
        mode: "agent",
        agentKey: "subagent:b",
      }).target,
    ).toEqual({ kind: "agent", agentKey: "subagent:a" });
    expect(
      closeRightPanelTab(opened(["review"], ["subagent:b"]), route("agent", "subagent:b"), {
        mode: "agent",
        agentKey: "subagent:b",
      }).target,
    ).toEqual({ kind: "tab", mode: "review" });
  });

  it("reopens the last tab while it is open, else the first open tab", () => {
    const state = opened(["files", "pullRequest"]);
    expect(resolveRightPanelReopenTarget(state, route(null), "pullRequest")).toEqual({
      kind: "tab",
      mode: "pullRequest",
    });
    expect(resolveRightPanelReopenTarget(state, route(null), "terminal")).toEqual({
      kind: "tab",
      mode: "files",
    });
    expect(
      resolveRightPanelReopenTarget(opened([], ["subagent:a"]), route(null), "review"),
    ).toEqual({ kind: "agent", agentKey: "subagent:a" });
    expect(resolveRightPanelReopenTarget(opened([]), route(null), "review")).toEqual({
      kind: "launcher",
    });
  });

  it("remembers the routed agent transcript once", () => {
    const state = opened(["files"]);
    const withAgent = rememberActiveAgentTab(state, route("agent", "subagent:a"));
    expect(withAgent.agentKeys).toEqual(["subagent:a"]);
    expect(rememberActiveAgentTab(withAgent, route("agent", "subagent:a"))).toBe(withAgent);
  });

  it("keeps desktop-only tabs off the frozen phone tier", () => {
    const base = { open: false, agentKeys: [] as string[] };
    expect(
      shouldMountRightPanelContent({
        ...base,
        route: route(null),
        opened: opened(["pullRequest"]),
        phone: false,
      }),
    ).toBe(true);
    expect(
      shouldMountRightPanelContent({
        ...base,
        route: route("pullRequest"),
        opened: opened(["pullRequest", "agents"]),
        phone: true,
      }),
    ).toBe(false);
    expect(
      shouldMountRightPanelContent({
        ...base,
        route: route(null),
        opened: opened(["terminal"]),
        phone: true,
      }),
    ).toBe(true);
  });

  it("builds the search for each target kind", () => {
    expect(
      buildRightPanelTargetSearch(
        { diff: "1", other: "kept" },
        { kind: "tab", mode: "pullRequest" },
      ),
    ).toMatchObject({
      other: "kept",
      workspaceOpen: "1",
      workspaceTab: "pullRequest",
      diff: undefined,
    });
    expect(
      buildRightPanelTargetSearch({}, { kind: "agent", agentKey: "subagent:a" }),
    ).toMatchObject({ workspaceTab: "agent", workspaceAgentKey: "subagent:a" });
    expect(buildRightPanelTargetSearch({ workspacePr: 7 }, { kind: "launcher" })).toMatchObject({
      workspaceOpen: "1",
      workspaceTab: undefined,
      workspacePr: undefined,
    });
  });
});
