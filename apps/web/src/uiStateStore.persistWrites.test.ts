import { ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

function createCountingStorage() {
  const store = new Map<string, string>();
  const setItem = vi.fn((key: string, value: string) => {
    store.set(key, value);
  });
  const storage: Storage = {
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
    removeItem: (key) => {
      store.delete(key);
    },
    setItem,
  };
  return { storage, setItem };
}

describe("uiStateStore persistence writes", () => {
  let setItem: ReturnType<typeof createCountingStorage>["setItem"];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    const counting = createCountingStorage();
    setItem = counting.setItem;
    vi.stubGlobal("window", { localStorage: counting.storage, addEventListener: () => {} });
    vi.stubGlobal("localStorage", counting.storage);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("writes nothing for changes to session-only fields", async () => {
    const { useUiStateStore } = await import("./uiStateStore");
    const threadId = ThreadId.make("thread-1");
    for (let index = 0; index < 100; index += 1) {
      useUiStateStore
        .getState()
        .setThreadWorkEntryExpanded(threadId, `entry-${index}`, index % 2 === 0);
      useUiStateStore
        .getState()
        .markThreadVisited(threadId, new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString());
      // Spaced past the debounce, so each update would otherwise be its own write.
      vi.advanceTimersByTime(600);
    }
    expect(setItem).not.toHaveBeenCalled();
  });

  it("writes once for a burst of changes to a saved field", async () => {
    const { useUiStateStore } = await import("./uiStateStore");
    useUiStateStore.getState().setAlwaysUseBuildMode(false);
    useUiStateStore.getState().setSidebarMode("projects");
    useUiStateStore.getState().setThreadPinned(ThreadId.make("thread-1"), true);
    vi.advanceTimersByTime(600);
    expect(setItem).toHaveBeenCalledOnce();
    const saved = JSON.parse(setItem.mock.calls[0]![1]) as Record<string, unknown>;
    expect(saved).toMatchObject({
      alwaysUseBuildMode: false,
      sidebarMode: "projects",
      pinnedThreadKeys: ["thread-1"],
    });
  });

  it("still writes a saved change made after session-only changes", async () => {
    const { useUiStateStore } = await import("./uiStateStore");
    const threadId = ThreadId.make("thread-1");
    useUiStateStore.getState().setThreadWorkGroupExpanded(threadId, "group-1", true);
    vi.advanceTimersByTime(600);
    useUiStateStore.getState().setWideComposerControlsAutoCollapse(false);
    useUiStateStore.getState().setThreadWorkGroupExpanded(threadId, "group-2", true);
    vi.advanceTimersByTime(600);
    expect(setItem).toHaveBeenCalledOnce();
    const saved = JSON.parse(setItem.mock.calls[0]![1]) as Record<string, unknown>;
    expect(saved.wideComposerControlsAutoCollapse).toBe(false);
  });
});
