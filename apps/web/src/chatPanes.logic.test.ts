import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import {
  closePane,
  decodePaneLayout,
  movePane,
  paneDropSide,
  paneGeometry,
  paneLeaves,
  resizePane,
  resolvePaneDrop,
  sharesPaneLeaves,
  splitPane,
  type PaneNode,
} from "./chatPanes.logic";
const ref = (id: string, env = "local") => ({
  environmentId: EnvironmentId.make(env),
  threadId: ThreadId.make(id),
});
const a = ref("a"),
  b = ref("b"),
  c = ref("c"),
  d = ref("d");
const leaf: PaneNode = { kind: "thread", ref: a };
const pair = () => splitPane(leaf, a, b, "right");
const grid = () => splitPane(splitPane(pair(), a, c, "bottom"), b, d, "bottom");
const encode = (root: unknown) => JSON.stringify({ version: 1, root });
describe("bounded thread panes", () => {
  it("permits 2x2 and rejects a fifth pane or a repeated split axis", () => {
    expect(paneLeaves(grid())).toEqual([a, c, b, d]);
    expect(splitPane(grid(), a, ref("e"), "top")).toEqual(grid());
    const root = pair();
    expect(splitPane(root, b, c, "right")).toBe(root);
  });
  it("rejects duplicate, missing target and cross-environment threads", () => {
    const root = pair();
    expect(splitPane(root, a, b, "bottom")).toBe(root);
    expect(splitPane(root, ref("absent"), c, "bottom")).toBe(root);
    expect(splitPane(root, a, ref("c", "remote"), "bottom")).toBe(root);
  });
  it("places incoming threads on each requested edge", () => {
    for (const side of ["left", "right", "top", "bottom"] as const) {
      expect(paneLeaves(splitPane(leaf, a, b, side))).toEqual(
        side === "left" || side === "top" ? [b, a] : [a, b],
      );
    }
  });
  it("moves atomically and leaves an invalid move intact", () => {
    const root = grid();
    expect(movePane(root, b, a, "right")).toBe(root);
    const moved = movePane(pair(), b, a, "right");
    expect(paneLeaves(moved)).toEqual([b, a]);
    expect(movePane(root, a, a, "left")).toBe(root);
  });
  it("collapses empty branches without replacing surviving references", () => {
    expect(closePane(pair(), b)).toEqual(leaf);
    expect(closePane(leaf, a)).toBeNull();
    const root = pair();
    expect(closePane(root, c)).toBe(root);
    expect(paneLeaves(closePane(grid(), a)!)).toEqual([c, b, d]);
  });
  it("clamps resize ratios and roundtrips only layout metadata", () => {
    expect(resizePane(pair(), "", 99)).toMatchObject({ ratio: 0.75 });
    expect(resizePane(pair(), "", NaN)).toMatchObject({ ratio: 0.5 });
    expect(decodePaneLayout(encode(grid()))).toEqual(grid());
    expect(decodePaneLayout(encode({ ...leaf, messages: ["unrelated content"] }))).toEqual(leaf);
  });
  it("rejects corrupt, huge, duplicate and overdeep persisted trees", () => {
    expect(decodePaneLayout("bad")).toBeNull();
    expect(decodePaneLayout(" ".repeat(8193))).toBeNull();
    expect(decodePaneLayout(JSON.stringify({ version: 2, root: leaf }))).toBeNull();
    const invalid = { kind: "split", axis: "horizontal", ratio: 0.5, first: leaf, second: leaf };
    expect(decodePaneLayout(encode(invalid))).toBeNull();
    expect(decodePaneLayout(encode({ ...invalid, second: pair() }))).toBeNull();
    expect(
      decodePaneLayout(encode({ ...invalid, second: { kind: "thread", ref: ref("b", "remote") } })),
    ).toBeNull();
  });
  it("resolves edges and rejects coordinates outside the pane", () => {
    const rect = { left: 10, top: 20, width: 400, height: 200 };
    expect(paneDropSide(rect, 11, 120)).toBe("left");
    expect(paneDropSide(rect, 409, 120)).toBe("right");
    expect(paneDropSide(rect, 210, 21)).toBe("top");
    expect(paneDropSide(rect, 210, 219)).toBe("bottom");
    expect(paneDropSide(rect, 0, 0)).toBeNull();
    expect(paneDropSide({ ...rect, width: 0 }, 10, 20)).toBeNull();
  });
  it("lays out percentage rects and the edge each leaf entered from", () => {
    const { leaves, dividers } = paneGeometry(resizePane(grid(), "", 0.6));
    expect(leaves.map(({ ref, side }) => [ref.threadId, side])).toEqual([
      ["a", "top"],
      ["c", "bottom"],
      ["b", "top"],
      ["d", "bottom"],
    ]);
    expect(leaves[2]!.rect).toEqual({ left: 60, top: 0, width: 40, height: 50 });
    expect(dividers.map((divider) => divider.path)).toEqual(["", "0", "1"]);
    expect(paneGeometry(leaf).leaves).toEqual([
      { ref: a, rect: { left: 0, top: 0, width: 100, height: 100 }, side: null },
    ]);
    expect(paneGeometry(pair()).leaves.map((entry) => entry.side)).toEqual(["left", "right"]);
  });
  it("explains every drop the tree would refuse", () => {
    expect(resolvePaneDrop(leaf, a, b, "right")).toEqual({ kind: "split" });
    expect(resolvePaneDrop(leaf, a, a, "right")).toEqual({ kind: "noop" });
    expect(resolvePaneDrop(leaf, a, ref("b", "remote"), "right")).toMatchObject({
      kind: "refused",
      reason: "environment",
    });
    expect(resolvePaneDrop(grid(), a, ref("e"), "left")).toMatchObject({
      kind: "refused",
      reason: "full",
    });
    // b already sits beside a horizontally; a vertical split still fits.
    expect(resolvePaneDrop(pair(), b, c, "right")).toEqual({
      kind: "refused",
      reason: "axis",
      alternative: "vertical",
    });
    expect(resolvePaneDrop(pair(), b, c, "bottom")).toEqual({ kind: "split" });
    // Dropping a pane back where it already is changes nothing.
    expect(resolvePaneDrop(pair(), a, b, "right")).toEqual({ kind: "noop" });
    expect(resolvePaneDrop(pair(), b, a, "right")).toEqual({ kind: "move" });
    // Every leaf of a 2x2 has used both axes.
    expect(resolvePaneDrop(grid(), b, a, "right")).toEqual({
      kind: "refused",
      reason: "axis",
      alternative: null,
    });
  });
  it("detects whether two layouts share a pane", () => {
    expect(sharesPaneLeaves(pair(), leaf)).toBe(true);
    expect(sharesPaneLeaves(pair(), { kind: "thread", ref: c })).toBe(false);
  });
});
