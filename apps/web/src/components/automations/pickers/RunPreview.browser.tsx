import "../../../index.css";

import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  type ScheduleMs,
  countRuns,
  formatDay,
  formatShortDateTime,
  formatTime,
  lastRun,
  rel,
  runPreviewNote,
} from "@ryco/shared/automationSchedule";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { RunPreview } from "./RunPreview";

const NOW = new Date(2026, 9, 7, 10, 42).getTime();
const START = new Date(2026, 9, 8, 9, 0).getTime();
const DAILY: ScheduleMs = {
  kind: "fixed-interval",
  startsAt: START,
  intervalMs: DAY_MS,
  endsAt: new Date(2026, 10, 7, 9, 0).getTime(),
};

/** The total's current reading (not a layer that is fading out). */
function totalText(): string {
  return (
    document.querySelector("[data-total] .pk-xf:not([data-leaving])")?.textContent?.trim() ?? ""
  );
}

function rowTexts(): string[][] {
  return [...document.querySelectorAll(".pk-pv-row:not(.is-leaving)")].map((row) =>
    [...row.children].map((cell) => cell.textContent ?? ""),
  );
}

function Frame(props: { readonly schedule: ScheduleMs | null; readonly visibleRows?: number }) {
  return (
    <div style={{ width: 600 }}>
      <RunPreview schedule={props.schedule} nowMs={NOW} visibleRows={props.visibleRows} />
    </div>
  );
}

describe("RunPreview", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("counts the runs, names the last, and lists the next five", async () => {
    mounted = await render(<Frame schedule={DAILY} />);
    const count = countRuns(DAILY, NOW);
    await expect
      .poll(totalText)
      .toBe(`${count} runs · last ${formatShortDateTime(lastRun(DAILY), NOW)}`);
    const rows = rowTexts();
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual([formatDay(START, NOW), formatTime(START), rel(START, NOW)]);
    await expect.element(page.getByRole("region", { name: "Next runs" })).toBeVisible();
  });

  it("dates a clock change for a day-based interval, and draws the strip", async () => {
    mounted = await render(<Frame schedule={DAILY} />);
    const note = runPreviewNote(DAILY, NOW);
    if (note) await expect.element(page.getByText(note, { exact: true })).toBeVisible();
    // 31 runs across 600px: ticks are ~20px apart, so the strip shows the next five.
    await expect.poll(() => document.querySelectorAll(".pk-pv-mark").length).toBe(5);
    expect(document.querySelectorAll(".pk-pv-mark[data-next]")).toHaveLength(1);
  });

  it("says a day's time only once and warns about frequent approvals", async () => {
    const schedule: ScheduleMs = {
      kind: "fixed-interval",
      startsAt: NOW + HOUR_MS,
      intervalMs: 15 * MINUTE_MS,
      endsAt: NOW + 30 * DAY_MS,
    };
    mounted = await render(<Frame schedule={schedule} />);
    await expect
      .element(
        page.getByText("About 96 runs a day — each waits up to 15 min for your approval.", {
          exact: true,
        }),
      )
      .toBeVisible();
    const rows = rowTexts();
    expect(rows[0]?.[0]).toBe(formatDay(NOW + HOUR_MS, NOW));
    // Later runs the same day read by time alone.
    expect(rows[1]?.[0]).toBe("");
    expect(rows[1]?.[2]).toBe("");
    // Ticks would crowd under 3px: the strip steps aside.
    expect(document.querySelectorAll(".pk-pv-mark")).toHaveLength(0);
  });

  it("says once, none left, or no schedule", async () => {
    mounted = await render(<Frame schedule={{ kind: "once", runAt: START }} />);
    await expect.poll(totalText).toBe("Runs once");
    await mounted.rerender(<Frame schedule={{ kind: "once", runAt: NOW - HOUR_MS }} />);
    await expect.poll(totalText).toBe("No runs left");
    await expect
      .element(page.getByRole("list"))
      .toHaveAttribute("data-empty", "Nothing left to run in this window");
    await mounted.rerender(<Frame schedule={null} />);
    await expect.poll(totalText).toBe("No schedule");
  });

  it("updates the count when the schedule changes", async () => {
    mounted = await render(<Frame schedule={DAILY} />);
    const shorter: ScheduleMs = { ...DAILY, endsAt: START + 9 * DAY_MS };
    await mounted.rerender(<Frame schedule={shorter} />);
    await expect
      .poll(totalText)
      .toBe(`${countRuns(shorter, NOW)} runs · last ${formatShortDateTime(lastRun(shorter), NOW)}`);
  });

  it("counts from the old total to the new one, and React keeps the number", async () => {
    mounted = await render(<Frame schedule={DAILY} />);
    const from = countRuns(DAILY, NOW);
    await expect.poll(totalText).toContain(`${from} runs`);
    const before = document.querySelector("[data-total] .pk-xf:not([data-leaving])");
    // A change after a pause (not a burst of steps) may move.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const shorter: ScheduleMs = { ...DAILY, endsAt: START + 9 * DAY_MS };
    const to = countRuns(shorter, NOW);
    const seen = new Set<number>();
    let sampling = true;
    const sample = () => {
      const text = document.querySelector("[data-total] .pk-xf:not([data-leaving]) b")?.textContent;
      if (text) seen.add(Number(text));
      if (sampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    await mounted.rerender(<Frame schedule={shorter} />);
    // The old layer keeps its element while it fades out.
    expect(before?.isConnected).toBe(true);
    expect(before?.hasAttribute("data-leaving")).toBe(true);
    await expect
      .poll(totalText)
      .toBe(`${to} runs · last ${formatShortDateTime(lastRun(shorter), NOW)}`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    sampling = false;
    expect([...seen].some((value) => value > to && value < from)).toBe(true);
    // React still owns the text: a later change lands without a tween in between.
    await mounted.rerender(<Frame schedule={DAILY} />);
    await expect.poll(totalText).toContain(`${from} runs`);
  });

  it("shows as many upcoming runs as asked", async () => {
    mounted = await render(<Frame schedule={DAILY} visibleRows={2} />);
    const list = page.getByRole("list").element() as HTMLElement;
    expect(list.getBoundingClientRect().height).toBe(58);
  });
});
