import { EnvironmentId } from "@ryco/contracts";
import { createEnvironmentEventBatcher } from "@ryco/client-runtime/state/threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  HIDDEN_STREAM_BATCH_DELAY_MS,
  VISIBLE_STREAM_BATCH_FALLBACK_MS,
  readStreamBatchFallbackDelayMs,
  resetStreamBatchTimingForTests,
  scheduleStreamBatchFrame,
} from "./streamBatchTiming";

const environmentId = EnvironmentId.make("environment-stream-batch");
/** A streaming thread sends a delta about every 32 ms: ~30 WebSocket messages a second. */
const DELTA_INTERVAL_MS = 33;
const STREAM_SECONDS = 10;

let visibilityState: DocumentVisibilityState = "visible";
let frames: Array<() => void> = [];

beforeEach(() => {
  vi.useFakeTimers();
  visibilityState = "visible";
  frames = [];
  resetStreamBatchTimingForTests();
  vi.stubGlobal("document", {
    get visibilityState() {
      return visibilityState;
    },
  });
  // A hidden document runs no animation frames; the queued ones run on its next visible frame.
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(() => callback(0));
    return frames.length;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function runFrames(): void {
  const due = frames;
  frames = [];
  for (const frame of due) frame();
}

/** Streams ~30 deltas a second for `STREAM_SECONDS` into a batcher and counts its store commits. */
function countHiddenCommits(options: {
  readonly scheduleFrame: (callback: () => void) => void;
  readonly fallbackDelayMs?: () => number;
}): { commits: number; events: number } {
  let commits = 0;
  let events = 0;
  const batcher = createEnvironmentEventBatcher<number>({
    apply: (_environmentId, batch) => {
      commits += 1;
      events += batch.length;
    },
    scheduleFrame: options.scheduleFrame,
    ...(options.fallbackDelayMs === undefined ? {} : { fallbackDelayMs: options.fallbackDelayMs }),
    registerStoreBarrier: false,
  });
  const total = (STREAM_SECONDS * 1_000) / DELTA_INTERVAL_MS;
  for (let index = 0; index < total; index += 1) {
    // Each WebSocket message is its own task; its microtasks run before the next.
    batcher.enqueue(environmentId, index);
    vi.advanceTimersByTime(DELTA_INTERVAL_MS);
  }
  vi.advanceTimersByTime(1_000);
  batcher.dispose();
  return { commits, events };
}

describe("stream batch timing", () => {
  it("waits a frame while visible and a longer timer while hidden", () => {
    expect(readStreamBatchFallbackDelayMs()).toBe(VISIBLE_STREAM_BATCH_FALLBACK_MS);
    visibilityState = "hidden";
    expect(readStreamBatchFallbackDelayMs()).toBe(HIDDEN_STREAM_BATCH_DELAY_MS);
  });

  it("commits a hidden document's stream about twice a second instead of once per message", async () => {
    visibilityState = "hidden";
    // Before: a hidden document flushed each message in a microtask (its own commit).
    const microtaskCommits = { commits: 0, events: 0 };
    {
      const batcher = createEnvironmentEventBatcher<number>({
        apply: (_environmentId, batch) => {
          microtaskCommits.commits += 1;
          microtaskCommits.events += batch.length;
        },
        scheduleFrame: (callback) => queueMicrotask(callback),
        registerStoreBarrier: false,
      });
      const total = (STREAM_SECONDS * 1_000) / DELTA_INTERVAL_MS;
      for (let index = 0; index < total; index += 1) {
        batcher.enqueue(environmentId, index);
        await Promise.resolve();
        vi.advanceTimersByTime(DELTA_INTERVAL_MS);
      }
      batcher.dispose();
    }
    const after = countHiddenCommits({
      scheduleFrame: scheduleStreamBatchFrame,
      fallbackDelayMs: readStreamBatchFallbackDelayMs,
    });

    expect(after.events).toBe(microtaskCommits.events);
    const beforePerSecond = microtaskCommits.commits / STREAM_SECONDS;
    const afterPerSecond = after.commits / STREAM_SECONDS;
    expect(beforePerSecond).toBeGreaterThanOrEqual(29);
    expect(afterPerSecond).toBeLessThanOrEqual(2.1);
    console.info(
      `[stream batch] hidden tab store commits per second: before ${beforePerSecond.toFixed(1)}, after ${afterPerSecond.toFixed(1)}`,
    );
  });

  it("applies what a hidden document buffered on its first visible frame", () => {
    visibilityState = "hidden";
    const applied: number[] = [];
    const batcher = createEnvironmentEventBatcher<number>({
      apply: (_environmentId, batch) => applied.push(...batch),
      scheduleFrame: scheduleStreamBatchFrame,
      fallbackDelayMs: readStreamBatchFallbackDelayMs,
      registerStoreBarrier: false,
    });
    batcher.enqueue(environmentId, 1);
    batcher.enqueue(environmentId, 2);
    vi.advanceTimersByTime(HIDDEN_STREAM_BATCH_DELAY_MS - 1);
    expect(applied).toEqual([]);

    visibilityState = "visible";
    runFrames();
    expect(applied).toEqual([1, 2]);
    // The hidden timer that was still waiting finds nothing left to apply.
    vi.advanceTimersByTime(HIDDEN_STREAM_BATCH_DELAY_MS);
    expect(applied).toEqual([1, 2]);
    batcher.dispose();
  });

  it("holds one frame request while hidden, however many batches it commits", () => {
    visibilityState = "hidden";
    const applied: number[] = [];
    const batcher = createEnvironmentEventBatcher<number>({
      apply: (_environmentId, batch) => applied.push(...batch),
      scheduleFrame: scheduleStreamBatchFrame,
      fallbackDelayMs: readStreamBatchFallbackDelayMs,
      registerStoreBarrier: false,
    });
    for (let index = 0; index < 100; index += 1) {
      batcher.enqueue(environmentId, index);
      vi.advanceTimersByTime(HIDDEN_STREAM_BATCH_DELAY_MS);
    }
    expect(applied).toHaveLength(100);
    expect(frames).toHaveLength(1);
    batcher.enqueue(environmentId, 100);
    visibilityState = "visible";
    runFrames();
    expect(applied).toHaveLength(101);
    batcher.dispose();
  });

  it("keeps a visible document's per-frame commits", () => {
    const applied: number[][] = [];
    const batcher = createEnvironmentEventBatcher<number>({
      apply: (_environmentId, batch) => applied.push([...batch]),
      scheduleFrame: scheduleStreamBatchFrame,
      fallbackDelayMs: readStreamBatchFallbackDelayMs,
      registerStoreBarrier: false,
    });
    batcher.enqueue(environmentId, 1);
    batcher.enqueue(environmentId, 2);
    runFrames();
    batcher.enqueue(environmentId, 3);
    vi.advanceTimersByTime(VISIBLE_STREAM_BATCH_FALLBACK_MS);
    expect(applied).toEqual([[1, 2], [3]]);
    batcher.dispose();
  });
});
