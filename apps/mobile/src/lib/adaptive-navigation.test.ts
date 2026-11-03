import { describe, expect, it } from "vite-plus/test";

import {
  isBaseThreadRoute,
  resolveFileSelectionNavigationAction,
  resolveThreadSelectionNavigationAction,
  resolveWorkspaceSelection,
} from "./adaptive-navigation";

describe("isBaseThreadRoute", () => {
  it("recognizes only the thread detail route", () => {
    expect(isBaseThreadRoute("/threads/environment/thread")).toBe(true);
    expect(isBaseThreadRoute("/threads/environment/thread/")).toBe(true);
    expect(isBaseThreadRoute("/threads/environment/thread/files")).toBe(false);
    expect(isBaseThreadRoute("/threads/environment/thread/review")).toBe(false);
  });
});

describe("resolveThreadSelectionNavigationAction", () => {
  it("updates params when a persistent sidebar selects a peer thread", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/threads/environment/thread",
      }),
    ).toBe("set-params");
  });

  it("replaces nested thread content when a persistent sidebar selects a peer", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/threads/environment/thread/files/path",
      }),
    ).toBe("replace");
  });

  it("pushes from Home so the back stack survives collapsing to compact", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: true,
        pathname: "/",
      }),
    ).toBe("push");
  });

  it("pushes compact list selections onto the native stack", () => {
    expect(
      resolveThreadSelectionNavigationAction({
        usesSplitView: false,
        pathname: "/threads/environment/thread",
      }),
    ).toBe("push");
  });
});

describe("resolveFileSelectionNavigationAction", () => {
  it("replaces the wide file browser with the selected preview", () => {
    expect(resolveFileSelectionNavigationAction({ hasPersistentFileInspector: true })).toBe(
      "replace",
    );
  });

  it("pushes a preview above the compact file browser", () => {
    expect(resolveFileSelectionNavigationAction({ hasPersistentFileInspector: false })).toBe(
      "push",
    );
  });
});

describe("resolveWorkspaceSelection", () => {
  const overlayRouteNames = new Set(["SettingsSheet", "NewTask", "Connections", "ConnectionsNew"]);
  const stack = { key: "root", type: "stack", stale: false as const, routeNames: ["Home"] };
  const home = { key: "home", name: "Home" };
  const threadA = {
    key: "thread-a",
    name: "Thread",
    params: { environmentId: "node", threadId: "a" },
  };
  const filesA = { key: "files-a", name: "ThreadFiles", params: threadA.params };
  const settings = { key: "settings", name: "SettingsSheet" };
  const connections = { key: "connections", name: "Connections" };
  const pairing = { key: "pairing", name: "ConnectionsNew" };
  const threadB = { name: "Thread", params: { environmentId: "node", threadId: "b" } };
  const resolve = (
    index: number,
    routes: ReadonlyArray<{ key: string; name: string }>,
    route: { name: string; params: Record<string, string> } = threadB,
  ) => resolveWorkspaceSelection({ state: { ...stack, index, routes }, overlayRouteNames, route });

  it("pushes normally when nothing covers Home or another screen", () => {
    expect(resolve(0, [home])).toEqual({ type: "navigate" });
    expect(resolve(2, [home, threadA, filesA])).toEqual({ type: "navigate" });
    expect(
      resolveWorkspaceSelection({ state: undefined, overlayRouteNames, route: threadB }),
    ).toEqual({ type: "navigate" });
  });

  it("closes every sheet over Home and keeps Home beneath the thread", () => {
    expect(resolve(3, [home, settings, connections, pairing])).toEqual({
      type: "reset",
      state: { ...stack, index: 1, routes: [home, threadB] },
    });
  });

  it("replaces an open thread instead of stacking threads, sheets or not", () => {
    expect(resolve(1, [home, threadA])).toEqual({
      type: "reset",
      state: { ...stack, index: 1, routes: [home, threadB] },
    });
    expect(resolve(2, [home, threadA, settings])).toEqual({
      type: "reset",
      state: { ...stack, index: 1, routes: [home, threadB] },
    });
  });

  it("keeps a thread's files beneath a thread opened over them", () => {
    expect(resolve(3, [home, threadA, filesA, settings])).toEqual({
      type: "reset",
      state: { ...stack, index: 3, routes: [home, threadA, filesA, threadB] },
    });
  });

  it("only closes the sheets when the destination is already open beneath them", () => {
    expect(resolve(1, [home, threadA], threadA)).toEqual({ type: "none" });
    expect(resolve(2, [home, threadA, settings], threadA)).toEqual({
      type: "reset",
      state: { ...stack, index: 1, routes: [home, threadA] },
    });
  });

  it("opens a project over sheets the same way, beside a thread rather than in place of it", () => {
    const project = { name: "Project", params: { environmentId: "node", projectId: "p" } };
    expect(resolve(2, [home, threadA, settings], project)).toEqual({
      type: "reset",
      state: { ...stack, index: 2, routes: [home, threadA, project] },
    });
    expect(resolve(1, [home, { key: "project-q", name: "Project" }], project)).toEqual({
      type: "reset",
      state: { ...stack, index: 1, routes: [home, project] },
    });
  });
});
