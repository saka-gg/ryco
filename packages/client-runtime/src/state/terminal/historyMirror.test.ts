import type { TerminalEvent } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { createTerminalHistoryMirrorCache } from "./historyMirror.ts";

const cursor = (sequence: number, generation = "g") => ({ generation, sequence });
const output = (sequence: number, data: string, generation = "g"): TerminalEvent => ({
  type: "output",
  threadId: "t",
  terminalId: "default",
  createdAt: "",
  cursor: cursor(sequence, generation),
  data,
});

const make = (overrides: Partial<Parameters<typeof createTerminalHistoryMirrorCache>[0]> = {}) =>
  createTerminalHistoryMirrorCache({
    maxEntries: 4,
    maxHistoryUnits: 1000,
    maxTotalUnits: 10_000,
    ...overrides,
  });

describe("terminal history mirror", () => {
  it("opens with the last cursor and appends a delta answer to what it kept", () => {
    const cache = make();
    expect(cache.cursorFor("a")).toBeUndefined();
    expect(cache.hydrate("a", { history: "one\r\n", cursor: cursor(3) }, undefined)).toBe(
      "one\r\n",
    );
    cache.apply("a", output(4, "two\r\n"));
    cache.apply("a", output(4, "duplicate"));
    expect(cache.cursorFor("a")).toEqual(cursor(4));
    const shown = cache.hydrate(
      "a",
      { history: "three\r\n", cursor: cursor(9), historySince: cursor(4) },
      cursor(4),
    );
    expect(shown).toBe("one\r\ntwo\r\nthree\r\n");
    expect(cache.cursorFor("a")).toEqual(cursor(9));
  });

  it("takes a full answer as is: an older node, another generation, a trimmed history", () => {
    const cache = make();
    cache.hydrate("a", { history: "old", cursor: cursor(3) }, undefined);
    // No `historySince`: the node sent everything.
    expect(cache.hydrate("a", { history: "full", cursor: cursor(5) }, cursor(3))).toBe("full");
    // A server restart: the old cursor is meaningless.
    cache.apply("a", output(1, "x", "other"));
    expect(cache.cursorFor("a")).toBeUndefined();
    // No cursor at all (a node without cursors): nothing is kept.
    cache.hydrate("b", { history: "h" }, undefined);
    expect(cache.cursorFor("b")).toBeUndefined();
  });

  it("follows clears and restarts", () => {
    const cache = make();
    cache.hydrate("a", { history: "before", cursor: cursor(1) }, undefined);
    cache.apply("a", { ...output(2, ""), type: "cleared" } as TerminalEvent);
    cache.apply("a", output(3, "after"));
    expect(
      cache.hydrate("a", { history: "", cursor: cursor(3), historySince: cursor(3) }, cursor(3)),
    ).toBe("after");
  });

  it("stays within its bounds", () => {
    const cache = make({ maxEntries: 2, maxHistoryUnits: 10, maxTotalUnits: 100 });
    cache.hydrate("a", { history: "x".repeat(30), cursor: cursor(1) }, undefined);
    expect(
      cache.hydrate("a", { history: "", cursor: cursor(1), historySince: cursor(1) }, cursor(1)),
    ).toHaveLength(10);
    cache.hydrate("b", { history: "b", cursor: cursor(1) }, undefined);
    cache.hydrate("c", { history: "c", cursor: cursor(1) }, undefined);
    expect(cache.size()).toBe(2);
    expect(cache.cursorFor("a")).toBeUndefined();
  });
});

describe("terminal history mirror without its base", () => {
  it("refuses a delta for scrollback it no longer keeps", () => {
    const cache = make();
    expect(
      cache.hydrate(
        "gone",
        { history: "tail", cursor: cursor(9), historySince: cursor(4) },
        cursor(4),
      ),
    ).toBeNull();
    expect(cache.cursorFor("gone")).toBeUndefined();
  });
});
