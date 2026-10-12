import { describe, expect, it } from "vite-plus/test";

import {
  type HistoryBufferLimits,
  appendTerminalHistoryChunk,
  historyBufferStateFrom,
} from "./historyBuffer.ts";
import { TerminalHistoryCursorIndex } from "./historyCursorIndex.ts";

const limits = (maxBytes: number, maxLines = 5_000): HistoryBufferLimits => ({
  maxBytes,
  maxLines,
});

/** Drives the index the way the manager does: one cursor per event, a mark per append. */
function session(initial: string, bufferLimits = limits(1_000_000), maxMarks?: number) {
  let sequence = 1;
  let state = historyBufferStateFrom(initial, bufferLimits);
  const index = new TerminalHistoryCursorIndex(sequence + 1, state.history.length, maxMarks);
  return {
    output(chunk: string) {
      state = appendTerminalHistoryChunk(state, chunk, bufferLimits);
      sequence += 1;
      if (chunk.length > 0) index.append(sequence, chunk.length, state.history.length);
      return sequence;
    },
    /** An event that advances the cursor without changing history (activity, exit). */
    tick() {
      sequence += 1;
      return sequence;
    },
    clear() {
      state = historyBufferStateFrom("", bufferLimits);
      index.reset(sequence + 1, 0);
      sequence += 1;
      return sequence;
    },
    since: (cursor: number) => index.since(cursor, state.history),
    history: () => state.history,
  };
}

describe("TerminalHistoryCursorIndex", () => {
  it("returns exactly the output after a cursor", () => {
    const terminal = session("loaded\n");
    const opened = terminal.tick();
    expect(terminal.since(opened)).toBe("");
    const first = terminal.output("one\n");
    terminal.output("two\n");
    const idle = terminal.tick();
    terminal.output("three");

    expect(terminal.since(opened)).toBe("one\ntwo\nthree");
    expect(terminal.since(first)).toBe("two\nthree");
    expect(terminal.since(idle)).toBe("three");
    expect(terminal.since(terminal.tick())).toBe("");
  });

  it("refuses cursors from before a reset", () => {
    const terminal = session("");
    const before = terminal.output("old output\n");
    const cleared = terminal.clear();
    terminal.output("new");

    expect(terminal.since(before)).toBeNull();
    expect(terminal.since(cleared)).toBe("new");
  });

  it("refuses a cursor whose position was trimmed out of the history", () => {
    const terminal = session("", limits(12));
    const early = terminal.output("aaaa\n");
    const middle = terminal.output("bbbb\n");
    terminal.output("cccc\n");

    // "aaaa\n" rolled off the head: the view at `early` holds it, the history does not.
    expect(terminal.history()).toBe("bbbb\ncccc\n");
    expect(terminal.since(early)).toBe("bbbb\ncccc\n");
    expect(terminal.since(middle)).toBe("cccc\n");
    terminal.output("dddd\n");
    expect(terminal.since(early)).toBeNull();
    expect(terminal.since(middle)).toBe("cccc\ndddd\n");
  });

  it("keeps resolving recent cursors once old marks are dropped, and only those", () => {
    const terminal = session("", limits(1_000_000), 4);
    const cursors = ["a", "b", "c", "d", "e", "f"].map((chunk) => terminal.output(chunk));

    // Five marks overflowed four: the oldest two now sit in the floor.
    expect(terminal.since(cursors[0]!)).toBeNull();
    expect(terminal.since(cursors[1]!)).toBe("cdef");
    expect(terminal.since(cursors[3]!)).toBe("ef");
    expect(terminal.since(cursors[5]!)).toBe("");
  });

  it("never slices a history that does not match its positions", () => {
    const index = new TerminalHistoryCursorIndex(1, 5);
    index.append(2, 3, 8);
    expect(index.since(1, "12345678")).toBe("678");
    expect(index.since(1, "1234567")).toBeNull();
  });
});
