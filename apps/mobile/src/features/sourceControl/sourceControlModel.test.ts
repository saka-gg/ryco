import { describe, expect, it } from "vite-plus/test";

import type { VcsStatusResult } from "@ryco/contracts";

import {
  sourceControlActionAvailability,
  sourceControlStatusLine,
  sourceControlSyncLine,
} from "./sourceControlModel";

const status = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/mobile-source-control",
  hasWorkingTreeChanges: true,
  workingTree: { files: [], insertions: 2, deletions: 1 },
  committed: { files: [], insertions: 4, deletions: 0 },
  hasUpstream: true,
  aheadCount: 2,
  behindCount: 1,
  aheadOfDefaultCount: 2,
  pr: null,
} satisfies VcsStatusResult;

describe("mobile source control model", () => {
  it("enables only actions supported by the exact repository state", () => {
    expect(sourceControlActionAvailability(status, true)).toEqual({
      canCommit: true,
      canPull: true,
      canPush: true,
      canCreatePullRequest: true,
    });
    expect(sourceControlActionAvailability(status, false)).toEqual({
      canCommit: false,
      canPull: false,
      canPush: false,
      canCreatePullRequest: false,
    });
  });

  it("keeps the branch, synchronization state, and pull request visible", () => {
    expect(sourceControlStatusLine(status)).toBe(
      "feature/mobile-source-control · 2 ahead · 1 behind",
    );
    expect(
      sourceControlStatusLine({
        ...status,
        pr: {
          number: 42,
          title: "Mobile source control",
          url: "https://example.test/pull/42",
          baseRef: "main",
          headRef: "feature/mobile-source-control",
          state: "open",
        },
      }),
    ).toContain("PR #42 open");
  });

  it("leaves the branch to the chip and says when nothing is out of sync", () => {
    expect(sourceControlSyncLine(status)).toBe("2 ahead · 1 behind");
    expect(sourceControlSyncLine({ ...status, aheadCount: 0, behindCount: 0 })).toBe("Up to date");
    expect(
      sourceControlSyncLine({ ...status, aheadCount: 0, behindCount: 0, hasUpstream: false }),
    ).toBe("Not pushed yet");
  });
});
