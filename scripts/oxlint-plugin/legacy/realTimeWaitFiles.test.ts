import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { REAL_TIME_WAIT_LEGACY_FILES } from "./realTimeWaitFiles.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("the real-time wait legacy list", () => {
  it("names only test files that still exist", () => {
    const missing = REAL_TIME_WAIT_LEGACY_FILES.filter((file) => !existsSync(`${repoRoot}${file}`));
    expect(missing, "remove these from realTimeWaitFiles.ts").toEqual([]);
    for (const file of REAL_TIME_WAIT_LEGACY_FILES) {
      expect(file).toMatch(/\.(?:test|spec)\.[cm]?[jt]sx?$/u);
    }
  });

  it("is sorted and has no duplicates, so a change to it is one line", () => {
    expect([...new Set(REAL_TIME_WAIT_LEGACY_FILES)].toSorted()).toEqual([
      ...REAL_TIME_WAIT_LEGACY_FILES,
    ]);
  });
});
