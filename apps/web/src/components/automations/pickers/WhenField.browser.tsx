import "../../../index.css";

import {
  AUTOMATION_LIMITS,
  formatDateTime,
  rel,
  withMinutes,
} from "@ryco/shared/automationSchedule";
import { explainWhen, parseWhen, suggestWhen } from "@ryco/shared/automationWhenParser";
import { type KeyboardEvent, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";

import { type WhenVia, WhenField } from "./WhenField";

// Wed Oct 7 2026, 10:42 local — the lab's simulated now. Every expectation is
// computed with the shared model, so the tests hold in any time zone.
const NOW = new Date(2026, 9, 7, 10, 42).getTime();
const TOMORROW_9 = new Date(2026, 9, 8, 9, 0).getTime();
const MAX = NOW + AUTOMATION_LIMITS.horizonMs;
const RANGE = { nowMs: NOW, min: NOW, max: MAX };

type ChangeSpy = (ms: number, info: { readonly via: WhenVia }) => void;
type CommitSpy = (ms: number, info: { readonly changed: boolean; readonly via: WhenVia }) => void;

function Harness(props: {
  readonly onChange?: ChangeSpy;
  readonly onCommit?: CommitSpy;
  readonly onHostKeyDown?: (key: string) => void;
  readonly initialText?: string;
  readonly nowMs?: number;
}) {
  const [value, setValue] = useState<number | null>(TOMORROW_9);
  return (
    <div
      data-testid="host"
      style={{ width: 460, padding: "10px 12px 12px" }}
      onKeyDown={(event: KeyboardEvent) => props.onHostKeyDown?.(event.key)}
    >
      <WhenField
        value={value}
        nowMs={props.nowMs ?? NOW}
        label="First run"
        autoFocus
        initialText={props.initialText}
        onChange={(ms, info) => {
          setValue(ms);
          props.onChange?.(ms, info);
        }}
        onCommit={props.onCommit}
      />
    </div>
  );
}

/** The chip's current reading (not a layer that is fading out). */
function chipText(): string {
  return document.querySelector(".pk-chip .pk-xf:not([data-leaving])")?.textContent ?? "";
}

function input() {
  return page.getByRole("combobox", { name: "First run" });
}

describe("WhenField", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("reads a typed phrase into a live chip and sets it on Enter", async () => {
    const onChange = vi.fn<ChangeSpy>();
    const onCommit = vi.fn<CommitSpy>();
    mounted = await render(<Harness onChange={onChange} onCommit={onCommit} />);
    await expect.element(input()).toHaveFocus();
    await expect.poll(chipText).toBe(rel(TOMORROW_9, NOW));

    await userEvent.keyboard("fri 17:30");
    const friday = new Date(2026, 9, 9, 17, 30).getTime();
    await expect.poll(chipText).toContain(formatDateTime(friday, NOW));
    expect(chipText()).toContain(rel(friday, NOW));

    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalledWith(friday, { via: "type" });
    expect(onCommit).toHaveBeenCalledWith(friday, { changed: true, via: "type" });
    // The field reads back what is set; the chip confirms it.
    await expect.element(input()).toHaveValue(formatDateTime(friday, NOW));
    await expect.poll(chipText).toBe(rel(friday, NOW));
  });

  it("commits Enter on the value as it stands without changing it", async () => {
    const onChange = vi.fn<ChangeSpy>();
    const onCommit = vi.fn<CommitSpy>();
    mounted = await render(<Harness onChange={onChange} onCommit={onCommit} />);
    await expect.element(input()).toHaveFocus();
    await userEvent.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledWith(TOMORROW_9, { changed: false, via: "type" });
  });

  it("offers suggestions for what is typed and chooses them with ↑ ↓ ↵", async () => {
    const onChange = vi.fn<ChangeSpy>();
    mounted = await render(<Harness onChange={onChange} />);
    await expect.element(input()).toHaveFocus();

    // Nothing typed: the default suggestions.
    const defaults = suggestWhen("", NOW, { min: NOW, max: MAX, defaultTime: 540 });
    await expect.poll(() => page.getByRole("option").elements().length).toBe(defaults.length);

    await userEvent.keyboard("tom");
    const expected = suggestWhen("tom", NOW, { min: NOW, max: MAX, defaultTime: 540 });
    expect(expected.length).toBeGreaterThanOrEqual(3);
    await expect
      .poll(() =>
        page
          .getByRole("option")
          .elements()
          .map((option) => option.textContent),
      )
      .toEqual(expected.map((item) => `${item.phrase}${item.label}`));

    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    const options = page.getByRole("option").elements();
    await expect.element(page.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
    await expect.element(input()).toHaveAttribute("aria-activedescendant", options[1]?.id ?? "");
    await userEvent.keyboard("{ArrowUp}");
    await expect.element(page.getByRole("option").nth(0)).toHaveAttribute("aria-selected", "true");
    // ↑ from the first wraps to the last.
    await userEvent.keyboard("{ArrowUp}");
    await expect
      .element(page.getByRole("option").nth(expected.length - 1))
      .toHaveAttribute("aria-selected", "true");
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenCalledWith(expected[0]?.ms, { via: "suggestion" });
    await expect.element(input()).toHaveValue(formatDateTime(expected[0]?.ms ?? 0, NOW));
  });

  it("chooses a suggestion with the pointer without leaving the field", async () => {
    const onChange = vi.fn<ChangeSpy>();
    mounted = await render(<Harness onChange={onChange} />);
    await userEvent.keyboard("tom");
    const expected = suggestWhen("tom", NOW, { min: NOW, max: MAX, defaultTime: 540 });
    await page.getByRole("option").nth(1).click();
    expect(onChange).toHaveBeenCalledWith(expected[1]?.ms, { via: "suggestion" });
    await expect.element(input()).toHaveFocus();
  });

  it("explains a past time and offers the earliest usable one", async () => {
    const onChange = vi.fn<ChangeSpy>();
    mounted = await render(<Harness onChange={onChange} />);
    await userEvent.keyboard("yesterday 9");
    const reading = parseWhen("yesterday 9", NOW, { defaultTime: 540 });
    if (!reading.ok) throw new Error("expected a reading");
    const why = explainWhen(reading.ms, RANGE);
    if (!why || why.fix == null) throw new Error("expected a past explanation with a fix");
    expect(why.kind).toBe("past");
    await expect.poll(chipText).toContain(why.short);
    expect(chipText()).toContain(reading.label);

    // Enter on an unusable time sets nothing.
    await userEvent.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();

    // The nearest valid time leads the suggestions.
    await expect.element(page.getByRole("option").first()).toHaveTextContent("Earliest allowed");

    await page.getByRole("button", { name: `Use ${why.fixLabel}` }).click();
    expect(onChange).toHaveBeenCalledWith(why.fix, { via: "fix" });
    expect(why.fix).toBe(withMinutes(NOW, 11 * 60));
    await expect.element(input()).toHaveValue(formatDateTime(why.fix, NOW));
  });

  it("explains a time past the 90-day limit and offers the latest one", async () => {
    const onChange = vi.fn<ChangeSpy>();
    mounted = await render(<Harness onChange={onChange} />);
    await userEvent.keyboard("in 100 days");
    const reading = parseWhen("in 100 days", NOW, { defaultTime: 540 });
    if (!reading.ok) throw new Error("expected a reading");
    const why = explainWhen(reading.ms, RANGE);
    if (!why || why.fix == null) throw new Error("expected a late explanation with a fix");
    expect(why.kind).toBe("late");
    await expect.poll(chipText).toContain("Past the 90-day limit");
    await expect.element(page.getByRole("option").first()).toHaveTextContent("Latest allowed");
    await page.getByRole("button", { name: `Use ${why.fixLabel}` }).click();
    expect(onChange).toHaveBeenCalledWith(why.fix, { via: "fix" });
  });

  it("waits for a pause before saying a phrase can't be read, and says it at once on Enter", async () => {
    mounted = await render(<Harness />);
    await userEvent.keyboard("blorp");
    const reading = parseWhen("blorp", NOW, { defaultTime: 540 });
    if (reading.ok) throw new Error("expected blorp not to parse");
    expect(chipText()).toBe("Keep typing…");
    await expect.poll(chipText, { timeout: 2_000 }).toBe(reading.error);

    await userEvent.keyboard("x");
    expect(chipText()).toBe("Keep typing…");
    await userEvent.keyboard("{Enter}");
    const again = parseWhen("blorpx", NOW, { defaultTime: 540 });
    if (again.ok) throw new Error("expected blorpx not to parse");
    await expect.poll(chipText).toBe(again.error);
  });

  it("reverts an edit on Escape and only then lets Escape reach the host", async () => {
    const onHostKeyDown = vi.fn<(key: string) => void>();
    const onChange = vi.fn<ChangeSpy>();
    mounted = await render(<Harness onHostKeyDown={onHostKeyDown} onChange={onChange} />);
    await userEvent.keyboard("fri 9");
    await userEvent.keyboard("{Escape}");
    await expect.element(input()).toHaveValue(formatDateTime(TOMORROW_9, NOW));
    expect(onHostKeyDown).not.toHaveBeenCalledWith("Escape");
    expect(onChange).not.toHaveBeenCalled();

    await userEvent.keyboard("{Escape}");
    expect(onHostKeyDown).toHaveBeenCalledWith("Escape");
  });

  it("keeps focus, the typed text and the chosen suggestion as the clock ticks", async () => {
    mounted = await render(<Harness />);
    await userEvent.keyboard("tom");
    await userEvent.keyboard("{ArrowDown}");
    for (let tick = 1; tick <= 3; tick += 1) {
      await mounted.rerender(<Harness nowMs={NOW + tick * 1000} />);
    }
    await expect.element(input()).toHaveFocus();
    await expect.element(input()).toHaveValue("tom");
    await expect.element(page.getByRole("option").nth(0)).toHaveAttribute("aria-selected", "true");
  });

  it("sets a readable phrase when the field is left", async () => {
    const onChange = vi.fn<ChangeSpy>();
    mounted = await render(<Harness onChange={onChange} />);
    await userEvent.keyboard("monday 9am");
    await userEvent.keyboard("{Tab}");
    const monday = new Date(2026, 9, 12, 9, 0).getTime();
    expect(onChange).toHaveBeenCalledWith(monday, { via: "blur" });
    await expect.element(input()).toHaveValue(formatDateTime(monday, NOW));
  });

  it("starts with text a host passes in (a key typed on its token)", async () => {
    mounted = await render(<Harness initialText="t" />);
    await expect.element(input()).toHaveFocus();
    await expect.element(input()).toHaveValue("t");
    await userEvent.keyboard("omorrow 14:00");
    await expect.element(input()).toHaveValue("tomorrow 14:00");
  });

  describe("calendar", () => {
    it("opens in place with the day focused and closes on Escape back to its button", async () => {
      const onHostKeyDown = vi.fn<(key: string) => void>();
      mounted = await render(<Harness onHostKeyDown={onHostKeyDown} />);
      const button = page.getByRole("button", { name: "Open calendar" });
      await button.click();
      await expect.element(button).toHaveAttribute("aria-expanded", "true");
      // The suggestions step aside for it.
      await expect.element(input()).toHaveAttribute("aria-expanded", "false");
      expect(
        document.querySelector<HTMLElement>('[role="listbox"][aria-label="Suggestions"]')?.hidden,
      ).toBe(true);
      await expect
        .element(page.getByRole("gridcell", { name: /^Thursday, October 8, 2026/ }))
        .toHaveFocus();
      await userEvent.keyboard("{Escape}");
      await expect.element(button).toHaveFocus();
      await expect.element(button).toHaveAttribute("aria-expanded", "false");
      expect(page.getByRole("grid").elements()).toHaveLength(0);
      expect(onHostKeyDown).not.toHaveBeenCalledWith("Escape");
    });

    it("sets a day at the current time with Enter and stays open", async () => {
      const onChange = vi.fn<ChangeSpy>();
      mounted = await render(<Harness onChange={onChange} />);
      await page.getByRole("button", { name: "Open calendar" }).click();
      await userEvent.keyboard("{ArrowRight}{Enter}");
      const friday = new Date(2026, 9, 9, 9, 0).getTime();
      expect(onChange).toHaveBeenCalledWith(friday, { via: "grid" });
      await expect.element(page.getByRole("grid")).toBeVisible();
      await expect.element(input()).toHaveValue(formatDateTime(friday, NOW));
    });

    it("sets a time from the column and closes", async () => {
      const onChange = vi.fn<ChangeSpy>();
      mounted = await render(<Harness onChange={onChange} />);
      const button = page.getByRole("button", { name: "Open calendar" });
      await button.click();
      await page.getByRole("option", { name: "10:00", exact: true }).click();
      expect(onChange).toHaveBeenCalledWith(new Date(2026, 9, 8, 10, 0).getTime(), {
        via: "time",
      });
      await expect.element(button).toHaveFocus();
      expect(page.getByRole("grid").elements()).toHaveLength(0);
    });

    it("explains a day whose time has passed and offers the next usable time", async () => {
      const onChange = vi.fn<ChangeSpy>();
      mounted = await render(<Harness onChange={onChange} />);
      await page.getByRole("button", { name: "Open calendar" }).click();
      await page.getByRole("gridcell", { name: /^Wednesday, October 7, 2026, today/ }).click();
      // 09:00 today is gone: nothing is set, the day shows as chosen.
      expect(onChange).not.toHaveBeenCalled();
      await expect
        .element(page.getByRole("gridcell", { name: /^Wednesday, October 7, 2026/ }))
        .toHaveAttribute("aria-selected", "true");
      await expect.element(page.getByText("09:00 has passed", { exact: true })).toBeVisible();
      // The time column lists today: times before the fix are unavailable.
      await expect
        .element(page.getByRole("option", { name: "10:30", exact: true }))
        .toHaveAttribute("aria-disabled", "true");
      await page.getByRole("button", { name: "Use 11:00" }).click();
      expect(onChange).toHaveBeenCalledWith(withMinutes(NOW, 11 * 60), { via: "fix" });
      expect(page.getByRole("grid").elements()).toHaveLength(0);
    });

    it("refuses an unavailable time in the column and says why", async () => {
      const onChange = vi.fn<ChangeSpy>();
      mounted = await render(<Harness onChange={onChange} />);
      await page.getByRole("button", { name: "Open calendar" }).click();
      await page.getByRole("gridcell", { name: /^Wednesday, October 7, 2026, today/ }).click();
      // aria-disabled rows stay clickable; the click is refused with a reason.
      await page.getByRole("option", { name: "08:00", exact: true }).click({ force: true });
      expect(onChange).not.toHaveBeenCalled();
      await expect.element(page.getByText("08:00 has passed", { exact: true })).toBeVisible();
    });

    it("marks the matching quick pick and sets another", async () => {
      const onChange = vi.fn<ChangeSpy>();
      mounted = await render(<Harness onChange={onChange} />);
      await page.getByRole("button", { name: "Open calendar" }).click();
      await expect
        .element(page.getByRole("button", { name: /^Tomorrow 09:00/ }))
        .toHaveAttribute("aria-pressed", "true");
      await page.getByRole("button", { name: /^Monday 09:00/ }).click();
      expect(onChange).toHaveBeenCalledWith(new Date(2026, 9, 12, 9, 0).getTime(), {
        via: "quick",
      });
    });

    it("types a time into the column's field", async () => {
      const onChange = vi.fn<ChangeSpy>();
      mounted = await render(<Harness onChange={onChange} />);
      await page.getByRole("button", { name: "Open calendar" }).click();
      await page.getByRole("textbox", { name: "Time, 24-hour" }).click();
      await userEvent.keyboard("21:05{Enter}");
      expect(onChange).toHaveBeenCalledWith(new Date(2026, 9, 8, 21, 5).getTime(), {
        via: "time",
      });
    });
  });

  it("inside a host popover, Escape reverts an edit, closes the calendar, then the popover", async () => {
    mounted = await render(
      <Popover defaultOpen>
        <PopoverTrigger>First run</PopoverTrigger>
        <PopoverPopup aria-label="First run popover">
          <Harness />
        </PopoverPopup>
      </Popover>,
    );
    await expect.element(input()).toHaveFocus();
    await userEvent.keyboard("fri 9");
    await userEvent.keyboard("{Escape}");
    await expect.element(input()).toHaveValue(formatDateTime(TOMORROW_9, NOW));
    await page.getByRole("button", { name: "Open calendar" }).click();
    await expect.element(page.getByRole("grid")).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("button", { name: "Open calendar" })).toHaveFocus();
    await expect.element(input()).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => page.getByRole("combobox").elements().length).toBe(0);
  });
});
