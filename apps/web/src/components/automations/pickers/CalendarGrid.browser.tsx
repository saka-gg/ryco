import "../../../index.css";

import { AUTOMATION_LIMITS, dayStart } from "@ryco/shared/automationSchedule";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { CalendarGrid } from "./CalendarGrid";

const NOW = new Date(2026, 9, 7, 10, 42).getTime();
const MAX = NOW + AUTOMATION_LIMITS.horizonMs;
const day = (month: number, date: number, year = 2026) => new Date(year, month - 1, date).getTime();

function focusedLabel(): string {
  return document.activeElement?.getAttribute("aria-label") ?? "";
}

function renderGrid(onPick = vi.fn<(dayMs: number) => void>(), value = day(10, 8)) {
  return render(
    <CalendarGrid value={value} min={NOW} max={MAX} nowMs={NOW} autoFocus onPick={onPick} />,
  );
}

describe("CalendarGrid", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("is one Tab stop on the selected day, today marked", async () => {
    mounted = await renderGrid();
    await expect.element(page.getByRole("grid")).toBeVisible();
    expect(focusedLabel()).toBe("Thursday, October 8, 2026");
    const stops = page
      .getByRole("gridcell")
      .elements()
      .filter((cell) => cell.tabIndex === 0);
    expect(stops).toHaveLength(1);
    await expect
      .element(page.getByRole("gridcell", { name: "Thursday, October 8, 2026" }))
      .toHaveAttribute("aria-selected", "true");
    await expect
      .element(page.getByRole("gridcell", { name: /^Wednesday, October 7, 2026, today$/ }))
      .toHaveAttribute("aria-current", "date");
  });

  it("moves by day, week, week end and month with the APG keys", async () => {
    mounted = await renderGrid();
    await userEvent.keyboard("{ArrowRight}");
    expect(focusedLabel()).toBe("Friday, October 9, 2026");
    await userEvent.keyboard("{ArrowDown}");
    expect(focusedLabel()).toBe("Friday, October 16, 2026");
    await userEvent.keyboard("{ArrowLeft}");
    expect(focusedLabel()).toBe("Thursday, October 15, 2026");
    await userEvent.keyboard("{ArrowUp}");
    expect(focusedLabel()).toBe("Thursday, October 8, 2026");
    await userEvent.keyboard("{Home}");
    expect(focusedLabel()).toBe("Monday, October 5, 2026, unavailable, in the past");
    await userEvent.keyboard("{End}");
    expect(focusedLabel()).toBe("Sunday, October 11, 2026");
    await userEvent.keyboard("{PageDown}");
    expect(focusedLabel()).toBe("Wednesday, November 11, 2026");
    await expect.element(page.getByText("November 2026", { exact: true })).toBeVisible();
    await userEvent.keyboard("{Shift>}{PageUp}{/Shift}");
    // A year back would leave the window: it stops at the first allowed month.
    expect(focusedLabel()).toBe("Thursday, October 1, 2026, unavailable, in the past");
    await userEvent.keyboard("{PageDown}{PageDown}{PageDown}");
    expect(focusedLabel()).toBe("Friday, January 1, 2027");
    await userEvent.keyboard(
      "{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}",
    );
    expect(focusedLabel()).toBe("Thursday, January 7, 2027, unavailable, beyond the 90-day limit");
    // …and at the last allowed month going forward.
    await userEvent.keyboard("{PageDown}");
    expect(focusedLabel()).toBe("Sunday, January 31, 2027, unavailable, beyond the 90-day limit");
  });

  it("chooses with Enter or Space, never an unavailable day", async () => {
    const onPick = vi.fn<(dayMs: number) => void>();
    mounted = await renderGrid(onPick);
    await userEvent.keyboard("{ArrowRight}{Enter}");
    expect(onPick).toHaveBeenLastCalledWith(day(10, 9));
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard(" ");
    expect(onPick).toHaveBeenLastCalledWith(day(10, 10));
    await userEvent.keyboard("{ArrowUp}{Enter}");
    // Oct 3 is in the past.
    expect(onPick).toHaveBeenCalledTimes(2);
    await page
      .getByRole("gridcell", { name: "Monday, October 5, 2026, unavailable, in the past" })
      .click({ force: true });
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it("pages with the month buttons, which say when they can't go further", async () => {
    mounted = await renderGrid();
    const previous = page.getByRole("button", { name: "Previous month" });
    const next = page.getByRole("button", { name: "Next month" });
    await expect.element(previous).toHaveAttribute("aria-disabled", "true");
    await next.click();
    await expect.element(page.getByText("November 2026", { exact: true })).toBeVisible();
    await expect.element(previous).toHaveAttribute("aria-disabled", "false");
    await next.click();
    await next.click();
    await expect.element(page.getByText("January 2027", { exact: true })).toBeVisible();
    await expect.element(next).toHaveAttribute("aria-disabled", "true");
    await next.click({ force: true });
    await expect.element(page.getByText("January 2027", { exact: true })).toBeVisible();
    // The roving focus followed the month.
    const stop = page
      .getByRole("gridcell")
      .elements()
      .find((cell) => cell.tabIndex === 0);
    expect(stop?.getAttribute("aria-label")).toMatch(/^Friday, January 8, 2027/);
  });

  it("draws a range from its start to the chosen day", async () => {
    const start = day(10, 8);
    mounted = await render(
      <CalendarGrid
        value={new Date(2026, 9, 14, 23, 59).getTime()}
        min={start}
        max={MAX}
        nowMs={NOW}
        rangeStart={start}
        compact
        onPick={() => {}}
      />,
    );
    const inRange = page
      .getByRole("gridcell")
      .elements()
      .filter((cell) => cell.hasAttribute("data-range"))
      .map((cell) => Number(cell.getAttribute("data-ms")));
    expect(inRange).toEqual([8, 9, 10, 11, 12, 13, 14].map((date) => dayStart(day(10, date))));
  });
});
