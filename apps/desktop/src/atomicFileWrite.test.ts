import * as FS from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { writeFileAtomicallySync } from "./atomicFileWrite.ts";

const directories: string[] = [];

function makeTempDir(): string {
  const directory = FS.mkdtempSync(join(tmpdir(), "ryco-atomic-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("writeFileAtomicallySync", () => {
  it("writes, replaces an existing file and leaves no temp file behind", () => {
    const directory = makeTempDir();
    const filePath = join(directory, "state.json");

    writeFileAtomicallySync(filePath, "first");
    expect(FS.readFileSync(filePath, "utf8")).toBe("first");

    writeFileAtomicallySync(filePath, "second");
    expect(FS.readFileSync(filePath, "utf8")).toBe("second");
    expect(FS.readdirSync(directory)).toEqual(["state.json"]);
  });

  it("creates missing parent directories", () => {
    const directory = makeTempDir();
    const filePath = join(directory, "nested", "deeper", "state.json");

    writeFileAtomicallySync(filePath, "contents");

    expect(FS.readFileSync(filePath, "utf8")).toBe("contents");
  });

  it.skipIf(process.platform === "win32")(
    "is owner-only: 0600 for the file, 0700 for a directory it creates",
    () => {
      const directory = makeTempDir();
      const filePath = join(directory, "created", "state.json");

      writeFileAtomicallySync(filePath, "contents");

      expect(FS.statSync(filePath).mode & 0o777).toBe(0o600);
      expect(FS.statSync(join(directory, "created")).mode & 0o777).toBe(0o700);
    },
  );

  it("throws when the rename fails, removes the temp file and leaves the target untouched", () => {
    const directory = makeTempDir();
    const target = join(directory, "occupied");
    FS.mkdirSync(target);
    FS.writeFileSync(join(target, "inside.txt"), "kept");

    expect(() => writeFileAtomicallySync(target, "contents")).toThrow();

    expect(FS.readdirSync(directory)).toEqual(["occupied"]);
    expect(FS.statSync(target).isDirectory()).toBe(true);
    expect(FS.readFileSync(join(target, "inside.txt"), "utf8")).toBe("kept");
  });
});
