import { describe, expect, it } from "vite-plus/test";
import { filterAnchoredMenuActions, resolveAnchoredMenuParent } from "./anchoredMenuModel";

const actions = [
  {
    id: "provider-a",
    title: "Claude",
    subactions: [{ id: "claude:opus", title: "Opus", state: "on" as const }],
  },
  { id: "provider-b", title: "OpenCode", subactions: [{ id: "open:opus", title: "Opus" }] },
];

describe("Anchored model menu search", () => {
  it("searches across providers without collapsing identical model names", () => {
    expect(
      filterAnchoredMenuActions(actions, actions[0]?.subactions, " OPUS ").map((action) => [
        action.id,
        action.subtitle,
      ]),
    ).toEqual([
      ["claude:opus", "Claude"],
      ["open:opus", "OpenCode"],
    ]);
    expect(
      filterAnchoredMenuActions(actions, undefined, "claude").map((action) => action.id),
    ).toEqual(["claude:opus"]);
    expect(filterAnchoredMenuActions(actions, undefined, "missing")).toEqual([]);
  });
  it("returns the current provider when search clears and respects hidden/disabled choices", () => {
    expect(filterAnchoredMenuActions(actions, actions[0]?.subactions, "")).toEqual(
      actions[0]?.subactions,
    );
    const filtered = filterAnchoredMenuActions(
      [
        { title: "Unavailable", attributes: { disabled: true }, subactions: [{ title: "Opus" }] },
        { title: "Hidden", attributes: { hidden: true }, subactions: [{ title: "Opus" }] },
        { title: "Other", subactions: [{ title: "Opus", attributes: { hidden: true } }] },
      ],
      undefined,
      "opus",
    );
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.attributes?.disabled).toBe(true);
  });
});

describe("Anchored menu nested submenus", () => {
  const legacy = {
    id: "#legacy:claude",
    title: "Legacy models",
    subactions: [
      { id: "claude:opus-4-6", title: "Opus 4.6" },
      { id: "claude:haiku-4-5", title: "Haiku 4.5", attributes: { hidden: true } },
    ],
  };
  const nested = [
    {
      id: "provider-a",
      title: "Claude",
      attributes: { disabled: true },
      subactions: [{ id: "claude:opus-5", title: "Opus 5" }, legacy],
    },
  ];

  it("searches a nested submenu's leaves in place of the submenu", () => {
    const opus = filterAnchoredMenuActions(nested, undefined, "opus");
    expect(opus.map((action) => [action.id, action.subtitle])).toEqual([
      ["claude:opus-5", "Claude"],
      ["claude:opus-4-6", "Claude"],
    ]);
    // Disabled reaches every depth; hidden leaves stay hidden.
    expect(opus.every((action) => action.attributes?.disabled === true)).toBe(true);
    expect(filterAnchoredMenuActions(nested, undefined, "haiku")).toEqual([]);
    expect(filterAnchoredMenuActions(nested, undefined, "legacy")).toEqual([]);
  });

  it("resolves each level of the path from the current actions", () => {
    const stale = { ...legacy, subactions: [{ id: "claude:old", title: "Old" }] };
    expect(resolveAnchoredMenuParent(nested, [])).toBeNull();
    expect(resolveAnchoredMenuParent(nested, [nested[0]!, stale])).toBe(legacy);
    // A level that is gone keeps the snapshot it opened with.
    const folded = [{ ...nested[0]!, subactions: [{ id: "claude:opus-5", title: "Opus 5" }] }];
    expect(resolveAnchoredMenuParent(folded, [nested[0]!, stale])).toBe(stale);
  });
});
