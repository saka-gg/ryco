import "../index.css";

import { parsePatchFiles } from "@pierre/diffs";
import { EnvironmentId, type EnvironmentApi } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../environmentApi";
import { DiffImagePreview } from "./DiffImagePreview";

const environmentId = EnvironmentId.make("environment-diff-images");

function pngBase64(width: number, height: number, color: string): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, width, height);
  return canvas.toDataURL("image/png").split(",", 2)[1]!;
}

function parseFile(lines: ReadonlyArray<string>) {
  return parsePatchFiles(`${lines.join("\n")}\n`, "diff-image-test").flatMap(
    (patch) => patch.files,
  )[0]!;
}

function installApi(input: {
  readImageBlob: EnvironmentApi["vcs"]["readImageBlob"];
  readFileBinary?: EnvironmentApi["projects"]["readFileBinary"];
}) {
  __setEnvironmentApiOverrideForTests(environmentId, {
    vcs: { readImageBlob: input.readImageBlob },
    projects: { readFileBinary: input.readFileBinary ?? vi.fn() },
  } as unknown as EnvironmentApi);
}

afterEach(() => {
  __resetEnvironmentApiOverridesForTests();
});

it("previews both stored versions of a changed image and opens them in the image viewer", async () => {
  const images: Record<string, { data: string; width: number; height: number }> = {
    a1b2c3d: { data: pngBase64(40, 20, "#d33"), width: 40, height: 20 },
    e4f5a6b: { data: pngBase64(30, 30, "#3a3"), width: 30, height: 30 },
  };
  const readImageBlob = vi.fn<EnvironmentApi["vcs"]["readImageBlob"]>(async ({ oid }) => {
    const image = images[oid]!;
    return {
      kind: "image",
      dataBase64: image.data,
      mimeType: "image/png",
      sizeBytes: 2048,
    };
  });
  installApi({ readImageBlob });
  const fileDiff = parseFile([
    "diff --git a/assets/shot.png b/assets/shot.png",
    "index a1b2c3d..e4f5a6b 100644",
    "Binary files a/assets/shot.png and b/assets/shot.png differ",
  ]);

  const screen = await render(
    <DiffImagePreview
      environmentId={environmentId}
      cwd="/repo"
      fileDiff={fileDiff}
      afterIsWorkingTree={false}
    />,
  );
  try {
    await expect
      .element(page.getByRole("button", { name: "Open before image of assets/shot.png" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Open after image of assets/shot.png" }))
      .toBeVisible();
    await expect.element(page.getByText("Before · 40 × 20 · 2 KB")).toBeVisible();
    await expect.element(page.getByText("After · 30 × 30 · 2 KB")).toBeVisible();
    expect(readImageBlob.mock.calls.map(([call]) => call)).toEqual([
      { cwd: "/repo", oid: "a1b2c3d" },
      { cwd: "/repo", oid: "e4f5a6b" },
    ]);

    await page.getByRole("button", { name: "Open before image of assets/shot.png" }).click();
    const dialog = page.getByRole("dialog", { name: "Expanded image preview" });
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText("Before — assets/shot.png (1/2)")).toBeVisible();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    await expect.element(dialog.getByText("After — assets/shot.png (2/2)")).toBeVisible();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await expect.element(dialog).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }

  // Remounting (virtualized scroll, turn switch) reuses the settled reads.
  const remount = await render(
    <DiffImagePreview
      environmentId={environmentId}
      cwd="/repo"
      fileDiff={fileDiff}
      afterIsWorkingTree={false}
    />,
  );
  try {
    await expect
      .element(page.getByRole("button", { name: "Open after image of assets/shot.png" }))
      .toBeVisible();
    expect(readImageBlob).toHaveBeenCalledTimes(2);
  } finally {
    await remount.unmount();
  }
});

it("reads the unstaged side from the working file and explains unavailable versions", async () => {
  const readImageBlob = vi.fn<EnvironmentApi["vcs"]["readImageBlob"]>(async () => ({
    kind: "unavailable",
    reason: "This image is too large to preview.",
  }));
  const readFileBinary = vi.fn<EnvironmentApi["projects"]["readFileBinary"]>(
    async ({ relativePath }) => ({
      relativePath,
      dataBase64: pngBase64(12, 12, "#36c"),
      mimeType: "image/png",
      sizeBytes: 512,
    }),
  );
  installApi({ readImageBlob, readFileBinary });
  const fileDiff = parseFile([
    "diff --git a/docs/diagram.webp b/docs/diagram.webp",
    `index ${"1".repeat(40)}..${"2".repeat(40)} 100644`,
    "GIT binary patch",
    "literal 5",
    "McmZQzU|?ckU;qFB00RI30RR91",
    "",
    "literal 0",
    "HcmV?d00001",
    "",
  ]);

  const screen = await render(
    <DiffImagePreview
      environmentId={environmentId}
      cwd="/repo"
      fileDiff={fileDiff}
      afterIsWorkingTree
    />,
  );
  try {
    await expect.element(page.getByText("This image is too large to preview.")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Open after image of docs/diagram.webp" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Open before image of docs/diagram.webp" }))
      .not.toBeInTheDocument();
    expect(readImageBlob).toHaveBeenCalledWith({ cwd: "/repo", oid: "1".repeat(40) });
    expect(readFileBinary).toHaveBeenCalledWith({
      cwd: "/repo",
      relativePath: "docs/diagram.webp",
    });
  } finally {
    await screen.unmount();
  }
});
