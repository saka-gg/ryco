import type { EnvironmentId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

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
// The cache database never finishes opening: hydration stays in flight.
vi.mock("expo-sqlite", () => ({ openDatabaseAsync: () => new Promise(() => {}) }));
vi.mock("expo-linking", () => ({ getInitialURL: async () => null }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "id" }));

import { HUB_SELECTED_NODE_STORAGE_KEY } from "../hostedHub/selectionPersistence";
import {
  initializeMobileSnapshotPersistence,
  resetMobileSnapshotPersistenceForTests,
} from "./environmentSnapshotPersistence";

afterEach(() => resetMobileSnapshotPersistenceForTests());

describe("snapshot persistence wiring", () => {
  it("starts restoring the Hub selection before the snapshot cache has hydrated", async () => {
    const getItem = vi.fn(async () => null);
    const initialization = initializeMobileSnapshotPersistence({
      kv: { getItem, setItem: async () => undefined, removeItem: async () => undefined },
      hasDirectEnvironment: (_environmentId: EnvironmentId) => false,
    });

    // The SQLite open never resolves, yet the selection record is already read.
    await vi.waitFor(() => expect(getItem).toHaveBeenCalledWith(HUB_SELECTED_NODE_STORAGE_KEY));
    let settled = false;
    void initialization.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
  });
});
