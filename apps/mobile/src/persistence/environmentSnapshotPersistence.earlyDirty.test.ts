import type { EnvironmentId, OrchestrationShellSnapshot } from "@ryco/contracts";
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
vi.mock("expo-linking", () => ({ getInitialURL: async () => null }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "id" }));

const saved = vi.hoisted(() => [] as string[]);
vi.mock("./snapshotDb", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./snapshotDb")>()),
  createSnapshotDb: () => ({
    loadEnvironmentSnapshot: async () => null,
    loadEnvironmentSnapshots: async () => [],
    saveEnvironmentSnapshot: async (input: { readonly environmentId: string }) => {
      saved.push(input.environmentId);
    },
    removeEnvironmentSnapshot: async () => undefined,
    listEnvironmentSnapshotStats: async () => [],
    loadHubNodeRoster: async () => null,
    saveHubNodeRoster: async () => undefined,
    clearAll: async () => undefined,
  }),
}));

import { useStore } from "../state/threadsRuntime";
import {
  initializeMobileSnapshotPersistence,
  markEnvironmentSnapshotDirty,
  resetMobileSnapshotPersistenceForTests,
  SNAPSHOT_WRITE_DEBOUNCE_MS,
} from "./environmentSnapshotPersistence";

const ENV_ID = "persist-early-dirty" as EnvironmentId;

afterEach(() => {
  vi.useRealTimers();
  resetMobileSnapshotPersistenceForTests();
  useStore.getState().removeEnvironmentState(ENV_ID);
  saved.length = 0;
});

describe("snapshot persistence before initialization", () => {
  it("captures a live projection that landed before the runtime existed", async () => {
    vi.useFakeTimers();
    // The direct plane starts once the catalog is hydrated, so its first
    // snapshot can be applied while persistence is still being initialized.
    useStore.getState().syncServerShellSnapshot(
      {
        snapshotSequence: 1,
        projects: [],
        worktrees: [],
        threads: [],
        updatedAt: "2026-08-20T00:00:00.000Z",
      } as unknown as OrchestrationShellSnapshot,
      ENV_ID,
    );
    markEnvironmentSnapshotDirty(ENV_ID);

    await initializeMobileSnapshotPersistence({
      kv: {
        getItem: async () => null,
        setItem: async () => undefined,
        removeItem: async () => undefined,
      },
      hasDirectEnvironment: () => true,
    });
    await vi.advanceTimersByTimeAsync(SNAPSHOT_WRITE_DEBOUNCE_MS);

    expect(saved).toEqual([ENV_ID]);
  });
});
