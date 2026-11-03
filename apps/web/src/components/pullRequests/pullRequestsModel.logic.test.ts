import type { pullRequestSelectionRefreshPhase } from "@ryco/client-runtime/state/pull-request-review";
import { describe, expect, it } from "vitest";

import { resolveSourceControlRefreshDelay } from "../../rpc/sourceControlRefreshPolicy";
import { derivePullRequestsLayoutMetrics } from "./pullRequestsModel.logic";

describe("pullRequestSelectionRefreshPhase cadence", () => {
  it("maps the shared phases onto the house cadence (60s / 120s while watching, never when manual)", () => {
    const delay = (
      phase: ReturnType<typeof pullRequestSelectionRefreshPhase>,
      mode: "automatic" | "reduced" | "manual",
    ) => resolveSourceControlRefreshDelay({ mode, phase });
    expect(delay("watching", "automatic")).toBe(60_000);
    expect(delay("watching", "reduced")).toBe(120_000);
    expect(delay("watching", "manual")).toBe(false);
    expect(delay("watching-slow", "automatic")).toBe(300_000);
    expect(delay("active", "automatic")).toBe(30_000);
    expect(delay("settled", "automatic")).toBe(false);
  });
});

describe("derivePullRequestsLayoutMetrics", () => {
  it("docks the list on wide pages and gives Files the full width", () => {
    const wide = derivePullRequestsLayoutMetrics({
      pageWidth: 1192,
      listWidth: 304,
      listHidden: false,
      hasSelection: true,
      tab: "conversation",
    });
    expect(wide).toMatchObject({
      listVisible: true,
      readerWidth: 887,
      railDocked: true,
      leadingRegion: "list",
    });
    const files = derivePullRequestsLayoutMetrics({
      pageWidth: 1192,
      listWidth: 304,
      listHidden: false,
      hasSelection: true,
      tab: "files",
    });
    expect(files).toMatchObject({ listDocked: false, readerWidth: 1192, leadingRegion: "reader" });
  });

  it("lets the list fill a narrow page with nothing selected", () => {
    expect(
      derivePullRequestsLayoutMetrics({
        pageWidth: 672,
        listWidth: 304,
        listHidden: false,
        hasSelection: false,
        tab: "conversation",
      }),
    ).toMatchObject({
      listDocked: false,
      listFillsPage: true,
      barCompact: false,
      leadingRegion: "list",
    });
  });

  it("gives a listless reader (the workspace panel) every breakpoint at its full width", () => {
    expect(
      derivePullRequestsLayoutMetrics({
        pageWidth: 880,
        listWidth: 304,
        listHidden: false,
        hasSelection: true,
        tab: "conversation",
        listless: true,
      }),
    ).toMatchObject({
      listDocked: false,
      listVisible: false,
      listFillsPage: false,
      readerWidth: 880,
      railDocked: true,
      treeDocked: true,
      barCompact: false,
      leadingRegion: "reader",
    });
  });
});
