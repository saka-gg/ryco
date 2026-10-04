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

it("fits large screenshots between resizable sidebars and preserves their proportions", async () => {
  await page.viewport(1600, 900);
  const images = (
    [
      [4000, 2400],
      [1200, 5000],
    ] as const
  ).map(([width, height], index) => ({
    name: `screenshot-${index}.svg`,
    src: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="teal"/></svg>`)}`,
    width,
    height,
  }));
  const onClose = vi.fn();
  const layout = (left: number, right: number, gallery = true) => (
    <div style={{ display: "flex", width: "100vw", height: 700 }}>
      <aside aria-label="Left sidebar" style={{ width: left, flexShrink: 0 }}>
        Sidebar
      </aside>
      <main
        aria-label="Available chat space"
        style={{ position: "relative", flex: 1, minWidth: 0 }}
      >
        <ExpandedImageDialog
          preview={{ images: gallery ? images : images.slice(0, 1), index: 0 }}
          onClose={onClose}
          contained
        />
      </main>
      <aside aria-label="Right workspace" style={{ width: right, flexShrink: 0 }}>
        Workspace
      </aside>
    </div>
  );
  const screen = await render(layout(300, 350));
  const assertFit = async (index: number, gallery = true) => {
    const image = page
      .getByRole("img", { name: images[index]!.name })
      .element() as HTMLImageElement;
    await vi.waitFor(() => expect(image.naturalWidth).toBe(images[index]!.width));
    const available = page
      .getByRole("main", { name: "Available chat space" })
      .element()
      .getBoundingClientRect();
    const dialog = page
      .getByRole("dialog", { name: "Expanded image preview" })
      .element()
      .getBoundingClientRect();
    await vi.waitFor(() => {
      const rect = image.getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.left).toBeGreaterThanOrEqual(available.left + 16);
      expect(rect.right).toBeLessThanOrEqual(available.right - 16);
      expect(rect.top).toBeGreaterThanOrEqual(available.top + 24);
      expect(rect.bottom).toBeLessThanOrEqual(available.bottom - 24);
      const style = getComputedStyle(image);
      const imageWidth =
        rect.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
      const imageHeight =
        rect.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
      expect(imageWidth / imageHeight).toBeCloseTo(images[index]!.width / images[index]!.height, 2);
      const caption = page
        .getByText(`${images[index]!.name}${gallery ? ` (${index + 1}/2)` : ""}`, { exact: true })
        .element()
        .getBoundingClientRect();
      expect(caption.bottom).toBeLessThanOrEqual(available.bottom);
    });
    expect(dialog.left).toBe(available.left);
    expect(dialog.right).toBe(available.right);
    expect(onClose).not.toHaveBeenCalled();
  };
  try {
    await assertFit(0);
    await screen.rerender(layout(430, 500));
    await assertFit(0);
    await page.viewport(1200, 800);
    await assertFit(0);
    await page.getByRole("button", { name: "Next image" }).click();
    await assertFit(1);
    await page.getByRole("button", { name: "Previous image" }).click();
    await assertFit(0);
    await screen.rerender(layout(430, 500, false));
    await assertFit(0, false);
    await expect.element(page.getByRole("button", { name: "Next image" })).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});
