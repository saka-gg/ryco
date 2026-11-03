import { describe, expect, it } from "vite-plus/test";
import { TurnId } from "@ryco/contracts";
import {
  createThreadReadingPositionMemory,
  decodeThreadReadingAnchor,
  sameThreadReadingAnchors,
  THREAD_READING_POSITION_CAPACITY,
} from "./readingPosition.ts";

function keysOf(memory: ReturnType<typeof createThreadReadingPositionMemory>): string[] {
  const keys: string[] = [];
  memory.forEach((key) => keys.push(key));
  return keys;
}

/** A clock that ticks once per reading. */
function ticking(start = 1_000) {
  let time = start;
  return () => time++;
}

describe("createThreadReadingPositionMemory", () => {
  it("keeps each thread's anchor apart, environments included", () => {
    const memory = createThreadReadingPositionMemory();
    memory.rememberAnchor("env-a:thread-1", { rowId: "message-4", offsetWithinRow: 32 });
    memory.rememberAnchor("env-b:thread-1", { rowId: "message-9", offsetWithinRow: -12 });

    expect(memory.read("env-a:thread-1")).toMatchObject({
      rowId: "message-4",
      offsetWithinRow: 32,
    });
    expect(memory.read("env-b:thread-1")).toMatchObject({
      rowId: "message-9",
      offsetWithinRow: -12,
    });
    expect(memory.read("env-a:unvisited")).toBeNull();
  });

  it("reports only a changed row, offset or turn, and drops the anchor at the end", () => {
    const memory = createThreadReadingPositionMemory();
    expect(memory.rememberAnchor("thread", { rowId: "row-1", offsetWithinRow: 10 })).toBe(true);
    expect(memory.rememberAnchor("thread", { rowId: "row-1", offsetWithinRow: 10 })).toBe(false);
    expect(memory.rememberAnchor("thread", { rowId: "row-1", offsetWithinRow: 11 })).toBe(true);
    expect(memory.rememberAnchor("thread", { rowId: "row-2", offsetWithinRow: 11 })).toBe(true);
    const turnId = TurnId.make("turn-1");
    expect(memory.rememberAnchor("thread", { rowId: "row-2", offsetWithinRow: 11, turnId })).toBe(
      true,
    );
    expect(memory.read("thread")?.turnId).toBe(turnId);

    expect(memory.rememberAtEnd("thread")).toBe(true);
    expect(memory.read("thread")).toBeNull();
    // Already at its end: nothing changed.
    expect(memory.rememberAtEnd("thread")).toBe(false);
  });

  it("keeps the turns the view watched with the anchor", () => {
    const memory = createThreadReadingPositionMemory();
    const watched = new Set([TurnId.make("turn-1")]);
    memory.rememberAnchor("thread", { rowId: "row-1", offsetWithinRow: 0 }, watched);
    expect(memory.read("thread")?.watchedTurnIds).toBe(watched);
    // A newer set rides along without counting as a change.
    const later = new Set([TurnId.make("turn-1"), TurnId.make("turn-2")]);
    expect(memory.rememberAnchor("thread", { rowId: "row-1", offsetWithinRow: 0 }, later)).toBe(
      false,
    );
    expect(memory.read("thread")?.watchedTurnIds).toBe(later);
  });

  it("evicts the least recently left thread past its capacity", () => {
    const memory = createThreadReadingPositionMemory();
    for (let index = 0; index < THREAD_READING_POSITION_CAPACITY; index += 1) {
      memory.rememberAnchor(`thread-${index}`, { rowId: "row", offsetWithinRow: index });
    }
    // Re-reporting the same anchor still counts as the latest visit.
    expect(memory.rememberAnchor("thread-0", { rowId: "row", offsetWithinRow: 0 })).toBe(false);
    memory.rememberAnchor("thread-new", { rowId: "row", offsetWithinRow: 1 });

    expect(memory.read("thread-0")).not.toBeNull();
    expect(memory.read("thread-1")).toBeNull();
    expect(memory.read("thread-new")).not.toBeNull();
    expect(keysOf(memory)).toHaveLength(THREAD_READING_POSITION_CAPACITY);
  });

  it("stamps when each anchor was last left, re-reports included", () => {
    const memory = createThreadReadingPositionMemory(THREAD_READING_POSITION_CAPACITY, ticking());
    memory.rememberAnchor("a", { rowId: "row", offsetWithinRow: 0 });
    memory.rememberAnchor("b", { rowId: "row", offsetWithinRow: 0 });
    memory.rememberAnchor("a", { rowId: "row", offsetWithinRow: 0 });
    const leftAt: Record<string, number> = {};
    memory.forEach((key, anchor) => {
      leftAt[key] = anchor.leftAt;
    });
    expect(keysOf(memory)).toEqual(["b", "a"]);
    expect(leftAt).toEqual({ b: 1_001, a: 1_002 });
  });

  it("restores saved anchors as older than this session's", () => {
    const memory = createThreadReadingPositionMemory(2, ticking(5_000));
    memory.rememberAnchor("fresh", { rowId: "row-live", offsetWithinRow: 5 });
    memory.restore([
      ["fresh", { rowId: "row-saved", offsetWithinRow: 1, leftAt: 10 }],
      ["saved-1", { rowId: "row-1", offsetWithinRow: 1, leftAt: 20 }],
      ["saved-2", { rowId: "row-2", offsetWithinRow: 2, leftAt: 30 }],
    ]);

    expect(memory.read("fresh")).toMatchObject({ rowId: "row-live", offsetWithinRow: 5 });
    expect(memory.read("saved-1")).toBeNull();
    expect(keysOf(memory)).toEqual(["saved-2", "fresh"]);
  });

  it("keeps the most recently left anchors across records, whichever is read back first", () => {
    // Two environments' records, each saved least recently left first, that
    // together hold more anchors than fit.
    const first = Array.from(
      { length: 3 },
      (_, index) =>
        [
          `env-a:thread-${index}`,
          { rowId: "row", offsetWithinRow: 0, leftAt: 10 + 2 * index },
        ] as const,
    );
    const second = Array.from(
      { length: 2 },
      (_, index) =>
        [
          `env-b:thread-${index}`,
          { rowId: "row", offsetWithinRow: 0, leftAt: 11 + 2 * index },
        ] as const,
    );
    const kept = ["env-a:thread-1", "env-b:thread-1", "env-a:thread-2"];
    for (const order of [
      [first, second],
      [second, first],
    ]) {
      const oneAtATime = createThreadReadingPositionMemory(3);
      for (const record of order) oneAtATime.restore(record);
      expect(keysOf(oneAtATime).toSorted()).toEqual(kept.toSorted());

      const atOnce = createThreadReadingPositionMemory(3);
      atOnce.restore(order.flat());
      expect(keysOf(atOnce).toSorted()).toEqual(kept.toSorted());
    }
  });

  it("orders a visit after a restore after every saved anchor, even one stamped ahead of the clock", () => {
    const memory = createThreadReadingPositionMemory(THREAD_READING_POSITION_CAPACITY, () => 100);
    memory.restore([["saved", { rowId: "row", offsetWithinRow: 0, leftAt: 5_000 }]]);
    memory.rememberAnchor("visited", { rowId: "row", offsetWithinRow: 0 });
    memory.restore([["late", { rowId: "row", offsetWithinRow: 0, leftAt: 4_000 }]]);
    expect(keysOf(memory)).toEqual(["late", "saved", "visited"]);
  });

  it("forgets matching threads and clears", () => {
    const memory = createThreadReadingPositionMemory();
    memory.rememberAnchor("env-a:thread-1", { rowId: "row", offsetWithinRow: 1 });
    memory.rememberAnchor("env-b:thread-1", { rowId: "row", offsetWithinRow: 1 });
    memory.forget((key) => key.startsWith("env-a:"));
    expect(keysOf(memory)).toEqual(["env-b:thread-1"]);
    memory.clear();
    expect(keysOf(memory)).toEqual([]);
  });
});

describe("decodeThreadReadingAnchor", () => {
  it("reads back a saved anchor and rejects anything else", () => {
    expect(
      decodeThreadReadingAnchor({
        rowId: "row",
        offsetWithinRow: -4,
        turnId: "turn-1",
        leftAt: 42,
        extra: 1,
      }),
    ).toEqual({ rowId: "row", offsetWithinRow: -4, turnId: "turn-1", leftAt: 42 });
    // A pixel offset saved by an older build is not an anchor.
    expect(decodeThreadReadingAnchor(240)).toBeNull();
    expect(decodeThreadReadingAnchor(null)).toBeNull();
    expect(decodeThreadReadingAnchor({ rowId: "", offsetWithinRow: 0 })).toBeNull();
    expect(decodeThreadReadingAnchor({ rowId: "x".repeat(513), offsetWithinRow: 0 })).toBeNull();
    expect(decodeThreadReadingAnchor({ rowId: "row", offsetWithinRow: Number.NaN })).toBeNull();
    expect(decodeThreadReadingAnchor({ rowId: "row", offsetWithinRow: 2_000_000 })).toBeNull();
  });

  it("keeps an anchor whose turn or time does not read back, without them", () => {
    expect(
      decodeThreadReadingAnchor({ rowId: "row", offsetWithinRow: 3, turnId: 7, leftAt: "late" }),
    ).toEqual({ rowId: "row", offsetWithinRow: 3, leftAt: 0 });
    expect(
      decodeThreadReadingAnchor({ rowId: "row", offsetWithinRow: 3, turnId: " turn ", leftAt: -1 }),
    ).toEqual({ rowId: "row", offsetWithinRow: 3, leftAt: 0 });
  });
});

describe("sameThreadReadingAnchors", () => {
  it("compares anchors by value, not by when they were left", () => {
    const anchor = { rowId: "row", offsetWithinRow: 3, leftAt: 1 };
    expect(sameThreadReadingAnchors({ a: anchor }, { a: { ...anchor, leftAt: 2 } })).toBe(true);
    expect(sameThreadReadingAnchors({ a: anchor }, { a: { ...anchor, offsetWithinRow: 4 } })).toBe(
      false,
    );
    expect(
      sameThreadReadingAnchors({ a: anchor }, { a: { ...anchor, turnId: TurnId.make("turn") } }),
    ).toBe(false);
    expect(sameThreadReadingAnchors({ a: anchor }, { b: anchor })).toBe(false);
    expect(sameThreadReadingAnchors({ a: anchor }, {})).toBe(false);
  });
});
