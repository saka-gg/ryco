import "../../index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import { ColorSwatchPicker } from "./ColorSwatchPicker";

function picker(onChange: (value: string | null) => void) {
  return (
    <ColorSwatchPicker
      value="#ff0000"
      onChange={onChange}
      swatches={["#ff0000"]}
      ariaLabel="Accent"
      commitDelayMs={10_000}
    />
  );
}

describe("ColorSwatchPicker", () => {
  it("saves a custom colour picked just before the picker closes", async () => {
    const onChange = vi.fn();
    const screen = await render(picker(onChange));
    await page.getByRole("button", { name: "Accent: custom" }).click();
    await page.getByLabelText("Hex value").fill("#123456");
    // The draft label shows that the pending commit was scheduled.
    await expect.element(page.getByText("#123456", { exact: true }).first()).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
    await screen.unmount();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("#123456");
  });

  it("sends nothing on unmount without a pending change", async () => {
    const onChange = vi.fn();
    const screen = await render(picker(onChange));
    await screen.unmount();
    expect(onChange).not.toHaveBeenCalled();
  });
});
