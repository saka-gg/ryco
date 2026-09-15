import { describe, expect, it } from "vite-plus/test";

import {
  createTerminalOutputBatcher,
  groupHasRunningTerminal,
  resolveTabLabel,
  resolveTerminalSelectionActionPosition,
  selectPendingTerminalEventEntries,
  selectTerminalEventEntriesAfterSnapshot,
  shouldHandleTerminalSelectionMouseUp,
  terminalSelectionActionDelayForClickCount,
} from "./ThreadTerminalDrawer";

describe("createTerminalOutputBatcher", () => {
  it("coalesces consecutive output writes until the scheduled flush", () => {
    const writes: string[] = [];
    const scheduledFlushes: Array<() => void> = [];
    const batcher = createTerminalOutputBatcher({
      write: (data) => {
        writes.push(data);
      },
      requestFlush: (callback) => {
        scheduledFlushes.push(callback);
        return () => undefined;
      },
    });

    batcher.writeOutput("one");
    batcher.writeOutput("two");

    expect(writes).toEqual([]);
    expect(scheduledFlushes).toHaveLength(1);

    scheduledFlushes[0]?.();

    expect(writes).toEqual(["onetwo"]);
  });

  it("flushes pending output before ordering-sensitive terminal events", () => {
    const writes: string[] = [];
    const cancellations: string[] = [];
    const batcher = createTerminalOutputBatcher({
      write: (data) => {
        writes.push(data);
      },
      requestFlush: () => () => {
        cancellations.push("cancelled");
      },
    });

    batcher.writeOutput("before ");
    batcher.writeOutput("reset");
    batcher.flush();
    writes.push("snapshot");

    expect(writes).toEqual(["before reset", "snapshot"]);
    expect(cancellations).toEqual(["cancelled"]);
  });

  it("flushes pending output on dispose without duplicating later scheduled flushes", () => {
    const writes: string[] = [];
    const scheduledFlushes: Array<() => void> = [];
    const batcher = createTerminalOutputBatcher({
      write: (data) => {
        writes.push(data);
      },
      requestFlush: (callback) => {
        scheduledFlushes.push(callback);
        return () => undefined;
      },
    });

    batcher.writeOutput("tail");
    batcher.dispose();
    scheduledFlushes[0]?.();

    expect(writes).toEqual(["tail"]);
  });
});

describe("resolveTerminalSelectionActionPosition", () => {
  it("retains output emitted after a snapshot in the same millisecond", () => {
    const timestamp = "2026-09-15T00:00:00.000Z";
    expect(
      selectTerminalEventEntriesAfterSnapshot(
        [
          {
            id: 1,
            event: {
              threadId: "thread-1",
              terminalId: "default",
              type: "output",
              data: "fresh",
              createdAt: timestamp,
              cursor: { generation: "server-1", sequence: 2 },
            },
          },
        ],
        timestamp,
        { generation: "server-1", sequence: 1 },
      ).map((entry) => entry.event),
    ).toHaveLength(1);
  });
  it("prefers the selection rect over the last pointer position", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: { right: 260, bottom: 140 },
        pointer: { x: 520, y: 200 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 260,
      y: 144,
    });
  });

  it("falls back to the pointer position when no selection rect is available", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 180, y: 130 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 180,
      y: 130,
    });
  });

  it("clamps the pointer fallback into the terminal drawer bounds", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 720, y: 340 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 600,
      y: 270,
    });

    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 40, y: 20 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 100,
      y: 50,
    });
  });

  it("delays multi-click selection actions so triple-click selection can complete", () => {
    expect(terminalSelectionActionDelayForClickCount(1)).toBe(0);
    expect(terminalSelectionActionDelayForClickCount(2)).toBe(260);
    expect(terminalSelectionActionDelayForClickCount(3)).toBe(260);
  });

  it("only handles mouseup when the selection gesture started in the terminal", () => {
    expect(shouldHandleTerminalSelectionMouseUp(true, 0)).toBe(true);
    expect(shouldHandleTerminalSelectionMouseUp(false, 0)).toBe(false);
    expect(shouldHandleTerminalSelectionMouseUp(true, 1)).toBe(false);
  });

  it("replays only terminal events newer than the open snapshot", () => {
    expect(
      selectTerminalEventEntriesAfterSnapshot(
        [
          {
            id: 1,
            event: {
              threadId: "thread-1",
              terminalId: "default",
              createdAt: "2026-04-02T20:00:00.000Z",
              type: "output",
              data: "before",
            },
          },
          {
            id: 2,
            event: {
              threadId: "thread-1",
              terminalId: "default",
              createdAt: "2026-04-02T20:00:01.000Z",
              type: "output",
              data: "after",
            },
          },
        ],
        "2026-04-02T20:00:00.500Z",
      ).map((entry) => entry.id),
    ).toEqual([2]);
  });

  it("applies only terminal events that have not already been consumed", () => {
    expect(
      selectPendingTerminalEventEntries(
        [
          {
            id: 1,
            event: {
              threadId: "thread-1",
              terminalId: "default",
              createdAt: "2026-04-02T20:00:00.000Z",
              type: "output",
              data: "one",
            },
          },
          {
            id: 2,
            event: {
              threadId: "thread-1",
              terminalId: "default",
              createdAt: "2026-04-02T20:00:01.000Z",
              type: "output",
              data: "two",
            },
          },
        ],
        1,
      ).map((entry) => entry.id),
    ).toEqual([2]);
  });
});

describe("resolveTabLabel", () => {
  it("labels a single-terminal group as Terminal N", () => {
    expect(resolveTabLabel({ id: "group-1", terminalIds: ["a"] }, 1)).toBe("Terminal 1");
  });

  it("labels a multi-terminal group as Split N", () => {
    expect(resolveTabLabel({ id: "group-2", terminalIds: ["a", "b"] }, 2)).toBe("Split 2");
  });

  it("uses the supplied 1-based group index", () => {
    expect(resolveTabLabel({ id: "group-3", terminalIds: ["a"] }, 7)).toBe("Terminal 7");
  });
});

describe("groupHasRunningTerminal", () => {
  it("returns false when no terminals are running", () => {
    expect(groupHasRunningTerminal({ id: "g", terminalIds: ["a", "b"] }, [])).toBe(false);
  });

  it("returns true when any group member is running", () => {
    expect(groupHasRunningTerminal({ id: "g", terminalIds: ["a", "b"] }, ["b"])).toBe(true);
  });

  it("returns false when running terminals are not in the group", () => {
    expect(groupHasRunningTerminal({ id: "g", terminalIds: ["a"] }, ["b"])).toBe(false);
  });
});
