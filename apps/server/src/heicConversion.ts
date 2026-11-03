/**
 * heicConversion - Converts a HEIC or HEIF photo attachment to JPEG with macOS's own `sips`.
 *
 * No provider reads HEIC, and Chromium (so the desktop app too) cannot decode it to convert it
 * in the composer, so the composer hands the photo to the node as it is. On a Mac the photo
 * becomes a JPEG here and goes on like any other; other nodes have no converter and refuse it
 * with a message the composer shows. The dispatch normalizer loads this module with `import()`
 * when such a photo arrives, so it imports no module the server boots with.
 *
 * @module heicConversion
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  IMAGE_COMPRESSION_MAX_EDGE,
  IMAGE_COMPRESSION_QUALITY_STEPS,
  compressedImageFileName,
} from "@ryco/client-runtime/state/composer/imageCompression";

import { detectRasterImageMimeType } from "./imageMime.ts";
import { jpegDimensions } from "./jpegHeader.ts";

/** Only the system's own binary, never one found on `PATH`. */
export const SIPS_PATH = "/usr/bin/sips";
/** Per `sips` call; a 48 MP photo converts in about a second. */
export const HEIC_CONVERSION_TIMEOUT_MS = 20_000;
/** Larger photos are refused before decoding: the RGBA buffer alone would pass 250 MB. */
export const HEIC_CONVERSION_MAX_PIXELS = 64_000_000;
/** What `sips -g` prints is a few lines; more means something else answered. */
const SIPS_MAX_OUTPUT_BYTES = 64 * 1024;

export type HeicConversionFailure = "unavailable" | "failed" | "timed-out" | "too-large";

export type SipsResult =
  | { readonly ok: true; readonly stdout: string }
  | { readonly ok: false; readonly timedOut: boolean };

/** Runs `sips` with these arguments; no shell is involved. */
export type SipsRunner = (
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal | undefined },
) => Promise<SipsResult>;

/** Runs `binary` directly, killed with SIGKILL once `timeoutMs` passes. */
export function execFileRunner(binary: string): SipsRunner {
  return (args, { timeoutMs, signal }) =>
    new Promise((resolve) => {
      execFile(
        binary,
        [...args],
        {
          timeout: timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: SIPS_MAX_OUTPUT_BYTES,
          windowsHide: true,
          ...(signal ? { signal } : {}),
        },
        (error, stdout) => {
          if (!error) {
            resolve({ ok: true, stdout });
            return;
          }
          // `killed` is set by the timeout, an abort and an overlong output alike.
          const timedOut =
            error.killed === true &&
            signal?.aborted !== true &&
            error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
          resolve({ ok: false, timedOut });
        },
      );
    });
}

/** The system's `sips`, or null where there is none: any platform but macOS. */
async function systemSips(): Promise<SipsRunner | null> {
  if (process.platform !== "darwin") return null;
  try {
    await access(SIPS_PATH, constants.X_OK);
  } catch {
    return null;
  }
  return execFileRunner(SIPS_PATH);
}

export type HeicConversionResult =
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly reason: HeicConversionFailure };

const sipsFailure = (result: { readonly timedOut: boolean }): HeicConversionResult => ({
  ok: false,
  reason: result.timedOut ? "timed-out" : "failed",
});

/**
 * The photo as a JPEG no larger than `maxOutputBytes`, its long edge at most the composer's
 * 2048 px and at the composer's first quality step, the size the browser's own conversion
 * gives. `sips` keeps the photo's EXIF orientation tag, which every viewer applies. The work
 * happens in a private temporary directory that is removed afterwards, whatever the outcome.
 */
export async function convertHeicToJpeg(input: {
  readonly bytes: Uint8Array;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal | undefined;
  /** Tests stand in for `sips`; null stands for a node without it. */
  readonly sips?: SipsRunner | null;
  readonly timeoutMs?: number;
}): Promise<HeicConversionResult> {
  const sips = input.sips === undefined ? await systemSips() : input.sips;
  if (!sips) return { ok: false, reason: "unavailable" };
  // ImageIO picks its decoder from the content, not the declared type: only bytes that really are
  // a HEIC/HEIF still image (its ISO base-media brand) ever reach it.
  if (detectRasterImageMimeType(input.bytes) !== "image/heic")
    return { ok: false, reason: "failed" };
  const options = {
    timeoutMs: input.timeoutMs ?? HEIC_CONVERSION_TIMEOUT_MS,
    signal: input.signal,
  };

  // mkdtemp creates the directory readable by this user only.
  const directory = await mkdtemp(path.join(tmpdir(), "ryco-heic-"));
  try {
    const source = path.join(directory, "photo.heic");
    const output = path.join(directory, "photo.jpg");
    await writeFile(source, input.bytes, { mode: 0o600 });

    // Reads the header only. `-Z` also enlarges, so it is passed only for a larger photo.
    const probe = await sips(
      ["-g", "format", "-g", "pixelWidth", "-g", "pixelHeight", source],
      options,
    );
    if (!probe.ok) return sipsFailure(probe);
    // And ImageIO must read it as HEIC/HEIF too, not as another format the brand check let by.
    if (!/format:\s*hei[cf]\b/i.test(probe.stdout)) return { ok: false, reason: "failed" };
    const width = Number(/pixelWidth:\s*(\d+)/.exec(probe.stdout)?.[1] ?? 0);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(probe.stdout)?.[1] ?? 0);
    if (width <= 0 || height <= 0) return { ok: false, reason: "failed" };
    if (width * height > HEIC_CONVERSION_MAX_PIXELS) return { ok: false, reason: "too-large" };

    const converted = await sips(
      [
        "-s",
        "format",
        "jpeg",
        "-s",
        "formatOptions",
        String(Math.round(IMAGE_COMPRESSION_QUALITY_STEPS[0] * 100)),
        ...(Math.max(width, height) > IMAGE_COMPRESSION_MAX_EDGE
          ? ["-Z", String(IMAGE_COMPRESSION_MAX_EDGE)]
          : []),
        source,
        "--out",
        output,
      ],
      options,
    );
    if (!converted.ok) return sipsFailure(converted);

    const info = await stat(output).catch(() => null);
    if (!info?.isFile() || info.size === 0) return { ok: false, reason: "failed" };
    if (info.size > input.maxOutputBytes) return { ok: false, reason: "too-large" };
    const bytes = await readFile(output);
    // A JPEG down to its frame header, or the converter wrote something else.
    return jpegDimensions(bytes) ? { ok: true, bytes } : { ok: false, reason: "failed" };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** What the composer shows when a photo cannot be converted; `name` is the photo's. */
export function heicConversionFailureMessage(name: string, reason: HeicConversionFailure): string {
  switch (reason) {
    case "unavailable":
      return `HEIC photos can be converted only on a Mac node. Convert '${name}' to JPEG first.`;
    case "too-large":
      return `'${name}' is too large to convert from HEIC to JPEG. Convert it to JPEG first.`;
    case "timed-out":
      return `Converting '${name}' from HEIC to JPEG took too long. Convert it to JPEG first.`;
    case "failed":
      return `'${name}' could not be converted from HEIC to JPEG. Convert it to JPEG first.`;
  }
}

/**
 * A HEIC or HEIF photo attachment as the JPEG it continues as, named for it (`IMG_1234.HEIC`
 * becomes `IMG_1234.jpg`), or the message refusing it.
 */
export async function convertHeicAttachment(input: {
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal | undefined;
  readonly sips?: SipsRunner | null;
}): Promise<
  | {
      readonly ok: true;
      readonly name: string;
      readonly mimeType: "image/jpeg";
      readonly bytes: Buffer;
    }
  | { readonly ok: false; readonly message: string }
> {
  const result = await convertHeicToJpeg(input);
  return result.ok
    ? {
        ok: true,
        name: compressedImageFileName(input.name, "image/jpeg"),
        mimeType: "image/jpeg",
        bytes: result.bytes,
      }
    : { ok: false, message: heicConversionFailureMessage(input.name, result.reason) };
}
