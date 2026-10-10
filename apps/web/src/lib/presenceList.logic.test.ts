import { assert, describe, it } from "vite-plus/test";

import {
  dropExited,
  reconcilePresence,
  settlePresence,
  type PresenceEntry,
  type ReconcilePresenceOptions,
} from "./presenceList.logic";

interface Item {
  readonly id: string;
  readonly v?: number;
}

const key = (item: Item) => item.id;
const ANIMATED: ReconcilePresenceOptions = { animateEnter: true, keepExiting: true };
const items = (...ids: string[]): Item[] => ids.map((id) => ({ id }));
const summary = (entries: ReadonlyArray<PresenceEntry<Item>>) =>
  entries.map((entry) => `${entry.key}:${entry.phase}`);

describe("reconcilePresence", () => {
  it("starts present without enter animation", () => {
    const entries = reconcilePresence([], items("a", "b"), key, {
      animateEnter: false,
      keepExiting: true,
    });
    assert.deepEqual(summary(entries), ["a:present", "b:present"]);
  });

  it("marks new items as entering and keeps existing phases", () => {
    const first = reconcilePresence([], items("a"), key, ANIMATED);
    assert.deepEqual(summary(first), ["a:enter"]);
    const settled = settlePresence(first);
    const second = reconcilePresence(settled, items("b", "a"), key, ANIMATED);
    assert.deepEqual(summary(second), ["b:enter", "a:present"]);
  });

  it("keeps removed items at their old position in an exit phase", () => {
    const start = reconcilePresence([], items("a", "b", "c", "d"), key, {
      animateEnter: false,
      keepExiting: true,
    });
    const next = reconcilePresence(start, items("a", "d"), key, ANIMATED);
    assert.deepEqual(summary(next), ["a:present", "b:exit", "c:exit", "d:present"]);
  });

  it("keeps a removed head item at the head", () => {
    const start = reconcilePresence([], items("a", "b"), key, {
      animateEnter: false,
      keepExiting: true,
    });
    assert.deepEqual(summary(reconcilePresence(start, items("b"), key, ANIMATED)), [
      "a:exit",
      "b:present",
    ]);
  });

  it("follows reordering while exits stay anchored", () => {
    const start = reconcilePresence([], items("a", "b", "c"), key, {
      animateEnter: false,
      keepExiting: true,
    });
    const next = reconcilePresence(start, items("c", "a"), key, ANIMATED);
    assert.deepEqual(summary(next), ["c:present", "a:present", "b:exit"]);
  });

  it("brings an exiting item back to present", () => {
    const start = reconcilePresence([], items("a", "b"), key, {
      animateEnter: false,
      keepExiting: true,
    });
    const gone = reconcilePresence(start, items("a"), key, ANIMATED);
    const back = reconcilePresence(gone, items("a", "b"), key, ANIMATED);
    assert.deepEqual(summary(back), ["a:present", "b:present"]);
  });

  it("drops removed items at once when exits are off", () => {
    const start = reconcilePresence([], items("a", "b"), key, {
      animateEnter: false,
      keepExiting: true,
    });
    const next = reconcilePresence(start, items("b"), key, {
      animateEnter: false,
      keepExiting: false,
    });
    assert.deepEqual(summary(next), ["b:present"]);
  });

  it("takes the latest value for present items and keeps the last value for exits", () => {
    const start = reconcilePresence(
      [],
      [
        { id: "a", v: 1 },
        { id: "b", v: 1 },
      ],
      key,
      ANIMATED,
    );
    const next = reconcilePresence(start, [{ id: "a", v: 2 }], key, ANIMATED);
    assert.equal(next[0]?.item.v, 2);
    assert.equal(next[1]?.item.v, 1);
    assert.equal(next[1]?.phase, "exit");
  });

  it("ignores duplicate keys in the next list", () => {
    const next = reconcilePresence([], items("a", "a"), key, ANIMATED);
    assert.deepEqual(summary(next), ["a:enter"]);
  });
});

describe("settlePresence", () => {
  it("returns the same array when nothing is entering", () => {
    const entries = reconcilePresence([], items("a"), key, {
      animateEnter: false,
      keepExiting: true,
    });
    assert.strictEqual(settlePresence(entries), entries);
  });
});

describe("dropExited", () => {
  it("removes only an exiting entry with that key", () => {
    const start = reconcilePresence([], items("a", "b"), key, {
      animateEnter: false,
      keepExiting: true,
    });
    const exiting = reconcilePresence(start, items("a"), key, ANIMATED);
    assert.deepEqual(summary(dropExited(exiting, "b")), ["a:present"]);
    assert.strictEqual(dropExited(exiting, "a"), exiting);
  });
});
