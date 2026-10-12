import "../../../index.css";
import { useState } from "react";
import { EnvironmentId, type UsageImportedMetric } from "@ryco/contracts";
import type { MergedUsageSummary } from "@ryco/client-runtime/usage";
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
