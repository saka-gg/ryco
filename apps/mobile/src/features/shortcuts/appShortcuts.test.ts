import { describe, expect, it, vi } from "vite-plus/test";

const links = vi.hoisted(() => ({
  registered: null as string | null,
  clear: vi.fn(),
  urlListeners: [] as Array<(event: { url: string }) => void>,
}));
vi.mock("expo-linking", () => ({
  createURL: (path: string) => `ryco-dev://${path}`,
  getInitialURL: async () => null,
  getLinkingURL: () => links.registered,
  clearInitialURL: () => {
    links.clear();
    links.registered = null;
  },
  addEventListener: (_type: string, listener: (event: { url: string }) => void) => {
    links.urlListeners.push(listener);
    return { remove: () => {} };
  },
}));
vi.mock("expo-quick-actions", () => ({
  initial: undefined,
  setItems: async () => {},
  addListener: () => ({ remove: () => {} }),
}));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

import {
  buildShortcutActions,
  sanitizeRecentThreadShortcuts,
  shortcutPath,
  withRecentThreadShortcut,
  type RecentThreadShortcut,
} from "./appShortcuts";
import { createRecentThreadShortcuts, shortcutAwareLinking } from "./appShortcutsRuntime";

const thread = (threadId: string, title = threadId): RecentThreadShortcut => ({
  environmentId: "env:a",
  threadId,
  title,
});

describe("app shortcuts", () => {
  it("lists New task, then up to three recent threads with encoded paths", () => {
    const actions = buildShortcutActions([thread("t1", "Fix login"), thread("t2", " ")]);
    expect(actions.map((action) => [action.title, action.params?.path])).toEqual([
      ["New task", "tasks/new"],
      ["Fix login", "threads/env%3Aa/t1"],
      ["Task", "threads/env%3Aa/t2"],
    ]);
  });

  it("opens only today's destinations", () => {
    expect(shortcutPath({ params: { path: "tasks/new" } })).toBe("tasks/new");
    expect(shortcutPath({ params: { path: "threads/a/b" } })).toBe("threads/a/b");
    expect(shortcutPath({ params: { path: "settings/hub" } })).toBeNull();
    expect(shortcutPath({ params: { path: "threads/a/b/c" } })).toBeNull();
    expect(shortcutPath({ params: {} })).toBeNull();
    expect(shortcutPath(undefined)).toBeNull();
  });

  it("moves an opened thread first, keeps three and the known title", () => {
    const list = [thread("a"), thread("b"), thread("c")];
    expect(withRecentThreadShortcut(list, thread("a"))).toBe(list);
    expect(withRecentThreadShortcut(list, thread("d")).map((t) => t.threadId)).toEqual([
      "d",
      "a",
      "b",
    ]);
    expect(withRecentThreadShortcut(list, thread("c", "")).at(0)).toEqual(thread("c"));
  });

  it("sanitizes the saved list", () => {
    expect(sanitizeRecentThreadShortcuts([thread("a"), { threadId: "x" }, "bad", null])).toEqual([
      thread("a"),
    ]);
  });
});

describe("recent thread shortcuts", () => {
  it("waits for the saved list before recording, then saves and publishes", async () => {
    const saved: ReadonlyArray<RecentThreadShortcut>[] = [];
    const published: ReadonlyArray<RecentThreadShortcut>[] = [];
    const load = Promise.withResolvers<ReadonlyArray<RecentThreadShortcut>>();
    const recents = createRecentThreadShortcuts({
      load: () => load.promise,
      save: async (list) => void saved.push(list),
      publish: async (list) => void published.push(list),
    });
    recents.record(thread("new"));
    load.resolve([thread("old")]);
    await recents.loaded;
    await recents.saved();
    expect(published.at(-1)?.map((t) => t.threadId)).toEqual(["new", "old"]);
    expect(saved.at(-1)?.map((t) => t.threadId)).toEqual(["new", "old"]);
  });

  it("never saves over the history after a failed read, and reads again on the next open", async () => {
    const save = vi.fn(async (_list: ReadonlyArray<RecentThreadShortcut>) => {});
    const publish = vi.fn(async (_list: ReadonlyArray<RecentThreadShortcut>) => {});
    let reads = 0;
    const recents = createRecentThreadShortcuts({
      load: async () => {
        reads += 1;
        if (reads === 1) throw new Error("unreadable");
        return [thread("saved-1"), thread("saved-2")];
      },
      save,
      publish,
    });
    await recents.loaded;
    await recents.saved();
    expect(publish).toHaveBeenLastCalledWith([]);
    expect(save).not.toHaveBeenCalled();
    await recents.record(thread("a"));
    await recents.saved();
    expect(reads).toBe(2);
    expect(save).toHaveBeenLastCalledWith([thread("a"), thread("saved-1"), thread("saved-2")]);
  });

  it("keeps an unreadable history unsaved while reads keep failing", async () => {
    const save = vi.fn(async () => {});
    const publish = vi.fn(async (_list: ReadonlyArray<RecentThreadShortcut>) => {});
    const recents = createRecentThreadShortcuts({
      load: async () => {
        throw new Error("unreadable");
      },
      save,
      publish,
    });
    await recents.loaded;
    await recents.record(thread("a"));
    await recents.saved();
    expect(save).not.toHaveBeenCalled();
    expect(publish).toHaveBeenLastCalledWith([thread("a")]);
  });
});

describe("shortcut-aware linking on iOS", () => {
  it("opens a cold-launch quick action the scene delivered, once", async () => {
    links.registered = "ryco-dev://threads/env%3Aa/t1";
    expect(await shortcutAwareLinking.getInitialURL()).toBe("ryco-dev://threads/env%3Aa/t1");
    // A navigator that mounts again does not replay it.
    expect(await shortcutAwareLinking.getInitialURL()).toBeNull();
  });

  it("forgets a link it delivered while running", () => {
    const received: string[] = [];
    shortcutAwareLinking.subscribe((url) => received.push(url));
    links.registered = "ryco-dev://tasks/new";
    links.urlListeners.at(-1)!({ url: "ryco-dev://tasks/new" });
    expect(received).toEqual(["ryco-dev://tasks/new"]);
    expect(links.registered).toBeNull();
  });
});
