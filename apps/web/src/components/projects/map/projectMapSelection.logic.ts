/**
 * What the map has selected, and how a click, a range or a marquee changes
 * it. Selection works like a file browser: a click picks one card, ⌘/ctrl
 * toggles a card, shift picks the run from the anchor in reading order (down
 * each device's column), and a marquee picks what it touches. Only
 * workspaces, automations and threads gather into a multiple selection; the
 * project and a device are inspected on their own.
 */
import type { WorkspaceReviewAction } from "../projectsSearch";
import { mapKey, type MapNode } from "./projectMap.logic";

export type MapItemKind = "workspace" | "automation" | "thread";

/** One card that can join a multiple selection. */
export interface MapItemRef {
  readonly kind: MapItemKind;
  readonly checkoutKey: string;
  readonly id: string;
}

export type MapSelection =
  | { readonly kind: "project" }
  | { readonly kind: "device"; readonly checkoutKey: string }
  | {
      readonly kind: "workspace";
      readonly checkoutKey: string;
      readonly id: string;
      /** A checkout change under review, shown in place of the details. */
      readonly review?: WorkspaceReviewAction | undefined;
    }
  | { readonly kind: "automation"; readonly checkoutKey: string; readonly id: string }
  | { readonly kind: "thread"; readonly checkoutKey: string; readonly id: string }
  /** Two or more cards, in the order they were picked. */
  | { readonly kind: "many"; readonly items: readonly MapItemRef[] };

export const itemKey = (item: MapItemRef): string => mapKey[item.kind](item.checkoutKey, item.id);

/** The node key a single selection rests on; null for none or several. */
export function selectionKey(selection: MapSelection | null): string | null {
  if (!selection) return null;
  switch (selection.kind) {
    case "project":
      return mapKey.project();
    case "device":
      return mapKey.device(selection.checkoutKey);
    case "many":
      return null;
    default:
      return itemKey(selection);
  }
}

export function itemOfNode(node: MapNode): MapItemRef | null {
  if (!node.checkoutKey || !node.refId) return null;
  if (node.kind === "workspace" || node.kind === "automation" || node.kind === "thread")
    return { kind: node.kind, checkoutKey: node.checkoutKey, id: node.refId };
  return null;
}

/** What a plain click on a node inspects. */
export function selectionOf(node: MapNode): MapSelection | null {
  if (node.kind === "project") return { kind: "project" };
  if (node.kind === "device" && node.checkoutKey)
    return { kind: "device", checkoutKey: node.checkoutKey };
  return itemOfNode(node);
}

/** The cards a selection holds (none for the project or a device). */
export function selectedItems(selection: MapSelection | null): readonly MapItemRef[] {
  if (!selection || selection.kind === "project" || selection.kind === "device") return [];
  if (selection.kind === "many") return selection.items;
  return [{ kind: selection.kind, checkoutKey: selection.checkoutKey, id: selection.id }];
}

/** None is no selection, one card inspects that card, more are "many". */
export function selectionFromItems(items: readonly MapItemRef[]): MapSelection | null {
  const unique = [...new Map(items.map((item) => [itemKey(item), item])).values()];
  if (unique.length === 0) return null;
  if (unique.length === 1) return { ...unique[0]! };
  return { kind: "many", items: unique };
}

/** ⌘/ctrl-click: the card joins the selection, or leaves it. */
export function toggleItem(selection: MapSelection | null, item: MapItemRef): MapSelection | null {
  const key = itemKey(item);
  const items = selectedItems(selection);
  return selectionFromItems(
    items.some((candidate) => itemKey(candidate) === key)
      ? items.filter((candidate) => itemKey(candidate) !== key)
      : [...items, item],
  );
}

/** Every selectable card, in reading order (the layout's own order). */
export function orderedItems(nodes: readonly MapNode[]): MapItemRef[] {
  return nodes.flatMap((node) => {
    const item = itemOfNode(node);
    return item ? [item] : [];
  });
}

/**
 * Shift-click: the run from the anchor to the card joins the selection. With
 * no anchor on the map (or the anchor gone), the card alone joins.
 */
export function rangeTo(
  selection: MapSelection | null,
  ordered: readonly MapItemRef[],
  anchorKey: string | null,
  item: MapItemRef,
): MapSelection | null {
  const keys = ordered.map(itemKey);
  const from = anchorKey === null ? -1 : keys.indexOf(anchorKey);
  const to = keys.indexOf(itemKey(item));
  const run =
    from === -1 || to === -1 ? [item] : ordered.slice(Math.min(from, to), Math.max(from, to) + 1);
  return selectionFromItems([...selectedItems(selection), ...run]);
}

export interface MapBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** The selectable cards a world-space box touches, in reading order. */
export function itemsInBox(nodes: readonly MapNode[], box: MapBox): MapItemRef[] {
  return nodes.flatMap((node) => {
    const item = itemOfNode(node);
    const touches =
      node.x < box.x + box.w &&
      node.x + node.w > box.x &&
      node.y < box.y + box.h &&
      node.y + node.h > box.y;
    return item && touches ? [item] : [];
  });
}

/**
 * The selection as the map shows it: cards that left the map (hidden,
 * folded, trashed) drop out of a multiple selection. A single card stays,
 * so its inspector can say it is gone.
 */
export function visibleSelection(
  selection: MapSelection | null,
  liveKeys: ReadonlySet<string>,
): MapSelection | null {
  if (selection?.kind !== "many") return selection;
  const items = selection.items.filter((item) => liveKeys.has(itemKey(item)));
  return items.length === selection.items.length ? selection : selectionFromItems(items);
}
