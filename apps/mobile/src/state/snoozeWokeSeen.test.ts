import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// In-memory KV so the store round-trips through a fake mobileKV.
const kvStore = new Map<string, string>();
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItem: async (key: string) => kvStore.get(key) ?? null,
    setItem: async (key: string, value: string) => void kvStore.set(key, value),
    removeItem: async (key: string) => void kvStore.delete(key),
  },
}));

import {
  getSnoozeWokeSeen,
  hydrateSnoozeWokeSeen,
  markSnoozeWokeSeen,
  recordSnoozeWokeSeen,
  resetSnoozeWokeSeenForTests,
  sanitizeSnoozeWokeSeen,
} from "./snoozeWokeSeen";

const KEY = "ryco.snoozeWokeSeen";
const at = (hour: number) => new Date(Date.UTC(2026, 9, 30, hour)).toISOString();

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  kvStore.clear();
  resetSnoozeWokeSeenForTests();
});

describe("recordSnoozeWokeSeen", () => {
  it("only moves a thread's mark later", () => {
    const seen = recordSnoozeWokeSeen({}, "a", at(10));
    expect(seen).toEqual({ a: at(10) });
    expect(recordSnoozeWokeSeen(seen, "a", at(9))).toBe(seen);
    expect(recordSnoozeWokeSeen(seen, "a", at(10))).toBe(seen);
    expect(recordSnoozeWokeSeen(seen, "a", at(11))).toEqual({ a: at(11) });
    expect(recordSnoozeWokeSeen(seen, "b", "not a time")).toBe(seen);
  });

  it("keeps the latest wakes within its limit", () => {
    let seen = {};
    for (const [key, hour] of [
      ["a", 1],
      ["b", 3],
      ["c", 2],
    ] as const) {
      seen = recordSnoozeWokeSeen(seen, key, at(hour), 2);
    }
    expect(seen).toEqual({ b: at(3), c: at(2) });
  });

  it("drops saved entries that are not times", () => {
    expect(sanitizeSnoozeWokeSeen({ a: at(1), b: 4, c: "soon" })).toEqual({ a: at(1) });
    expect(sanitizeSnoozeWokeSeen(["a"])).toEqual({});
  });
});

describe("the saved marks", () => {
  it("persists a mark and reads it back", async () => {
    hydrateSnoozeWokeSeen();
    await flush();
    markSnoozeWokeSeen("a", at(10));
    await flush();
    expect(JSON.parse(kvStore.get(KEY)!)).toEqual({ a: at(10) });

    resetSnoozeWokeSeenForTests();
    hydrateSnoozeWokeSeen();
    await flush();
    expect(getSnoozeWokeSeen()).toEqual({ a: at(10) });
  });

  it("keeps the saved marks when one is made before they are read", async () => {
    kvStore.set(KEY, JSON.stringify({ a: at(10) }));
    markSnoozeWokeSeen("b", at(11));
    expect(getSnoozeWokeSeen()).toEqual({ b: at(11) });
    await flush();
    expect(getSnoozeWokeSeen()).toEqual({ a: at(10), b: at(11) });
    expect(JSON.parse(kvStore.get(KEY)!)).toEqual({ a: at(10), b: at(11) });
  });
});
