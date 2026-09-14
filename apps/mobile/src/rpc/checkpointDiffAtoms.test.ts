import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi, beforeEach } from "vite-plus/test";

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

import { appAtomRegistry } from "@ryco/client-runtime/rpc";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../connection/environmentApi";
import type { EnvironmentApi } from "@ryco/contracts";
import {
  checkpointDiffCacheKey,
  checkpointDiffCacheBytes,
  clearCheckpointDiffCacheForEnvironment,
  checkpointDiffStateAtom,
  invalidateCheckpointDiff,
  resetCheckpointDiffStateForTests,
  watchCheckpointDiff,
  type CheckpointDiffInput,
} from "./checkpointDiffAtoms";

const ENV = "env-a" as EnvironmentId;
const THREAD = "t1" as ThreadId;

function input(overrides: Partial<CheckpointDiffInput> = {}): CheckpointDiffInput {
  return {
    environmentId: ENV,
    threadId: THREAD,
    fromTurnCount: 0,
    toTurnCount: 2,
    ignoreWhitespace: false,
    ...overrides,
  };
}

function readState(diffInput: CheckpointDiffInput) {
  return appAtomRegistry.get(checkpointDiffStateAtom(checkpointDiffCacheKey(diffInput)));
}

beforeEach(() => {
  resetCheckpointDiffStateForTests();
  __resetEnvironmentApiOverridesForTests();
});

describe("checkpointDiffAtoms cache", () => {
  it("routes fromTurnCount 0 to getFullThreadDiff and caches the result by key", async () => {
    const getFullThreadDiff = vi.fn(async () => ({ files: [{ id: "f1" }] }));
    const getTurnDiff = vi.fn(async () => ({ files: [] }));
    __setEnvironmentApiOverrideForTests(ENV, {
      orchestration: { getFullThreadDiff, getTurnDiff },
    } as unknown as EnvironmentApi);

    const release = watchCheckpointDiff(input());
    await vi.waitFor(() => expect(readState(input()).data).not.toBeNull());

    expect(getFullThreadDiff).toHaveBeenCalledTimes(1);
    expect(getTurnDiff).not.toHaveBeenCalled();
    expect(readState(input()).isLoading).toBe(false);
    release();
  });

  it("routes a non-zero fromTurnCount to getTurnDiff", async () => {
    const getFullThreadDiff = vi.fn(async () => ({ files: [] }));
    const getTurnDiff = vi.fn(async () => ({ files: [{ id: "t" }] }));
    __setEnvironmentApiOverrideForTests(ENV, {
      orchestration: { getFullThreadDiff, getTurnDiff },
    } as unknown as EnvironmentApi);

    const diffInput = input({ fromTurnCount: 1, toTurnCount: 2 });
    const release = watchCheckpointDiff(diffInput);
    await vi.waitFor(() => expect(readState(diffInput).data).not.toBeNull());

    expect(getTurnDiff).toHaveBeenCalledTimes(1);
    expect(getFullThreadDiff).not.toHaveBeenCalled();
    release();
  });

  it("refetches on invalidation while retaining the previously resolved data", async () => {
    let call = 0;
    const getFullThreadDiff = vi.fn(async () => ({ files: [{ id: `call-${++call}` }] }));
    __setEnvironmentApiOverrideForTests(ENV, {
      orchestration: { getFullThreadDiff, getTurnDiff: vi.fn() },
    } as unknown as EnvironmentApi);

    const release = watchCheckpointDiff(input());
    await vi.waitFor(() => expect(readState(input()).data).not.toBeNull());
    const firstData = readState(input()).data;

    invalidateCheckpointDiff(THREAD);
    // Previous data stays visible during the background refetch (staleTime Infinity).
    expect(readState(input()).data).toEqual(firstData);

    await vi.waitFor(() => expect(getFullThreadDiff).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect((readState(input()).data as unknown as { files: { id: string }[] }).files[0]!.id).toBe(
        "call-2",
      ),
    );
    release();
  });
});

it("clears unused diffs by device and preserves an actively viewed diff", async () => {
  const other = "env-b" as EnvironmentId;
  for (const id of [ENV, other])
    __setEnvironmentApiOverrideForTests(id, {
      orchestration: { getFullThreadDiff: async () => ({ files: [{ id: "f1" }] }) },
    } as unknown as EnvironmentApi);
  const a = input(),
    b = input({ environmentId: other });
  const releaseA = watchCheckpointDiff(a),
    releaseB = watchCheckpointDiff(b);
  await vi.waitFor(() => expect(readState(a).data).not.toBeNull());
  await vi.waitFor(() => expect(readState(b).data).not.toBeNull());
  clearCheckpointDiffCacheForEnvironment(ENV);
  expect(readState(a).data).not.toBeNull();
  releaseA();
  releaseB();
  expect(checkpointDiffCacheBytes(ENV)).toBeGreaterThan(0);
  clearCheckpointDiffCacheForEnvironment(ENV);
  expect(readState(a).data).toBeNull();
  expect(readState(b).data).not.toBeNull();
});
