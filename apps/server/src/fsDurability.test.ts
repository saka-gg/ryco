import * as NFS from "node:fs/promises";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { replaceFileAtomically } from "./fsDurability.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await NFS.rm(dir, { recursive: true, force: true });
});
const scratch = async () => {
  const dir = await NFS.mkdtemp(NodePath.join(tmpdir(), "ryco-fs-durability-"));
  dirs.push(dir);
  return dir;
};

describe("replaceFileAtomically", () => {
  it("replaces the file and leaves no temp entries", async () => {
    const dir = await scratch();
    const filePath = NodePath.join(dir, "state.json");
    await replaceFileAtomically({ filePath, contents: "one" });
    await replaceFileAtomically({ filePath, contents: Buffer.from("two"), durable: true });
    expect(await NFS.readFile(filePath, "utf8")).toBe("two");
    expect(await NFS.readdir(dir)).toEqual(["state.json"]);
  });

  it.runIf(process.platform !== "win32")("sets the mode exactly, whatever the umask", async () => {
    const dir = await scratch();
    const filePath = NodePath.join(dir, "identity.json");
    const previous = process.umask(0o077);
    try {
      await replaceFileAtomically({ filePath, contents: "a", mode: 0o640 });
    } finally {
      process.umask(previous);
    }
    expect((await NFS.stat(filePath)).mode & 0o777).toBe(0o640);
    await replaceFileAtomically({ filePath, contents: "b", mode: 0o600, durable: true });
    expect((await NFS.stat(filePath)).mode & 0o777).toBe(0o600);
  });

  it("rethrows a failed rename and removes its temp file", async () => {
    const dir = await scratch();
    const filePath = NodePath.join(dir, "taken");
    await NFS.mkdir(NodePath.join(filePath, "inside"), { recursive: true });
    await expect(replaceFileAtomically({ filePath, contents: "x" })).rejects.toBeDefined();
    expect(await NFS.readdir(dir)).toEqual(["taken"]);
  });

  it("fails when the folder does not exist", async () => {
    const dir = await scratch();
    await expect(
      replaceFileAtomically({ filePath: NodePath.join(dir, "missing", "f"), contents: "x" }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
