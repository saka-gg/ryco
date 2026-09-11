import { EnvironmentId, type VcsRef } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  dedupeRemoteBranchesWithLocalMatches,
  deriveLocalBranchNameFromRemoteRef,
  deriveRepositoryWebUrl,
  normalizeGitRemoteToWebUrl,
  resolveEnvironmentOptionLabel,
  resolveBranchSelectionTarget,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  resolveBranchToolbarValue,
  shouldIncludeBranchPickerItem,
} from "./BranchToolbar.logic";

describe("normalizeGitRemoteToWebUrl", () => {
  it("converts scp-like, ssh, git and https remotes to a browsable url", () => {
    expect(normalizeGitRemoteToWebUrl("git@github.com:sak0a/ryco.git")).toBe(
      "https://github.com/sak0a/ryco",
    );
    expect(normalizeGitRemoteToWebUrl("ssh://git@gitlab.com/group/proj.git")).toBe(
      "https://gitlab.com/group/proj",
    );
    expect(normalizeGitRemoteToWebUrl("https://bitbucket.org/team/repo.git")).toBe(
      "https://bitbucket.org/team/repo",
    );
    expect(normalizeGitRemoteToWebUrl("https://user:token@git.example.com/o/r")).toBe(
      "https://git.example.com/o/r",
    );
    expect(normalizeGitRemoteToWebUrl("git@self-hosted.example.com:owner/repo")).toBe(
      "https://self-hosted.example.com/owner/repo",
    );
  });

  it("drops SSH ports from the derived web url", () => {
    expect(normalizeGitRemoteToWebUrl("ssh://git@host.example.com:2222/owner/repo.git")).toBe(
      "https://host.example.com/owner/repo",
    );
  });

  it("rejects local filesystem remotes so callers can fall back", () => {
    expect(normalizeGitRemoteToWebUrl("C:/mirror/repo.git")).toBeNull();
    expect(normalizeGitRemoteToWebUrl("c:\\mirror\\repo")).toBeNull();
    expect(normalizeGitRemoteToWebUrl("\\\\server\\share\\repo")).toBeNull();
  });

  it("returns null for unparseable or bare remotes", () => {
    expect(normalizeGitRemoteToWebUrl("")).toBeNull();
    expect(normalizeGitRemoteToWebUrl("https://github.com/")).toBeNull();
  });
});

describe("deriveRepositoryWebUrl", () => {
  it("prefers the locator remote and falls back to the first parseable remote", () => {
    expect(
      deriveRepositoryWebUrl({
        canonicalKey: "k",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "git@github.com:o/r.git",
        },
        remotes: [],
      }),
    ).toBe("https://github.com/o/r");
    expect(
      deriveRepositoryWebUrl({
        canonicalKey: "k",
        locator: { source: "git-remote", remoteName: "origin", remoteUrl: "not-a-url" },
        remotes: [{ name: "upstream", url: "https://gitlab.com/g/p.git" }],
      }),
    ).toBe("https://gitlab.com/g/p");
  });

  it("returns null when no identity or remote is usable", () => {
    expect(deriveRepositoryWebUrl(null)).toBeNull();
    expect(deriveRepositoryWebUrl(undefined)).toBeNull();
  });
});

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

describe("resolveDraftEnvModeAfterBranchChange", () => {
  it("switches to local mode when returning from an existing worktree to the main worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: "/repo/.ryco/worktrees/feature-a",
        effectiveEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("keeps new-worktree mode when selecting a base ref before worktree creation", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: null,
        effectiveEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("uses worktree mode when selecting a ref already attached to a worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: "/repo/.ryco/worktrees/feature-a",
        currentWorktreePath: null,
        effectiveEnvMode: "local",
      }),
    ).toBe("worktree");
  });
});

describe("resolveBranchToolbarValue", () => {
  it("defaults new-worktree mode to current git ref when no explicit base ref is set", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: null,
        currentGitBranch: "main",
      }),
    ).toBe("main");
  });

  it("keeps an explicitly selected worktree base ref", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBe("feature/base");
  });

  it("shows the actual checked-out ref when not selecting a new worktree base", () => {
    expect(
      resolveBranchToolbarValue({
        envMode: "local",
        activeWorktreePath: null,
        activeThreadBranch: "feature/base",
        currentGitBranch: "main",
      }),
    ).toBe("main");
  });
});

describe("resolveEnvironmentOptionLabel", () => {
  it("prefers the primary environment's machine label", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: localEnvironmentId,
        runtimeLabel: "Julius's Mac mini",
        savedLabel: "Local environment",
      }),
    ).toBe("Julius's Mac mini");
  });

  it("falls back to 'This device' for generic primary labels", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: localEnvironmentId,
        runtimeLabel: "Local environment",
        savedLabel: "Local",
      }),
    ).toBe("Device connecting…");
  });

  it("keeps configured labels for non-primary environments", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: false,
        environmentId: remoteEnvironmentId,
        runtimeLabel: null,
        savedLabel: "Build box",
      }),
    ).toBe("Build box");
  });
});

describe("resolveEffectiveEnvMode", () => {
  it("treats draft threads already attached to a worktree as current-checkout mode", () => {
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: "/repo/.ryco/worktrees/feature-a",
        hasServerThread: false,
        draftThreadEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("keeps explicit new-worktree mode for draft threads without a worktree path", () => {
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: null,
        hasServerThread: false,
        draftThreadEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });
});

describe("deriveLocalBranchNameFromRemoteRef", () => {
  it("strips the remote prefix from a remote ref", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/feature/demo")).toBe("feature/demo");
  });

  it("supports remote names that contain slashes", () => {
    expect(deriveLocalBranchNameFromRemoteRef("my-org/upstream/feature/demo")).toBe(
      "upstream/feature/demo",
    );
  });

  it("returns the original name when ref is malformed", () => {
    expect(deriveLocalBranchNameFromRemoteRef("origin/")).toBe("origin/");
    expect(deriveLocalBranchNameFromRemoteRef("/feature/demo")).toBe("/feature/demo");
  });
});

describe("dedupeRemoteBranchesWithLocalMatches", () => {
  it("hides remote refs when the matching local ref exists", () => {
    const input: VcsRef[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/demo",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/demo",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps all entries when no local match exists for a remote ref", () => {
    const input: VcsRef[] = [
      {
        name: "feature/local",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/local",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps non-origin remote refs visible even when a matching local ref exists", () => {
    const input: VcsRef[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature/demo",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/demo",
      "my-org/upstream/feature/demo",
    ]);
  });

  it("keeps non-origin remote refs visible when git tracks with first-slash local naming", () => {
    const input: VcsRef[] = [
      {
        name: "upstream/feature",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "upstream/feature",
      "my-org/upstream/feature",
    ]);
  });
});

describe("resolveBranchSelectionTarget", () => {
  it("reuses an existing secondary worktree for the selected ref", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.ryco/worktrees/feature-a",
        refName: {
          isDefault: false,
          worktreePath: "/repo/.ryco/worktrees/feature-b",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.ryco/worktrees/feature-b",
      nextWorktreePath: "/repo/.ryco/worktrees/feature-b",
      reuseExistingWorktree: true,
    });
  });

  it("switches back to the main repo when the ref already lives there", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.ryco/worktrees/feature-a",
        refName: {
          isDefault: true,
          worktreePath: "/repo",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: true,
    });
  });

  it("checks out the default ref in the main repo when leaving a secondary worktree", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.ryco/worktrees/feature-a",
        refName: {
          isDefault: true,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: false,
    });
  });

  it("keeps checkout in the current worktree for non-default refs", () => {
    expect(
      resolveBranchSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.ryco/worktrees/feature-a",
        refName: {
          isDefault: false,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.ryco/worktrees/feature-a",
      nextWorktreePath: "/repo/.ryco/worktrees/feature-a",
      reuseExistingWorktree: false,
    });
  });
});

describe("shouldIncludeBranchPickerItem", () => {
  it("keeps the synthetic checkout PR item visible for gh pr checkout input", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "__checkout_pull_request__:1359",
        normalizedQuery: "gh pr checkout 1359",
        createBranchItemValue: "__create_new_branch__:gh pr checkout 1359",
        checkoutPullRequestItemValue: "__checkout_pull_request__:1359",
      }),
    ).toBe(true);
  });

  it("keeps the synthetic create-ref item visible for arbitrary ref input", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "__create_new_branch__:feature/demo",
        normalizedQuery: "feature/demo",
        createBranchItemValue: "__create_new_branch__:feature/demo",
        checkoutPullRequestItemValue: null,
      }),
    ).toBe(true);
  });

  it("still filters ordinary ref items by query text", () => {
    expect(
      shouldIncludeBranchPickerItem({
        itemValue: "main",
        normalizedQuery: "gh pr checkout 1359",
        createBranchItemValue: "__create_new_branch__:gh pr checkout 1359",
        checkoutPullRequestItemValue: "__checkout_pull_request__:1359",
      }),
    ).toBe(false);
  });
});
