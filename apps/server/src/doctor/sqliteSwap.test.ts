import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareCopyForSwap, swapInCopy } from "./sqliteSwap.ts";

const directories: Array<string> = [];
const scratch = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-doctor-swap-"));
  directories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("sqliteSwap", () => {
  it.skipIf(process.platform === "win32")(
    "gives the copy the database's owner, group and permission bits",
    async () => {
      const directory = scratch();
      const database = NodePath.join(directory, "state.sqlite");
      const copy = `${database}.doctor-1-2.tmp`;
      NodeFS.writeFileSync(database, "old");
      NodeFS.chmodSync(database, 0o640);
      NodeFS.writeFileSync(copy, "new");
      NodeFS.chmodSync(copy, 0o644);

      await prepareCopyForSwap(copy, database);

      const copied = NodeFS.statSync(copy);
      const original = NodeFS.statSync(database);
      expect(copied.mode & 0o7777).toBe(0o640);
      expect([copied.uid, copied.gid]).toEqual([original.uid, original.gid]);
    },
  );

  it("renames the copy over the database, and a failed rename leaves the database as it was", async () => {
    const directory = scratch();
    const database = NodePath.join(directory, "state.sqlite");
    const copy = `${database}.doctor-1-2.tmp`;
    NodeFS.writeFileSync(database, "old");

    await expect(swapInCopy(copy, database)).rejects.toThrow();
    expect(NodeFS.readFileSync(database, "utf8")).toBe("old");

    NodeFS.writeFileSync(copy, "new");
    await expect(swapInCopy(copy, database)).resolves.toEqual({ syncError: null });
    expect(NodeFS.readFileSync(database, "utf8")).toBe("new");
    expect(NodeFS.existsSync(copy)).toBe(false);
  });
});
