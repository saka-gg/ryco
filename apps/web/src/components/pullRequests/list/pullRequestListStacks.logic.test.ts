import type {
  ChangeRequest,
  ChangeRequestState,
  SourceControlChangeRequestStack,
} from "@ryco/contracts";
import type { ChangeRequestListGroup } from "@ryco/client-runtime/state/pull-request-review";
import { describe, expect, it } from "vitest";

import {
  arrangePullRequestStacks,
  buildPullRequestListItems,
  collectStackLayers,
  describeStackFoot,
  landableThrough,
  stackFootParts,
  type PullRequestListItem,
  type PullRequestStackLayer,
} from "./pullRequestListStacks.logic";

type Row = Pick<ChangeRequest, "number" | "state" | "stackSummary">;

function row(
  number: number,
  stack?: { readonly number: number; readonly position: number; readonly size?: number },
  state: ChangeRequestState = "open",
): Row {
  return {
    number,
    state,
    ...(stack
      ? {
          stackSummary: {
            number: stack.number,
            position: stack.position,
            size: stack.size ?? 4,
            baseRefName: "main",
          },
        }
      : {}),
  };
}

function group(
  key: ChangeRequestListGroup<Row>["key"],
  entries: ReadonlyArray<Row>,
): ChangeRequestListGroup<Row> {
  return { key, label: key, entries };
}

function numbers(groups: ReadonlyArray<ChangeRequestListGroup<Row>>) {
  return groups.map((entry) => [entry.key, entry.entries.map((item) => item.number)]);
}

function layer(
  number: number,
  position: number,
  state: ChangeRequestState,
  landable = false,
): PullRequestStackLayer {
  return { number, position, state, landable };
}

describe("arrangePullRequestStacks", () => {
  it("keeps a stack together, top layer first, at its best-ranked layer", () => {
    const groups = [
      group("yours", [
        row(697),
        row(701, { number: 14, position: 1 }),
        row(704, { number: 14, position: 4 }),
        row(702, { number: 14, position: 2 }),
        row(690),
        row(703, { number: 14, position: 3 }),
      ]),
    ];
    expect(numbers(arrangePullRequestStacks(groups))).toEqual([
      ["yours", [697, 704, 703, 702, 701, 690]],
    ]);
  });

  it("places the unit in the most urgent group any open layer qualifies for", () => {
    const groups = [
      group("needs-your-review", [row(712), row(716, { number: 15, position: 2, size: 2 })]),
      group("others", [row(715, { number: 15, position: 1, size: 2 }), row(688)]),
    ];
    expect(numbers(arrangePullRequestStacks(groups))).toEqual([
      ["needs-your-review", [712, 716, 715]],
      ["others", [688]],
    ]);
  });

  it("ignores merged layers when choosing the group, and drops groups left empty", () => {
    const groups = [
      group("needs-your-review", [row(801, { number: 20, position: 1, size: 2 }, "merged")]),
      group("yours", [row(802, { number: 20, position: 2, size: 2 })]),
    ];
    expect(numbers(arrangePullRequestStacks(groups))).toEqual([["yours", [802, 801]]]);
  });

  it("places a stack with nothing open at its first layer", () => {
    const groups = [
      group("yours", [row(1), row(802, { number: 20, position: 2, size: 2 }, "closed")]),
      group("others", [row(801, { number: 20, position: 1, size: 2 }, "merged")]),
    ];
    expect(numbers(arrangePullRequestStacks(groups))).toEqual([["yours", [1, 802, 801]]]);
  });

  it("returns the groups untouched when nothing is stacked", () => {
    const groups = [group("others", [row(1), row(2)])];
    expect(arrangePullRequestStacks(groups)).toBe(groups);
  });
});

describe("landableThrough", () => {
  it("counts merged layers as landed and stops at the first blocked layer", () => {
    expect(
      landableThrough([
        layer(700, 1, "merged"),
        layer(701, 2, "open", true),
        layer(702, 3, "open", false),
        layer(703, 4, "open", true),
      ]),
    ).toBe(2);
    expect(landableThrough([layer(701, 1, "open", false)])).toBe(0);
  });
});

describe("collectStackLayers", () => {
  const detailStack: SourceControlChangeRequestStack = {
    number: 14,
    size: 4,
    position: 3,
    baseRefName: "main",
    entries: [
      {
        position: 1,
        number: 700,
        title: "Base",
        url: "https://github.com/acme/app/pull/700",
        headRefName: "stack-1",
        baseRefName: "main",
        state: "merged",
        isDraft: false,
        mergeability: "mergeable",
      },
      {
        position: 2,
        number: 701,
        title: "Second",
        url: "https://github.com/acme/app/pull/701",
        headRefName: "stack-2",
        baseRefName: "stack-1",
        state: "open",
        isDraft: false,
        mergeability: "mergeable",
        mergeStateStatus: "CLEAN",
      },
      {
        position: 3,
        number: 702,
        title: "Third",
        url: "https://github.com/acme/app/pull/702",
        headRefName: "stack-3",
        baseRefName: "stack-2",
        state: "open",
        isDraft: false,
        mergeability: "mergeable",
        mergeStateStatus: "blocked",
      },
    ],
  };

  it("fills layers the list did not load from the selected stack's detail", () => {
    const layers = collectStackLayers({
      rows: [row(702, { number: 14, position: 3 })],
      isLandable: () => true,
      detailStack,
    });
    expect(layers).toEqual([
      layer(700, 1, "merged"),
      layer(701, 2, "open", true),
      // The loaded row wins over the detail's merge state.
      layer(702, 3, "open", true),
    ]);
  });

  it("ignores another stack's detail", () => {
    const layers = collectStackLayers({
      rows: [row(901, { number: 30, position: 1 })],
      isLandable: () => false,
      detailStack,
    });
    expect(layers.map((entry) => entry.number)).toEqual([901]);
  });
});

describe("stack foot", () => {
  it("names the landable stretch from the base", () => {
    const foot = describeStackFoot({
      stack: 14,
      baseRefName: "main",
      layers: [
        layer(701, 1, "open", true),
        layer(702, 2, "open", false),
        layer(703, 3, "open", true),
      ],
      lowest: 701,
    });
    expect(foot).toMatchObject({ landable: [701], blockedAt: null, tone: "landable" });
    expect(stackFootParts(foot)).toEqual([{ text: "#701 can land", tone: "landable" }]);
  });

  it("names a range when several layers can land together", () => {
    const foot = describeStackFoot({
      stack: 14,
      baseRefName: "main",
      layers: [layer(701, 1, "open", true), layer(702, 2, "open", true)],
      lowest: 701,
    });
    expect(stackFootParts(foot)).toEqual([{ text: "#701–#702 can land", tone: "landable" }]);
  });

  it("says where the stack is blocked when nothing can land", () => {
    const foot = describeStackFoot({
      stack: 14,
      baseRefName: "main",
      layers: [layer(701, 1, "merged"), layer(702, 2, "open", false), layer(703, 3, "open", true)],
      lowest: 702,
    });
    expect(foot).toMatchObject({ mergedCount: 1, blockedAt: 702, tone: "none" });
    expect(stackFootParts(foot)).toEqual([
      { text: "1 merged", tone: "merged" },
      { text: "blocked at #702", tone: "blocked" },
    ]);
  });

  it("only counts merged layers once everything has landed", () => {
    const foot = describeStackFoot({
      stack: 14,
      baseRefName: "main",
      layers: [layer(701, 1, "merged"), layer(702, 2, "merged")],
      lowest: 701,
    });
    expect(foot.tone).toBe("merged");
    expect(stackFootParts(foot)).toEqual([{ text: "2 merged", tone: "merged" }]);
  });
});

describe("buildPullRequestListItems", () => {
  const landable = new Set([701, 715]);
  const isLandable = (entry: Row) => landable.has(entry.number);

  function describeItems(items: ReadonlyArray<PullRequestListItem<Row>>) {
    return items.map((item) =>
      item.kind === "row"
        ? [
            item.entry.number,
            item.spine ? `${item.spine.edge}:${item.spine.up}/${item.spine.down}` : null,
          ]
        : [item.key, stackFootParts(item.foot).map((part) => part.text)],
    );
  }

  it("draws each layer's spine segments and ends the unit in a foot", () => {
    const items = buildPullRequestListItems(
      [
        row(697),
        row(704, { number: 14, position: 4 }),
        row(703, { number: 14, position: 3 }),
        row(702, { number: 14, position: 2 }),
        row(701, { number: 14, position: 1 }),
        row(690),
      ],
      { isLandable },
    );
    expect(describeItems(items)).toEqual([
      [697, null],
      [704, "top:none/none"],
      [703, "mid:none/none"],
      [702, "mid:none/none"],
      // The base layer can land: its segment down to the base is the landable stretch.
      [701, "bottom:none/landable"],
      ["stack:14", ["#701 can land"]],
      [690, null],
    ]);
    const foot = items.find((item) => item.kind === "foot");
    expect(foot?.kind === "foot" ? foot.foot : null).toMatchObject({
      baseRefName: "main",
      tone: "landable",
    });
  });

  it("tones merged layers violet and carries the landable stretch upward", () => {
    landable.add(702);
    const items = buildPullRequestListItems(
      [
        row(703, { number: 14, position: 3 }),
        row(702, { number: 14, position: 2 }),
        row(701, { number: 14, position: 1 }, "merged"),
      ],
      { isLandable },
    );
    expect(describeItems(items)).toEqual([
      [703, "top:none/none"],
      [702, "mid:none/landable"],
      [701, "bottom:landable/merged"],
      ["stack:14", ["1 merged", "#702 can land"]],
    ]);
    landable.delete(702);
  });

  it("describes the whole stack when a filter hides some of its layers", () => {
    const all = [
      row(704, { number: 14, position: 4 }),
      row(703, { number: 14, position: 3 }),
      row(702, { number: 14, position: 2 }),
      row(701, { number: 14, position: 1 }),
    ];
    const items = buildPullRequestListItems([row(703, { number: 14, position: 3 })], {
      isLandable,
      allRows: all,
    });
    expect(describeItems(items)).toEqual([
      [703, "top:none/none"],
      ["stack:14", ["#701 can land"]],
    ]);
  });

  it("gives every row a stable key so motion can track it", () => {
    const items = buildPullRequestListItems([row(716, { number: 15, position: 2, size: 2 })], {
      isLandable,
    });
    expect(items.map((item) => item.key)).toEqual(["pr:716", "stack:15"]);
  });
});
