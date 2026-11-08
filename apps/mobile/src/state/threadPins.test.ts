import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const kvStore = new Map<string, string>();
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItem: async (key: string) => kvStore.get(key) ?? null,
    setItem: async (key: string, value: string) => void kvStore.set(key, value),
    removeItem: async (key: string) => void kvStore.delete(key),
  },
}));
const undo = vi.hoisted(() => ({ supersede: vi.fn(), unpin: vi.fn() }));
vi.mock("./sidebarUndo", () => ({ sidebarUndo: undo }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn(async () => {}) }));

import {
  changeThreadPin,
  getThreadPins,
  hydrateThreadPins,
  isThreadPinned,
  resetThreadPinsForTests,
  setThreadPinned,
} from "./threadPins";

const KEY = "ryco.pinnedThreadKeys";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  kvStore.clear();
  resetThreadPinsForTests();
  vi.clearAllMocks();
});

describe("device thread pins", () => {
  it("reads the saved pins and saves changes", async () => {
    kvStore.set(KEY, JSON.stringify(["env:a", "env:b"]));
    hydrateThreadPins();
    await flush();
    expect(getThreadPins()).toEqual({ "env:a": true, "env:b": true });
    setThreadPinned("env:a", false);
    await flush();
    expect(JSON.parse(kvStore.get(KEY)!)).toEqual(["env:b"]);
  });

  it("keeps a pin changed while the saved ones load", async () => {
    kvStore.set(KEY, JSON.stringify(["env:a"]));
    setThreadPinned("env:a", false);
    setThreadPinned("env:c", true);
    await flush();
    expect(getThreadPins()).toEqual({ "env:c": true });
    expect(JSON.parse(kvStore.get(KEY)!)).toEqual(["env:c"]);
  });

  it("ignores a corrupt saved list", async () => {
    kvStore.set(KEY, "{not json");
    hydrateThreadPins();
    await flush();
    expect(getThreadPins()).toEqual({});
  });

  it("pins through the Undo history and ignores no-op changes", async () => {
    hydrateThreadPins();
    await flush();
    changeThreadPin("env:thread", true);
    expect(isThreadPinned("env:thread")).toBe(true);
    expect(undo.supersede).toHaveBeenCalledOnce();
    changeThreadPin("env:thread", true);
    expect(undo.supersede).toHaveBeenCalledOnce();
    changeThreadPin("env:thread", false);
    expect(undo.unpin).toHaveBeenCalledOnce();
    changeThreadPin("not-a-key", true);
    expect(isThreadPinned("not-a-key")).toBe(false);
  });
});
