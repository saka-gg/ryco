import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { it } from "@effect/vitest";
import { Effect } from "effect";
import sharp from "sharp";
import { describe, expect } from "vite-plus/test";

import {
  probeAttachmentMediaDimensions,
  probeAttachmentMediaDimensionsFromBytes,
  probeAttachmentMediaForServing,
} from "./attachmentMedia.ts";
import { makeNamedPipe } from "./testing/namedPipe.ts";

const buildMp4Box = (type: string, payload: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, payload]);
};

const buildTkhdV0 = (width: number, height: number): Buffer => {
  const body = Buffer.alloc(84);
  body.writeUInt32BE(width * 65536, 76);
  body.writeUInt32BE(height * 65536, 80);
  return buildMp4Box("tkhd", body);
};

const buildTkhdV1 = (width: number, height: number): Buffer => {
  const body = Buffer.alloc(96);
  body.writeUInt8(1, 0);
  body.writeUInt32BE(width * 65536, 88);
  body.writeUInt32BE(height * 65536, 92);
  return buildMp4Box("tkhd", body);
};

const buildHdlr = (handlerType: string): Buffer => {
  const body = Buffer.alloc(12);
  body.write(handlerType, 8, "ascii");
  return buildMp4Box("hdlr", body);
};

const buildMp4 = (tracks: ReadonlyArray<Buffer>): Buffer =>
  Buffer.concat([
    buildMp4Box("ftyp", Buffer.from("isom")),
    buildMp4Box("moov", Buffer.concat(tracks.map((track) => buildMp4Box("trak", track)))),
  ]);

const makeTempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "ryco-attachment-media-"));

describe("attachment media probing", () => {
  it.effect("reports displayed dimensions for EXIF-rotated images", () =>
    Effect.gen(function* () {
      const bytes = yield* Effect.promise(() =>
        sharp({ create: { width: 20, height: 30, channels: 3, background: "red" } })
          .jpeg()
          .withMetadata({ orientation: 6 })
          .toBuffer(),
      );
      expect(yield* probeAttachmentMediaDimensionsFromBytes(bytes, "image/jpeg")).toEqual({
        width: 30,
        height: 20,
      });
    }),
  );

  it.effect("applies quarter-turn video track rotation", () =>
    Effect.gen(function* () {
      for (const version of [0, 1]) {
        const tkhd = version === 0 ? buildTkhdV0(1920, 1080) : buildTkhdV1(1920, 1080);
        const matrixOffset = 8 + (version === 0 ? 40 : 52);
        tkhd.writeInt32BE(65536, matrixOffset + 4);
        tkhd.writeInt32BE(-65536, matrixOffset + 12);
        const bytes = buildMp4([Buffer.concat([tkhd, buildMp4Box("mdia", buildHdlr("vide"))])]);
        expect(yield* probeAttachmentMediaDimensionsFromBytes(bytes, "video/quicktime")).toEqual({
          width: 1080,
          height: 1920,
        });
      }
    }),
  );

  it.effect("bounds scans of files containing thousands of tiny boxes", () =>
    Effect.gen(function* () {
      const bytes = Buffer.concat([
        ...Array.from({ length: 3000 }, () => buildMp4Box("free", Buffer.alloc(0))),
        buildMp4([Buffer.concat([buildTkhdV0(320, 240), buildMp4Box("mdia", buildHdlr("vide"))])]),
      ]);
      expect(yield* probeAttachmentMediaDimensionsFromBytes(bytes, "video/mp4")).toBeNull();
      const dir = makeTempDir();
      try {
        const file = path.join(dir, "many-boxes.mp4");
        fs.writeFileSync(file, bytes);
        expect(yield* probeAttachmentMediaDimensions(file, "video/mp4")).toBeNull();
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("ignores padding in oversized metadata boxes", () =>
    Effect.gen(function* () {
      const tkhd = buildMp4Box(
        "tkhd",
        Buffer.concat([buildTkhdV0(320, 240).subarray(8), Buffer.alloc(1024 * 1024)]),
      );
      const hdlr = buildMp4Box(
        "hdlr",
        Buffer.concat([buildHdlr("vide").subarray(8), Buffer.alloc(1024 * 1024)]),
      );
      const dir = makeTempDir();
      try {
        const file = path.join(dir, "padded.mp4");
        fs.writeFileSync(file, buildMp4([Buffer.concat([tkhd, buildMp4Box("mdia", hdlr)])]));
        expect(yield* probeAttachmentMediaDimensions(file, "video/mp4")).toEqual({
          width: 320,
          height: 240,
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("probes image dimensions from bytes", () =>
    Effect.gen(function* () {
      const pngBytes = yield* Effect.promise(() =>
        sharp({
          create: { width: 2, height: 3, channels: 3, background: "#ff0000" },
        })
          .png()
          .toBuffer(),
      );

      const dimensions = yield* probeAttachmentMediaDimensionsFromBytes(pngBytes, "image/png");
      expect(dimensions).toEqual({ width: 2, height: 3 });
    }),
  );

  it.effect("returns null for corrupt image bytes", () =>
    Effect.gen(function* () {
      const corrupt = yield* probeAttachmentMediaDimensionsFromBytes(
        Buffer.from("not-a-png-at-all"),
        "image/png",
      );
      expect(corrupt).toBeNull();
    }),
  );

  it.effect("probes mp4 dimensions from the video track tkhd", () =>
    Effect.gen(function* () {
      const videoOnly = buildMp4([
        Buffer.concat([buildTkhdV0(320, 240), buildMp4Box("mdia", buildHdlr("vide"))]),
      ]);
      expect(yield* probeAttachmentMediaDimensionsFromBytes(videoOnly, "video/mp4")).toEqual({
        width: 320,
        height: 240,
      });

      const audioFirst = buildMp4([
        Buffer.concat([buildTkhdV0(0, 0), buildMp4Box("mdia", buildHdlr("soun"))]),
        Buffer.concat([buildTkhdV1(1920, 1080), buildMp4Box("mdia", buildHdlr("vide"))]),
      ]);
      expect(yield* probeAttachmentMediaDimensionsFromBytes(audioFirst, "video/mp4")).toEqual({
        width: 1920,
        height: 1080,
      });
    }),
  );

  it.effect("skips audio-only mp4 tracks and non-mp4 video containers", () =>
    Effect.gen(function* () {
      const audioOnly = buildMp4([
        Buffer.concat([buildTkhdV0(0, 0), buildMp4Box("mdia", buildHdlr("soun"))]),
      ]);
      expect(yield* probeAttachmentMediaDimensionsFromBytes(audioOnly, "video/mp4")).toBeNull();

      const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64, 0x42)]);
      expect(yield* probeAttachmentMediaDimensionsFromBytes(webm, "video/webm")).toBeNull();

      const plainBytes = Buffer.from("plain text");
      expect(yield* probeAttachmentMediaDimensionsFromBytes(plainBytes, "text/plain")).toBeNull();
    }),
  );

  it.effect("returns null for truncated mp4 bytes", () =>
    Effect.gen(function* () {
      const truncated = buildMp4([
        Buffer.concat([buildTkhdV0(320, 240), buildMp4Box("mdia", buildHdlr("vide"))]),
      ]).subarray(0, 24);
      expect(yield* probeAttachmentMediaDimensionsFromBytes(truncated, "video/mp4")).toBeNull();
    }),
  );

  it.effect("probes persisted files and memoizes serving probes per extension", () =>
    Effect.gen(function* () {
      const tempDir = makeTempDir();
      const pngBytes = yield* Effect.promise(() =>
        sharp({
          create: { width: 4, height: 5, channels: 3, background: "#00ff00" },
        })
          .png()
          .toBuffer(),
      );
      const pngPath = path.join(tempDir, "clip.png");
      fs.writeFileSync(pngPath, pngBytes);
      const mp4Path = path.join(tempDir, "clip.mp4");
      fs.writeFileSync(
        mp4Path,
        buildMp4([Buffer.concat([buildTkhdV0(640, 360), buildMp4Box("mdia", buildHdlr("vide"))])]),
      );
      const textPath = path.join(tempDir, "notes.txt");
      fs.writeFileSync(textPath, "abc");
      const missingPath = path.join(tempDir, "missing.png");

      expect(yield* probeAttachmentMediaDimensions(pngPath, "image/png")).toEqual({
        width: 4,
        height: 5,
      });
      expect(yield* probeAttachmentMediaDimensions(mp4Path, "video/mp4")).toEqual({
        width: 640,
        height: 360,
      });
      expect(yield* probeAttachmentMediaDimensions(textPath, "text/plain")).toBeNull();
      expect(yield* probeAttachmentMediaDimensions(missingPath, "image/png")).toBeNull();

      expect(yield* probeAttachmentMediaForServing(pngPath, ".png")).toEqual({
        width: 4,
        height: 5,
      });
      expect(yield* probeAttachmentMediaForServing(pngPath, ".PNG")).toEqual({
        width: 4,
        height: 5,
      });
      expect(yield* probeAttachmentMediaForServing(mp4Path, ".mp4")).toEqual({
        width: 640,
        height: 360,
      });
      expect(yield* probeAttachmentMediaForServing(textPath, ".txt")).toBeNull();
      expect(yield* probeAttachmentMediaForServing(missingPath, ".png")).toBeNull();

      fs.rmSync(tempDir, { recursive: true, force: true });
    }),
  );

  it.effect.skipIf(process.platform === "win32")("does not wait on a named pipe", () =>
    Effect.gen(function* () {
      const tempDir = makeTempDir();
      const fifo = path.join(tempDir, "clip.mp4");
      makeNamedPipe(fifo);
      // The probe opens synchronously, so a blocked open would stall the event
      // loop where no deadline can fire. A child opens the other end after five
      // seconds instead: a regression shows up as a slow probe, not a hang.
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          spawn("sh", ["-c", 'sleep 5; exec 3<>"$1"', "sh", fifo], { stdio: "ignore" }),
        ),
        (child) =>
          Effect.sync(() => {
            child.kill("SIGKILL");
            fs.rmSync(tempDir, { recursive: true, force: true });
          }),
      );

      const started = performance.now();
      expect(yield* probeAttachmentMediaDimensions(fifo, "video/mp4")).toBeNull();
      expect(performance.now() - started).toBeLessThan(2_500);
    }),
  );
});
