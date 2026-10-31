import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import sharp from "sharp";
import { describe, expect, it } from "vite-plus/test";

import {
  HEIC_CONVERSION_MAX_PIXELS,
  SIPS_PATH,
  convertHeicAttachment,
  convertHeicToJpeg,
  execFileRunner,
  type SipsResult,
  type SipsRunner,
} from "./heicConversion.ts";

const MB = 1024 * 1024;
/** The smallest file `jpegDimensions` reads as a JPEG: SOI, then a 1x1 baseline frame header. */
const TINY_JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
]);

/**
 * Stands in for `sips`: answers the size probe with `size`, and the conversion by writing
 * `output` to the `--out` path. Records each call's arguments and the work directory.
 */
function fakeSips(input: {
  readonly size?: { readonly width: number; readonly height: number };
  readonly probe?: SipsResult;
  readonly convert?: SipsResult;
  readonly output?: Uint8Array;
}) {
  const calls: Array<ReadonlyArray<string>> = [];
  const directories: string[] = [];
  const run: SipsRunner = async (args) => {
    calls.push(args);
    if (args[0] === "-g") {
      directories.push(path.dirname(args.at(-1)!));
      const { width, height } = input.size ?? { width: 4032, height: 3024 };
      return (
        input.probe ?? {
          ok: true,
          stdout: `${args.at(-1)}\n  pixelWidth: ${width}\n  pixelHeight: ${height}\n`,
        }
      );
    }
    if (input.convert) return input.convert;
    await writeFile(args.at(-1)!, input.output ?? TINY_JPEG);
    return { ok: true, stdout: "" };
  };
  return { run, calls, directories };
}

const heicBytes = Buffer.from("not decoded by the fake");

describe("convertHeicToJpeg with a stand-in sips", () => {
  it("refuses on a node without sips, naming the Mac and the way out", async () => {
    expect(await convertHeicToJpeg({ bytes: heicBytes, maxOutputBytes: MB, sips: null })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    expect(
      await convertHeicAttachment({ name: "IMG_0001.HEIC", bytes: heicBytes, maxOutputBytes: MB }),
    ).toEqual(
      process.platform === "darwin" && existsSync(SIPS_PATH)
        ? // The real sips cannot read these bytes.
          {
            ok: false,
            message:
              "'IMG_0001.HEIC' could not be converted from HEIC to JPEG. Convert it to JPEG first.",
          }
        : {
            ok: false,
            message:
              "HEIC photos can be converted only on a Mac node. Convert 'IMG_0001.HEIC' to JPEG first.",
          },
    );
  });

  it("converts at the composer's quality, shrinking only a photo over 2048 px", async () => {
    const large = fakeSips({ size: { width: 4032, height: 3024 } });
    const result = await convertHeicToJpeg({
      bytes: heicBytes,
      maxOutputBytes: MB,
      sips: large.run,
    });
    expect(result).toEqual({ ok: true, bytes: TINY_JPEG });
    const [probe, convert] = large.calls;
    expect(probe?.slice(0, 4)).toEqual(["-g", "pixelWidth", "-g", "pixelHeight"]);
    expect(convert?.slice(0, 8)).toEqual([
      "-s",
      "format",
      "jpeg",
      "-s",
      "formatOptions",
      "92",
      "-Z",
      "2048",
    ]);

    // `sips -Z` would enlarge a smaller photo.
    const small = fakeSips({ size: { width: 1200, height: 900 } });
    await convertHeicToJpeg({ bytes: heicBytes, maxOutputBytes: MB, sips: small.run });
    expect(small.calls[1]).not.toContain("-Z");
  });

  it("works in a private directory and removes it whatever the outcome", async () => {
    const converted = fakeSips({});
    let mode = 0;
    const run: SipsRunner = async (args, options) => {
      mode ||= statSync(path.dirname(args.at(-1)!)).mode & 0o777;
      return converted.run(args, options);
    };
    await convertHeicToJpeg({ bytes: heicBytes, maxOutputBytes: MB, sips: run });
    const failed = fakeSips({ convert: { ok: false, timedOut: false } });
    await convertHeicToJpeg({ bytes: heicBytes, maxOutputBytes: MB, sips: failed.run });

    expect(mode).toBe(0o700);
    for (const directory of [...converted.directories, ...failed.directories]) {
      expect(path.basename(directory)).toMatch(/^ryco-heic-/);
      expect(existsSync(directory)).toBe(false);
    }
  });

  it("tells a failed and a timed-out sips apart", async () => {
    const convert = (sips: SipsRunner) =>
      convertHeicToJpeg({ bytes: heicBytes, maxOutputBytes: MB, sips });
    expect(await convert(fakeSips({ probe: { ok: false, timedOut: false } }).run)).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(await convert(fakeSips({ convert: { ok: false, timedOut: true } }).run)).toEqual({
      ok: false,
      reason: "timed-out",
    });
    // A probe that names no size is a file sips could not read.
    expect(await convert(fakeSips({ probe: { ok: true, stdout: "Error 13" } }).run)).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("refuses a photo too large to decode without converting it", async () => {
    const huge = fakeSips({
      size: { width: 10_000, height: HEIC_CONVERSION_MAX_PIXELS / 10_000 + 1 },
    });
    expect(
      await convertHeicToJpeg({ bytes: heicBytes, maxOutputBytes: MB, sips: huge.run }),
    ).toEqual({ ok: false, reason: "too-large" });
    expect(huge.calls).toHaveLength(1);
  });

  it("refuses an output over the size cap or one that is not a JPEG", async () => {
    const oversized = fakeSips({ output: Buffer.concat([TINY_JPEG, Buffer.alloc(2048)]) });
    expect(
      await convertHeicToJpeg({ bytes: heicBytes, maxOutputBytes: 1024, sips: oversized.run }),
    ).toEqual({ ok: false, reason: "too-large" });

    const png = fakeSips({ output: Buffer.from("\x89PNG\r\n\x1a\n0000", "latin1") });
    expect(
      await convertHeicToJpeg({ bytes: heicBytes, maxOutputBytes: MB, sips: png.run }),
    ).toEqual({ ok: false, reason: "failed" });
  });

  it("names the converted attachment as a JPEG", async () => {
    const result = await convertHeicAttachment({
      name: "IMG_0001.HEIC",
      bytes: heicBytes,
      maxOutputBytes: MB,
      sips: fakeSips({}).run,
    });
    expect(result).toEqual({
      ok: true,
      name: "IMG_0001.jpg",
      mimeType: "image/jpeg",
      bytes: TINY_JPEG,
    });
  });
});

describe.skipIf(process.platform === "win32")("execFileRunner", () => {
  it("kills a process that outlives its timeout", async () => {
    const startedAt = Date.now();
    expect(await execFileRunner("/bin/sleep")(["10"], { timeoutMs: 100 })).toEqual({
      ok: false,
      timedOut: true,
    });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it("reports an aborted run as failed, not timed out", async () => {
    const controller = new AbortController();
    const run = execFileRunner("/bin/sleep")(["10"], {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    controller.abort();
    expect(await run).toEqual({ ok: false, timedOut: false });
  });
});

const hasSips = process.platform === "darwin" && existsSync(SIPS_PATH);

/** A HEIC photo of `width` x `height` made by sips itself, from a PNG sharp draws. */
async function makeHeic(width: number, height: number): Promise<Buffer> {
  const directory = await mkdtemp(path.join(tmpdir(), "ryco-heic-fixture-"));
  try {
    const png = path.join(directory, "photo.png");
    const heic = path.join(directory, "photo.heic");
    await sharp({ create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } } })
      .png()
      .toFile(png);
    await promisify(execFile)(SIPS_PATH, ["-s", "format", "heic", png, "--out", heic]);
    return await readFile(heic);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Needs macOS's sips; other platforms skip it and keep the stand-in tests above.
describe.skipIf(!hasSips)("convertHeicToJpeg with the real sips (macOS only)", () => {
  it("converts a photo to a JPEG, its long edge at 2048 px", async () => {
    const heic = await makeHeic(3000, 1000);
    expect(heic.subarray(4, 12).toString("latin1")).toBe("ftypheic");

    const result = await convertHeicToJpeg({ bytes: heic, maxOutputBytes: 10 * MB });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const metadata = await sharp(result.bytes).metadata();
    expect(metadata.format).toBe("jpeg");
    expect([metadata.width, metadata.height]).toEqual([2048, 682]);
  });

  it("keeps a smaller photo's size", async () => {
    const result = await convertHeicToJpeg({ bytes: await makeHeic(300, 200), maxOutputBytes: MB });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const metadata = await sharp(result.bytes).metadata();
    expect([metadata.width, metadata.height]).toEqual([300, 200]);
  });

  it("fails on bytes that are not a photo", async () => {
    expect(
      await convertHeicToJpeg({ bytes: Buffer.from("not a photo"), maxOutputBytes: MB }),
    ).toEqual({ ok: false, reason: "failed" });
  });
});
