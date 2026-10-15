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
  MAX_INACTIVE_CHECKPOINT_DIFF_CHARS,
  MAX_INACTIVE_CHECKPOINT_DIFF_ENTRIES,
  checkpointDiffCacheKey,
  checkpointDiffCacheBytes,
  evictCheckpointDiffsForThread,
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
    const getFullThreadDiff = vi.fn(async () => ({ diff: "full", files: [{ id: "f1" }] }));
    const getTurnDiff = vi.fn(async () => ({ diff: "", files: [] }));
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
    const getFullThreadDiff = vi.fn(async () => ({ diff: "", files: [] }));
    const getTurnDiff = vi.fn(async () => ({ diff: "turn", files: [{ id: "t" }] }));
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
    const getFullThreadDiff = vi.fn(async () => ({
      diff: "full",
      files: [{ id: `call-${++call}` }],
    }));
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
      orchestration: { getFullThreadDiff: async () => ({ diff: "full", files: [{ id: "f1" }] }) },
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

describe("checkpoint diff cache bounds", () => {
  function mockDiffs(diffFor: (toTurnCount: number) => string) {
    const getFullThreadDiff = vi.fn(async (request: { toTurnCount: number }) => ({
      threadId: THREAD,
      fromTurnCount: 0,
      toTurnCount: request.toTurnCount,
      diff: diffFor(request.toTurnCount),
    }));
    const getTurnDiff = vi.fn(async (request: { fromTurnCount: number; toTurnCount: number }) => ({
      threadId: THREAD,
      fromTurnCount: request.fromTurnCount,
      toTurnCount: request.toTurnCount,
      diff: diffFor(request.toTurnCount),
    }));
    __setEnvironmentApiOverrideForTests(ENV, {
      orchestration: { getFullThreadDiff, getTurnDiff },
    } as unknown as EnvironmentApi);
    return { getFullThreadDiff, getTurnDiff };
  }

  async function watchUntilResolved(diffInput: CheckpointDiffInput) {
    const release = watchCheckpointDiff(diffInput);
    await vi.waitFor(() => expect(readState(diffInput).data).not.toBeNull());
    return release;
  }

  const turn = (count: number) => input({ fromTurnCount: count - 1, toTurnCount: count });
  // The review sheet's full-thread input: every completed turn is a new key.
  const conversation = (count: number) => input({ toTurnCount: count, cacheSlot: "conversation" });

  it("keeps recently released diffs and evicts the oldest past the entry bound", async () => {
    mockDiffs((count) => `patch-${count}`);
    const total = MAX_INACTIVE_CHECKPOINT_DIFF_ENTRIES + 2;
    for (let count = 1; count <= total; count += 1) {
      (await watchUntilResolved(turn(count)))();
    }
    expect(readState(turn(1)).data).toBeNull();
    expect(readState(turn(2)).data).toBeNull();
    expect(readState(turn(3)).data?.diff).toBe("patch-3");
    expect(readState(turn(total)).data?.diff).toBe(`patch-${total}`);
  });

  it("evicts released diffs once their retained characters exceed the budget", async () => {
    const largeLength = Math.floor(MAX_INACTIVE_CHECKPOINT_DIFF_CHARS / 2) + 1;
    mockDiffs((count) => `${count}`.padEnd(largeLength, "x"));
    (await watchUntilResolved(turn(1)))();
    (await watchUntilResolved(turn(2)))();
    expect(readState(turn(1)).data).toBeNull();
    expect(readState(turn(2)).data?.diff.length).toBe(largeLength);
  });

  it("never evicts a diff that is still watched", async () => {
    mockDiffs((count) => `patch-${count}`);
    const releaseFirst = await watchUntilResolved(turn(1));
    for (let count = 2; count <= MAX_INACTIVE_CHECKPOINT_DIFF_ENTRIES + 3; count += 1) {
      (await watchUntilResolved(turn(count)))();
    }
    expect(readState(turn(1)).data?.diff).toBe("patch-1");
    releaseFirst();
  });

  it("keeps one full-thread patch while turns complete under an open review", async () => {
    mockDiffs((count) => `conversation-${count}`);
    let release = await watchUntilResolved(conversation(1));
    for (let count = 2; count <= 5; count += 1) {
      // The sheet re-keys on the new turn count: watch the new key, then
      // release the old one (React runs the old cleanup after the new effect
      // is scheduled; either order leaves one entry).
      const next = await watchUntilResolved(conversation(count));
      release();
      release = next;
    }
    for (let count = 1; count < 5; count += 1) {
      expect(readState(conversation(count)).data).toBeNull();
    }
    expect(readState(conversation(5)).data?.diff).toBe("conversation-5");
    release();
    // The latest stays cached for a quick reopen.
    expect(readState(conversation(5)).data?.diff).toBe("conversation-5");
    expect(checkpointDiffCacheBytes(ENV)).toBeGreaterThan(0);
  });

  it("evicts a thread's diffs on archive, deferring the ones still on screen", async () => {
    mockDiffs((count) => `patch-${count}`);
    (await watchUntilResolved(turn(1)))();
    const releaseSecond = await watchUntilResolved(turn(2));

    evictCheckpointDiffsForThread(THREAD);
    expect(readState(turn(1)).data).toBeNull();
    expect(readState(turn(2)).data?.diff).toBe("patch-2");

    releaseSecond();
    expect(readState(turn(2)).data).toBeNull();
  });
});
