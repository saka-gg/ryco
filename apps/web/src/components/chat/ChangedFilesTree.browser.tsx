import "../../index.css";

import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
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
