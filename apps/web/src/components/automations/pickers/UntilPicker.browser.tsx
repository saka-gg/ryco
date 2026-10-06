import "../../../index.css";

import {
  DAY_MS,
  WEEK_MS,
  countRuns,
  endFor,
  formatDate,
  formatDateTime,
  untilLimit,
  withMinutes,
} from "@ryco/shared/automationSchedule";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

import { type UntilVia, UntilPicker } from "./UntilPicker";

const NOW = new Date(2026, 9, 7, 10, 42).getTime();
const START = new Date(2026, 9, 8, 9, 0).getTime();
const LIMIT = untilLimit(NOW);

type CommitSpy = (ms: number, info: { readonly via: UntilVia }) => void;

function Harness(props: {
  readonly start?: number;
  readonly initial: number;
  readonly onChange?: (ms: number) => void;
  readonly onCommit?: CommitSpy;
}) {
  const [value, setValue] = useState(props.initial);
  return (
    <div style={{ width: 460, padding: 12 }}>
      <UntilPicker
        startMs={props.start ?? START}
        valueMs={value}
        nowMs={NOW}
        intervalMs={DAY_MS}
        onChange={(ms) => {
          setValue(ms);
          props.onChange?.(ms);
        }}
        onCommit={props.onCommit}
      />
    </div>
  );
}

const runsUntil = (end: number, start = START) =>
  countRuns({ kind: "fixed-interval", startsAt: start, intervalMs: DAY_MS, endsAt: end });

describe("UntilPicker", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("reads an end back as its preset, with the runs it allows", async () => {
    const end = endFor(START, WEEK_MS);
    mounted = await render(<Harness initial={end} />);
    await expect
      .element(page.getByRole("radio", { name: "1 week" }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(page.getByText(`Until ${formatDateTime(end, NOW)}`, { exact: true }))
      .toBeVisible();
    await expect.element(page.getByText(`${runsUntil(end)} runs`, { exact: true })).toBeVisible();
  });

  it("sets a preset (wall-clock days from the start) and reports the click", async () => {
    const onChange = vi.fn<(ms: number) => void>();
    const onCommit = vi.fn<CommitSpy>();
    mounted = await render(
      <Harness initial={endFor(START, WEEK_MS)} onChange={onChange} onCommit={onCommit} />,
    );
    await page.getByRole("radio", { name: "30 days" }).click();
    const end = endFor(START, 30 * DAY_MS);
    expect(onChange).toHaveBeenCalledWith(end);
    expect(onCommit).toHaveBeenCalledWith(end, { via: "preset" });
    await expect.element(page.getByText(`${runsUntil(end)} runs`, { exact: true })).toBeVisible();
  });

  it("keeps a preset that would pass the 90-day limit out of reach and says why", async () => {
    const onChange = vi.fn<(ms: number) => void>();
    const start = new Date(2026, 11, 20, 9, 0).getTime();
    mounted = await render(
      <Harness start={start} initial={endFor(start, DAY_MS)} onChange={onChange} />,
    );
    const thirty = page.getByRole("radio", { name: "30 days" });
    await expect.element(thirty).toHaveAttribute("aria-disabled", "true");
    await expect
      .element(page.getByRole("radio", { name: "2 weeks" }))
      .toHaveAttribute("aria-disabled", "false");
    // Its tip says why; clicking it changes nothing.
    await thirty.hover();
    await expect
      .element(page.getByText(`Past the 90-day limit (${formatDate(LIMIT, NOW)})`, { exact: true }))
      .toBeVisible();
    await thirty.click({ force: true });
    expect(onChange).not.toHaveBeenCalled();
    // Arrowing skips it.
    (page.getByRole("radio", { name: "2 weeks" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect.element(page.getByRole("radio", { name: "Until the 90-day limit" })).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith(LIMIT);
  });

  it("ends at the 90-day limit with Max", async () => {
    const onChange = vi.fn<(ms: number) => void>();
    const onCommit = vi.fn<CommitSpy>();
    mounted = await render(
      <Harness initial={endFor(START, WEEK_MS)} onChange={onChange} onCommit={onCommit} />,
    );
    await page.getByRole("radio", { name: "Until the 90-day limit" }).click();
    expect(onChange).toHaveBeenCalledWith(LIMIT);
    expect(onCommit).toHaveBeenCalledWith(LIMIT, { via: "max" });
    await expect.element(page.getByText("the 90-day limit", { exact: true })).toBeVisible();
  });

  it("explains an end past the limit and offers the latest one", async () => {
    const onChange = vi.fn<(ms: number) => void>();
    mounted = await render(<Harness initial={LIMIT + 2 * DAY_MS} onChange={onChange} />);
    await expect
      .element(
        page.getByText(`Past the 90-day limit — the latest is ${formatDate(LIMIT, NOW)}`, {
          exact: true,
        }),
      )
      .toBeVisible();
    await page.getByRole("button", { name: `Use ${formatDate(LIMIT, NOW)}` }).click();
    expect(onChange).toHaveBeenCalledWith(LIMIT);
  });

  it("says when an end comes before the start", async () => {
    mounted = await render(<Harness initial={START - DAY_MS} />);
    await expect
      .element(page.getByText("Ends before it starts — pick a later end", { exact: true }))
      .toBeVisible();
  });

  it("picks the end of a day from the calendar, drawn from the start", async () => {
    const onChange = vi.fn<(ms: number) => void>();
    const onCommit = vi.fn<CommitSpy>();
    mounted = await render(
      <Harness initial={endFor(START, WEEK_MS)} onChange={onChange} onCommit={onCommit} />,
    );
    const date = page.getByRole("radio", { name: "On a date. Opens a calendar" });
    await date.click();
    // The grid opens on the current end, the range drawn from the start.
    await expect
      .element(page.getByRole("gridcell", { name: "Thursday, October 15, 2026" }))
      .toHaveFocus();
    await expect
      .element(page.getByRole("gridcell", { name: "Thursday, October 8, 2026" }))
      .toHaveAttribute("data-range-start", "");
    await expect
      .element(page.getByText(`From ${formatDate(START, NOW)}`, { exact: true }))
      .toBeVisible();
    await userEvent.keyboard("{ArrowRight}{Enter}");
    const end = withMinutes(new Date(2026, 9, 16).getTime(), 1439);
    expect(onChange).toHaveBeenCalledWith(end);
    expect(onCommit).toHaveBeenCalledWith(end, { via: "date" });
    // It closes back onto the chip, which now names the date.
    await expect
      .element(page.getByRole("radio", { name: `On ${formatDate(end, NOW)}. Opens a calendar` }))
      .toHaveFocus();
    expect(page.getByRole("grid").elements()).toHaveLength(0);
    await expect.element(page.getByText(/^Through /)).toBeVisible();
  });

  it("closes the calendar on Escape without changing the end", async () => {
    const onChange = vi.fn<(ms: number) => void>();
    mounted = await render(<Harness initial={endFor(START, WEEK_MS)} onChange={onChange} />);
    const date = page.getByRole("radio", { name: "On a date. Opens a calendar" });
    await date.click();
    await expect.element(page.getByRole("grid")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(date).toHaveFocus();
    await expect.poll(() => page.getByRole("grid").elements().length).toBe(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("works inside a host popover: its calendar nests, Escape closes one layer at a time", async () => {
    const onChange = vi.fn<(ms: number) => void>();
    mounted = await render(
      <Popover defaultOpen>
        <PopoverTrigger>Ends</PopoverTrigger>
        <PopoverPopup aria-label="Ends">
          <Harness initial={endFor(START, WEEK_MS)} onChange={onChange} />
        </PopoverPopup>
      </Popover>,
    );
    await page.getByRole("radio", { name: "On a date. Opens a calendar" }).click();
    await page.getByRole("gridcell", { name: "Friday, October 16, 2026" }).click();
    expect(onChange).toHaveBeenCalledWith(withMinutes(new Date(2026, 9, 16).getTime(), 1439));
    // The pick closed the calendar only; the host popover stays.
    await expect.poll(() => page.getByRole("grid").elements().length).toBe(0);
    await expect.element(page.getByRole("radiogroup", { name: "Ends" })).toBeVisible();

    await page.getByRole("radio", { name: /^On Oct 16/ }).click();
    await expect.element(page.getByRole("grid")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => page.getByRole("grid").elements().length).toBe(0);
    await expect.element(page.getByRole("radiogroup", { name: "Ends" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect
      .poll(() => page.getByRole("radiogroup", { name: "Ends" }).elements().length)
      .toBe(0);
  });
});
