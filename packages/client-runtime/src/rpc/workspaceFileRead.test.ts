import { describe, expect, it, vi } from "vite-plus/test";
import {
  PROJECT_READ_FILE_CHUNK_BYTES,
  PROJECT_READ_FILE_CHUNKED_MAX_BYTES,
  type ProjectReadFileChunkInput,
  type ProjectReadFileChunkResult,
} from "@ryco/contracts";

import {
  readWorkspaceFileBytes,
  readWorkspaceFileBytesFromTransport,
  type WorkspaceFileChunkTransport,
} from "./workspaceFileRead.ts";

const reference = { cwd: "/repo", relativePath: "docs/sample.pdf" };
const FILE = "%PDF-1.7 abcdefgh";
const FINGERPRINT = "stat:one";

/** Serves `file` in `sliceBytes` pieces, as the node would. */
function chunkServer(
  file: string,
  sliceBytes: number,
  overrides?: Partial<ProjectReadFileChunkResult>,
) {
  return vi.fn(async (input: ProjectReadFileChunkInput): Promise<ProjectReadFileChunkResult> => ({
    relativePath: input.relativePath,
    offset: input.offset,
    totalBytes: file.length,
    dataBase64: btoa(file.slice(input.offset, input.offset + sliceBytes)),
    mimeType: "application/pdf",
    fingerprint: FINGERPRINT,
    ...(input.offset > 0 ? overrides : {}),
  }));
}

describe("readWorkspaceFileBytes", () => {
  it("assembles sequential chunks, pins the first fingerprint and reports progress", async () => {
    const readChunk = chunkServer(FILE, 6);
    const progress: Array<[number, number]> = [];
    const result = await readWorkspaceFileBytes({
      reference,
      readChunk,
      onProgress: ({ loadedBytes, totalBytes }) => progress.push([loadedBytes, totalBytes]),
    });

    expect(new TextDecoder().decode(result.bytes)).toBe(FILE);
    expect(result.mimeType).toBe("application/pdf");
    expect(result.fingerprint).toBe(FINGERPRINT);
    expect(readChunk.mock.calls.map(([input]) => input)).toEqual([
      { ...reference, offset: 0 },
      { ...reference, offset: 6, expectedFingerprint: FINGERPRINT },
      { ...reference, offset: 12, expectedFingerprint: FINGERPRINT },
    ]);
    expect(progress).toEqual([
      [6, FILE.length],
      [12, FILE.length],
      [FILE.length, FILE.length],
    ]);
  });

  it("fails when a later chunk disagrees with the first", async () => {
    for (const overrides of [
      { offset: 7 },
      { totalBytes: FILE.length + 1 },
      { fingerprint: "stat:two" },
      { mimeType: "image/png" },
    ]) {
      await expect(
        readWorkspaceFileBytes({ reference, readChunk: chunkServer(FILE, 6, overrides) }),
      ).rejects.toThrow("File changed while it was being read. Try again.");
    }
  });

  it("refuses an oversized file, an oversized chunk and an empty chunk", async () => {
    const oversizedFile = vi.fn(async (input: ProjectReadFileChunkInput) => ({
      relativePath: input.relativePath,
      offset: 0,
      totalBytes: PROJECT_READ_FILE_CHUNKED_MAX_BYTES + 1,
      dataBase64: btoa("%PDF-"),
      mimeType: "application/pdf",
      fingerprint: FINGERPRINT,
    }));
    await expect(readWorkspaceFileBytes({ reference, readChunk: oversizedFile })).rejects.toThrow(
      "Invalid file size.",
    );
    expect(oversizedFile).toHaveBeenCalledTimes(1);

    const big = "a".repeat(PROJECT_READ_FILE_CHUNK_BYTES + 3);
    await expect(
      readWorkspaceFileBytes({ reference, readChunk: chunkServer(big, big.length) }),
    ).rejects.toThrow("Invalid file chunk.");
    await expect(
      readWorkspaceFileBytes({ reference, readChunk: chunkServer(FILE, 6, { dataBase64: "" }) }),
    ).rejects.toThrow("Invalid file chunk.");
  });

  it("stops requesting chunks once aborted", async () => {
    const controller = new AbortController();
    const serve = chunkServer(FILE, 6);
    const readChunk = vi.fn(async (input: ProjectReadFileChunkInput) => {
      const result = await serve(input);
      controller.abort();
      return result;
    });
    await expect(
      readWorkspaceFileBytes({ reference, readChunk, signal: controller.signal }),
    ).rejects.toThrow("File load cancelled.");
    expect(readChunk).toHaveBeenCalledTimes(1);
  });
});

describe("readWorkspaceFileBytesFromTransport", () => {
  it("reads over the transport current at the start and fails if it is replaced mid-read", async () => {
    const first: WorkspaceFileChunkTransport = { readFileChunk: chunkServer(FILE, 6) };
    expect(
      new TextDecoder().decode(
        (await readWorkspaceFileBytesFromTransport({ reference, currentTransport: () => first }))
          .bytes,
      ),
    ).toBe(FILE);

    const serveFirst = chunkServer(FILE, 6);
    const second = { readFileChunk: chunkServer(FILE, 6) };
    let current: WorkspaceFileChunkTransport | undefined;
    const swapping: WorkspaceFileChunkTransport = {
      readFileChunk: async (input) => {
        current = second;
        return serveFirst(input);
      },
    };
    current = swapping;
    await expect(
      readWorkspaceFileBytesFromTransport({ reference, currentTransport: () => current }),
    ).rejects.toThrow("File connection changed.");
    expect(second.readFileChunk).not.toHaveBeenCalled();

    current = undefined;
    await expect(
      readWorkspaceFileBytesFromTransport({ reference, currentTransport: () => current }),
    ).rejects.toThrow("File connection unavailable.");
  });
});
