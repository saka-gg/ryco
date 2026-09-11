import { DEFAULT_CLIENT_SETTINGS, EnvironmentId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { HOSTED_INBOX_PREFERENCES_KEY } from "./hostedInboxPreferences";

vi.mock("./env", () => ({ isHostedHubMode: () => true }));

function installStorage() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  vi.stubGlobal("window", { localStorage: storage });
  return { values, storage };
}

afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

describe("hosted inbox preference persistence", () => {
  it("restores inbox choices after reload without persisting node metadata or secrets", async () => {
    const { values } = installStorage();
    const persistence = await import("./clientPersistenceStorage");
    persistence.writeBrowserClientSettings({
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarAutoSettleAfterDays: 3,
      aiFocusEnabled: true,
      aiFocusRefreshIntervalMs: 0,
      sidebarProjectGroupingOverrides: { "private-project-path": "separate" },
      dismissedProviderUpdateNotificationKeys: ["private-provider-notice"],
    });
    persistence.writeBrowserSavedEnvironmentRegistry([
      {
        environmentId: EnvironmentId.make("private-node"),
        label: "Private node",
        httpBaseUrl: "https://private.example",
        wsBaseUrl: "wss://private.example",
        createdAt: "2026-09-11T00:00:00Z",
        lastConnectedAt: null,
      },
    ]);
    persistence.writeBrowserSavedEnvironmentSecret(EnvironmentId.make("private-node"), "secret");
    expect([...values.keys()]).toEqual([HOSTED_INBOX_PREFERENCES_KEY]);
    expect(JSON.parse(values.get(HOSTED_INBOX_PREFERENCES_KEY)!)).toEqual({
      sidebarAutoSettleAfterDays: 3,
      aiFocusEnabled: true,
      aiFocusRefreshIntervalMs: 0,
    });
    vi.resetModules();
    const reloaded = await import("./clientPersistenceStorage");
    expect(reloaded.readBrowserClientSettings()).toMatchObject({
      sidebarAutoSettleAfterDays: 3,
      aiFocusEnabled: true,
      aiFocusRefreshIntervalMs: 0,
      sidebarProjectGroupingOverrides: {},
      dismissedProviderUpdateNotificationKeys: [],
    });
    expect(reloaded.readBrowserSavedEnvironmentRegistry()).toEqual([]);
    expect(
      reloaded.readBrowserSavedEnvironmentSecret(EnvironmentId.make("private-node")),
    ).toBeNull();
  });

  it.each(["not json", '{"sidebarAutoSettleAfterDays":2}', "x".repeat(513)])(
    "ignores invalid or oversized stored preferences",
    async (value) => {
      const { storage } = installStorage();
      storage.setItem(HOSTED_INBOX_PREFERENCES_KEY, value);
      const { readBrowserClientSettings } = await import("./clientPersistenceStorage");
      expect(readBrowserClientSettings()).toEqual(DEFAULT_CLIENT_SETTINGS);
    },
  );

  it("keeps the in-memory selection if browser storage is unavailable", async () => {
    const { storage } = installStorage();
    storage.setItem = () => {
      throw new Error("Storage unavailable");
    };
    const { readBrowserClientSettings, writeBrowserClientSettings } =
      await import("./clientPersistenceStorage");
    expect(() =>
      writeBrowserClientSettings({ ...DEFAULT_CLIENT_SETTINGS, sidebarAutoSettleAfterDays: 7 }),
    ).toThrow("Storage unavailable");
    expect(readBrowserClientSettings()?.sidebarAutoSettleAfterDays).toBe(7);
  });
});
