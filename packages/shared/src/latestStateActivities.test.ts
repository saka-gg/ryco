import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  claudeContextUsageActivityId,
  LATEST_STATE_ACTIVITY_GROUPS,
  latestStateCompactionKey,
  type LatestStateCarry,
  type LatestStateEventRow,
  liveCoalescingActivityKey,
  LOG_COMPACTION_ACTIVITY_KINDS,
  reasoningActivityId,
  selectSupersededLatestStateEvents,
  subagentMessageActivityId,
  taskProgressActivityId,
  taskUsageActivityId,
  toolProgressActivityId,
} from "./latestStateActivities.ts";
import { inheritedItemId } from "./threadFork.ts";

const THREAD = "thread-a";
const OTHER = "thread-b";

describe("latest-state groups", () => {
  it("compacts exactly the four replace-by-id kinds, never the context-window gauge", () => {
    expect(LOG_COMPACTION_ACTIVITY_KINDS).toEqual([
      "task.progress",
      "tool.progress",
      "agent.message",
      "reasoning",
    ]);
    expect(LATEST_STATE_ACTIVITY_GROUPS["context-window"].logCompaction).toBe(false);
  });

  it("classifies every writer's id into its stream, and nothing else", () => {
    const cases = [
      { kind: "task.progress", id: taskProgressActivityId(THREAD, "task-1") },
      { kind: "task.progress", id: taskUsageActivityId(THREAD, "task-1") },
      { kind: "tool.progress", id: toolProgressActivityId(THREAD, "task-1") },
      {
        kind: "agent.message",
        id: subagentMessageActivityId({
          threadId: THREAD,
          providerThreadId: "provider-thread",
          providerItemId: "item-1",
        }),
      },
      { kind: "reasoning", id: reasoningActivityId(THREAD, "turn-1", "segment-1") },
      { kind: "reasoning", id: reasoningActivityId(THREAD, null, "segment-1") },
    ] as const;
    for (const activity of cases) {
      expect(latestStateCompactionKey(THREAD, activity)).toBe(`${THREAD}\u0000${activity.id}`);
      // The same id appended to another stream was not minted for it.
      expect(latestStateCompactionKey(OTHER, activity)).toBeNull();
      // A fork's inherited copy is history of the fork, never compacted.
      const inherited = inheritedItemId({
        forkThreadId: OTHER,
        sourceThreadId: THREAD,
        sourceItemId: activity.id,
      });
      expect(latestStateCompactionKey(OTHER, { kind: activity.kind, id: inherited })).toBeNull();
      expect(latestStateCompactionKey(THREAD, { kind: activity.kind, id: inherited })).toBeNull();
    }
  });

  it("never compacts context-window gauges, unknown kinds or foreign ids", () => {
    expect(
      latestStateCompactionKey(THREAD, {
        kind: "context-window.updated",
        id: claudeContextUsageActivityId(THREAD),
      }),
    ).toBeNull();
    expect(
      latestStateCompactionKey(THREAD, {
        kind: "tool.updated",
        id: taskProgressActivityId(THREAD, "task-1"),
      }),
    ).toBeNull();
    // A kind/id mismatch: a progress kind under an id another writer minted.
    expect(
      latestStateCompactionKey(THREAD, {
        kind: "reasoning",
        id: taskProgressActivityId(THREAD, "task-1"),
      }),
    ).toBeNull();
    expect(latestStateCompactionKey(THREAD, { kind: "task.progress", id: "imported-1" })).toBe(
      null,
    );
    expect(latestStateCompactionKey(THREAD, { kind: null, id: "x" })).toBeNull();
    expect(latestStateCompactionKey(THREAD, { kind: "task.progress", id: null })).toBeNull();
    // A thread id that only shares a prefix with the stream is not the stream.
    expect(
      latestStateCompactionKey("thread", {
        kind: "task.progress",
        id: taskProgressActivityId("thread-a", "task-1"),
      }),
    ).toBeNull();
  });
});

describe("liveCoalescingActivityKey", () => {
  it("keeps today's live frame coalescing, kind-based and independent of the id", () => {
    const table = [
      { kind: "task.progress", id: "any-1", payload: {}, expected: "any-1" },
      { kind: "tool.progress", id: "any-2", payload: null, expected: "any-2" },
      { kind: "agent.message", id: "m", payload: { streaming: true }, expected: "m" },
      { kind: "agent.message", id: "m", payload: { streaming: false }, expected: null },
      { kind: "agent.message", id: "m", payload: {}, expected: null },
      { kind: "agent.message", id: "m", payload: null, expected: null },
      { kind: "context-window.updated", id: "event-1", payload: {}, expected: "event-1" },
      { kind: "reasoning", id: "r", payload: {}, expected: null },
      { kind: "tool.started", id: "t", payload: {}, expected: null },
    ] as const;
    for (const entry of table) {
      expect(liveCoalescingActivityKey(entry), JSON.stringify(entry)).toBe(entry.expected);
    }
  });
});

const row = (sequence: number, id: string, streamId = THREAD): LatestStateEventRow => ({
  sequence,
  streamId,
  activityId: id,
  kind: "task.progress",
  bytes: sequence * 10,
});

describe("selectSupersededLatestStateEvents", () => {
  it("keeps the newest event per key and points every deletion at it", () => {
    const a = taskProgressActivityId(THREAD, "a");
    const b = taskProgressActivityId(THREAD, "b");
    const carry: LatestStateCarry = new Map();
    const result = selectSupersededLatestStateEvents(
      [row(1, a), row(2, b), row(3, a), row(4, a), row(5, "foreign-id")],
      carry,
    );
    expect(result.deletions).toEqual([
      { sequence: 1, bytes: 10, supersededBy: 4 },
      { sequence: 3, bytes: 30, supersededBy: 4 },
    ]);
    expect([...result.survivors]).toEqual([4]);
    expect([...carry.values()].map((entry) => entry.sequence).toSorted()).toEqual([2, 4]);
  });

  it("carries survivors across windows", () => {
    const a = taskProgressActivityId(THREAD, "a");
    const carry: LatestStateCarry = new Map();
    expect(selectSupersededLatestStateEvents([row(1, a)], carry).deletions).toEqual([]);
    expect(selectSupersededLatestStateEvents([row(7, a)], carry).deletions).toEqual([
      { sequence: 1, bytes: 10, supersededBy: 7 },
    ]);
  });

  it("evicts the least recently seen key, leaving its event in place", () => {
    const a = taskProgressActivityId(THREAD, "a");
    const b = taskProgressActivityId(THREAD, "b");
    const carry: LatestStateCarry = new Map();
    const result = selectSupersededLatestStateEvents(
      [row(1, a), row(2, b), row(3, b), row(4, a)],
      carry,
      1,
    );
    // `a` was evicted when `b` arrived, so its first version stays.
    expect(result.deletions.map((entry) => entry.sequence)).toEqual([2]);
  });

  const arbitraryRows = fc
    .array(
      fc.record({
        stream: fc.constantFrom(THREAD, OTHER),
        task: fc.integer({ min: 0, max: 4 }),
        compactable: fc.boolean(),
        bytes: fc.integer({ min: 1, max: 5_000 }),
      }),
      { maxLength: 200 },
    )
    .map((entries) =>
      entries.map((entry, index): LatestStateEventRow => ({
        sequence: index + 1,
        streamId: entry.stream,
        activityId: taskProgressActivityId(entry.stream, `task-${entry.task}`),
        kind: entry.compactable ? "task.progress" : "context-window.updated",
        bytes: entry.bytes,
      })),
    );

  const selectInWindows = (
    rows: ReadonlyArray<LatestStateEventRow>,
    windowSize: number,
    capacity: number,
  ) => {
    const carry: LatestStateCarry = new Map();
    const deletions = new Map<number, number>();
    for (let start = 0; start < rows.length; start += windowSize) {
      const window = rows.slice(start, start + windowSize);
      for (const deletion of selectSupersededLatestStateEvents(window, carry, capacity).deletions) {
        deletions.set(deletion.sequence, deletion.supersededBy);
      }
    }
    return deletions;
  };

  it("bounded carries only ever delete less, and every deletion has a later kept survivor", () => {
    fc.assert(
      fc.property(
        arbitraryRows,
        fc.integer({ min: 1, max: 30 }),
        fc.integer({ min: 0, max: 6 }),
        (rows, windowSize, capacity) => {
          const unbounded = selectInWindows(rows, windowSize, Number.POSITIVE_INFINITY);
          const bounded = selectInWindows(rows, windowSize, capacity);
          const keyOf = (sequence: number) => {
            const entry = rows[sequence - 1]!;
            return latestStateCompactionKey(entry.streamId, {
              id: entry.activityId,
              kind: entry.kind,
            });
          };
          for (const [sequence, survivor] of bounded) {
            expect(unbounded.has(sequence)).toBe(true);
            expect(survivor).toBeGreaterThan(sequence);
            expect(keyOf(sequence)).not.toBeNull();
            expect(keyOf(survivor)).toBe(keyOf(sequence));
            // A later window may supersede the survivor in turn; the chain ends at a kept event.
            let kept = survivor;
            while (bounded.has(kept)) kept = bounded.get(kept)!;
            expect(keyOf(kept)).toBe(keyOf(sequence));
          }
          // Unbounded: exactly every compactable event but the newest of its key goes.
          const newestByKey = new Map<string, number>();
          for (const entry of rows) {
            const key = keyOf(entry.sequence);
            if (key !== null) newestByKey.set(key, entry.sequence);
          }
          for (const entry of rows) {
            const key = keyOf(entry.sequence);
            const expected = key !== null && newestByKey.get(key) !== entry.sequence;
            expect(unbounded.has(entry.sequence)).toBe(expected);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
