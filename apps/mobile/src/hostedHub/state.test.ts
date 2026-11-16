import { describe, expect, it, vi } from "vite-plus/test";

/**
 * Importing the hosted state module must have no side effect beyond registering
 * a configurator callback. Screens import it for the React bindings, so touching
 * SecureStore, expo-constants, or the device-key module at import time would
 * pull the native bridge into every consumer and make these adapters
 * unmockable in suites that never exercise hosted mode.
 */

const touched = vi.hoisted(() => ({ secureStore: 0, constants: 0, deviceKey: 0, configured: 0 }));

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => {
    touched.secureStore += 1;
    return null;
  },
  setItemAsync: async () => {
    touched.secureStore += 1;
  },
  deleteItemAsync: async () => {
    touched.secureStore += 1;
  },
}));
vi.mock("expo-constants", () => ({
  default: {
    get expoConfig() {
      touched.constants += 1;
      return { extra: {} };
    },
  },
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("expo-linking", () => ({ getInitialURL: async () => null }));
vi.mock("@ryco/mobile-device-key", () => ({
  default: {
    ensureKey: async () => {
      touched.deviceKey += 1;
      return { publicKey: "", backing: "unavailable" };
    },
    sign: async () => "",
    deleteKey: async () => {},
  },
}));

describe("hosted state module import purity", () => {
  it("does not configure the runtime or touch native adapters at import", async () => {
    const runtime = await import("@ryco/client-runtime/authorization");
    const configure = vi.spyOn(runtime, "configureHostedRuntime");

    await import("./state");

    expect(configure).not.toHaveBeenCalled();
    expect(touched.secureStore).toBe(0);
    expect(touched.constants).toBe(0);
    expect(touched.deviceKey).toBe(0);
  });

  it("re-exports the controller bindings screens need from one place", async () => {
    const state = await import("./state");

    for (const member of [
      "hostedHubController",
      "hostedHubStore",
      "useHostedHubStore",
      "ensureMobileHostedSession",
      "isMobileHostedModeAvailable",
      "subscribeMobileHostedModeAvailability",
      "markHostedSessionReady",
      "markHostedSessionReplaying",
      "reportHostedShellSnapshotFailure",
      "HOSTED_SESSION_SYNC_FAILURE_MESSAGE",
    ]) {
      expect(member in state).toBe(true);
    }
  });
});
