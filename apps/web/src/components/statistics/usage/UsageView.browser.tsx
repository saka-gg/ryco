import "../../../index.css";
import { useState } from "react";
import { EnvironmentId, type UsageCostBreakdown, type UsageImportedMetric } from "@ryco/contracts";
import type { MergedUsageBucket, MergedUsageSummary } from "@ryco/client-runtime/usage";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { parseStatisticsSearch } from "../statisticsSearch";
import { UsageView } from "./UsageView";
const state = vi.hoisted(() => ({
  merged: null as MergedUsageSummary | null,
  connecting: false,
  pendingEnvironmentIds: [] as string[],
}));
vi.mock("../useUsageSummary", () => ({
  useUsageSummary: () => ({
    merged: state.merged,
    environments: [],
    availableEnvironments: [{ environmentId: "fixture", label: "Synthetic node" }],
    pendingEnvironmentIds: state.pendingEnvironmentIds,
    connecting: state.connecting,
    loading: state.pendingEnvironmentIds.length > 0,
    refreshing: state.pendingEnvironmentIds.length > 0 && state.merged !== null,
    refresh: () => {},
  }),
}));
function fixture(imports: readonly UsageImportedMetric[] = []): MergedUsageSummary {
  return {
    startDate: "2026-08-01",
    endDate: "2026-08-10",
    timeZone: "UTC",
    buckets: [],
    imports,
    sources: [
      {
        sourceId: "fixture",
        provider: "cursor",
        deduplicationKind: "declared",
        status: imports.length ? "partial" : "unsupported",
        environmentId: EnvironmentId.make("fixture"),
        environmentLabel: "Synthetic node",
        included: true,
        transcriptFileCount: 0,
        reusedCacheFileCount: 0,
        parsedFileCount: 0,
        skippedLineCount: 0,
        malformedLineCount: 0,
        distinctSessionCount: 0,
        distinctResponseCount: 0,
        scanStartedAt: "2026-08-10T12:00:00.000Z",
        scanFinishedAt: "2026-08-10T12:00:00.000Z",
        scanDurationMs: 0,
        message: imports.length
          ? "Saved export: token fields unavailable and page set incomplete."
          : "Configure saved Cursor Admin API JSON exports in provider settings.",
      },
    ],
    environments: [],
    duplicateSourceCount: 0,
    environmentOnlyDeduplicationWarning: false,
  };
}
function costBucket(
  date: string,
  model: string,
  estimatedCostUsd: number,
  costBreakdown?: UsageCostBreakdown,
): MergedUsageBucket {
  return {
    date,
    provider: "claude",
    model,
    tokens: {
      uncachedInputTokens: 1_000,
      cachedInputTokens: 3_000,
      cacheCreationInputTokens: 1_000,
      outputTokens: 500,
      totalTokens: 5_500,
    },
    responseCount: 4,
    sessionCount: 1,
    estimatedCostUsd,
    ...(costBreakdown === undefined ? {} : { costBreakdown }),
    pricedTokenCount: 5_500,
    unpricedTokenCount: 0,
    costSource: costBreakdown === undefined ? "provider-reported" : "litellm",
    sourceIds: ["claude-home"],
  };
}
/** $10: $8 split by type ($1.25 of it Fast-mode premium), $2 reported without a rate. */
function costFixture(split = true): MergedUsageSummary {
  const base = fixture();
  return {
    ...base,
    buckets: [
      costBucket(
        "2026-08-09",
        "claude-opus-4-1",
        8,
        split
          ? {
              inputUsd: 2,
              cacheReadUsd: 1,
              cacheWriteUsd: 0.5,
              outputUsd: 4.5,
              speedPremiumUsd: 1.25,
            }
          : undefined,
      ),
      costBucket("2026-08-10", "claude-preview-x", 2),
    ],
    sources: [
      {
        ...base.sources[0]!,
        sourceId: "claude-home",
        provider: "claude",
        deduplicationKind: "physical",
        status: "complete",
        transcriptFileCount: 2,
        parsedFileCount: 2,
        distinctSessionCount: 1,
        distinctResponseCount: 8,
      },
    ],
  };
}
function Harness() {
  const [search, setSearch] = useState(parseStatisticsSearch({}));
  return (
    <div style={{ width: 1100 }}>
      <UsageView search={search} onSearchChange={setSearch} />
    </div>
  );
}
describe("usage provider history", () => {
  it("shows loading, not the empty state, while this app's node is still connecting", async () => {
    state.merged = null;
    state.connecting = true;
    state.pendingEnvironmentIds = [];
    await render(<Harness />);
    await expect
      .element(page.getByText("No usage environments are connected"))
      .not.toBeInTheDocument();
    state.connecting = false;
  });
  it("keeps showing the last result while an environment refreshes", async () => {
    state.merged = fixture();
    state.pendingEnvironmentIds = ["fixture"];
    await render(<Harness />);
    await expect.element(page.getByText("Updating Synthetic node…")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Refreshing" })).toBeDisabled();
    state.pendingEnvironmentIds = [];
  });
  it("keeps setup coverage visible when there are no token buckets", async () => {
    state.merged = fixture();
    await render(<Harness />);
    await expect.element(page.getByRole("button", { name: "OpenCode", exact: true })).toBeVisible();
    await expect
      .element(
        page.getByText("Configure saved Cursor Admin API JSON exports in provider settings.", {
          exact: false,
        }),
      )
      .toBeVisible();
  });
  it("splits the estimated cost by token type with the Fast-mode premium and an Other note", async () => {
    state.merged = costFixture();
    await render(<Harness />);
    const types = page.getByRole("list", { name: "Cost by type" });
    await expect.element(types).toBeVisible();
    const rows = types.getByRole("listitem");
    await expect.element(rows.nth(0)).toMatchTextContent(/Input\s*\$2\.00\s*20%/u);
    await expect.element(rows.nth(1)).toMatchTextContent(/Cache read\s*\$1\.00\s*10%/u);
    await expect.element(rows.nth(2)).toMatchTextContent(/Cache write\s*\$0\.50\s*5%/u);
    await expect.element(rows.nth(3)).toMatchTextContent(/Output\s*\$4\.50\s*45%/u);
    await expect.element(rows.nth(4)).toMatchTextContent(/Other\s*\$2\.00\s*20%/u);
    expect(rows.elements()).toHaveLength(5);
    await expect.element(page.getByText("Fast-mode premium (included)")).toBeVisible();
    await expect.element(page.getByText("$1.25", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Some cost could not be split", { exact: false }))
      .toBeVisible();
    // The rail's cache-read share: 3,000 of 5,000 input tokens per bucket.
    await expect.element(page.getByText("60%", { exact: true })).toBeVisible();
  });
  it("leaves the cost unsplit when no node split it", async () => {
    state.merged = costFixture(false);
    await render(<Harness />);
    await expect.element(page.getByText("$10.00", { exact: true })).toBeVisible();
    await expect.element(page.getByRole("list", { name: "Cost by type" })).not.toBeInTheDocument();
    await expect.element(page.getByText("Fast-mode premium (included)")).not.toBeInTheDocument();
  });
  it("paginates billed metadata separately and applies Cursor filters without inventing token buckets", async () => {
    state.merged = fixture(
      Array.from({ length: 25 }, (_, index) => ({
        sourceId: "fixture",
        recordId: `hash-${index}`,
        provider: "cursor",
        date: "2026-08-10",
        metric: "cost",
        value: 0.1,
        currency: "USD",
      })),
    );
    await render(<Harness />);
    await expect.element(page.getByText("Cursor exported events and billed cost")).toBeVisible();
    await expect.element(page.getByText("1 / 2", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect.element(page.getByText("2 / 2", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cursor", exact: true }).click();
    await expect
      .element(page.getByText("Cursor exported events and billed cost"))
      .not.toBeInTheDocument();
  });
});
