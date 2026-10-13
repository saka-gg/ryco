import { describe, expect, it } from "vite-plus/test";

import { mapKey, type MapNode } from "./projectMap.logic";
import {
  itemKey,
  itemsInBox,
  orderedItems,
  rangeTo,
  selectedItems,
  selectionFromItems,
  selectionKey,
  selectionOf,
  toggleItem,
  visibleSelection,
  type MapItemRef,
} from "./projectMapSelection.logic";

const node = (
  kind: MapNode["kind"],
  refId: string | null,
  box: { x: number; y: number; w?: number; h?: number },
): MapNode => ({
  key:
    kind === "project"
      ? mapKey.project()
      : kind === "device"
        ? mapKey.device("c")
        : kind === "label"
          ? `label|${refId}`
          : mapKey[kind]("c", refId!),
  kind,
  x: box.x,
  y: box.y,
  w: box.w ?? 100,
  h: box.h ?? 40,
  checkoutKey: kind === "project" ? null : "c",
  refId,
});

const ws = (id: string): MapItemRef => ({ kind: "workspace", checkoutKey: "c", id });
const th = (id: string): MapItemRef => ({ kind: "thread", checkoutKey: "c", id });
const au = (id: string): MapItemRef => ({ kind: "automation", checkoutKey: "c", id });

const NODES: MapNode[] = [
  node("project", null, { x: 0, y: 0 }),
  node("device", null, { x: 0, y: 100 }),
  node("workspace", "w1", { x: 0, y: 200 }),
  node("thread", "t1", { x: 30, y: 250 }),
  node("workspace", "w2", { x: 0, y: 300 }),
  node("automation", "a1", { x: 0, y: 400 }),
];

describe("map selection", () => {
  it("inspects the project and devices alone; cards are items", () => {
    expect(selectionOf(NODES[0]!)).toEqual({ kind: "project" });
    expect(selectionOf(NODES[1]!)).toEqual({ kind: "device", checkoutKey: "c" });
    expect(selectionOf(NODES[3]!)).toEqual(th("t1"));
    expect(orderedItems(NODES)).toEqual([ws("w1"), th("t1"), ws("w2"), au("a1")]);
    expect(selectedItems({ kind: "device", checkoutKey: "c" })).toEqual([]);
  });

  it("collapses to one card or nothing, and drops duplicates", () => {
    expect(selectionFromItems([])).toBeNull();
    expect(selectionFromItems([ws("w1"), ws("w1")])).toEqual(ws("w1"));
    const many = selectionFromItems([ws("w1"), th("t1")]);
    expect(many).toEqual({ kind: "many", items: [ws("w1"), th("t1")] });
    expect(selectionKey(many)).toBeNull();
    expect(selectionKey(ws("w1"))).toBe(mapKey.workspace("c", "w1"));
  });

  it("toggles a card in and out, keeping the card already inspected", () => {
    const two = toggleItem(ws("w1"), au("a1"));
    expect(two).toEqual({ kind: "many", items: [ws("w1"), au("a1")] });
    expect(toggleItem(two, ws("w1"))).toEqual(au("a1"));
    expect(toggleItem(au("a1"), au("a1"))).toBeNull();
    // A device is not a card: toggling from it starts a fresh selection.
    expect(toggleItem({ kind: "device", checkoutKey: "c" }, ws("w2"))).toEqual(ws("w2"));
  });

  it("selects the run from the anchor in reading order, either direction", () => {
    const ordered = orderedItems(NODES);
    expect(rangeTo(ws("w1"), ordered, itemKey(ws("w1")), ws("w2"))).toEqual({
      kind: "many",
      items: [ws("w1"), th("t1"), ws("w2")],
    });
    expect(rangeTo(null, ordered, itemKey(au("a1")), th("t1"))).toEqual({
      kind: "many",
      items: [th("t1"), ws("w2"), au("a1")],
    });
    // Without an anchor on the map, the card joins on its own.
    expect(rangeTo(ws("w1"), ordered, "gone", au("a1"))).toEqual({
      kind: "many",
      items: [ws("w1"), au("a1")],
    });
  });

  it("picks the cards a marquee touches", () => {
    expect(itemsInBox(NODES, { x: 50, y: 245, w: 10, h: 60 })).toEqual([th("t1"), ws("w2")]);
    // The device and project are never picked.
    expect(itemsInBox(NODES, { x: 0, y: 0, w: 10, h: 210 })).toEqual([ws("w1")]);
  });

  it("drops cards that left the map from a multiple selection", () => {
    const many = selectionFromItems([ws("w1"), th("t1"), au("a1")]);
    const live = new Set([itemKey(ws("w1")), itemKey(au("a1"))]);
    expect(visibleSelection(many, live)).toEqual({ kind: "many", items: [ws("w1"), au("a1")] });
    expect(visibleSelection(many, new Set([itemKey(ws("w1"))]))).toEqual(ws("w1"));
    expect(visibleSelection(many, new Set())).toBeNull();
    // A single card stays so its inspector can say it is gone.
    expect(visibleSelection(th("t1"), new Set())).toEqual(th("t1"));
  });
});
