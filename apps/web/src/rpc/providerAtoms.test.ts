import { EnvironmentId, type EnvironmentApi, ThreadId } from "@ryco/contracts";
import { Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as environmentApi from "../environmentApi";
import { appAtomRegistry } from "@ryco/client-runtime/rpc";
import {
  checkpointDiffCacheKey,
  checkpointDiffRetryDelay,
  checkpointDiffStateAtom,
  clearCheckpointDiffCacheForEnvironment,
  decodeCheckpointDiffRequest,
  evictCheckpointDiffsForThread,
  executeCheckpointDiffRequest,
  invalidateAllCheckpointDiffs,
  invalidateCheckpointDiff,
  isCheckpointDiffEnabled,
  MAX_INACTIVE_CHECKPOINT_DIFF_CHARS,
  MAX_INACTIVE_CHECKPOINT_DIFF_ENTRIES,
  normalizeCheckpointErrorMessage,
  resetCheckpointDiffStateForTests,
  shouldRetryCheckpointDiff,
  watchCheckpointDiff,
  type CheckpointDiffInput,
} from "./providerAtoms";

const threadId = ThreadId.make("thread-id");
const environmentId = EnvironmentId.make("environment-local");

function mockOrchestrationApi(input: {
  getTurnDiff: ReturnType<typeof vi.fn>;
  getFullThreadDiff: ReturnType<typeof vi.fn>;
}) {
  vi.spyOn(environmentApi, "ensureEnvironmentApi").mockReturnValue({
    orchestration: {
      getTurnDiff: input.getTurnDiff,
      getFullThreadDiff: input.getFullThreadDiff,
    },
  } as unknown as EnvironmentApi);
}

function readState(input: CheckpointDiffInput) {
  return appAtomRegistry.get(checkpointDiffStateAtom(checkpointDiffCacheKey(input)));
}

afterEach(() => {
  resetCheckpointDiffStateForTests();
  vi.restoreAllMocks();
});

describe("checkpointDiffCacheKey", () => {
  it("includes cacheScope so reused turn counts do not collide", () => {
    const baseInput = {
      environmentId,
      threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: false,
    } as const;

    expect(checkpointDiffCacheKey({ ...baseInput, cacheScope: "turn:old-turn" })).not.toEqual(
      checkpointDiffCacheKey({ ...baseInput, cacheScope: "turn:new-turn" }),
    );
  });

  it("includes ignoreWhitespace so normal and whitespace-hidden diffs do not collide", () => {
    const baseInput = {
      environmentId,
      threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
      cacheScope: "turn:abc",
    } as const;

    expect(checkpointDiffCacheKey({ ...baseInput, ignoreWhitespace: false })).not.toEqual(
      checkpointDiffCacheKey({ ...baseInput, ignoreWhitespace: true }),
    );
  });
});

describe("decodeCheckpointDiffRequest", () => {
  it("decodes a turn diff for non-zero ranges", () => {
    const decoded = decodeCheckpointDiffRequest({
      environmentId,
      threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: false,
    });
    expect(Option.isSome(decoded)).toBe(true);
    expect(Option.getOrThrow(decoded).kind).toBe("turnDiff");
  });

  it("decodes a full thread diff when the range starts from zero", () => {
    const decoded = decodeCheckpointDiffRequest({
      environmentId,
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    expect(Option.isSome(decoded)).toBe(true);
    expect(Option.getOrThrow(decoded).kind).toBe("fullThreadDiff");
  });

  it("is None for invalid ranges", () => {
    const decoded = decodeCheckpointDiffRequest({
      environmentId,
      threadId,
      fromTurnCount: 4,
      toTurnCount: 3,
      ignoreWhitespace: false,
    });
    expect(Option.isNone(decoded)).toBe(true);
  });
});

describe("isCheckpointDiffEnabled", () => {
  it("requires an environment, thread, valid range, and the enabled flag", () => {
    const valid = {
      environmentId,
      threadId,
      fromTurnCount: 1,
      toTurnCount: 2,
      ignoreWhitespace: false,
    } as const;

    expect(isCheckpointDiffEnabled(valid)).toBe(true);
    expect(isCheckpointDiffEnabled({ ...valid, enabled: false })).toBe(false);
    expect(isCheckpointDiffEnabled({ ...valid, environmentId: null })).toBe(false);
    expect(isCheckpointDiffEnabled({ ...valid, threadId: null })).toBe(false);
    expect(isCheckpointDiffEnabled({ ...valid, fromTurnCount: 4, toTurnCount: 3 })).toBe(false);
  });
});

describe("executeCheckpointDiffRequest", () => {
  it("forwards the checkpoint range to the turn diff API by default", async () => {
    const getTurnDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    const getFullThreadDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    mockOrchestrationApi({ getTurnDiff, getFullThreadDiff });

    await executeCheckpointDiffRequest({
      environmentId,
      threadId,
      fromTurnCount: 3,
      toTurnCount: 4,
      ignoreWhitespace: false,
      cacheScope: "turn:abc",
    });

    expect(getTurnDiff).toHaveBeenCalledWith({
      threadId,
      fromTurnCount: 3,
      toTurnCount: 4,
      ignoreWhitespace: false,
    });
    expect(getFullThreadDiff).not.toHaveBeenCalled();
  });

  it("forwards whitespace-hidden checkpoint ranges to the turn diff API", async () => {
    const getTurnDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    const getFullThreadDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    mockOrchestrationApi({ getTurnDiff, getFullThreadDiff });

    await executeCheckpointDiffRequest({
      environmentId,
      threadId,
      fromTurnCount: 3,
      toTurnCount: 4,
      ignoreWhitespace: true,
      cacheScope: "turn:abc",
    });

    expect(getTurnDiff).toHaveBeenCalledWith({
      threadId,
      fromTurnCount: 3,
      toTurnCount: 4,
      ignoreWhitespace: true,
    });
    expect(getFullThreadDiff).not.toHaveBeenCalled();
  });

  it("uses the full thread diff API when the range starts from zero", async () => {
    const getTurnDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    const getFullThreadDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    mockOrchestrationApi({ getTurnDiff, getFullThreadDiff });

    await executeCheckpointDiffRequest({
      environmentId,
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      ignoreWhitespace: true,
      cacheScope: "thread:all",
    });

    expect(getFullThreadDiff).toHaveBeenCalledWith({
      threadId,
      toTurnCount: 2,
      ignoreWhitespace: true,
    });
    expect(getTurnDiff).not.toHaveBeenCalled();
  });

  it("fails fast on invalid range and does not call provider RPC", async () => {
    const getTurnDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    const getFullThreadDiff = vi.fn().mockResolvedValue({ diff: "patch" });
    mockOrchestrationApi({ getTurnDiff, getFullThreadDiff });

    await expect(
      executeCheckpointDiffRequest({
        environmentId,
        threadId,
        fromTurnCount: 4,
        toTurnCount: 3,
        ignoreWhitespace: false,
        cacheScope: "turn:invalid",
      }),
    ).rejects.toThrow("Checkpoint diff is unavailable.");
    expect(getTurnDiff).not.toHaveBeenCalled();
    expect(getFullThreadDiff).not.toHaveBeenCalled();
  });
});

describe("checkpoint retry/backoff", () => {
  it("retries checkpoint-not-ready errors longer than generic failures", () => {
    expect(
      shouldRetryCheckpointDiff(
        1,
        new Error("Checkpoint turn count 2 exceeds current turn count 1."),
      ),
    ).toBe(true);
    expect(
      shouldRetryCheckpointDiff(
        11,
        new Error("Filesystem checkpoint is unavailable for turn 2 in thread thread-1."),
      ),
    ).toBe(true);
    expect(
      shouldRetryCheckpointDiff(
        12,
        new Error("Filesystem checkpoint is unavailable for turn 2 in thread thread-1."),
      ),
    ).toBe(false);
    expect(shouldRetryCheckpointDiff(2, new Error("Something else failed."))).toBe(true);
    expect(shouldRetryCheckpointDiff(3, new Error("Something else failed."))).toBe(false);
  });

  it("backs off longer for checkpoint-not-ready errors", () => {
    const checkpointDelay = checkpointDiffRetryDelay(
      4,
      new Error("Checkpoint turn count 2 exceeds current turn count 1."),
    );
    const genericDelay = checkpointDiffRetryDelay(4, new Error("Network failure"));
    expect(checkpointDelay).toBeGreaterThan(genericDelay);
  });
});

describe("normalizeCheckpointErrorMessage", () => {
  it("maps git-repo errors to a friendly message", () => {
    expect(normalizeCheckpointErrorMessage(new Error("fatal: not a git repository"))).toBe(
      "Turn diffs are unavailable because this project is not a git repository.",
    );
  });

  it("falls back to a default message for empty errors", () => {
    expect(normalizeCheckpointErrorMessage(new Error(""))).toBe("Failed to load checkpoint diff.");
  });

  it("passes through unknown messages unchanged", () => {
    expect(normalizeCheckpointErrorMessage("boom")).toBe("boom");
  });
});

describe("watchCheckpointDiff", () => {
  const input: CheckpointDiffInput = {
    environmentId,
    threadId,
    fromTurnCount: 1,
    toTurnCount: 2,
    ignoreWhitespace: false,
    cacheScope: "turn:abc",
  };

  it("resolves the checkpoint diff into atom state", async () => {
    const getTurnDiff = vi
      .fn()
      .mockResolvedValue({ diff: "patch", threadId, fromTurnCount: 1, toTurnCount: 2 });
    const getFullThreadDiff = vi.fn();
    mockOrchestrationApi({ getTurnDiff, getFullThreadDiff });

    const unwatch = watchCheckpointDiff(input);
    await vi.waitFor(() => {
      expect(readState(input).data?.diff).toBe("patch");
    });
    expect(readState(input).isLoading).toBe(false);
    expect(readState(input).error).toBeNull();
    unwatch();
  });

  it("refetches when the thread's checkpoint cache is invalidated", async () => {
    const getTurnDiff = vi
      .fn()
      .mockResolvedValue({ diff: "patch", threadId, fromTurnCount: 1, toTurnCount: 2 });
    const getFullThreadDiff = vi.fn();
    mockOrchestrationApi({ getTurnDiff, getFullThreadDiff });

    const unwatch = watchCheckpointDiff(input);
    await vi.waitFor(() => {
      expect(readState(input).data?.diff).toBe("patch");
    });
    expect(getTurnDiff).toHaveBeenCalledTimes(1);

    invalidateCheckpointDiff(threadId);
    await vi.waitFor(() => {
      expect(getTurnDiff).toHaveBeenCalledTimes(2);
    });
    unwatch();
  });

  it("surfaces a normalized error after exhausting generic retries", async () => {
    const getTurnDiff = vi.fn().mockRejectedValue(new Error("boom"));
    const getFullThreadDiff = vi.fn();
    mockOrchestrationApi({ getTurnDiff, getFullThreadDiff });

    const unwatch = watchCheckpointDiff(input);
    await vi.waitFor(
      () => {
        expect(readState(input).error?.message).toBe("boom");
      },
      { timeout: 2_000 },
    );
    expect(getTurnDiff).toHaveBeenCalledTimes(3);
    unwatch();
  });

  it("invalidateAllCheckpointDiffs refetches active watchers", async () => {
    const getTurnDiff = vi
      .fn()
      .mockResolvedValue({ diff: "patch", threadId, fromTurnCount: 1, toTurnCount: 2 });
    const getFullThreadDiff = vi.fn();
    mockOrchestrationApi({ getTurnDiff, getFullThreadDiff });

    const unwatch = watchCheckpointDiff(input);
    await vi.waitFor(() => {
      expect(getTurnDiff).toHaveBeenCalledTimes(1);
    });

    invalidateAllCheckpointDiffs();
    await vi.waitFor(() => {
      expect(getTurnDiff).toHaveBeenCalledTimes(2);
    });
    unwatch();
  });
});

describe("checkpoint diff cache bounds", () => {
  function turnInput(turn: number, extra?: Partial<CheckpointDiffInput>): CheckpointDiffInput {
    return {
      environmentId,
      threadId,
      fromTurnCount: turn - 1,
      toTurnCount: turn,
      ignoreWhitespace: false,
      cacheScope: `turn:${turn}`,
      ...extra,
    };
  }

  function mockDiffs(diffForInput: (input: { toTurnCount: number }) => string) {
    const getTurnDiff = vi.fn((request: { fromTurnCount: number; toTurnCount: number }) =>
      Promise.resolve({
        diff: diffForInput(request),
        threadId,
        fromTurnCount: request.fromTurnCount,
        toTurnCount: request.toTurnCount,
      }),
    );
    const getFullThreadDiff = vi.fn((request: { toTurnCount: number }) =>
      Promise.resolve({
        diff: diffForInput(request),
        threadId,
        fromTurnCount: 0,
        toTurnCount: request.toTurnCount,
      }),
    );
    mockOrchestrationApi({ getTurnDiff, getFullThreadDiff });
    return { getTurnDiff, getFullThreadDiff };
  }

  async function watchUntilResolved(input: CheckpointDiffInput) {
    const unwatch = watchCheckpointDiff(input);
    await vi.waitFor(() => {
      expect(readState(input).data).not.toBeNull();
    });
    return unwatch;
  }

  it("keeps recently released diffs and evicts the oldest past the entry bound", async () => {
    const { getTurnDiff } = mockDiffs((request) => `patch-${request.toTurnCount}`);
    const total = MAX_INACTIVE_CHECKPOINT_DIFF_ENTRIES + 2;
    for (let turn = 1; turn <= total; turn += 1) {
      (await watchUntilResolved(turnInput(turn)))();
    }

    // The two least recently released entries were dropped and read as unfetched.
    expect(readState(turnInput(1))).toEqual({ data: null, error: null, isLoading: true });
    expect(readState(turnInput(2)).data).toBeNull();
    expect(readState(turnInput(3)).data?.diff).toBe("patch-3");
    expect(readState(turnInput(total)).data?.diff).toBe(`patch-${total}`);

    // A retained entry re-opens without a request; an evicted one refetches.
    const callsBefore = getTurnDiff.mock.calls.length;
    const unwatchRetained = watchCheckpointDiff(turnInput(total));
    expect(getTurnDiff.mock.calls.length).toBe(callsBefore);
    unwatchRetained();
    (await watchUntilResolved(turnInput(2)))();
    expect(getTurnDiff.mock.calls.length).toBe(callsBefore + 1);
  });

  it("evicts released diffs once their retained characters exceed the budget", async () => {
    const largeLength = Math.floor(MAX_INACTIVE_CHECKPOINT_DIFF_CHARS / 2) + 1;
    mockDiffs((request) => `${request.toTurnCount}`.padEnd(largeLength, "x"));
    (await watchUntilResolved(turnInput(1)))();
    (await watchUntilResolved(turnInput(2)))();

    expect(readState(turnInput(1)).data).toBeNull();
    expect(readState(turnInput(2)).data?.diff.length).toBe(largeLength);
  });

  it("never evicts a diff that is still watched", async () => {
    mockDiffs((request) => `patch-${request.toTurnCount}`);
    const unwatchFirst = await watchUntilResolved(turnInput(1));
    for (let turn = 2; turn <= MAX_INACTIVE_CHECKPOINT_DIFF_ENTRIES + 3; turn += 1) {
      (await watchUntilResolved(turnInput(turn)))();
    }
    expect(readState(turnInput(1)).data?.diff).toBe("patch-1");
    unwatchFirst();
  });

  it("drops a superseded conversation diff as soon as the newer one is watched", async () => {
    mockDiffs((request) => `conversation-${request.toTurnCount}`);
    const conversation = (turns: number): CheckpointDiffInput => ({
      environmentId,
      threadId,
      fromTurnCount: 0,
      toTurnCount: turns,
      ignoreWhitespace: false,
      cacheScope: `conversation:${Array.from({ length: turns }, (_, index) => index).join(",")}`,
      cacheSlot: "conversation",
    });

    const unwatchFirst = await watchUntilResolved(conversation(1));
    const unwatchSecond = await watchUntilResolved(conversation(2));
    // Still on screen until its watcher releases it.
    expect(readState(conversation(1)).data?.diff).toBe("conversation-1");
    unwatchFirst();
    expect(readState(conversation(1)).data).toBeNull();
    expect(readState(conversation(2)).data?.diff).toBe("conversation-2");
    unwatchSecond();
    // The latest conversation diff stays cached for a quick reopen.
    expect(readState(conversation(2)).data?.diff).toBe("conversation-2");

    // A turn diff from the same thread is not part of the slot.
    (await watchUntilResolved(turnInput(1)))();
    const unwatchThird = await watchUntilResolved(conversation(3));
    expect(readState(conversation(2)).data).toBeNull();
    expect(readState(turnInput(1)).data?.diff).toBe("conversation-1");
    unwatchThird();
  });

  it("evicts a thread's diffs on archive, deferring the ones still on screen", async () => {
    mockDiffs((request) => `patch-${request.toTurnCount}`);
    (await watchUntilResolved(turnInput(1)))();
    const unwatchSecond = await watchUntilResolved(turnInput(2));

    evictCheckpointDiffsForThread(threadId);
    expect(readState(turnInput(1)).data).toBeNull();
    expect(readState(turnInput(2)).data?.diff).toBe("patch-2");

    unwatchSecond();
    expect(readState(turnInput(2)).data).toBeNull();
  });

  it("clears one environment's unwatched diffs and leaves the others cached", async () => {
    const otherEnvironmentId = EnvironmentId.make("environment-other");
    const { getTurnDiff } = mockDiffs((request) => `patch-${request.toTurnCount}`);

    (await watchUntilResolved(turnInput(2)))();
    const unwatchOnScreen = await watchUntilResolved(turnInput(3));
    (await watchUntilResolved(turnInput(2, { environmentId: otherEnvironmentId })))();

    clearCheckpointDiffCacheForEnvironment(environmentId);

    // The released diff of the cleared environment reads as unfetched again.
    expect(readState(turnInput(2))).toEqual({ data: null, error: null, isLoading: true });
    // A diff still on screen survives the clear.
    expect(readState(turnInput(3)).data?.diff).toBe("patch-3");
    // Another environment's diff is untouched and reopens without a request.
    const otherInput = turnInput(2, { environmentId: otherEnvironmentId });
    expect(readState(otherInput).data?.diff).toBe("patch-2");
    const callsBefore = getTurnDiff.mock.calls.length;
    watchCheckpointDiff(otherInput)();
    expect(getTurnDiff.mock.calls.length).toBe(callsBefore);

    // The cleared environment's diff refetches on the next watch.
    (await watchUntilResolved(turnInput(2)))();
    expect(getTurnDiff.mock.calls.length).toBe(callsBefore + 1);
    unwatchOnScreen();
  });
});
