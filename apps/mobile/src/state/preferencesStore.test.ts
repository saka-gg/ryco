import { describe, expect, it, vi, beforeEach } from "vite-plus/test";

// In-memory KV so the prefs store round-trips through a fake mobileKV (§3-2, R6).
const kvStore = new Map<string, string>();
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItem: async (key: string) => kvStore.get(key) ?? null,
    setItem: async (key: string, value: string) => void kvStore.set(key, value),
    removeItem: async (key: string) => void kvStore.delete(key),
  },
}));

import {
  getPreferencesSnapshot,
  hydratePreferences,
  isPreferencesHydrated,
  resetPreferencesStoreForTests,
  updatePreferences,
} from "./preferencesStore";

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  kvStore.clear();
  resetPreferencesStoreForTests();
});

describe("preferencesStore persistence", () => {
  it("persists an appearance preference and rehydrates it from the fake KV", async () => {
    updatePreferences({ baseFontSize: 18 });
    expect(getPreferencesSnapshot().baseFontSize).toBe(18);
    await flush();
    // The write reached the fake KV.
    expect(kvStore.has("ryco.preferences")).toBe(true);

    // A fresh store hydrates the persisted value.
    resetPreferencesStoreForTests();
    expect(getPreferencesSnapshot().baseFontSize).toBeUndefined();
    hydratePreferences();
    await flush();
    expect(isPreferencesHydrated()).toBe(true);
    expect(getPreferencesSnapshot().baseFontSize).toBe(18);
  });

  it("shallow-merges successive patches", async () => {
    updatePreferences({ baseFontSize: 16 });
    updatePreferences({ codeWordBreak: true });
    await flush();
    expect(getPreferencesSnapshot()).toMatchObject({ baseFontSize: 16, codeWordBreak: true });
  });

  it("drops unknown/malformed fields via sanitizePreferences", async () => {
    kvStore.set("ryco.preferences", JSON.stringify({ baseFontSize: "nope", codeWordBreak: true }));
    hydratePreferences();
    await flush();
    const prefs = getPreferencesSnapshot();
    expect(prefs.baseFontSize).toBeUndefined();
    expect(prefs.codeWordBreak).toBe(true);
  });

  it("persists only supported AI Focus intervals", async () => {
    updatePreferences({ aiFocusEnabled: true, aiFocusRefreshIntervalMs: 600_000 });
    await flush();
    expect(getPreferencesSnapshot()).toMatchObject({
      aiFocusEnabled: true,
      aiFocusRefreshIntervalMs: 600_000,
    });

    kvStore.set(
      "ryco.preferences",
      JSON.stringify({ aiFocusEnabled: true, aiFocusRefreshIntervalMs: 86_400_001 }),
    );
    resetPreferencesStoreForTests();
    hydratePreferences();
    await flush();
    expect(getPreferencesSnapshot().aiFocusRefreshIntervalMs).toBeUndefined();
  });

  it("persists Off and supported auto-settle presets while rejecting arbitrary days", async () => {
    updatePreferences({ sidebarAutoSettleAfterDays: 14 });
    await flush();
    expect(getPreferencesSnapshot().sidebarAutoSettleAfterDays).toBe(14);

    updatePreferences({ sidebarAutoSettleAfterDays: null });
    expect(getPreferencesSnapshot().sidebarAutoSettleAfterDays).toBeNull();

    kvStore.set("ryco.preferences", JSON.stringify({ sidebarAutoSettleAfterDays: 2 }));
    resetPreferencesStoreForTests();
    hydratePreferences();
    await flush();
    expect(getPreferencesSnapshot().sidebarAutoSettleAfterDays).toBeUndefined();
  });
});

it("migrates model-only favorites unchanged and reloads multiple effort presets", async () => {
  const favorites = [
    { provider: "codex", model: "gpt-5" },
    { provider: "codex", model: "gpt-5", reasoningEffort: "low" },
    { provider: "codex", model: "gpt-5", reasoningEffort: "high" },
  ];
  kvStore.set(
    "ryco.preferences",
    JSON.stringify({ favorites: [...favorites, favorites[1], { provider: "codex", model: "" }] }),
  );
  hydratePreferences();
  await flush();
  expect(getPreferencesSnapshot().favorites).toEqual(favorites);
  updatePreferences({ baseFontSize: 18 });
  await flush();
  resetPreferencesStoreForTests();
  hydratePreferences();
  await flush();
  expect(getPreferencesSnapshot().favorites).toEqual(favorites);
});
