import "../../index.css";
import { page } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { ExpandedImageDialog } from "./ExpandedImageDialog";
import { PaneFocusContext } from "./PaneFocus";

it("preserves single-image expansion and releases keyboard ownership when its pane loses focus", async () => {
  const onClose = vi.fn();
  const preview = {
    index: 0,
    images: [
      {
        name: "image.svg",
        src: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'%3E%3Crect width='10' height='10' fill='blue'/%3E%3C/svg%3E",
      },
    ],
  };
  const view = (focused: boolean) => (
    <PaneFocusContext value={focused}>
      <ExpandedImageDialog preview={preview} onClose={onClose} />
    </PaneFocusContext>
  );
  const screen = await render(view(true));
  try {
    await expect
      .element(page.getByRole("dialog", { name: "Expanded image preview" }))
      .toBeVisible();
    await expect.element(page.getByRole("img", { name: "image.svg" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Next image" })).not.toBeInTheDocument();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await screen.rerender(view(false));
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    await screen.unmount();
  }
});
