import { describe, expect, it } from "vite-plus/test";

import {
  formatProjectOverviewCount,
  formatProjectOverviewHostedCount,
  isProjectOverviewUnhosted,
  NO_HOSTING_PROVIDER_LABEL,
  projectHasGitRemote,
} from "./ProjectOverviewTab.logic";

const identity = {
  canonicalKey: "github.com/example/repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "git@github.com:example/repo.git",
  },
  remotes: [],
};

describe("projectHasGitRemote", () => {
  it("reads the repository identity resolved from the checkout's remotes", () => {
    expect(projectHasGitRemote({ repositoryIdentity: identity })).toBe(true);
    expect(projectHasGitRemote({ repositoryIdentity: null })).toBe(false);
    expect(projectHasGitRemote({})).toBe(false);
    expect(projectHasGitRemote(null)).toBe(false);
  });
});

describe("formatProjectOverviewHostedCount", () => {
  it("says there is no hosting provider instead of a zero count without a remote", () => {
    expect(formatProjectOverviewHostedCount({ hasGitRemote: false, count: 0 })).toBe(
      NO_HOSTING_PROVIDER_LABEL,
    );
    expect(isProjectOverviewUnhosted({ hasGitRemote: false, count: 0 })).toBe(true);
  });

  it("keeps counting with a remote, including zero", () => {
    expect(formatProjectOverviewHostedCount({ hasGitRemote: true, count: 0 })).toBe("0");
    expect(formatProjectOverviewHostedCount({ hasGitRemote: true, count: 3 })).toBe("3");
    expect(formatProjectOverviewHostedCount({ hasGitRemote: true, count: 20 })).toBe("20+");
  });

  it("counts rows that arrived even when the remote snapshot lags", () => {
    expect(formatProjectOverviewHostedCount({ hasGitRemote: false, count: 2 })).toBe("2");
    expect(isProjectOverviewUnhosted({ hasGitRemote: false, count: 2 })).toBe(false);
  });
});

describe("formatProjectOverviewCount", () => {
  it("caps at the list limit", () => {
    expect(formatProjectOverviewCount(19)).toBe("19");
    expect(formatProjectOverviewCount(20)).toBe("20+");
    expect(formatProjectOverviewCount(7, 5)).toBe("5+");
  });
});
