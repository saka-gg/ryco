import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const testEnvironmentId = EnvironmentId.make("environment-1");

const savedRegistryRecord: PersistedSavedEnvironmentRecord = {
  environmentId: testEnvironmentId,
  label: "Remote environment",
  httpBaseUrl: "https://remote.example.com/",
  wsBaseUrl: "wss://remote.example.com/",
  createdAt: "2026-04-09T00:00:00.000Z",
  lastConnectedAt: null,
  desktopSsh: {
    alias: "devbox",
    hostname: "devbox.example.com",
    username: "julius",
    port: 22,
  },
};

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function getTestWindow(): Window & typeof globalThis {
  const localStorage = createLocalStorageStub();
  const testWindow = {
    localStorage,
  } as Window & typeof globalThis;
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("localStorage", localStorage);
  return testWindow;
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clientPersistenceStorage", () => {
  it("stores browser secrets inline with an explicit browser-local expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T00:00:00.000Z"));
    const testWindow = getTestWindow();
    const {
      SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      readBrowserSavedEnvironmentRegistry,
      readBrowserSavedEnvironmentSecret,
      writeBrowserSavedEnvironmentRegistry,
      writeBrowserSavedEnvironmentSecret,
    } = await import("./clientPersistenceStorage");

    writeBrowserSavedEnvironmentRegistry([savedRegistryRecord]);
    expect(writeBrowserSavedEnvironmentSecret(testEnvironmentId, "bearer-token")).toBe(true);
    writeBrowserSavedEnvironmentRegistry([savedRegistryRecord]);

    expect(readBrowserSavedEnvironmentRegistry()).toEqual([savedRegistryRecord]);
    expect(readBrowserSavedEnvironmentSecret(testEnvironmentId)).toBe("bearer-token");
    expect(
      JSON.parse(testWindow.localStorage.getItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY)!),
    ).toEqual({
      version: 1,
      records: [
        {
          ...savedRegistryRecord,
          bearerToken: "bearer-token",
          bearerTokenSavedAt: "2026-04-09T00:00:00.000Z",
          bearerTokenExpiresAt: "2026-04-16T00:00:00.000Z",
        },
      ],
    });
  });

  it("keeps a switched-off machine off and its browser credential stored", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T00:00:00.000Z"));
    getTestWindow();
    const {
      readBrowserSavedEnvironmentRegistry,
      readBrowserSavedEnvironmentSecret,
      writeBrowserSavedEnvironmentRegistry,
      writeBrowserSavedEnvironmentSecret,
    } = await import("./clientPersistenceStorage");
    const switchedOff = { ...savedRegistryRecord, disabledAt: "2026-04-09T00:00:00.000Z" };

    writeBrowserSavedEnvironmentRegistry([savedRegistryRecord]);
    expect(writeBrowserSavedEnvironmentSecret(testEnvironmentId, "bearer-token")).toBe(true);
    writeBrowserSavedEnvironmentRegistry([switchedOff]);

    expect(readBrowserSavedEnvironmentRegistry()).toEqual([switchedOff]);
    expect(readBrowserSavedEnvironmentSecret(testEnvironmentId)).toBe("bearer-token");
  });

  it("migrates legacy browser secrets to the explicit expiry format on read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T00:00:00.000Z"));
    const testWindow = getTestWindow();
    const {
      SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      readBrowserSavedEnvironmentSecret,
      writeBrowserSavedEnvironmentRegistry,
    } = await import("./clientPersistenceStorage");

    writeBrowserSavedEnvironmentRegistry([savedRegistryRecord]);
    testWindow.localStorage.setItem(
      SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        records: [
          {
            ...savedRegistryRecord,
            bearerToken: "legacy-bearer-token",
          },
        ],
      }),
    );

    expect(readBrowserSavedEnvironmentSecret(testEnvironmentId)).toBe("legacy-bearer-token");
    expect(
      JSON.parse(testWindow.localStorage.getItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY)!),
    ).toEqual({
      version: 1,
      records: [
        {
          ...savedRegistryRecord,
          bearerToken: "legacy-bearer-token",
          bearerTokenSavedAt: "2026-04-09T00:00:00.000Z",
          bearerTokenExpiresAt: "2026-04-16T00:00:00.000Z",
        },
      ],
    });
  });

  it("removes expired browser secrets when they are read or metadata is rewritten", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T00:00:00.000Z"));
    const testWindow = getTestWindow();
    const {
      SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      readBrowserSavedEnvironmentSecret,
      writeBrowserSavedEnvironmentRegistry,
    } = await import("./clientPersistenceStorage");

    testWindow.localStorage.setItem(
      SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        records: [
          {
            ...savedRegistryRecord,
            bearerToken: "expired-bearer-token",
            bearerTokenSavedAt: "2026-04-09T00:00:00.000Z",
            bearerTokenExpiresAt: "2026-04-16T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(readBrowserSavedEnvironmentSecret(testEnvironmentId)).toBeNull();
    expect(
      JSON.parse(testWindow.localStorage.getItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY)!),
    ).toEqual({
      version: 1,
      records: [savedRegistryRecord],
    });

    testWindow.localStorage.setItem(
      SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        records: [
          {
            ...savedRegistryRecord,
            bearerToken: "expired-bearer-token",
            bearerTokenSavedAt: "2026-04-09T00:00:00.000Z",
            bearerTokenExpiresAt: "2026-04-16T00:00:00.000Z",
          },
        ],
      }),
    );

    writeBrowserSavedEnvironmentRegistry([
      {
        ...savedRegistryRecord,
        label: "Renamed remote environment",
      },
    ]);

    expect(
      JSON.parse(testWindow.localStorage.getItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY)!),
    ).toEqual({
      version: 1,
      records: [
        {
          ...savedRegistryRecord,
          label: "Renamed remote environment",
        },
      ],
    });
  });

  it("removes browser secret metadata explicitly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T00:00:00.000Z"));
    const testWindow = getTestWindow();
    const {
      SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      removeBrowserSavedEnvironmentSecret,
      writeBrowserSavedEnvironmentRegistry,
      writeBrowserSavedEnvironmentSecret,
    } = await import("./clientPersistenceStorage");

    writeBrowserSavedEnvironmentRegistry([savedRegistryRecord]);
    expect(writeBrowserSavedEnvironmentSecret(testEnvironmentId, "bearer-token")).toBe(true);
    removeBrowserSavedEnvironmentSecret(testEnvironmentId);

    expect(
      JSON.parse(testWindow.localStorage.getItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY)!),
    ).toEqual({
      version: 1,
      records: [savedRegistryRecord],
    });
  });
});
