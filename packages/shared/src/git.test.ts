import type { VcsStatusRemoteResult, VcsStatusResult } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyGitStatusStreamEvent,
  buildTemporaryWorktreeBranchName,
  buildGeneratedWorktreeBranchName,
  extractTemporaryWorktreeBranchPrefix,
  isManagedWorktreeBranch,
  isTemporaryWorktreeBranch,
  normalizeGitRemoteUrl,
  parseGitHubRepositoryNameWithOwnerFromRemoteUrl,
  WORKTREE_BRANCH_PREFIX,
} from "./git.ts";

describe("normalizeGitRemoteUrl", () => {
  it("canonicalizes equivalent GitHub remotes across protocol variants", () => {
    expect(normalizeGitRemoteUrl("git@github.com:Ryco/Ryco.git")).toBe("github.com/ryco/ryco");
    expect(normalizeGitRemoteUrl("https://github.com/Ryco/Ryco.git")).toBe("github.com/ryco/ryco");
    expect(normalizeGitRemoteUrl("ssh://git@github.com/Ryco/Ryco")).toBe("github.com/ryco/ryco");
  });

  it("preserves nested group paths for providers like GitLab", () => {
    expect(normalizeGitRemoteUrl("git@gitlab.com:Ryco/platform/Ryco.git")).toBe(
      "gitlab.com/ryco/platform/ryco",
    );
    expect(normalizeGitRemoteUrl("https://gitlab.com/Ryco/platform/Ryco.git")).toBe(
      "gitlab.com/ryco/platform/ryco",
    );
  });

  it("drops explicit ports from URL-shaped remotes", () => {
    expect(normalizeGitRemoteUrl("https://gitlab.company.com:8443/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
    expect(normalizeGitRemoteUrl("ssh://git@gitlab.company.com:2222/team/project.git")).toBe(
      "gitlab.company.com/team/project",
    );
  });
});

describe("parseGitHubRepositoryNameWithOwnerFromRemoteUrl", () => {
  it("extracts the owner and repository from common GitHub remote shapes", () => {
    expect(parseGitHubRepositoryNameWithOwnerFromRemoteUrl("git@github.com:Ryco/Ryco.git")).toBe(
      "Ryco/Ryco",
    );
    expect(
      parseGitHubRepositoryNameWithOwnerFromRemoteUrl("https://github.com/Ryco/Ryco.git"),
    ).toBe("Ryco/Ryco");
  });
});

describe("isTemporaryWorktreeBranch", () => {
  it("matches the generated temporary worktree refName format", () => {
    expect(isTemporaryWorktreeBranch(buildTemporaryWorktreeBranchName())).toBe(true);
  });

  it("matches generated temporary worktree refs", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef`)).toBe(true);
    expect(isTemporaryWorktreeBranch(` ${WORKTREE_BRANCH_PREFIX}/deadbeef `)).toBe(true);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/DEADBEEF`)).toBe(true);
  });

  it("matches legacy temporary worktree refs so existing drafts can be renamed", () => {
    expect(isTemporaryWorktreeBranch("ryco/deadbeef")).toBe(true);
  });

  it("rejects non-temporary refName names", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/feature/demo`)).toBe(false);
    expect(isTemporaryWorktreeBranch("main")).toBe(false);
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef-extra`)).toBe(false);
  });
});

describe("applyGitStatusStreamEvent", () => {
  it("treats a remote-only update as a repository when local state is missing", () => {
    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(null, { _tag: "remoteUpdated", remote })).toEqual({
      isRepo: true,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });

  it("preserves local-only fields when applying a remote update", () => {
    const current: VcsStatusResult = {
      isRepo: true,
      sourceControlProvider: {
        kind: "github",
        name: "GitHub",
        baseUrl: "https://github.com",
      },
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature/demo",
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "src/demo.ts", insertions: 1, deletions: 0 }],
        insertions: 1,
        deletions: 0,
      },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };

    const remote: VcsStatusRemoteResult = {
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    };

    expect(applyGitStatusStreamEvent(current, { _tag: "remoteUpdated", remote })).toEqual({
      ...current,
      hasUpstream: true,
      aheadCount: 2,
      behindCount: 1,
      pr: null,
    });
  });
});

describe("configurable worktree namespaces", () => {
  it.each(["team/agents", "Team", "", "team.v2"])(
    "generates and recognizes %j temporary branches",
    (prefix) => {
      const branch = buildTemporaryWorktreeBranchName(prefix);
      expect(extractTemporaryWorktreeBranchPrefix(branch, prefix)).toBe(prefix);
      expect(isTemporaryWorktreeBranch(branch, prefix)).toBe(true);
      expect(isManagedWorktreeBranch(branch, prefix)).toBe(true);
      expect(isTemporaryWorktreeBranch("ryco/deadbeef", prefix)).toBe(true);
      expect(extractTemporaryWorktreeBranchPrefix("ryco/deadbeef", prefix)).toBe("ryco");
    },
  );

  it("keeps unrelated namespaces and non-temporary suffixes out", () => {
    expect(isTemporaryWorktreeBranch("someone/deadbeef", "team")).toBe(false);
    expect(isTemporaryWorktreeBranch("team/deadbeef-extra", "team")).toBe(false);
    expect(isTemporaryWorktreeBranch("team/DEADBEEF", "team")).toBe(true);
    expect(extractTemporaryWorktreeBranchPrefix("RYCO/DEADBEEF", "team")).toBe("RYCO");
    expect(isTemporaryWorktreeBranch("teamXv2/deadbeef", "team.v2")).toBe(false);
    expect(isManagedWorktreeBranch("ryco/fix", "team")).toBe(true);
    expect(isManagedWorktreeBranch("team/fix", "team")).toBe(true);
    expect(isManagedWorktreeBranch("teamwork/fix", "team")).toBe(false);
    expect(isManagedWorktreeBranch("main", "")).toBe(false);
    expect(isManagedWorktreeBranch("feature/fix", "")).toBe(false);
  });

  it.each([
    ["refs/heads/ryco/Fix Login", "team/agents", "team/agents/fix-login"],
    ["team/agents/Fix Login", "team/agents", "team/agents/fix-login"],
    ["ryco/Fix Login", "", "fix-login"],
    ["feature/New Login", "Team", "Team/feature/new-login"],
    ["???", "team", "team/update"],
    ["ryco/Fix Login", "ryco", "ryco/fix-login"],
  ])("builds %j using %j", (raw, prefix, expected) => {
    expect(buildGeneratedWorktreeBranchName(raw, prefix)).toBe(expected);
  });

  it("limits generated suffixes to 64 characters without truncating the prefix", () => {
    expect(buildGeneratedWorktreeBranchName("A".repeat(100), "team/agents")).toBe(
      `team/agents/${"a".repeat(64)}`,
    );
  });
});
