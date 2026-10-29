import { describe, expect, it, vi } from "vite-plus/test";

import { QUEUE_MIGRATION_FAILED_CAUSE_PREFIX } from "./drain.ts";
import { moveDeviceQueueToServer, queueMigrationFailedHold } from "./migrate.ts";

interface Entry {
  readonly id: string;
  readonly waits?: boolean;
}

/** A device queue and the node's side of `thread.queue.add` (a no-op for a known id). */
function setup(ids: ReadonlyArray<string | Entry>) {
  let queue: Entry[] = ids.map((id) => (typeof id === "string" ? { id } : id));
  const node: string[] = [];
  let current = true;
  let refuse: Error | null = null;
  const move = vi.fn(async (entry: Entry) => {
    await Promise.resolve();
    if (refuse) throw refuse;
    if (!node.includes(entry.id)) node.push(entry.id);
  });
  const run = () =>
    moveDeviceQueueToServer({
      nextEntry: () => {
        const head = queue[0];
        return head && !head.waits ? head : null;
      },
      move,
      isQueued: (entry) => queue.some((candidate) => candidate.id === entry.id),
      drop: (entry) => {
        queue = queue.filter((candidate) => candidate.id !== entry.id);
      },
      current: () => current,
    });
  return {
    run,
    move,
    node,
    local: () => queue.map((entry) => entry.id),
    remove: (id: string) => {
      queue = queue.filter((entry) => entry.id !== id);
    },
    refuseWith: (error: Error | null) => {
      refuse = error;
    },
    supersede: () => {
      current = false;
    },
  };
}

describe("moving a device queue to the node", () => {
  it("moves head first and drops each entry only after the node took it", async () => {
    const f = setup(["q-1", "q-2", "q-3"]);
    const dropsAtMove: string[][] = [];
    f.move.mockImplementation(async (entry: Entry) => {
      dropsAtMove.push(f.local());
      f.node.push(entry.id);
    });
    await expect(f.run()).resolves.toEqual({ kind: "moved" });
    expect(f.node).toEqual(["q-1", "q-2", "q-3"]);
    // Each add went out while its entry was still on the device.
    expect(dropsAtMove).toEqual([["q-1", "q-2", "q-3"], ["q-2", "q-3"], ["q-3"]]);
    expect(f.local()).toEqual([]);
  });

  it("marks the entry whose add is on its way until it settled, a refused one included", async () => {
    const f = setup(["q-1", "q-2"]);
    const marks: Array<string | null> = [];
    const run = (onMoving: (entry: Entry | null) => void) =>
      moveDeviceQueueToServer({
        nextEntry: () => (f.local()[0] ? { id: f.local()[0]! } : null),
        move: f.move,
        isQueued: (entry) => f.local().includes(entry.id),
        drop: (entry) => f.remove(entry.id),
        current: () => true,
        onMoving,
      });
    f.move.mockImplementationOnce(async (entry: Entry) => {
      // While its add is on its way, the entry is still on the device, marked.
      expect(marks.at(-1)).toBe(entry.id);
      f.node.push(entry.id);
    });
    f.move.mockImplementationOnce(async () => {
      throw new Error("Refused.");
    });
    await run((entry) => marks.push(entry?.id ?? null));
    expect(marks).toEqual(["q-1", null, "q-2", null]);
    expect(f.local()).toEqual(["q-2"]);
  });

  it("stops at an entry that must wait, keeping it and the rest", async () => {
    const f = setup(["q-1", { id: "q-2", waits: true }, "q-3"]);
    await expect(f.run()).resolves.toEqual({ kind: "moved" });
    expect(f.node).toEqual(["q-1"]);
    expect(f.local()).toEqual(["q-2", "q-3"]);
  });

  it("returns the entry the node did not take and keeps it on the device", async () => {
    const f = setup(["q-1", "q-2"]);
    const error = new Error("The queue is full (20 follow-ups).");
    f.refuseWith(error);
    await expect(f.run()).resolves.toEqual({
      kind: "failed",
      entry: { id: "q-1" },
      error,
    });
    expect(f.local()).toEqual(["q-1", "q-2"]);
    // A second run after the refusal ended moves everything, with no second copy.
    f.refuseWith(null);
    await f.run();
    expect(f.node).toEqual(["q-1", "q-2"]);
  });

  it("does not drop an entry removed while its add was on its way", async () => {
    const f = setup(["q-1", "q-2"]);
    f.move.mockImplementationOnce(async (entry: Entry) => {
      f.remove(entry.id);
      f.node.push(entry.id);
    });
    await f.run();
    expect(f.node).toEqual(["q-1", "q-2"]);
    expect(f.local()).toEqual([]);
  });

  it("leaves everything alone once superseded, even a refused entry", async () => {
    const f = setup(["q-1", "q-2"]);
    f.move.mockImplementationOnce(async () => {
      f.supersede();
      throw new Error("The connection closed.");
    });
    await expect(f.run()).resolves.toEqual({ kind: "stale" });
    expect(f.local()).toEqual(["q-1", "q-2"]);

    const g = setup(["q-1", "q-2"]);
    g.move.mockImplementationOnce(async (entry: Entry) => {
      g.node.push(entry.id);
      g.supersede();
    });
    await expect(g.run()).resolves.toEqual({ kind: "stale" });
    // Acknowledged, but the move that sent it is gone: the entry stays for the next one,
    // whose add of a known id is a no-op.
    expect(g.local()).toEqual(["q-1", "q-2"]);
  });

  it("records a refusal as an error hold that waits for Resume", () => {
    expect(
      queueMigrationFailedHold("q-1", new Error("Refused."), "2026-10-01T10:00:00.000Z"),
    ).toEqual({
      reason: "error",
      causeKeys: [`${QUEUE_MIGRATION_FAILED_CAUSE_PREFIX}q-1`],
      detail: "Refused.",
      heldAt: "2026-10-01T10:00:00.000Z",
    });
    expect(queueMigrationFailedHold("q-1", "?", "2026-10-01T10:00:00.000Z").detail).toBe(
      "This message could not be moved to the node's queue.",
    );
  });
});
