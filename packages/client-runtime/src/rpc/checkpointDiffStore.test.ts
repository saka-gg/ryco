import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "./atomRegistry.ts";
import {
  checkpointDiffCacheKey,
  createCheckpointDiffStore,
  type CheckpointDiffInput,
} from "./checkpointDiffStore.ts";

const environmentA = "env-a" as EnvironmentId;
const environmentB = "env-b" as EnvironmentId;
const threadId = "thread-1" as ThreadId;

function makeStore(options: { maxInactiveEntries?: number; maxInactiveChars?: number } = {}) {
  const getTurnDiff = vi.fn(async (request: { fromTurnCount: number; toTurnCount: number }) => ({
    threadId,
    fromTurnCount: request.fromTurnCount,
    toTurnCount: request.toTurnCount,
    diff: `patch-${request.fromTurnCount}`,
  }));
  const getFullThreadDiff = vi.fn(async (request: { toTurnCount: number }) => ({
    threadId,
    fromTurnCount: 0,
    toTurnCount: request.toTurnCount,
    diff: `conversation-${request.toTurnCount}`,
  }));
  const resolveOrchestrationApi = vi.fn(() => ({ getTurnDiff, getFullThreadDiff }) as never);
  const store = createCheckpointDiffStore({
    resolveOrchestrationApi,
    maxInactiveEntries: options.maxInactiveEntries ?? 2,
    maxInactiveChars: options.maxInactiveChars ?? 1_000,
  });
  const read = (input: CheckpointDiffInput) =>
    appAtomRegistry.get(store.checkpointDiffStateAtom(checkpointDiffCacheKey(input)));
  const watchUntilResolved = async (input: CheckpointDiffInput) => {
    const release = store.watchCheckpointDiff(input);
    await vi.waitFor(() => expect(read(input).data).not.toBeNull());
    return release;
  };
  return { store, read, watchUntilResolved, getTurnDiff, resolveOrchestrationApi };
}

// A single-turn diff (a non-zero start routes to getTurnDiff), named by its start.
const turn = (count: number, environmentId = environmentA): CheckpointDiffInput => ({
  environmentId,
  threadId,
  fromTurnCount: count,
  toTurnCount: count + 1,
  ignoreWhitespace: false,
});

let activeStore: ReturnType<typeof makeStore>["store"] | null = null;
afterEach(() => {
  activeStore?.clearCheckpointDiffState();
  activeStore = null;
});

describe("createCheckpointDiffStore", () => {
  it("routes requests through the injected environment API and bounds unwatched entries", async () => {
    const { store, read, watchUntilResolved, getTurnDiff, resolveOrchestrationApi } = makeStore();
    activeStore = store;
    for (let count = 1; count <= 3; count += 1) {
      (await watchUntilResolved(turn(count)))();
    }
    expect(resolveOrchestrationApi).toHaveBeenCalledWith(environmentA);
    expect(getTurnDiff).toHaveBeenCalledTimes(3);
    expect(read(turn(1))).toEqual({ data: null, error: null, isLoading: true });
    expect(read(turn(2)).data?.diff).toBe("patch-2");
    expect(read(turn(3)).data?.diff).toBe("patch-3");
  });

  it("evicts unwatched entries past the character budget", async () => {
    const { store, read, watchUntilResolved } = makeStore({ maxInactiveChars: 10 });
    activeStore = store;
    (await watchUntilResolved(turn(1)))();
    (await watchUntilResolved(turn(2)))();
    // "patch-1" + "patch-2" is 14 characters: the older one goes.
    expect(read(turn(1)).data).toBeNull();
    expect(read(turn(2)).data?.diff).toBe("patch-2");
  });

  it("reads and clears one environment's unwatched entries, keeping watched ones", async () => {
    const { store, read, watchUntilResolved } = makeStore({ maxInactiveEntries: 8 });
    activeStore = store;
    (await watchUntilResolved(turn(1)))();
    const releaseWatched = await watchUntilResolved(turn(2));
    (await watchUntilResolved(turn(1, environmentB)))();

    expect(store.readUnwatchedCheckpointDiffResults(environmentA).map((r) => r.diff)).toEqual([
      "patch-1",
    ]);
    store.clearUnwatchedCheckpointDiffsForEnvironment(environmentA);
    expect(read(turn(1)).data).toBeNull();
    expect(read(turn(2)).data?.diff).toBe("patch-2");
    expect(read(turn(1, environmentB)).data?.diff).toBe("patch-1");
    releaseWatched();
  });

  it("supersedes older keys of the same slot", async () => {
    const { store, read, watchUntilResolved } = makeStore({ maxInactiveEntries: 8 });
    activeStore = store;
    const conversation = (count: number): CheckpointDiffInput => ({
      environmentId: environmentA,
      threadId,
      fromTurnCount: 0,
      toTurnCount: count,
      ignoreWhitespace: false,
      cacheSlot: "conversation",
    });
    (await watchUntilResolved(conversation(1)))();
    const release = await watchUntilResolved(conversation(2));
    expect(read(conversation(1)).data).toBeNull();
    release();
    expect(read(conversation(2)).data?.diff).toBe("conversation-2");
  });
});
