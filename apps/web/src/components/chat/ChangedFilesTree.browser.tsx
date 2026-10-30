import "../../index.css";

import { page, userEvent } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { ChangedFilesTree } from "./ChangedFilesTree";

const FILES = [{ path: "src/app.ts" }, { path: "README.md" }];

describe("ChangedFilesTree drags", () => {
  it("makes file rows draggable only when the caller writes the drag", async () => {
    const onFileDragStart = vi.fn((path: string, transfer: DataTransfer) =>
      transfer.setData("text/plain", path),
    );
    const onFileDragEnd = vi.fn();
    const mounted = await render(
      <ChangedFilesTree
        files={FILES}
        allDirectoriesExpanded
        resolvedTheme="light"
        onSelectFile={vi.fn()}
        showStats={false}
        onFileDragStart={onFileDragStart}
        onFileDragEnd={onFileDragEnd}
      />,
    );

    const row = page.getByRole("button", { name: "app.ts" });
    await expect.element(row).toHaveAttribute("draggable", "true");
    // Directory rows only toggle; they never drag.
    expect(
      page.getByRole("button", { name: "src" }).element().getAttribute("draggable"),
    ).toBeNull();

    const transfer = new DataTransfer();
    row
      .element()
      .dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
    row.element().dispatchEvent(new DragEvent("dragend", { bubbles: true }));
    expect(onFileDragStart).toHaveBeenCalledWith("src/app.ts", transfer);
    expect(transfer.getData("text/plain")).toBe("src/app.ts");
    expect(onFileDragEnd).toHaveBeenCalledTimes(1);
    await mounted.unmount();

    const plain = await render(
      <ChangedFilesTree
        files={FILES}
        allDirectoriesExpanded
        resolvedTheme="light"
        onSelectFile={vi.fn()}
      />,
    );
    expect(
      page.getByRole("button", { name: "README.md" }).element().getAttribute("draggable"),
    ).toBeNull();
    await plain.unmount();
  });
});

// Rows are 24px tall and 2px apart.
const ROW_STRIDE = 26;
const manyFiles = Array.from({ length: 16_185 }, (_, index) => ({
  path: `src/file-${index.toString().padStart(5, "0")}.ts`,
}));

const buttons = () => document.querySelectorAll("button");
const text = () => document.body.textContent ?? "";
const fileButton = (name: string) =>
  [...buttons()].find((button) => button.textContent === name) ?? null;

async function scrollTo(element: HTMLElement, top: number) {
  element.scrollTop = top;
  element.dispatchEvent(new Event("scroll"));
  await new Promise(requestAnimationFrame);
  await new Promise(requestAnimationFrame);
}

describe("ChangedFilesTree with thousands of files", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("virtualizes above 250 expanded files and stops when folders collapse below that", async () => {
    const mounted = await render(
      <div style={{ height: 280, overflowY: "auto" }}>
        <ChangedFilesTree
          files={[...manyFiles.slice(0, 250), { path: "extra/overflow.ts" }]}
          allDirectoriesExpanded={false}
          resolvedTheme="light"
          onSelectFile={vi.fn()}
        />
      </div>,
    );
    expect(buttons().length).toBe(2);

    await page.getByRole("button", { name: "src" }).click();
    expect(buttons().length).toBe(252);
    expect(text()).toContain("file-00249.ts");

    // A 251st file in an expanded folder switches to the window in view.
    await page.getByRole("button", { name: "extra" }).click();
    await expect.poll(() => buttons().length).toBeLessThan(40);
    expect(text()).not.toContain("file-00249.ts");

    await page.getByRole("button", { name: "extra" }).click();
    await expect.poll(() => buttons().length).toBe(252);
    expect(text()).toContain("file-00249.ts");
    expect(text()).not.toContain("overflow.ts");
    await mounted.unmount();
  });

  it("selects and drags a file after scrolling to the end of an expanded tree", async () => {
    const onSelectFile = vi.fn();
    const onFileDragStart = vi.fn();
    const mounted = await render(
      <div style={{ height: 280, overflowY: "auto" }}>
        <ChangedFilesTree
          files={manyFiles}
          allDirectoriesExpanded
          resolvedTheme="light"
          onSelectFile={onSelectFile}
          selectedFilePath="src/file-16184.ts"
          onFileDragStart={onFileDragStart}
        />
      </div>,
    );
    const viewport = mounted.container.firstElementChild as HTMLElement;
    expect(buttons().length).toBeLessThan(40);
    // The list keeps the full tree's height so the scrollbar spans every row.
    expect(viewport.scrollHeight).toBeGreaterThan(16_000 * ROW_STRIDE);
    expect(text()).not.toContain("file-08000.ts");

    await scrollTo(viewport, 8_001 * ROW_STRIDE);
    expect(text()).toContain("file-08000.ts");
    expect(text()).not.toContain("file-00000.ts");
    expect(buttons().length).toBeLessThan(40);

    await scrollTo(viewport, viewport.scrollHeight);
    const last = fileButton("file-16184.ts")!;
    expect(last.className).toContain("bg-accent");
    await userEvent.click(last);
    expect(onSelectFile).toHaveBeenCalledWith("src/file-16184.ts");
    last.dispatchEvent(
      new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() }),
    );
    expect(onFileDragStart).toHaveBeenCalledWith("src/file-16184.ts", expect.anything());
    await mounted.unmount();
  });

  it("keeps a focused file mounted when scrolled away, and Tab walks past the window", async () => {
    const mounted = await render(
      <div style={{ height: 280, overflowY: "auto" }}>
        <ChangedFilesTree
          files={manyFiles}
          allDirectoriesExpanded
          resolvedTheme="light"
          onSelectFile={vi.fn()}
        />
      </div>,
    );
    const viewport = mounted.container.firstElementChild as HTMLElement;
    const focusedFile = fileButton("file-00000.ts")!;
    focusedFile.focus();
    await scrollTo(viewport, 8_001 * ROW_STRIDE);
    expect(text()).toContain("file-08000.ts");
    expect(document.activeElement).toBe(focusedFile);
    expect(buttons().length).toBeLessThan(40);

    // Tab moves focus row by row, well past the rows first rendered.
    await scrollTo(viewport, 0);
    for (let step = 0; step < 40; step += 1) {
      await userEvent.tab();
    }
    await expect.poll(() => document.activeElement?.textContent).toBe("file-00040.ts");
    expect(buttons().length).toBeLessThan(40);

    (document.activeElement as HTMLElement).blur();
    await scrollTo(viewport, 8_001 * ROW_STRIDE);
    await expect.poll(() => text().includes("file-00040.ts")).toBe(false);
    await mounted.unmount();
  });

  it("remeasures the rows in view when the viewport or content above it resizes", async () => {
    const content = (height: number, precedingHeight: number) => (
      <div style={{ height, overflowY: "auto" }}>
        <div style={{ height: precedingHeight }} />
        <ChangedFilesTree
          files={manyFiles}
          allDirectoriesExpanded
          resolvedTheme="light"
          onSelectFile={vi.fn()}
        />
      </div>
    );
    const mounted = await render(content(140, 0));
    const viewport = mounted.container.firstElementChild as HTMLElement;
    await scrollTo(viewport, 8_001 * ROW_STRIDE);
    const beforeResize = buttons().length;
    await mounted.rerender(content(560, 560));
    await expect.poll(() => buttons().length).toBeGreaterThan(beforeResize);
    // 560px more above the list moves the rows in view up by about 21 rows.
    expect(text()).toContain("file-07980.ts");
    expect(buttons().length).toBeLessThan(60);
    await mounted.unmount();
  });
});
