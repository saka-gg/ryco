// @effect-diagnostics nodeBuiltinImport:off
import * as FS from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readBoundedUsageFile } from "./usageFileReader.ts";

const mode = vi.hoisted(() => ({ shortReads: false, replaceOnRead: false }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof FS>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof FS.open>) => {
      const file = await fs.open(...args),
        read = file.read.bind(file);
      Object.defineProperty(file, "read", {
        value: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await read(
            buffer,
            offset,
            mode.shortReads ? Math.min(length, 7) : length,
            position,
          );
          if (mode.replaceOnRead) {
            mode.replaceOnRead = false;
            await fs.writeFile(args[0], "changed snapshot");
          }
          return result;
        },
      });
      return file;
    },
  };
});
const roots: string[] = [];
afterEach(async () => {
  mode.shortReads = false;
  mode.replaceOnRead = false;
  for (const root of roots.splice(0)) await FS.rm(root, { recursive: true, force: true });
});
async function path() {
  const root = await FS.mkdtemp(join(tmpdir(), "ryco-read-fixture-"));
  roots.push(root);
  return join(root, "usage.json");
}
describe("bounded usage file reads", () => {
  it("loops short regular-file reads instead of accepting truncated records", async () => {
    const file = await path(),
      content = JSON.stringify({ usageEvents: [], synthetic: "x".repeat(500) });
    await FS.writeFile(file, content);
    mode.shortReads = true;
    expect(await readBoundedUsageFile(file, 1024)).toBe(content);
  });
  it("discards changed snapshots rather than publishing partial/deleted replacement rows", async () => {
    const file = await path();
    await FS.writeFile(file, "original snapshot");
    mode.replaceOnRead = true;
    await expect(readBoundedUsageFile(file, 1024)).rejects.toMatchObject({
      code: "usage-file-changed",
    });
  });
  it("rejects links and oversized regular files", async () => {
    const file = await path();
    await FS.writeFile(file, "data");
    await FS.symlink(file, file + ".link");
    await expect(readBoundedUsageFile(file + ".link", 10)).rejects.toMatchObject({
      code: "usage-path-rejected",
    });
    await expect(readBoundedUsageFile(file, 1)).rejects.toMatchObject({
      code: "usage-file-oversized",
    });
  });
  it.skipIf(process.platform === "win32")(
    "rejects a FIFO before opening it",
    async () => {
      const file = await path();
      expect(spawnSync("mkfifo", [file]).status).toBe(0);
      await expect(readBoundedUsageFile(file, 10)).rejects.toMatchObject({
        code: "usage-path-rejected",
      });
    },
    1000,
  );
});
