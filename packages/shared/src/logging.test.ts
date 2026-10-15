import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { AsyncRotatingFileSink } from "./logging.ts";

const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-async-log-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("AsyncRotatingFileSink", () => {
  it("writes a batch in order through one held handle", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "thread.log");
    const openSpy = vi.spyOn(fs.promises, "open");
    const sink = new AsyncRotatingFileSink({ filePath, maxBytes: 1_024, maxFiles: 2 });

    expect(await sink.writeBatch(["a\n", "b\n"])).toBe(4);
    await sink.write("c\n");
    expect(await sink.writeBatch([])).toBe(0);
    await sink.close();

    expect(fs.readFileSync(filePath, "utf8")).toBe("a\nb\nc\n");
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it("rotates between the chunks of a batch that crosses maxBytes", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "thread.log");
    const sink = new AsyncRotatingFileSink({ filePath, maxBytes: 10, maxFiles: 2 });

    await sink.writeBatch(["12345", "67890", "abc", "defghij", "k"]);
    await sink.close();

    expect(fs.readFileSync(`${filePath}.2`, "utf8")).toBe("1234567890");
    expect(fs.readFileSync(`${filePath}.1`, "utf8")).toBe("abcdefghij");
    expect(fs.readFileSync(filePath, "utf8")).toBe("k");
  });

  it("reopens the file after close", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "thread.log");
    const sink = new AsyncRotatingFileSink({ filePath, maxBytes: 1_024, maxFiles: 1 });

    await sink.write("first\n");
    await sink.close();
    fs.rmSync(filePath);
    await sink.write("second\n");
    await sink.close();

    expect(fs.readFileSync(filePath, "utf8")).toBe("second\n");
  });

  it("gzips rotated backups and shifts them with the plain ones", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "thread.log");
    const sink = new AsyncRotatingFileSink({
      filePath,
      maxBytes: 10,
      maxFiles: 2,
      compressRotatedFiles: true,
    });

    await sink.writeBatch(["0123456789", "abcdefghij", "tail"]);
    await sink.close();

    expect(fs.existsSync(`${filePath}.1`)).toBe(false);
    expect(fs.existsSync(`${filePath}.2`)).toBe(false);
    expect(zlib.gunzipSync(fs.readFileSync(`${filePath}.1.gz`)).toString("utf8")).toBe(
      "abcdefghij",
    );
    expect(zlib.gunzipSync(fs.readFileSync(`${filePath}.2.gz`)).toString("utf8")).toBe(
      "0123456789",
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe("tail");
  });

  it("prunes backups left by a deeper rotation without listing the directory", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "thread.log");
    for (const suffix of [".1", ".2", ".3", ".4", ".4.gz"]) {
      fs.writeFileSync(`${filePath}${suffix}`, "old");
    }
    fs.writeFileSync(path.join(dir, "other.log.9"), "unrelated");
    const readdirSpy = vi.spyOn(fs.promises, "readdir");

    const sink = new AsyncRotatingFileSink({ filePath, maxBytes: 1_024, maxFiles: 2 });
    await sink.flush();

    expect(readdirSpy).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir).toSorted()).toEqual(["other.log.9", "thread.log.1", "thread.log.2"]);
  });

  it("prunes backups up to an earlier, deeper maxFiles", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "desktop-main.log");
    // Left by a rotation that kept ten backups before maxFiles dropped to three.
    for (const suffix of [".1", ".3", ".4", ".7", ".7.gz", ".10", ".11"]) {
      fs.writeFileSync(`${filePath}${suffix}`, "old");
    }
    const readdirSpy = vi.spyOn(fs.promises, "readdir");

    const sink = new AsyncRotatingFileSink({
      filePath,
      maxBytes: 1_024,
      maxFiles: 3,
      pruneBackupsUpTo: 10,
    });
    await sink.flush();

    expect(readdirSpy).not.toHaveBeenCalled();
    // Index 11 was never written by any configuration and is left alone.
    expect(fs.readdirSync(dir).toSorted()).toEqual([
      "desktop-main.log.1",
      "desktop-main.log.11",
      "desktop-main.log.3",
    ]);
  });
});
