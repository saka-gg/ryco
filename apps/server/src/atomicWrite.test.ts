import * as NFS from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer } from "effect";
import * as PlatformError from "effect/PlatformError";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { writeFileAtomically, writeFileStringAtomically } from "./atomicWrite.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await NFS.rm(dir, { recursive: true, force: true });
});
const scratch = async () => {
  const dir = await NFS.mkdtemp(NodePath.join(tmpdir(), "ryco-atomic-write-"));
  dirs.push(dir);
  return dir;
};
const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect);
const write = (input: Parameters<typeof writeFileAtomically>[0]) =>
  run(writeFileAtomically(input).pipe(Effect.provide(NodeServices.layer)));

describe("writeFileAtomically", () => {
  it("creates missing folders, replaces the file and leaves no temp entries", async () => {
    const dir = await scratch();
    const filePath = NodePath.join(dir, "nested", "settings.json");
    await write({ filePath, contents: "one" });
    await run(
      writeFileStringAtomically({ filePath, contents: "two" }).pipe(
        Effect.provide(NodeServices.layer),
      ),
    );
    expect(await NFS.readFile(filePath, "utf8")).toBe("two");
    expect(await NFS.readdir(NodePath.dirname(filePath))).toEqual(["settings.json"]);
  });

  it("writes bytes", async () => {
    const dir = await scratch();
    const filePath = NodePath.join(dir, "blob.bin");
    await write({ filePath, contents: Uint8Array.of(1, 2, 3) });
    expect([...(await NFS.readFile(filePath))]).toEqual([1, 2, 3]);
  });

  it.runIf(process.platform !== "win32")("sets the mode exactly, whatever the umask", async () => {
    const dir = await scratch();
    const filePath = NodePath.join(dir, "secret.bin");
    const previous = process.umask(0o077);
    try {
      await write({ filePath, contents: "a", mode: 0o640 });
    } finally {
      process.umask(previous);
    }
    expect((await NFS.stat(filePath)).mode & 0o777).toBe(0o640);
    await write({ filePath, contents: "b", mode: 0o600 });
    expect((await NFS.stat(filePath)).mode & 0o777).toBe(0o600);
    expect(await NFS.readFile(filePath, "utf8")).toBe("b");
  });

  it("writes durably when asked", async () => {
    const dir = await scratch();
    const filePath = NodePath.join(dir, "marker.json");
    await write({ filePath, contents: "{}\n", durable: true });
    expect(await NFS.readFile(filePath, "utf8")).toBe("{}\n");
    expect(await NFS.readdir(dir)).toEqual(["marker.json"]);
  });

  it("fails without touching the old file or leaving temp entries when the rename fails", async () => {
    const dir = await scratch();
    // A non-empty folder cannot be replaced by a file.
    const filePath = NodePath.join(dir, "taken");
    await NFS.mkdir(NodePath.join(filePath, "inside"), { recursive: true });
    await expect(write({ filePath, contents: "x" })).rejects.toBeDefined();
    expect((await NFS.stat(filePath)).isDirectory()).toBe(true);
    expect(await NFS.readdir(dir)).toEqual(["taken"]);
  });

  /** The node file system, except that opening `failOpen(path, flag)` paths fails with EINVAL. */
  const failingOpenLayer = (failOpen: (path: string, flag: string | undefined) => boolean) =>
    Layer.effect(
      FileSystem.FileSystem,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        return {
          ...fileSystem,
          open: (path, options) =>
            failOpen(String(path), options?.flag)
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "InvalidData",
                    module: "FileSystem",
                    method: "open",
                    pathOrDescriptor: String(path),
                  }),
                )
              : fileSystem.open(path, options),
        } satisfies FileSystem.FileSystem;
      }),
    ).pipe(Layer.provideMerge(NodeServices.layer));

  it("keeps a durable write when the directory refuses fsync after the rename", async () => {
    const dir = await scratch();
    const filePath = NodePath.join(dir, "marker.json");
    await run(
      writeFileAtomically({ filePath, contents: "new\n", durable: true }).pipe(
        Effect.provide(failingOpenLayer((path, flag) => path === dir && flag === "r")),
      ),
    );
    expect(await NFS.readFile(filePath, "utf8")).toBe("new\n");
    expect(await NFS.readdir(dir)).toEqual(["marker.json"]);
  });

  it("fails a durable write whose file cannot be flushed, before the rename", async () => {
    const dir = await scratch();
    const filePath = NodePath.join(dir, "marker.json");
    await NFS.writeFile(filePath, "old\n");
    await expect(
      run(
        writeFileAtomically({ filePath, contents: "new\n", durable: true }).pipe(
          Effect.provide(failingOpenLayer((_path, flag) => flag === "r+")),
        ),
      ),
    ).rejects.toBeDefined();
    expect(await NFS.readFile(filePath, "utf8")).toBe("old\n");
    expect(await NFS.readdir(dir)).toEqual(["marker.json"]);
  });
});
