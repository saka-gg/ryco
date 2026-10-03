import type {
  SourceControlChangeRequestStack,
  SourceControlChangeRequestStackEntry,
} from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import { fixtureDetail } from "../testing/pullRequestFixtures";
import {
  assessStack,
  defaultMergeThroughLayer,
  isStackLayerLandable,
  newlyMergedLayers,
  stackLayerBlocker,
  stackLayersTopDown,
  stackLayerWord,
  stackLinkTone,
  stackMergeThroughPlan,
  stackPositionLabel,
} from "./stackFacts.logic";

/** Stack #14 as #703 sees it: #701 ready, #702 blocked, #703 unstable, #704 draft. */
const stack14 = fixtureDetail(703).stack!;

function layer(
  position: number,
  patch: Partial<SourceControlChangeRequestStackEntry> = {},
): SourceControlChangeRequestStackEntry {
  return {
    position,
    number: 800 + position,
    title: `Layer ${position}`,
    url: `https://github.com/o/r/pull/${800 + position}`,
    headRefName: `layer-${position}`,
    baseRefName: position === 1 ? "main" : `layer-${position - 1}`,
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    mergeStateStatus: "clean",
    ...patch,
  };
}

function stackOf(
  entries: ReadonlyArray<SourceControlChangeRequestStackEntry>,
  position = 1,
): SourceControlChangeRequestStack {
  return { number: 9, size: entries.length, position, baseRefName: "main", entries };
}

describe("stack layers", () => {
  it("orders layers top first", () => {
    expect(stackLayersTopDown(stack14).map((entry) => entry.number)).toEqual([704, 703, 702, 701]);
    expect(stackPositionLabel(stack14)).toBe("3 of 4");
  });

  it("gives each layer one word and tone", () => {
    const words = Object.fromEntries(
      stack14.entries.map((entry) => [entry.number, stackLayerWord(entry)]),
    );
    expect(words[701]).toEqual({ text: "Ready", tone: "success" });
    expect(words[702]).toEqual({ text: "Blocked", tone: "warning" });
    expect(words[704]).toEqual({ text: "Draft", tone: "neutral" });
    expect(stackLayerWord(layer(1, { state: "merged" }))).toEqual({
      text: "Merged",
      tone: "merged",
    });
    expect(stackLayerWord(layer(1, { mergeability: "conflicting" }))).toEqual({
      text: "Conflicts",
      tone: "danger",
    });
  });

  it("knows which layers can land and why the others cannot", () => {
    expect(isStackLayerLandable(layer(1))).toBe(true);
    expect(isStackLayerLandable(layer(1, { mergeStateStatus: "unstable" }))).toBe(true);
    expect(isStackLayerLandable(layer(1, { mergeStateStatus: "blocked" }))).toBe(false);
    expect(stackLayerBlocker(layer(2, { isDraft: true }))).toBe("#802 is a draft");
    expect(stackLayerBlocker(layer(2, { state: "closed" }))).toBe(
      "#802 is closed without being merged",
    );
    expect(stackLayerBlocker(layer(2, { mergeStateStatus: "dirty" }))).toBe("#802 has conflicts");
    expect(stackLayerBlocker(layer(2, { state: "merged" }))).toBeNull();
  });
});

describe("assessStack (the stack foot)", () => {
  it("names the top of the landable stretch", () => {
    expect(assessStack(stack14)).toMatchObject({
      canLand: { number: 701 },
      blockedAt: { number: 702 },
      mergedCount: 0,
      foot: { text: "#701 can land", tone: "success" },
    });
  });

  it("says where the stack is blocked when nothing can land", () => {
    const stack = stackOf([layer(1, { mergeStateStatus: "behind" }), layer(2)]);
    expect(assessStack(stack).foot).toEqual({ text: "blocked at #801", tone: "warning" });
  });

  it("counts merged layers and skips them when finding what can land", () => {
    const partly = stackOf([layer(1, { state: "merged" }), layer(2), layer(3, { isDraft: true })]);
    expect(assessStack(partly)).toMatchObject({
      mergedCount: 1,
      foot: { text: "#802 can land" },
    });
    const done = stackOf([layer(1, { state: "merged" }), layer(2, { state: "merged" })]);
    expect(assessStack(done).foot).toEqual({ text: "2 merged", tone: "merged" });
  });

  it("colours the spine: merged violet, the landable stretch success, the rest plain", () => {
    const stack = stackOf([layer(1, { state: "merged" }), layer(2), layer(3, { isDraft: true })]);
    expect(stack.entries.map((entry) => stackLinkTone(stack, entry))).toEqual([
      "merged",
      "landable",
      "plain",
    ]);
  });
});

describe("merge through", () => {
  it("lands every open layer up to the picked one", () => {
    expect(stackMergeThroughPlan(stack14, 701)).toEqual({
      layers: [expect.objectContaining({ number: 701 })],
      blocker: null,
      blockedBy: null,
    });
    const through703 = stackMergeThroughPlan(stack14, 703);
    expect(through703.layers.map((entry) => entry.number)).toEqual([701, 702, 703]);
    expect(through703.blocker).toBe("#702 is blocked");
    expect(through703.blockedBy).toBe(702);
  });

  it("refuses merged and unknown layers", () => {
    const stack = stackOf([layer(1, { state: "merged" }), layer(2)]);
    expect(stackMergeThroughPlan(stack, 801).blocker).toBe("Already merged");
    expect(stackMergeThroughPlan(stack, 999).blocker).toBe("#999 is not in this stack");
    expect(stackMergeThroughPlan(stack, 802).layers.map((entry) => entry.number)).toEqual([802]);
  });

  it("opens on the requested layer, else the highest that can land", () => {
    expect(defaultMergeThroughLayer(stack14, 703)).toBe(701);
    expect(defaultMergeThroughLayer(stack14, 701)).toBe(701);
    expect(defaultMergeThroughLayer(stackOf([layer(1), layer(2), layer(3)]), null)).toBe(803);
  });
});

describe("newlyMergedLayers", () => {
  it("returns layers that just merged, from the base up", () => {
    const before = new Map<number, SourceControlChangeRequestStackEntry["state"]>([
      [801, "open"],
      [802, "open"],
      [803, "open"],
    ]);
    const after = stackOf([layer(1, { state: "merged" }), layer(2, { state: "merged" }), layer(3)]);
    expect(newlyMergedLayers(before, after)).toEqual([801, 802]);
    expect(newlyMergedLayers(new Map([[801, "merged"]]), after)).toEqual([]);
  });
});
