/**
 * attachmentPreview - Smaller copies of image attachments, to show them in a
 * thread.
 *
 * A thread shows an image at most a few hundred pixels tall, while the
 * original is often a multi-megabyte screenshot. A preview is a WebP whose
 * longest edge is one of `CHAT_ATTACHMENT_PREVIEW_SIZES`, made on first
 * request and kept on disk beside the attachments
 * (`<attachmentsDir>/.previews/<attachment id>/<size>.webp`), so later reads
 * cost one stat. Attachments never change once stored, so neither does a
 * preview. The preview folder goes with its attachment (`removeAttachmentPreviews`,
 * `removeThreadAttachmentPreviews`).
 *
 * sharp loads on first use (`loadSharp`), so importing this module costs
 * nothing until a preview is actually made.
 *
 * @module attachmentPreview
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ChatAttachmentPreviewSize } from "@ryco/contracts";

import { normalizeAttachmentRelativePath } from "./attachmentPaths.ts";
import { loadSharp } from "./loadSharp.ts";

export const ATTACHMENT_PREVIEWS_DIRECTORY = ".previews";
export const ATTACHMENT_PREVIEW_CONTENT_TYPE = "image/webp";

/** Still images sharp decodes. GIFs are often animated; SVGs and icons are small. */
const PREVIEWABLE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".avif",
  ".tif",
  ".tiff",
]);
/** A smaller original is served as it is: a preview would save too little. */
export const ATTACHMENT_PREVIEW_MIN_SOURCE_BYTES = 96 * 1024;
/** A preview is kept only when it is at most this share of the original's bytes. */
const PREVIEW_MAX_SHARE_OF_SOURCE = 0.75;
const PREVIEW_WEBP_QUALITY = 80;
/** Making a preview takes a core for a moment; a thread full of screenshots queues. */
const MAX_CONCURRENT_GENERATIONS = 2;
const GENERATION_TIMEOUT_MS = 20_000;
const UNHELPFUL_MEMO_MAX_ENTRIES = 1024;

/** The folder of one attachment's previews; null for an id that could leave the folder. */
export function attachmentPreviewDirectory(
  attachmentsDir: string,
  attachmentId: string,
): string | null {
  const normalized = normalizeAttachmentRelativePath(attachmentId);
  if (!normalized || normalized !== attachmentId || /[/\\.]/.test(normalized)) return null;
  return path.join(path.resolve(attachmentsDir), ATTACHMENT_PREVIEWS_DIRECTORY, normalized);
}

export type AttachmentPreviewOutcome =
  /** The preview file, to serve instead of the original. */
  | { readonly kind: "preview"; readonly path: string; readonly sizeBytes: number }
  /** For good: the original is small already, or not an image a preview is made of. */
  | { readonly kind: "original" }
  /** For now: making the preview failed or took too long; the original stands in. */
  | { readonly kind: "unavailable" };

const ORIGINAL: AttachmentPreviewOutcome = { kind: "original" };
const UNAVAILABLE: AttachmentPreviewOutcome = { kind: "unavailable" };

/** Originals found not worth a preview, by path and size: they are not decoded again. */
const unhelpful = new Map<string, number>();
const inflight = new Map<string, Promise<AttachmentPreviewOutcome>>();
let running = 0;
const waiting: Array<() => void> = [];

async function withGenerationSlot<T>(run: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT_GENERATIONS) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else {
    running += 1;
  }
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }
}

function rememberUnhelpful(key: string, sourceBytes: number) {
  if (unhelpful.size >= UNHELPFUL_MEMO_MAX_ENTRIES) unhelpful.clear();
  unhelpful.set(key, sourceBytes);
}

async function statFile(filePath: string) {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info : null;
  } catch {
    return null;
  }
}

async function generatePreview(input: {
  readonly sourcePath: string;
  readonly sourceBytes: number;
  readonly previewPath: string;
  readonly size: ChatAttachmentPreviewSize;
  readonly memoKey: string;
}): Promise<AttachmentPreviewOutcome> {
  const sharp = await loadSharp();
  const encoded = await withGenerationSlot(async () => {
    const image = sharp(input.sourcePath);
    const metadata = await image.metadata();
    // Only the first frame would survive: an animation stays the original.
    if ((metadata.pages ?? 1) > 1) return null;
    return image
      .autoOrient()
      .resize({
        width: input.size,
        height: input.size,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: PREVIEW_WEBP_QUALITY })
      .toBuffer();
  });
  if (encoded === null || encoded.byteLength > input.sourceBytes * PREVIEW_MAX_SHARE_OF_SOURCE) {
    rememberUnhelpful(input.memoKey, input.sourceBytes);
    return ORIGINAL;
  }
  const directory = path.dirname(input.previewPath);
  await mkdir(directory, { recursive: true });
  const staging = `${input.previewPath}.${randomUUID()}.part`;
  try {
    await writeFile(staging, encoded, { flag: "wx" });
    await rename(staging, input.previewPath);
  } catch (cause) {
    await rm(staging, { force: true });
    throw cause;
  }
  // The attachment was deleted while its preview was being made.
  if ((await statFile(input.sourcePath)) === null) {
    await rm(directory, { recursive: true, force: true });
    return UNAVAILABLE;
  }
  return { kind: "preview", path: input.previewPath, sizeBytes: encoded.byteLength };
}

/**
 * The preview of `size` for the attachment stored at `sourcePath`, made now
 * when it does not exist yet. Never fails: a preview that cannot be made is
 * `unavailable`, and the caller serves the original.
 */
export async function resolveAttachmentPreview(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
  /** The stored original; its extension tells whether it is an image a preview is made of. */
  readonly sourcePath: string;
  /** The original's extension when its file name has none (streamed-upload ids). */
  readonly extension?: string | null | undefined;
  readonly size: ChatAttachmentPreviewSize;
}): Promise<AttachmentPreviewOutcome> {
  const extension = (path.extname(input.sourcePath) || input.extension || "").toLowerCase();
  if (!PREVIEWABLE_EXTENSIONS.has(extension)) return ORIGINAL;
  const directory = attachmentPreviewDirectory(input.attachmentsDir, input.attachmentId);
  if (directory === null) return ORIGINAL;
  const previewPath = path.join(directory, `${input.size}.webp`);
  const existing = await statFile(previewPath);
  if (existing) return { kind: "preview", path: previewPath, sizeBytes: existing.size };
  const source = await statFile(input.sourcePath);
  if (source === null) return UNAVAILABLE;
  if (source.size < ATTACHMENT_PREVIEW_MIN_SOURCE_BYTES) return ORIGINAL;
  const memoKey = `${input.sourcePath}\u0000${input.size}`;
  if (unhelpful.get(memoKey) === source.size) return ORIGINAL;
  // One generation per preview; it runs on past a caller that stopped waiting.
  let generated = inflight.get(previewPath);
  if (!generated) {
    generated = generatePreview({
      sourcePath: input.sourcePath,
      sourceBytes: source.size,
      previewPath,
      size: input.size,
      memoKey,
    })
      .catch(() => UNAVAILABLE)
      .finally(() => inflight.delete(previewPath));
    inflight.set(previewPath, generated);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    generated,
    new Promise<AttachmentPreviewOutcome>((resolve) => {
      timer = setTimeout(() => resolve(UNAVAILABLE), GENERATION_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Removes one attachment's previews; a missing folder counts as removed. */
export async function removeAttachmentPreviews(
  attachmentsDir: string,
  attachmentId: string,
): Promise<void> {
  const directory = attachmentPreviewDirectory(attachmentsDir, attachmentId);
  if (directory !== null) await rm(directory, { recursive: true, force: true });
}

/** Removes the previews of every attachment `inThread` accepts (its thread is deleted). */
export async function removeThreadAttachmentPreviews(
  attachmentsDir: string,
  inThread: (attachmentId: string) => boolean,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(path.join(attachmentsDir, ATTACHMENT_PREVIEWS_DIRECTORY));
  } catch {
    return;
  }
  for (const attachmentId of entries) {
    if (inThread(attachmentId)) await removeAttachmentPreviews(attachmentsDir, attachmentId);
  }
}

/** For tests: forget what was found not worth a preview. */
export function resetAttachmentPreviewMemoForTests(): void {
  unhelpful.clear();
}
