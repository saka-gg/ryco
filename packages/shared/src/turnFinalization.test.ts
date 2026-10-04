import { describe, expect, it } from "vite-plus/test";

import {
  checkpointStatusToTurnState,
  isStickyTurnState,
  laterIsoTimestamp,
  latestIsoTimestamp,
  mergeReleasedTurn,
} from "./turnFinalization.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z";
const T2 = "2026-01-01T00:00:02.000Z";
const T3 = "2026-01-01T00:00:03.000Z";

describe("laterIsoTimestamp", () => {
  it("returns next when current is null", () => {
    expect(laterIsoTimestamp(null, T1)).toBe(T1);
  });

  it("returns the later timestamp and keeps current on ties", () => {
    expect(laterIsoTimestamp(T1, T2)).toBe(T2);
    expect(laterIsoTimestamp(T2, T1)).toBe(T2);
    const sameInstant = "2026-01-01T00:00:01Z";
    expect(laterIsoTimestamp(T1, sameInstant)).toBe(T1);
  });

  it("tolerates unparsable values", () => {
    expect(laterIsoTimestamp("not-a-date", T1)).toBe(T1);
    expect(laterIsoTimestamp(T1, "not-a-date")).toBe(T1);
  });
});

describe("latestIsoTimestamp", () => {
  it("skips null and undefined values", () => {
    expect(latestIsoTimestamp(T1, null, undefined, T3, T2)).toBe(T3);
    expect(latestIsoTimestamp(T2)).toBe(T2);
  });
});

describe("isStickyTurnState", () => {
  it("treats only interrupted and error as sticky", () => {
    expect(isStickyTurnState("interrupted")).toBe(true);
    expect(isStickyTurnState("error")).toBe(true);
    expect(isStickyTurnState("completed")).toBe(false);
    expect(isStickyTurnState("running")).toBe(false);
    expect(isStickyTurnState("pending")).toBe(false);
  });
});

describe("checkpointStatusToTurnState", () => {
  it("maps checkpoint statuses to terminal turn states", () => {
    expect(checkpointStatusToTurnState("ready")).toBe("completed");
    expect(checkpointStatusToTurnState("missing")).toBe("interrupted");
    expect(checkpointStatusToTurnState("error")).toBe("error");
  });
});

describe("mergeReleasedTurn", () => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly current: {
      readonly state: string;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
    };
    readonly released: {
      readonly state: "completed" | "error" | "interrupted";
      completedAt: string;
    };
    readonly expected: { readonly state: string; readonly completedAt: string };
  }> = [
    {
      name: "running → completed",
      current: { state: "running", startedAt: T0, completedAt: null },
      released: { state: "completed", completedAt: T2 },
      expected: { state: "completed", completedAt: T2 },
    },
    {
      name: "running → error",
      current: { state: "running", startedAt: T0, completedAt: null },
      released: { state: "error", completedAt: T2 },
      expected: { state: "error", completedAt: T2 },
    },
    {
      name: "running → interrupted",
      current: { state: "running", startedAt: T0, completedAt: null },
      released: { state: "interrupted", completedAt: T2 },
      expected: { state: "interrupted", completedAt: T2 },
    },
    {
      name: "pending → completed",
      current: { state: "pending", startedAt: null, completedAt: null },
      released: { state: "completed", completedAt: T2 },
      expected: { state: "completed", completedAt: T2 },
    },
    {
      name: "completed → error takes the later completedAt",
      current: { state: "completed", startedAt: T0, completedAt: T3 },
      released: { state: "error", completedAt: T2 },
      expected: { state: "error", completedAt: T3 },
    },
    {
      name: "completed → error with a later release",
      current: { state: "completed", startedAt: T0, completedAt: T1 },
      released: { state: "error", completedAt: T2 },
      expected: { state: "error", completedAt: T2 },
    },
    {
      name: "completed → interrupted",
      current: { state: "completed", startedAt: T0, completedAt: T1 },
      released: { state: "interrupted", completedAt: T2 },
      expected: { state: "interrupted", completedAt: T2 },
    },
    {
      name: "interrupted stays interrupted and keeps completedAt",
      current: { state: "interrupted", startedAt: T0, completedAt: T1 },
      released: { state: "completed", completedAt: T3 },
      expected: { state: "interrupted", completedAt: T1 },
    },
    {
      name: "error stays error",
      current: { state: "error", startedAt: T0, completedAt: T1 },
      released: { state: "completed", completedAt: T3 },
      expected: { state: "error", completedAt: T1 },
    },
    {
      name: "sticky state with a null completedAt gets it filled",
      current: { state: "interrupted", startedAt: T0, completedAt: null },
      released: { state: "completed", completedAt: T2 },
      expected: { state: "interrupted", completedAt: T2 },
    },
    {
      name: "released completedAt before startedAt is clamped",
      current: { state: "running", startedAt: T2, completedAt: null },
      released: { state: "completed", completedAt: T1 },
      expected: { state: "completed", completedAt: T2 },
    },
    {
      name: "sticky fill is clamped to startedAt",
      current: { state: "error", startedAt: T2, completedAt: null },
      released: { state: "interrupted", completedAt: T1 },
      expected: { state: "error", completedAt: T2 },
    },
  ];

  it.each(cases)("$name", ({ current, released, expected }) => {
    expect(mergeReleasedTurn(current, released)).toEqual(expected);
  });
});
