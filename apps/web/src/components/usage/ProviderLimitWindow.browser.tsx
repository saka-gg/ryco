import "../../index.css";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { ProviderLimitWindow } from "./ProviderLimitWindow";

const now = Date.now();
const checkedAt = new Date(now).toISOString();
const window = { usedPercent: 40, windowDurationMins: 300, resetsAt: (now + 120 * 60_000) / 1000 };

describe("provider allowance rows", () => {
  it("renders snapshot pace and keeps unavailable usage nonnumeric", async () => {
    const mounted = await render(
      <div style={{ width: 300 }}>
        <ProviderLimitWindow window={window} label="5h" checkedAt={checkedAt} now={now} available />
        <ProviderLimitWindow
          window={{ ...window, usedPercent: NaN }}
          label="Weekly"
          checkedAt={checkedAt}
          now={now}
          available
        />
      </div>,
    );
    const paceReference = page.getByRole("button", {
      name: "Even-pace reference: 20 percentage points below even pace · at last check",
    });
    await expect.element(paceReference).toBeVisible();
    expect((paceReference.element() as HTMLElement).style.left).toBe("60%");
    await paceReference.hover();
    await expect
      .element(
        page.getByText("20 percentage points below even pace · at last check", { exact: true }),
      )
      .toBeVisible();
    await expect.element(page.getByText("Unavailable", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("progressbar", { name: "5h window usage" }))
      .toHaveAttribute("aria-valuenow", "40");
    expect(document.querySelectorAll('[role="progressbar"]').length).toBe(1);
    expect(document.body.textContent).not.toContain("100% available");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
      document.documentElement.clientWidth,
    );
    await mounted.unmount();
  });
  it("suppresses retained pace on disconnect and after reset, then accepts a new snapshot", async () => {
    const props = { window, label: "5h", checkedAt, now, available: true };
    const mounted = await render(<ProviderLimitWindow {...props} compact />);
    await mounted.rerender(<ProviderLimitWindow {...props} available={false} compact />);
    await expect.element(page.getByText("Pace unavailable")).toBeVisible();
    expect(document.querySelector('[aria-label^="Even-pace reference:"]')).toBeNull();
    await mounted.rerender(<ProviderLimitWindow {...props} now={window.resetsAt * 1000} compact />);
    await expect.element(page.getByText("Pace unavailable")).toBeVisible();
    expect(document.querySelector('[aria-label^="Even-pace reference:"]')).toBeNull();
    await mounted.rerender(
      <ProviderLimitWindow {...props} window={{ ...window, usedPercent: 80 }} compact />,
    );
    await expect
      .element(
        page.getByRole("button", {
          name: "Even-pace reference: 20 percentage points above even pace · at last check",
        }),
      )
      .toBeVisible();
    expect(document.body.textContent).not.toContain(
      "20 percentage points above even pace · at last check",
    );
    await mounted.unmount();
  });

  it("omits the marker when the comparison is intentionally quiet", async () => {
    const mounted = await render(
      <ProviderLimitWindow
        window={{ ...window, usedPercent: 59 }}
        label="5h"
        checkedAt={checkedAt}
        now={now}
        available
      />,
    );
    expect(document.querySelector('[aria-label^="Even-pace reference:"]')).toBeNull();
    expect(document.body.textContent).not.toContain("even pace");
    await mounted.unmount();
  });
});
