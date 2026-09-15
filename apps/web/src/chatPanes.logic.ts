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
