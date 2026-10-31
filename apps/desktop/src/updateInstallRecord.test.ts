import * as FS from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DESKTOP_UPDATE_INSTALL_RECORD_FILE,
  parseDesktopUpdateInstallRecord,
  resolveDesktopUpdateInstallOutcome,
  settleDesktopUpdateInstallRecord,
  writeDesktopUpdateInstallRecord,
} from "./updateInstallRecord.ts";

const directories: string[] = [];

function recordPath(): string {
  const directory = FS.mkdtempSync(join(tmpdir(), "ryco-update-install-"));
  directories.push(directory);
  return join(directory, DESKTOP_UPDATE_INSTALL_RECORD_FILE);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("updateInstallRecord", () => {
  it("reads back what the quit wrote, and rejects anything else", () => {
    const record = { fromVersion: "1.0.0", targetVersion: "1.1.0" };
    expect(parseDesktopUpdateInstallRecord(JSON.stringify(record))).toEqual(record);
    for (const text of [
      "",
      "not json",
      "[]",
      "null",
      JSON.stringify({ fromVersion: "1.0.0" }),
      JSON.stringify({ fromVersion: "1.0.0", targetVersion: 1 }),
      JSON.stringify({ fromVersion: "1.0.0", targetVersion: "1.0.0" }),
      JSON.stringify({ fromVersion: "1.0.0", targetVersion: "x".repeat(300) }),
    ]) {
      expect(parseDesktopUpdateInstallRecord(text)).toBeNull();
    }
  });

  it("tells an update that took effect from one that did not apply", () => {
    const record = { fromVersion: "1.0.0", targetVersion: "1.1.0" };
    expect(resolveDesktopUpdateInstallOutcome(record, "1.1.0")).toEqual({
      kind: "updated",
      fromVersion: "1.0.0",
      version: "1.1.0",
    });
    expect(resolveDesktopUpdateInstallOutcome(record, "1.0.0")).toEqual({
      kind: "not-applied",
      version: "1.1.0",
    });
    expect(resolveDesktopUpdateInstallOutcome(record, "1.2.0")).toEqual({ kind: "none" });
    expect(resolveDesktopUpdateInstallOutcome(null, "1.1.0")).toEqual({ kind: "none" });
  });

  it("says Updated to X once on the next launch, then forgets the record", () => {
    const path = recordPath();
    expect(
      writeDesktopUpdateInstallRecord(path, { fromVersion: "1.0.0", targetVersion: "1.1.0" }),
    ).toBe(true);
    expect(settleDesktopUpdateInstallRecord(path, "1.1.0")).toEqual({
      kind: "updated",
      fromVersion: "1.0.0",
      version: "1.1.0",
    });
    expect(FS.existsSync(path)).toBe(false);
    expect(settleDesktopUpdateInstallRecord(path, "1.1.0")).toEqual({ kind: "none" });
  });

  it("keeps the record while its install did not apply, and drops a stale or broken one", () => {
    const path = recordPath();
    writeDesktopUpdateInstallRecord(path, { fromVersion: "1.0.0", targetVersion: "1.1.0" });
    expect(settleDesktopUpdateInstallRecord(path, "1.0.0")).toEqual({
      kind: "not-applied",
      version: "1.1.0",
    });
    // A later launch on the same version still knows.
    expect(settleDesktopUpdateInstallRecord(path, "1.0.0").kind).toBe("not-applied");
    // Updated by hand to something else: stale.
    expect(settleDesktopUpdateInstallRecord(path, "1.2.0")).toEqual({ kind: "none" });
    expect(FS.existsSync(path)).toBe(false);
    FS.writeFileSync(path, "{");
    expect(settleDesktopUpdateInstallRecord(path, "1.0.0")).toEqual({ kind: "none" });
    expect(FS.existsSync(path)).toBe(false);
  });

  it("reports a record it cannot write instead of throwing into the quit", () => {
    const path = recordPath();
    // A directory where the file should go makes the rename fail.
    FS.mkdirSync(path);
    expect(
      writeDesktopUpdateInstallRecord(path, { fromVersion: "1.0.0", targetVersion: "1.1.0" }),
    ).toBe(false);
  });
});
