import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { UsageCostBreakdownTotals } from "@ryco/client-runtime/usage";

vi.mock("react-native", () => ({
  // Native-only props are dropped; the style shows the bar's proportions.
  View: ({ children, style }: { children?: ReactNode; style?: object }) => (
    <div style={style}>{children}</div>
  ),
}));
vi.mock("../../../components/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("./StatisticsParts", () => ({
  Note: "p",
  money: (value: number) => `$${value.toFixed(2)}`,
  useStatisticsPalette: () => ({ border: "#ddd", accent: "#eee", muted: "#666" }),
}));
import { UsageCostByType } from "./UsageCostByType";

function totals(overrides: Partial<UsageCostBreakdownTotals>): UsageCostBreakdownTotals {
  return {
    totalUsd: 10,
    inputUsd: 2,
    cacheReadUsd: 1,
    cacheWriteUsd: 0.5,
    outputUsd: 4.5,
    otherUsd: 2,
    speedPremiumUsd: 1.25,
    unsplitBucketCount: 1,
    ...overrides,
  };
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("native usage cost by type", () => {
  it("shows each type's cost and share, the Fast-mode premium and what could not be split", () => {
    const html = renderToStaticMarkup(<UsageCostByType totals={totals({})} />);
    const shown = text(html);
    expect(shown).toContain("Cost by type");
    expect(shown).toContain("Input $2.00 20%");
    expect(shown).toContain("Cache read $1.00 10%");
    expect(shown).toContain("Cache write $0.50 5%");
    expect(shown).toContain("Output $4.50 45%");
    expect(shown).toContain("Other $2.00 20%");
    expect(shown).toContain("Fast-mode premium (included) $1.25");
    expect(shown).toContain("Some cost could not be split");
    expect(html).toContain("flex-grow:0.45");
  });

  it("leaves out empty types, a zero premium and the note when everything is split", () => {
    const shown = text(
      renderToStaticMarkup(
        <UsageCostByType
          totals={totals({
            totalUsd: 8,
            cacheWriteUsd: 0,
            outputUsd: 5,
            otherUsd: 0,
            speedPremiumUsd: 0,
            unsplitBucketCount: 0,
          })}
        />,
      ),
    );
    expect(shown).toContain("Output $5.00 63%");
    expect(shown).not.toContain("Cache write");
    expect(shown).not.toContain("Other");
    expect(shown).not.toContain("Fast-mode premium");
    expect(shown).not.toContain("could not be split");
  });

  it("renders nothing when no cost was split", () => {
    expect(
      renderToStaticMarkup(
        <UsageCostByType
          totals={totals({ inputUsd: 0, cacheReadUsd: 0, cacheWriteUsd: 0, outputUsd: 0 })}
        />,
      ),
    ).toBe("");
  });
});
