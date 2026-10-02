import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@ryco/contracts";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";

export type PaneSide = "left" | "right" | "top" | "bottom";
export type PaneAxis = "horizontal" | "vertical";
export type PaneNode =
  | { kind: "thread"; ref: ScopedThreadRef }
  | { kind: "split"; axis: PaneAxis; ratio: number; first: PaneNode; second: PaneNode };
export const PANE_DRAG_TYPE = "application/x-ryco-thread-pane";
export const paneKey = scopedThreadKey;
export const paneLeaves = (node: PaneNode): ScopedThreadRef[] =>
  node.kind === "thread" ? [node.ref] : [...paneLeaves(node.first), ...paneLeaves(node.second)];
export const paneContains = (node: PaneNode, ref: ScopedThreadRef) =>
  paneLeaves(node).some((item) => paneKey(item) === paneKey(ref));
export const clampPaneRatio = (ratio: number) =>
  Number.isFinite(ratio) ? Math.max(0.25, Math.min(0.75, ratio)) : 0.5;
const axisFor = (side: PaneSide): PaneAxis =>
  side === "left" || side === "right" ? "horizontal" : "vertical";

/** Each path can split once on each axis: a genuine 2x2 bound, not just four leaves. */
export function splitPane(
  root: PaneNode,
  target: ScopedThreadRef,
  ref: ScopedThreadRef,
  side: PaneSide,
): PaneNode {
  if (
    paneLeaves(root).length >= 4 ||
    paneContains(root, ref) ||
    paneLeaves(root)[0]?.environmentId !== ref.environmentId
  )
    return root;
  const axis = axisFor(side);
  const visit = (node: PaneNode, used: ReadonlySet<PaneAxis>): PaneNode => {
    if (node.kind === "thread") {
      if (paneKey(node.ref) !== paneKey(target) || used.has(axis)) return node;
      const leaf: PaneNode = { kind: "thread", ref };
      const before = side === "left" || side === "top";
      return {
        kind: "split",
        axis,
        ratio: 0.5,
        first: before ? leaf : node,
        second: before ? node : leaf,
      };
    }
    const next = new Set(used).add(node.axis);
    const first = visit(node.first, next),
      second = visit(node.second, next);
    return first === node.first && second === node.second ? node : { ...node, first, second };
  };
  return visit(root, new Set());
}
export function closePane(root: PaneNode, ref: ScopedThreadRef): PaneNode | null {
  if (root.kind === "thread") return paneKey(root.ref) === paneKey(ref) ? null : root;
  const first = closePane(root.first, ref),
    second = closePane(root.second, ref);
  if (!first) return second;
  if (!second) return first;
  return first === root.first && second === root.second ? root : { ...root, first, second };
}
export function movePane(
  root: PaneNode,
  target: ScopedThreadRef,
  ref: ScopedThreadRef,
  side: PaneSide,
): PaneNode {
  if (paneKey(ref) === paneKey(target)) return root;
  if (!paneContains(root, ref)) return splitPane(root, target, ref, side);
  const remaining = closePane(root, ref);
  if (!remaining) return root;
  const next = splitPane(remaining, target, ref, side);
  return next === remaining ? root : next;
}
export function resizePane(root: PaneNode, path: string, ratio: number): PaneNode {
  if (root.kind !== "split") return root;
  if (!path) return { ...root, ratio: clampPaneRatio(ratio) };
  return path[0] === "0"
    ? { ...root, first: resizePane(root.first, path.slice(1), ratio) }
    : { ...root, second: resizePane(root.second, path.slice(1), ratio) };
}
export interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface PaneLeafGeometry {
  ref: ScopedThreadRef;
  rect: PaneRect;
  /** The edge of its parent split this leaf occupies; null for a lone pane. */
  side: PaneSide | null;
}
export interface PaneDividerGeometry {
  path: string;
  node: Extract<PaneNode, { kind: "split" }>;
  rect: PaneRect;
}
const FULL_RECT: PaneRect = { left: 0, top: 0, width: 100, height: 100 };

/** Percentage rects for every leaf and divider, in leaf order. */
export function paneGeometry(node: PaneNode, rect: PaneRect = FULL_RECT) {
  const leaves: PaneLeafGeometry[] = [],
    dividers: PaneDividerGeometry[] = [];
  const visit = (node: PaneNode, rect: PaneRect, path: string, side: PaneSide | null) => {
    if (node.kind === "thread") {
      leaves.push({ ref: node.ref, rect, side });
      return;
    }
    dividers.push({ path, node, rect });
    const horizontal = node.axis === "horizontal";
    visit(
      node.first,
      {
        ...rect,
        width: horizontal ? rect.width * node.ratio : rect.width,
        height: horizontal ? rect.height : rect.height * node.ratio,
      },
      `${path}0`,
      horizontal ? "left" : "top",
    );
    visit(
      node.second,
      {
        left: rect.left + (horizontal ? rect.width * node.ratio : 0),
        top: rect.top + (horizontal ? 0 : rect.height * node.ratio),
        width: horizontal ? rect.width * (1 - node.ratio) : rect.width,
        height: horizontal ? rect.height : rect.height * (1 - node.ratio),
      },
      `${path}1`,
      horizontal ? "right" : "bottom",
    );
  };
  visit(node, rect, "", null);
  return { leaves, dividers };
}

/** The half of a pane a drop on `side` would occupy, in the pane's own percentages. */
export function paneDropRect(side: PaneSide): PaneRect {
  return {
    left: side === "right" ? 50 : 0,
    top: side === "bottom" ? 50 : 0,
    width: side === "left" || side === "right" ? 50 : 100,
    height: side === "top" || side === "bottom" ? 50 : 100,
  };
}

/** Same leaves in the same arrangement; ratios are ignored. */
function samePaneShape(a: PaneNode, b: PaneNode): boolean {
  if (a.kind === "thread") return b.kind === "thread" && paneKey(a.ref) === paneKey(b.ref);
  if (b.kind === "thread") return false;
  return a.axis === b.axis && samePaneShape(a.first, b.first) && samePaneShape(a.second, b.second);
}

export function sharesPaneLeaves(a: PaneNode, b: PaneNode): boolean {
  const keys = new Set(paneLeaves(a).map(paneKey));
  return paneLeaves(b).some((ref) => keys.has(paneKey(ref)));
}

export type PaneDropRefusal = "full" | "environment" | "axis";
export type PaneDropVerdict =
  | { kind: "split" | "move" }
  | { kind: "refused"; reason: PaneDropRefusal; alternative: PaneAxis | null }
  | { kind: "noop" };

/**
 * What dropping `source` on `side` of `target` would do, decided by the same
 * tree operations the drop runs, so the preview can never promise a layout
 * the drop refuses.
 */
export function resolvePaneDrop(
  root: PaneNode,
  target: ScopedThreadRef,
  source: ScopedThreadRef,
  side: PaneSide,
): PaneDropVerdict {
  if (paneKey(source) === paneKey(target)) return { kind: "noop" };
  const moving = paneContains(root, source);
  if (!moving) {
    if (paneLeaves(root)[0]?.environmentId !== source.environmentId)
      return { kind: "refused", reason: "environment", alternative: null };
    if (paneLeaves(root).length >= 4) return { kind: "refused", reason: "full", alternative: null };
  }
  const next = movePane(root, target, source, side);
  if (next === root) {
    const other: PaneAxis = axisFor(side) === "horizontal" ? "vertical" : "horizontal";
    const otherSides: PaneSide[] = other === "horizontal" ? ["left", "right"] : ["top", "bottom"];
    const works = otherSides.some(
      (candidate) => movePane(root, target, source, candidate) !== root,
    );
    return { kind: "refused", reason: "axis", alternative: works ? other : null };
  }
  if (moving && samePaneShape(next, root)) return { kind: "noop" };
  return { kind: moving ? "move" : "split" };
}

export function paneDropSide(
  rect: { left: number; top: number; width: number; height: number },
  x: number,
  y: number,
): PaneSide | null {
  if (rect.width <= 0 || rect.height <= 0) return null;
  const rx = (x - rect.left) / rect.width,
    ry = (y - rect.top) / rect.height;
  if (rx < 0 || rx > 1 || ry < 0 || ry > 1) return null;
  const distances: [PaneSide, number][] = [
    ["left", rx],
    ["right", 1 - rx],
    ["top", ry],
    ["bottom", 1 - ry],
  ];
  return distances.toSorted((a, b) => a[1] - b[1])[0]![0];
}

export function decodePaneRef(value: unknown): ScopedThreadRef | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.environmentId !== "string" ||
    typeof v.threadId !== "string" ||
    !v.environmentId ||
    !v.threadId ||
    v.environmentId.length > 512 ||
    v.threadId.length > 512
  )
    return null;
  return {
    environmentId: EnvironmentId.make(v.environmentId),
    threadId: ThreadId.make(v.threadId),
  };
}
/** Bounded before recursion, strips all unknown fields (never persist thread content). */
export function decodePaneLayout(text: string | null): PaneNode | null {
  if (!text || text.length > 8192) return null;
  try {
    const doc: unknown = JSON.parse(text);
    if (
      !doc ||
      typeof doc !== "object" ||
      !("version" in doc) ||
      doc.version !== 1 ||
      !("root" in doc)
    )
      return null;
    const seen = new Set<string>();
    let environment: string | undefined;
    const decode = (value: unknown, axes: ReadonlySet<PaneAxis>): PaneNode => {
      if (!value || typeof value !== "object") throw new Error("Invalid pane");
      const v = value as Record<string, unknown>;
      if (v.kind === "thread") {
        const ref = decodePaneRef(v.ref);
        if (
          !ref ||
          seen.has(paneKey(ref)) ||
          (environment !== undefined && environment !== ref.environmentId)
        )
          throw new Error("Invalid thread");
        environment = ref.environmentId;
        seen.add(paneKey(ref));
        return { kind: "thread", ref };
      }
      if (
        v.kind !== "split" ||
        (v.axis !== "horizontal" && v.axis !== "vertical") ||
        axes.has(v.axis) ||
        typeof v.ratio !== "number" ||
        !Number.isFinite(v.ratio)
      )
        throw new Error("Invalid split");
      const next = new Set(axes).add(v.axis);
      return {
        kind: "split",
        axis: v.axis,
        ratio: clampPaneRatio(v.ratio),
        first: decode(v.first, next),
        second: decode(v.second, next),
      };
    };
    return decode(doc.root, new Set());
  } catch {
    return null;
  }
}
