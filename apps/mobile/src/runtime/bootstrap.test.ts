import { describe, expect, it, vi } from "vite-plus/test";

// Stub the native modules the wiring pulls in so the bootstrap runs headless.
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("expo-linking", () => ({ getInitialURL: async () => null }));
vi.mock("expo-constants", () => ({
  default: { expoConfig: { extra: { node: { httpBaseUrl: "http://node.local:44342" } } } },
}));

// The snapshot cache read is held open so a test can observe what starts
// before it completes.
const persistence = vi.hoisted(() => ({
  release: null as (() => void) | null,
  initialize: null as unknown as () => Promise<void>,
}));
persistence.initialize = () =>
  new Promise<void>((resolve) => {
    persistence.release = resolve;
  });
vi.mock("../persistence/environmentSnapshotPersistence", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../persistence/environmentSnapshotPersistence")>()),
  initializeMobileSnapshotPersistence: () => persistence.initialize(),
}));

import {
  createMobileConnectionRegistry,
  initializeMobileRuntime,
  resetMobileRuntimeInitForTests,
} from "./bootstrap";
import { mobileRuntimeStartupBarrier } from "./startupBarrier";

describe("mobile runtime bootstrap", () => {
  it("constructs the connection registry with fake adapters without error", async () => {
    const store = new Map<string, string>();
    const secrets = new Map<string, string>();
    const registry = createMobileConnectionRegistry({
      kv: {
        getItem: async (key) => store.get(key) ?? null,
        setItem: async (key, value) => {
          store.set(key, value);
        },
      },
      secretKV: {
        get: async (key) => secrets.get(key) ?? null,
        set: async (key, value) => {
          secrets.set(key, value);
          return true;
        },
        remove: async (key) => {
          secrets.delete(key);
        },
      },
    });

    // The environment-connection driver (the supervisor over the shared catalog)
    // is present.
    expect(registry.driver.supervisor).toBeDefined();

    // The saved-environment catalog (the environment registry) initializes with
    // an empty registry.
    expect(registry.catalog).toBeDefined();
    await expect(registry.catalog.waitForHydration()).resolves.not.toThrow();
    expect(registry.catalog.hasHydrated()).toBe(true);
    expect(registry.catalog.list()).toEqual([]);

    // Bearer tokens route through the injected SecretKV (the direct-node token
    // store), not the registry KV.
    await registry.catalog.writeBearerToken("env-1" as never, "bearer-token");
    expect(secrets.get("env-1")).toBe("bearer-token");
    await expect(registry.catalog.readBearerToken("env-1" as never)).resolves.toBe("bearer-token");

    // The direct-node bearer API exposes the pairing bootstrap surface.
    expect(typeof registry.remoteApi.bootstrapRemoteBearerSession).toBe("function");
    expect(typeof registry.remoteApi.issueRemoteWebSocketToken).toBe("function");
    expect(typeof registry.remoteApi.resolveRemoteWebSocketConnectionUrl).toBe("function");
  });

  it("starts the direct driver once the catalog is hydrated, before the snapshot cache", async () => {
    resetMobileRuntimeInitForTests();
    const registry = createMobileConnectionRegistry();
    const start = vi.spyOn(registry.driver, "start");
    const release = vi.spyOn(registry.driver, "releaseDeferredPrimaryConnection");
    try {
      initializeMobileRuntime();

      await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
      // The cache read is still open: the hosted primary stays deferred.
      expect(persistence.release).not.toBeNull();
      expect(mobileRuntimeStartupBarrier.isHydrated()).toBe(false);
      expect(release).not.toHaveBeenCalled();

      persistence.release!();
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
      expect(mobileRuntimeStartupBarrier.isHydrated()).toBe(true);
    } finally {
      resetMobileRuntimeInitForTests();
    }
  });
});
