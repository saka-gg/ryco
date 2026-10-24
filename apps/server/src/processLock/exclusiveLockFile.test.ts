import { chmod, lstat, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createLockFileExclusive,
  readLockFile,
  removeLockFileIfUnchanged,
} from "./exclusiveLockFile.ts";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await chmod(join(directory, "lock"), 0o600).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

async function lockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ryco-lock-file-"));
  directories.push(directory);
  return join(directory, "lock");
}

const decodeNumber = (content: string) => (/^\d+\n$/u.test(content) ? Number(content) : undefined);
const read = (path: string) => readLockFile(path, { maxBytes: 64, decode: decodeNumber });

describe("exclusive lock files", () => {
  it("lets exactly one of two racing creators win", async () => {
    const path = await lockPath();
    const results = await Promise.all([
      createLockFileExclusive(path, "1\n"),
      createLockFileExclusive(path, "2\n"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const content = await readFile(path, "utf8");
    expect(content === "1\n" || content === "2\n").toBe(true);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("can name the inode it was written into", async () => {
    const path = await lockPath();
    await createLockFileExclusive(path, (ino) => `${ino}\n`);
    const result = await read(path);
    expect(result.kind).toBe("holder");
    if (result.kind === "holder") expect(result.record).toBe(result.ino);
  });

  it("classifies absent, holder and unparseable files with their age", async () => {
    const path = await lockPath();
    expect(await read(path)).toEqual({ kind: "absent" });

    await writeFile(path, "42\n");
    expect(await read(path)).toMatchObject({ kind: "holder", record: 42 });

    await writeFile(path, "");
    const fresh = await read(path);
    expect(fresh.kind).toBe("unparseable");
    if (fresh.kind === "unparseable") expect(Date.now() - fresh.mtimeMs).toBeLessThan(60_000);

    const old = new Date(Date.now() - 61_000);
    await utimes(path, old, old);
    const stale = await read(path);
    expect(stale.kind).toBe("unparseable");
    if (stale.kind === "unparseable") expect(Date.now() - stale.mtimeMs).toBeGreaterThan(60_000);
  });

  it("reports a directory or an oversized file as foreign and never removes it", async () => {
    const path = await lockPath();
    await mkdir(path);
    const directory = await read(path);
    expect(directory.kind).toBe("foreign");
    if (directory.kind === "foreign") {
      await expect(removeLockFileIfUnchanged(path, directory)).resolves.toBe(false);
    }
    expect((await lstat(path)).isDirectory()).toBe(true);

    await rm(path, { recursive: true });
    await writeFile(path, "1".repeat(65));
    expect((await read(path)).kind).toBe("foreign");
  });

  it("removes only the file that was judged", async () => {
    const path = await lockPath();
    await writeFile(path, "1\n");
    // An abandoned lock is not from this instant.
    const written = new Date(Date.now() - 10_000);
    await utimes(path, written, written);
    const judged = await read(path);
    if (judged.kind !== "holder") throw new Error("expected a holder");
    // Replaced by a racing process after it was judged.
    await rm(path);
    await createLockFileExclusive(path, "2\n");
    await expect(removeLockFileIfUnchanged(path, judged)).resolves.toBe(false);
    expect(await readFile(path, "utf8")).toBe("2\n");

    const current = await read(path);
    if (current.kind !== "holder") throw new Error("expected a holder");
    await expect(removeLockFileIfUnchanged(path, current)).resolves.toBe(true);
    expect(await read(path)).toEqual({ kind: "absent" });
  });

  it("keeps a new file that got the judged file's inode number", async () => {
    const path = await lockPath();
    await writeFile(path, "1\n");
    const written = new Date(Date.now() - 10_000);
    await utimes(path, written, written);
    const judged = await read(path);
    if (judged.kind !== "holder") throw new Error("expected a holder");
    // What a replacement that reused the inode (ext4) looks like: same inode,
    // written later.
    await writeFile(path, "2\n");
    expect((await lstat(path)).ino).toBe(judged.ino);
    await expect(removeLockFileIfUnchanged(path, judged)).resolves.toBe(false);
    expect(await readFile(path, "utf8")).toBe("2\n");
    // Without a known modification time (a file this process just created), the inode decides.
    await expect(removeLockFileIfUnchanged(path, { ino: judged.ino })).resolves.toBe(true);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports a lock it may not read as unreadable",
    async () => {
      const path = await lockPath();
      await writeFile(path, "1\n");
      await chmod(path, 0o000);
      expect(await read(path)).toEqual({ kind: "unreadable", code: "EACCES" });
    },
  );
});
