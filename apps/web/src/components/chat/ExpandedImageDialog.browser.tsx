import "../../index.css";
import { page, userEvent } from "vite-plus/test/browser";
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

it("zooms and pans an expanded image inside its box, from buttons, keys, pinch and drag", async () => {
  await page.viewport(1200, 800);
  const onClose = vi.fn();
  const preview = {
    index: 0,
    images: [
      {
        name: "chart.svg",
        src: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="100%" height="100%" fill="teal"/></svg>`)}`,
        width: 800,
        height: 400,
      },
    ],
  };
  const screen = await render(
    <div>
      <input aria-label="Composer" />
      <ExpandedImageDialog preview={preview} onClose={onClose} />
    </div>,
  );
  const box = () => document.querySelector<HTMLElement>("[data-image-zoom]")!;
  const scale = () => Number(box().getAttribute("data-image-zoom"));
  const transform = () => box().querySelector("img")!.style.transform;
  try {
    await expect.element(page.getByRole("img", { name: "chart.svg" })).toBeVisible();
    const fitted = box().getBoundingClientRect();
    expect(scale()).toBe(1);
    await expect.element(page.getByRole("button", { name: "Zoom out" })).toBeDisabled();

    await page.getByRole("button", { name: "Zoom in" }).click();
    expect(scale()).toBe(1.25);
    expect(transform()).toBe("translate(0px, 0px) scale(1.25)");
    // Zooming happens inside the box: the image's place on the page stays.
    expect(box().getBoundingClientRect()).toEqual(fitted);

    // A pinch (Ctrl+wheel) at the box's right edge zooms there, held back from the browser.
    const pinch = new WheelEvent("wheel", {
      deltaY: -100,
      ctrlKey: true,
      cancelable: true,
      clientX: fitted.right - 10,
      clientY: fitted.top + fitted.height / 2,
    });
    box().dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(scale()).toBeCloseTo(1.5625, 3));
    expect(transform()).toMatch(/^translate\(-\d/);

    // A drag pans, never past the image's edges.
    const element = box();
    const start = { x: fitted.left + 100, y: fitted.top + 100 };
    element.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: 7,
        button: 0,
        clientX: start.x,
        clientY: start.y,
        bubbles: true,
      }),
    );
    element.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerId: 7,
        clientX: start.x + 5000,
        clientY: start.y,
        bubbles: true,
      }),
    );
    element.dispatchEvent(
      new PointerEvent("pointerup", {
        pointerId: 7,
        clientX: start.x + 5000,
        clientY: start.y,
        bubbles: true,
      }),
    );
    const maxX = (fitted.width * (scale() - 1)) / 2;
    await vi.waitFor(() => {
      const [, x, y] = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(transform())!;
      expect(Number(x)).toBeCloseTo(maxX, 1);
      expect(Number(y)).toBe(0);
    });

    // Typing in the composer never zooms the image.
    // (A contained viewer leaves the composer beside it; focus stands in for the click.)
    (page.getByRole("textbox", { name: "Composer" }).element() as HTMLInputElement).focus();
    await userEvent.keyboard("0-");
    expect(scale()).toBeCloseTo(1.5625, 3);

    // Keys anywhere else: 0 resets, + steps in, − steps out.
    (document.activeElement as HTMLElement).blur();
    await userEvent.keyboard("0");
    expect(scale()).toBe(1);
    expect(transform()).toBe("");
    await userEvent.keyboard("=");
    expect(scale()).toBe(1.25);
    await userEvent.keyboard("-");
    expect(scale()).toBe(1);
    expect(onClose).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});
