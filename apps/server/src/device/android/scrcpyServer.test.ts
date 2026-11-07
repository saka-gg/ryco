import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  androidCacheRoot,
  SCRCPY_SERVER_SHA256,
  SCRCPY_SERVER_URL,
  ScrcpyServerArtifact,
  type FetchBytes,
} from "./scrcpyServer.ts";

describe("scrcpy-server artifact", () => {
  it("lives under the Ryco home", () => {
    expect(androidCacheRoot({ RYCO_HOME: "/srv/ryco" }, "/h")).toBe(
      path.join("/srv/ryco", "cache", "android"),
    );
    expect(androidCacheRoot({}, "/h")).toBe(path.join("/h", ".ryco", "cache", "android"));
  });

  it("refuses a download whose checksum is wrong, and remembers the failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ryco-scrcpy-"));
    try {
      const fetch = vi.fn<FetchBytes>(async () => Buffer.from("not the jar"));
      let now = 0;
      const artifact = new ScrcpyServerArtifact({
        cacheDirectory: directory,
        fetch,
        now: () => now,
      });
      await expect(artifact.resolve()).rejects.toThrow("failed its checksum");
      expect(fetch).toHaveBeenCalledWith(SCRCPY_SERVER_URL, expect.any(AbortSignal));
      await expect(artifact.resolve()).rejects.toThrow("failed its checksum");
      expect(fetch).toHaveBeenCalledTimes(1);
      now = 61_000;
      await expect(artifact.resolve()).rejects.toThrow("failed its checksum");
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses a verified cached file and replaces a corrupt one", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ryco-scrcpy-"));
    try {
      const fetch = vi.fn<FetchBytes>(async () => {
        throw new Error("offline");
      });
      const artifact = new ScrcpyServerArtifact({ cacheDirectory: directory, fetch });
      await writeFile(artifact.filePath, "corrupt");
      await expect(artifact.resolve()).rejects.toThrow("offline");
      // Only the pinned bytes are ever accepted from the cache.
      expect(
        createHash("sha256")
          .update(await readFile(artifact.filePath).catch(() => Buffer.alloc(0)))
          .digest("hex"),
      ).not.toBe(SCRCPY_SERVER_SHA256);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
