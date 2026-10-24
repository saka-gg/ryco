// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { describeFileHolders, findFileHolders, parseLsofFields } from "./fileHolders.ts";

const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-file-holders-"));
afterAll(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

const supported = process.platform === "darwin" || process.platform === "linux";

describe("fileHolders", () => {
  it("parses lsof's field output into processes", () => {
    expect(
      parseLsofFields("p4154\ncnode\nftxt\nf3\np77\ncDB Browser for SQLite\nf9\np88\nf1\n"),
    ).toEqual([
      { pid: 4154, command: "node" },
      { pid: 77, command: "DB Browser for SQLite" },
      { pid: 88, command: null },
    ]);
    expect(parseLsofFields("")).toEqual([]);
    expect(
      describeFileHolders([
        { pid: 77, command: "sqlite3" },
        { pid: 88, command: null },
      ]),
    ).toBe("pid 77 (sqlite3), pid 88");
  });

  it("is unavailable on other platforms and when no file exists", async () => {
    const path = NodePath.join(directory, "other-platform");
    NodeFS.writeFileSync(path, "x");
    expect((await findFileHolders({ paths: [path], platform: "win32" })).kind).toBe("unavailable");
    expect((await findFileHolders({ paths: [NodePath.join(directory, "missing")] })).kind).toBe(
      "unavailable",
    );
  });

  it.skipIf(!supported)("does not trust an answer that misses this process", async () => {
    // Nobody has the file open, this process included: the answer cannot be checked.
    const path = NodePath.join(directory, "closed");
    NodeFS.writeFileSync(path, "x");
    const result = await findFileHolders({ paths: [path] });
    expect(result.kind).toBe("unavailable");
  });

  it.skipIf(!supported)("lists another process that only holds a descriptor", async () => {
    const path = NodePath.join(directory, "held");
    NodeFS.writeFileSync(path, "x");
    const own = NodeFS.openSync(path, "r");
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require("node:fs").openSync(${JSON.stringify(path)}, "r"); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.stdout.once("data", () => resolve());
      });
      const alone = await findFileHolders({ paths: [path, `${path}-missing`] });
      expect(alone.kind).toBe("checked");
      expect(alone.kind === "checked" ? alone.others.map((holder) => holder.pid) : []).toEqual([
        child.pid,
      ]);
    } finally {
      child.kill("SIGKILL");
      NodeFS.closeSync(own);
    }
  });
});
