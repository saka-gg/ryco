import { describe, expect, it } from "vite-plus/test";
import { filterAnchoredMenuActions } from "./anchoredMenuModel";

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
