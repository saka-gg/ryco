import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { NotRegularFileError, REGULAR_FILE_READ_FLAGS, openRegularFile } from "./regularFile.ts";

const posix = process.platform !== "win32";
const tempRoots: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-regular-file-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeFifo(): string {
  const fifo = path.join(makeTempDir(), "pipe");
  execFileSync("mkfifo", [fifo]);
  return fifo;
}

/**
 * Opening a FIFO without O_NONBLOCK waits for its other end and cannot be
 * cancelled. Each case races a deadline and then opens the other end itself,
 * so a regression fails the test instead of stranding a libuv worker.
 */
async function withinDeadline<T>(fifo: string, operation: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Waited on a named pipe.")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    fs.closeSync(fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK));
  }
}

describe("openRegularFile", () => {
  it("opens a regular file with the descriptor's stat", async () => {
    const file = path.join(makeTempDir(), "notes.txt");
    fs.writeFileSync(file, "hello");

    const opened = await openRegularFile(file);
    try {
      expect(opened.stat.size).toBe(5);
      expect((await opened.handle.readFile()).toString("utf8")).toBe("hello");
    } finally {
      await opened.handle.close();
    }

    const bigint = await openRegularFile(file, { bigint: true });
    await bigint.handle.close();
    expect(bigint.stat.size).toBe(5n);
  });

  it("refuses a directory", async () => {
    await expect(openRegularFile(makeTempDir())).rejects.toBeInstanceOf(NotRegularFileError);
  });

  it.skipIf(!posix)("refuses a final symbolic link unless told to follow it", async () => {
    const dir = makeTempDir();
    const target = path.join(dir, "target.txt");
    const link = path.join(dir, "link.txt");
    const dangling = path.join(dir, "dangling.txt");
    fs.writeFileSync(target, "target");
    fs.symlinkSync(target, link);
    fs.symlinkSync(path.join(dir, "absent.txt"), dangling);

    await expect(openRegularFile(link)).rejects.toBeInstanceOf(NotRegularFileError);
    await expect(openRegularFile(link, { write: true })).rejects.toBeInstanceOf(
      NotRegularFileError,
    );
    // Creating through a dangling link would place the file wherever it points.
    await expect(openRegularFile(dangling, { write: true })).rejects.toBeInstanceOf(
      NotRegularFileError,
    );
    expect(fs.existsSync(path.join(dir, "absent.txt"))).toBe(false);
    const followed = await openRegularFile(link, { followSymlinks: true });
    try {
      expect((await followed.handle.readFile()).toString("utf8")).toBe("target");
    } finally {
      await followed.handle.close();
    }
  });

  it("creates an absent file for writing and leaves an existing one untruncated", async () => {
    const dir = makeTempDir();
    const created = path.join(dir, "created.txt");
    const fresh = await openRegularFile(created, { write: true });
    await fresh.handle.close();
    expect(fs.readFileSync(created, "utf8")).toBe("");

    const existing = path.join(dir, "existing.txt");
    fs.writeFileSync(existing, "keep");
    const opened = await openRegularFile(existing, { write: true });
    await opened.handle.close();
    expect(opened.stat.size).toBe(4);
    expect(fs.readFileSync(existing, "utf8")).toBe("keep");
  });

  it.skipIf(!posix)("refuses a named pipe for reading without waiting for a writer", async () => {
    const fifo = makeFifo();
    await expect(withinDeadline(fifo, () => openRegularFile(fifo))).rejects.toBeInstanceOf(
      NotRegularFileError,
    );
  });

  it.skipIf(!posix)("refuses a named pipe for writing without waiting for a reader", async () => {
    const fifo = makeFifo();
    await expect(
      withinDeadline(fifo, () => openRegularFile(fifo, { write: true })),
    ).rejects.toBeInstanceOf(NotRegularFileError);
  });

  it.skipIf(!posix)("refuses a Unix socket for reading and for writing", async () => {
    // Linux fails the open with ENXIO, macOS with an EOPNOTSUPP libuv has no name for.
    const socketPath = path.join(makeTempDir(), "s.sock");
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    try {
      await expect(openRegularFile(socketPath)).rejects.toBeInstanceOf(NotRegularFileError);
      await expect(openRegularFile(socketPath, { write: true })).rejects.toBeInstanceOf(
        NotRegularFileError,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.skipIf(!posix)("keeps the read flags non-blocking on a named pipe", async () => {
    const fifo = makeFifo();
    const handle = await withinDeadline(fifo, () =>
      fs.promises.open(fifo, REGULAR_FILE_READ_FLAGS),
    );
    try {
      expect((await handle.stat()).isFIFO()).toBe(true);
    } finally {
      await handle.close();
    }
  });
});
