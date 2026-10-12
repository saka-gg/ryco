import "../../index.css";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import type { DayPoint, ProjectAggregate } from "../settings/statistics/selectors";
import {
  CodeChangesChart,
  niceTicks,
  ProjectBars,
  SeriesAreaChart,
  visibleTickIndexes,
} from "./charts";

const dates = Array.from(
  { length: 30 },
  (_, index) => `2026-08-${String(index + 1).padStart(2, "0")}`,
);

function day(date: string, additions: number, deletions: number): DayPoint {
  return {
    date,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    uncategorizedTokens: 0,
    totalTokens: 0,
    turns: 0,
    activeMs: 0,
    filesChanged: 0,
    additions,
    deletions,
  };
}

describe("statistics charts", () => {
  it("picks round ticks and non-overlapping labels that keep the last date", () => {
    // Recharts' defaults: five ticks, 0 on the axis, steps of 0.05/0.1 of a power of ten.
    expect(niceTicks(0, 87)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(0, 41)).toEqual([0, 15, 30, 45, 60]);
    expect(niceTicks(-40, 120)).toEqual([-40, 0, 40, 80, 120]);
    expect(niceTicks(0, 0)).toEqual([0, 1, 2, 3, 4]);
    expect(niceTicks(0, 0.37)).toEqual([0, 0.095, 0.19, 0.285, 0.38]);
    const indexes = visibleTickIndexes(["Aug 1", "Aug 2", "Aug 3", "Aug 4", "Aug 5"], 20, 28);
    expect(indexes.at(-1)).toBe(4);
    expect(indexes.length).toBeLessThan(5);
  });

  it("draws gapped area series and reports the hovered day", async () => {
    await render(
      <div style={{ width: 600 }}>
        <SeriesAreaChart
          className="h-[300px]"
          label="Usage over time"
          dates={dates}
          series={[
            {
              key: "claude",
              label: "Claude",
              color: "#d97757",
              values: dates.map((_, index) => (index === 10 ? null : index * 100)),
            },
            { key: "codex", label: "Codex", color: "#6b8cce", values: dates.map(() => 50) },
          ]}
          formatYTick={(value) => String(value)}
          formatValue={(value) => `${value} tokens`}
        />
      </div>,
    );
    const chart = page.getByRole("img", { name: "Usage over time" });
    await expect.element(chart).toBeVisible();
    // The null splits Claude into two runs: two areas and two lines, plus Codex.
    const paths = chart.element().querySelectorAll("path");
    expect(paths.length).toBe(6);
    const plot = chart.element().querySelector("rect")!;
    const bounds = plot.getBoundingClientRect();
    await userEvent.hover(plot, {
      position: { x: bounds.width - 1, y: bounds.height / 2 },
    });
    await expect.element(page.getByText("2900 tokens")).toBeVisible();
    await expect.element(page.getByText("50 tokens")).toBeVisible();
  });

  it("draws one bar per project and day-grouped code changes", async () => {
    const projects: ProjectAggregate[] = ["Alpha", "Beta"].map((title, index) => ({
      projectId: title,
      title,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: (index + 1) * 1000,
      turns: 0,
      activeMs: 0,
      toolUses: 0,
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      commits: 0,
      pushes: 0,
      threadsCreated: 0,
    }));
    await render(
      <div style={{ width: 500 }}>
        <ProjectBars data={projects} />
        <CodeChangesChart data={[day("2026-08-01", 30, 10), day("2026-08-02", 0, 4)]} />
      </div>,
    );
    const bars = page.getByRole("img", { name: "Projects" });
    await expect.element(bars).toBeVisible();
    expect(bars.element().querySelectorAll("path").length).toBe(2);
    await expect.element(page.getByText("Alpha")).toBeVisible();
    const changes = page.getByRole("img", { name: "Code changes" });
    expect(changes.element().querySelectorAll("path").length).toBe(3);
  });
});
