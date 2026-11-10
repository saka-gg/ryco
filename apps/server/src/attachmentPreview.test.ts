import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it } from "vite-plus/test";

import {
  ATTACHMENT_PREVIEW_MIN_SOURCE_BYTES,
  attachmentPreviewDirectory,
  removeAttachmentPreviews,
  removeThreadAttachmentPreviews,
  resetAttachmentPreviewMemoForTests,
  resolveAttachmentPreview,
} from "./attachmentPreview.ts";
import { parseAttachmentPreviewSize } from "./attachmentPaths.ts";

const ID = "thread-0a1b2c3d-1111-2222-3333-444455556666";
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ryco-preview-"));
  resetAttachmentPreviewMemoForTests();
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** A noisy screenshot-sized PNG: several megabytes, like a real one. */
async function writeScreenshot(name: string, width = 2400, height = 1500) {
  const filePath = path.join(root, name);
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: "#000",
      noise: { type: "gaussian", mean: 128, sigma: 40 },
    },
  })
    .png()
    .toFile(filePath);
  return filePath;
}

it("makes a WebP preview once, fitted to the size, and keeps it beside the attachments", async () => {
  const source = await writeScreenshot(`${ID}.png`);
  const sourceBytes = (await fs.stat(source)).size;
  const first = await resolveAttachmentPreview({
    attachmentsDir: root,
    attachmentId: ID,
    sourcePath: source,
    size: 1024,
  });
  expect(first.kind).toBe("preview");
  if (first.kind !== "preview") return;
  expect(first.path).toBe(path.join(root, ".previews", ID, "1024.webp"));
  const metadata = await sharp(first.path).metadata();
  expect(metadata.format).toBe("webp");
  expect([metadata.width, metadata.height]).toEqual([1024, 640]);
  expect(first.sizeBytes).toBeLessThan(sourceBytes * 0.75);

  const mtime = (await fs.stat(first.path)).mtimeMs;
  const second = await resolveAttachmentPreview({
    attachmentsDir: root,
    attachmentId: ID,
    sourcePath: source,
    size: 1024,
  });
  expect(second).toEqual(first);
  expect((await fs.stat(first.path)).mtimeMs).toBe(mtime);
});

it("makes one preview for concurrent requests", async () => {
  const source = await writeScreenshot(`${ID}.png`);
  const results = await Promise.all(
    Array.from({ length: 4 }, () =>
      resolveAttachmentPreview({
        attachmentsDir: root,
        attachmentId: ID,
        sourcePath: source,
        size: 512,
      }),
    ),
  );
  expect(new Set(results.map((result) => result.kind))).toEqual(new Set(["preview"]));
  const files = await fs.readdir(path.join(root, ".previews", ID));
  expect(files).toEqual(["512.webp"]);
});

it("serves the original for small files, animations and types it does not decode", async () => {
  const small = path.join(root, `${ID}.png`);
  await sharp({ create: { width: 40, height: 40, channels: 3, background: "#fff" } })
    .png()
    .toFile(small);
  expect((await fs.stat(small)).size).toBeLessThan(ATTACHMENT_PREVIEW_MIN_SOURCE_BYTES);
  for (const sourcePath of [small, path.join(root, `${ID}.gif`), path.join(root, `${ID}.svg`)]) {
    expect(
      await resolveAttachmentPreview({
        attachmentsDir: root,
        attachmentId: ID,
        sourcePath,
        size: 512,
      }),
    ).toEqual({ kind: "original" });
  }

  const animatedId = "thread-0a1b2c3d-1111-2222-3333-444455557777";
  const animated = path.join(root, `${animatedId}.webp`);
  const frame = (mean: number) =>
    sharp({
      create: {
        width: 900,
        height: 900,
        channels: 3,
        background: "#000",
        noise: { type: "gaussian", mean, sigma: 40 },
      },
    })
      .png()
      .toBuffer();
  await sharp([await frame(100), await frame(160)], { join: { animated: true } })
    .webp({ lossless: true })
    .toFile(animated);
  expect((await sharp(animated, { pages: -1 }).metadata()).pages).toBe(2);
  expect(
    await resolveAttachmentPreview({
      attachmentsDir: root,
      attachmentId: animatedId,
      sourcePath: animated,
      size: 512,
    }),
  ).toEqual({ kind: "original" });
});

it("is unavailable, not an error, for a missing or undecodable original", async () => {
  expect(
    await resolveAttachmentPreview({
      attachmentsDir: root,
      attachmentId: ID,
      sourcePath: path.join(root, `${ID}.png`),
      size: 512,
    }),
  ).toEqual({ kind: "unavailable" });
  const broken = path.join(root, `${ID}.jpg`);
  await fs.writeFile(broken, Buffer.alloc(ATTACHMENT_PREVIEW_MIN_SOURCE_BYTES * 2, 7));
  expect(
    await resolveAttachmentPreview({
      attachmentsDir: root,
      attachmentId: ID,
      sourcePath: broken,
      size: 512,
    }),
  ).toEqual({ kind: "unavailable" });
});

it("removes one attachment's previews, or a thread's", async () => {
  const source = await writeScreenshot(`${ID}.png`, 1600, 1000);
  await resolveAttachmentPreview({
    attachmentsDir: root,
    attachmentId: ID,
    sourcePath: source,
    size: 512,
  });
  const otherId = "other-0a1b2c3d-1111-2222-3333-444455556666";
  await fs.mkdir(path.join(root, ".previews", otherId), { recursive: true });

  await removeThreadAttachmentPreviews(root, (attachmentId) => attachmentId.startsWith("thread-"));
  expect(await fs.readdir(path.join(root, ".previews"))).toEqual([otherId]);
  await removeAttachmentPreviews(root, otherId);
  expect(await fs.readdir(path.join(root, ".previews"))).toEqual([]);
});

it("accepts only the preview sizes and ids that stay in the folder", () => {
  expect(parseAttachmentPreviewSize("512")).toBe(512);
  expect(parseAttachmentPreviewSize("1024")).toBe(1024);
  for (const value of [null, "", "513", "2048", "1e3", "abc"]) {
    expect(parseAttachmentPreviewSize(value)).toBeNull();
  }
  expect(attachmentPreviewDirectory(root, "../escape")).toBeNull();
  expect(attachmentPreviewDirectory(root, "a.b")).toBeNull();
  expect(attachmentPreviewDirectory(root, ID)).toBe(path.join(root, ".previews", ID));
});
