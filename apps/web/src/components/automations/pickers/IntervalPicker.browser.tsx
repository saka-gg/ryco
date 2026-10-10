import "../../../index.css";

import { AUTOMATION_LIMITS, DAY_MS, HOUR_MS, MINUTE_MS } from "@ryco/shared/automationSchedule";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { cdpSession } from "../../../../test/browserPointer";

import { IntervalPicker } from "./IntervalPicker";

function Harness(props: {
  readonly initial: number;
  readonly onChange?: (ms: number) => void;
  readonly onCommit?: (ms: number) => void;
}) {
  const [value, setValue] = useState(props.initial);
  return (
    <div style={{ width: 440 }}>
      <IntervalPicker
        valueMs={value}
        onChange={(ms) => {
          setValue(ms);
          props.onChange?.(ms);
        }}
        onCommit={props.onCommit}
      />
      <output data-testid="value">{value}</output>
    </div>
  );
}

const amount = () => page.getByRole("textbox", { name: "Interval amount" });
const shownValue = () => Number(document.querySelector('[data-testid="value"]')?.textContent);

describe("IntervalPicker", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    await mounted?.unmount();
    mounted = null;
    document.body.innerHTML = "";
  });

  it("sets a preset on click and reports the click", async () => {
    const onChange = vi.fn<(ms: number) => void>();
    const onCommit = vi.fn<(ms: number) => void>();
    mounted = await render(<Harness initial={HOUR_MS} onChange={onChange} onCommit={onCommit} />);
    await expect
      .element(page.getByRole("radio", { name: "Every hour" }))
      .toHaveAttribute("aria-checked", "true");
    await page.getByRole("radio", { name: "Every 2 hours" }).click();
    expect(onChange).toHaveBeenCalledWith(2 * HOUR_MS);
    expect(onCommit).toHaveBeenCalledWith(2 * HOUR_MS);
    await expect
      .element(page.getByRole("radio", { name: "Every 2 hours" }))
      .toHaveAttribute("aria-checked", "true");
  });

  it("moves between presets with the arrow keys (one Tab stop, no commit)", async () => {
    const onChange = vi.fn<(ms: number) => void>();
    const onCommit = vi.fn<(ms: number) => void>();
    mounted = await render(<Harness initial={HOUR_MS} onChange={onChange} onCommit={onCommit} />);
    const stops = page
      .getByRole("radiogroup", { name: "Repeat every" })
      .getByRole("radio")
      .elements()
      .filter((radio) => radio.tabIndex === 0);
    expect(stops).toHaveLength(1);
    (stops[0] as HTMLElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith(2 * HOUR_MS);
    await expect.element(page.getByRole("radio", { name: "Every 2 hours" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    // Custom is last: arrowing onto it opens the amount without moving focus there.
    await expect.element(page.getByRole("radio", { name: "Custom interval" })).toHaveFocus();
    await expect
      .element(page.getByRole("group", { name: "Custom interval" }))
      .toHaveAttribute("data-open", "");
    await userEvent.keyboard("{Home}");
    expect(onChange).toHaveBeenLastCalledWith(15 * MINUTE_MS);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("opens a custom amount that converts between units", async () => {
    const onChange = vi.fn<(ms: number) => void>();
    mounted = await render(<Harness initial={DAY_MS} onChange={onChange} />);
    await page.getByRole("radio", { name: "Custom interval" }).click();
    await expect.element(amount()).toHaveFocus();
    await expect.element(amount()).toHaveValue("1");
    await expect
      .element(page.getByRole("radio", { name: "days", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    await page.getByRole("radio", { name: "min", exact: true }).click();
    await expect.element(amount()).toHaveValue("1440");
    expect(onChange).not.toHaveBeenCalled();

    // 100 minutes is 1.67 hours: it rounds to whole hours and says so.
    await amount().fill("100");
    expect(onChange).toHaveBeenLastCalledWith(100 * MINUTE_MS);
    await page.getByRole("radio", { name: "hours", exact: true }).click();
    await expect.element(amount()).toHaveValue("2");
    expect(onChange).toHaveBeenLastCalledWith(2 * HOUR_MS);
    await expect.element(page.getByText("Rounded to 2 hours", { exact: true })).toBeVisible();
  });

  it("never applies an amount under 15 minutes and offers the nearest one", async () => {
    const onChange = vi.fn<(ms: number) => void>();
    mounted = await render(<Harness initial={HOUR_MS} onChange={onChange} />);
    await page.getByRole("radio", { name: "Custom interval" }).click();
    await expect.element(amount()).toHaveFocus();
    await userEvent.keyboard("0.1");
    await expect
      .element(page.getByText("0.1 hours is under the 15-minute minimum", { exact: true }))
      .toBeVisible();
    expect(shownValue()).toBe(HOUR_MS);
    await page.getByRole("button", { name: "Use 15 min" }).click();
    expect(onChange).toHaveBeenLastCalledWith(15 * MINUTE_MS);
    await expect.element(amount()).toHaveValue("0.25");
    for (const [ms] of onChange.mock.calls) {
      expect(ms).toBeGreaterThanOrEqual(AUTOMATION_LIMITS.minIntervalMs);
    }
  });

  it("steps by 5 minutes and stops at the limits, saying so", async () => {
    const onChange = vi.fn<(ms: number) => void>();
    mounted = await render(<Harness initial={25 * MINUTE_MS} onChange={onChange} />);
    // Not a preset: the custom amount is already open, in minutes.
    await expect.element(amount()).toHaveValue("25");
    await amount().click();
    await userEvent.keyboard("{ArrowDown}");
    expect(onChange).toHaveBeenLastCalledWith(20 * MINUTE_MS);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(onChange).toHaveBeenLastCalledWith(15 * MINUTE_MS);
    await expect
      .element(page.getByText("15 min is the shortest interval", { exact: true }))
      .toBeVisible();
    await userEvent.keyboard("{Shift>}{ArrowUp}{/Shift}");
    expect(onChange).toHaveBeenLastCalledWith(30 * MINUTE_MS);
    await page.getByRole("button", { name: "More" }).click();
    expect(onChange).toHaveBeenLastCalledWith(35 * MINUTE_MS);
  });

  it("settles an out-of-range amount on the nearest valid one when the field is left", async () => {
    const onChange = vi.fn<(ms: number) => void>();
    mounted = await render(<Harness initial={25 * MINUTE_MS} onChange={onChange} />);
    await amount().fill("5");
    expect(shownValue()).toBe(25 * MINUTE_MS);
    await userEvent.keyboard("{Tab}");
    expect(onChange).toHaveBeenLastCalledWith(15 * MINUTE_MS);
    await expect.element(amount()).toHaveValue("15");
    await expect
      .element(page.getByText("Set to 15 min — the shortest interval", { exact: true }))
      .toBeVisible();
  });

  it("moves the plate at once under reduced motion, keeping the choice visible", async () => {
    await cdpSession().send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    try {
      await vi.waitFor(() => {
        expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      });
      mounted = await render(<Harness initial={HOUR_MS} />);
      const target = page.getByRole("radio", { name: "Every 6 hours" });
      await target.click();
      await expect.element(target).toHaveAttribute("aria-checked", "true");
      const plate = document.querySelector<HTMLElement>(".pk-plate");
      if (!plate) throw new Error("expected the plate");
      expect(getComputedStyle(plate).transitionProperty).not.toContain("transform");
      const radio = target.element() as HTMLElement;
      // Already in place — no slide to wait for.
      expect(new DOMMatrix(getComputedStyle(plate).transform).m41).toBe(radio.offsetLeft);
      expect(plate.offsetWidth).toBe(radio.offsetWidth);
    } finally {
      await cdpSession().send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-reduced-motion", value: "" }],
      });
    }
  });
});
