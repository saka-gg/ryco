import { EnvironmentId, type VcsListRefsResult } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { listRefsSpy, resolvePullRequestSpy } = vi.hoisted(() => ({
  listRefsSpy: vi.fn(),
  resolvePullRequestSpy: vi.fn(),
}));

vi.mock("../environmentApi", () => ({
  readEnvironmentApi: () => ({
    vcs: { listRefs: listRefsSpy },
    git: { resolvePullRequest: resolvePullRequestSpy },
  }),
}));

import { appAtomRegistry, resetAppAtomRegistryForTests } from "@ryco/client-runtime/rpc";
import {
  beginMutationTracking,
  clearGitAtomStateForEnvironment,
  endMutationTracking,
  fetchNextBranchesPage,
  getBranchesSnapshot,
  getBranchesTargetKey,
  getMutationRunningAtom,
  getResolvePullRequestSnapshot,
  getResolvePullRequestTargetKey,
  gitScopeKey,
  invalidateScopes,
  prefetchBranches,
  projectScopeKey,
  resetGitAtomsForTests,
  subscribeInvalidationScope,
  watchBranches,
  watchResolvePullRequest,
} from "./gitAtoms";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");

function makeRefsPage(cursor: number): VcsListRefsResult {
  return {
    refs: [],
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: cursor === 0 ? 1 : null,
    totalCount: 2,
  };
}

async function flush(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

afterEach(() => {
  resetGitAtomsForTests();
  resetAppAtomRegistryForTests();
  listRefsSpy.mockReset();
  resolvePullRequestSpy.mockReset();
});

describe("scope keys", () => {
  it("builds scoped invalidation keys per cwd", () => {
    expect(gitScopeKey("/repo")).toBe("git:/repo");
    expect(projectScopeKey("/repo")).toBe("project:/repo");
    expect(gitScopeKey(null)).toBe("git:");
  });
});

describe("invalidateScopes", () => {
  it("only notifies listeners subscribed to the invalidated scope", () => {
    const repoA = vi.fn();
    const repoB = vi.fn();
    const unsubscribeA = subscribeInvalidationScope(gitScopeKey("/repo/a"), repoA);
    const unsubscribeB = subscribeInvalidationScope(gitScopeKey("/repo/b"), repoB);

    invalidateScopes([gitScopeKey("/repo/a")]);

    expect(repoA).toHaveBeenCalledTimes(1);
    expect(repoB).not.toHaveBeenCalled();

    unsubscribeA();
    unsubscribeB();
  });

  it("notifies each matching listener once even with duplicate scopes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInvalidationScope(gitScopeKey("/repo"), listener);

    invalidateScopes([gitScopeKey("/repo"), gitScopeKey("/repo")]);

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe("mutation running tracker", () => {
  it("counts in-flight mutations per key", () => {
    const key = "git-mutation:pull:env:/repo";
    expect(appAtomRegistry.get(getMutationRunningAtom(key))).toBe(0);

    beginMutationTracking(key);
    beginMutationTracking(key);
    expect(appAtomRegistry.get(getMutationRunningAtom(key))).toBe(2);

    endMutationTracking(key);
    expect(appAtomRegistry.get(getMutationRunningAtom(key))).toBe(1);

    endMutationTracking(key);
    expect(appAtomRegistry.get(getMutationRunningAtom(key))).toBe(0);
  });

  it("never drops below zero", () => {
    const key = "git-mutation:pull:env:/other";
    endMutationTracking(key);
    expect(appAtomRegistry.get(getMutationRunningAtom(key))).toBe(0);
  });
});

describe("branch search atoms", () => {
  it("loads the first page when a target is watched and paginates", async () => {
    listRefsSpy.mockImplementation(async (input: { cursor?: number }) =>
      makeRefsPage(input.cursor ?? 0),
    );
    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo", query: "" };
    const key = getBranchesTargetKey(target);

    const release = watchBranches(target);
    await flush();

    expect(getBranchesSnapshot(key).pages).toHaveLength(1);
    expect(getBranchesSnapshot(key).isPending).toBe(false);

    fetchNextBranchesPage(key);
    await flush();

    expect(getBranchesSnapshot(key).pages).toHaveLength(2);
    expect(listRefsSpy).toHaveBeenCalledTimes(2);

    release();
  });

  it("refetches the watched branch list when its git scope is invalidated", async () => {
    listRefsSpy.mockImplementation(async (input: { cursor?: number }) =>
      makeRefsPage(input.cursor ?? 0),
    );
    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo", query: "" };

    const release = watchBranches(target);
    await flush();
    listRefsSpy.mockClear();

    invalidateScopes([gitScopeKey("/repo")]);
    await flush();

    expect(listRefsSpy).toHaveBeenCalledTimes(1);
    release();
  });

  it("keeps branch invalidation scoped to a single cwd", async () => {
    listRefsSpy.mockImplementation(async (input: { cwd: string; cursor?: number }) =>
      makeRefsPage(input.cursor ?? 0),
    );
    const releaseA = watchBranches({ environmentId: ENVIRONMENT_A, cwd: "/repo/a", query: "" });
    const releaseB = watchBranches({ environmentId: ENVIRONMENT_B, cwd: "/repo/b", query: "" });
    await flush();
    listRefsSpy.mockClear();

    invalidateScopes([gitScopeKey("/repo/a")]);
    await flush();

    expect(listRefsSpy).toHaveBeenCalledTimes(1);
    expect(listRefsSpy).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/repo/a" }));

    releaseA();
    releaseB();
  });

  it("resets a reused branch atom on every lifecycle clear", async () => {
    listRefsSpy.mockResolvedValue(makeRefsPage(0));
    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo/reused", query: "" };
    const key = getBranchesTargetKey(target);

    const releaseFirst = watchBranches(target);
    await flush();
    releaseFirst();
    resetGitAtomsForTests();
    expect(getBranchesSnapshot(key).pages).toHaveLength(0);

    const releaseSecond = watchBranches(target);
    await flush();
    expect(getBranchesSnapshot(key).pages).toHaveLength(1);
    releaseSecond();
    resetGitAtomsForTests();

    expect(getBranchesSnapshot(key).pages).toHaveLength(0);
    expect(getBranchesSnapshot(key).isPending).toBe(true);
  });

  it("shares one listRefs between a prefetch and a watcher of the same key", async () => {
    let resolveRequest!: (value: VcsListRefsResult) => void;
    listRefsSpy.mockReturnValue(
      new Promise<VcsListRefsResult>((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo/shared", query: "" };
    const key = getBranchesTargetKey(target);

    prefetchBranches(target);
    const release = watchBranches(target);
    await flush();
    expect(listRefsSpy).toHaveBeenCalledTimes(1);

    resolveRequest(makeRefsPage(0));
    await flush();
    expect(listRefsSpy).toHaveBeenCalledTimes(1);
    expect(getBranchesSnapshot(key).pages).toHaveLength(1);
    expect(getBranchesSnapshot(key).isPending).toBe(false);
    release();
  });

  it("adopts a fresh list when a watcher remounts instead of refetching it", async () => {
    listRefsSpy.mockImplementation(async (input: { cursor?: number }) =>
      makeRefsPage(input.cursor ?? 0),
    );
    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo/remount", query: "" };
    const key = getBranchesTargetKey(target);

    const releaseFirst = watchBranches(target);
    await flush();
    expect(listRefsSpy).toHaveBeenCalledTimes(1);
    releaseFirst();

    const releaseSecond = watchBranches(target);
    await flush();
    expect(listRefsSpy).toHaveBeenCalledTimes(1);
    expect(getBranchesSnapshot(key).pages).toHaveLength(1);
    releaseSecond();
  });

  it("refetches on remount once the list is stale or its scope was invalidated", async () => {
    listRefsSpy.mockImplementation(async (input: { cursor?: number }) =>
      makeRefsPage(input.cursor ?? 0),
    );
    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo/stale", query: "" };

    const releaseFirst = watchBranches(target);
    await flush();
    releaseFirst();
    invalidateScopes([gitScopeKey("/repo/stale")]);
    const releaseSecond = watchBranches(target);
    await flush();
    expect(listRefsSpy).toHaveBeenCalledTimes(2);
    releaseSecond();

    const now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    try {
      const releaseThird = watchBranches(target);
      await flush();
      expect(listRefsSpy).toHaveBeenCalledTimes(3);
      releaseThird();
    } finally {
      dateNow.mockRestore();
    }
  });

  it("does not vouch for a first page whose watcher left before it arrived", async () => {
    listRefsSpy.mockImplementation(async (input: { cursor?: number }) =>
      makeRefsPage(input.cursor ?? 0),
    );
    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo/dropped", query: "" };

    const releaseFirst = watchBranches(target);
    await flush();
    releaseFirst();

    const now = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    try {
      // The list is stale now; this watcher's refetch is dropped with it.
      let resolveRequest!: (value: VcsListRefsResult) => void;
      listRefsSpy.mockReturnValueOnce(
        new Promise<VcsListRefsResult>((resolve) => {
          resolveRequest = resolve;
        }),
      );
      const releaseSecond = watchBranches(target);
      await flush();
      expect(listRefsSpy).toHaveBeenCalledTimes(2);
      releaseSecond();
      resolveRequest(makeRefsPage(0));
      await flush();

      // The cached pages are still the stale ones, so a new watcher refetches.
      const releaseThird = watchBranches(target);
      await flush();
      expect(listRefsSpy).toHaveBeenCalledTimes(3);
      releaseThird();
    } finally {
      dateNow.mockRestore();
    }
  });

  it("clears a next-page load the previous watcher left in flight when adopting the list", async () => {
    listRefsSpy.mockImplementation(async (input: { cursor?: number }) =>
      makeRefsPage(input.cursor ?? 0),
    );
    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo/next-page", query: "" };
    const key = getBranchesTargetKey(target);

    const releaseFirst = watchBranches(target);
    await flush();
    listRefsSpy.mockReturnValueOnce(new Promise<VcsListRefsResult>(() => undefined));
    fetchNextBranchesPage(key);
    expect(getBranchesSnapshot(key).isFetchingNextPage).toBe(true);
    releaseFirst();

    const releaseSecond = watchBranches(target);
    await flush();
    expect(listRefsSpy).toHaveBeenCalledTimes(2);
    expect(getBranchesSnapshot(key).isFetchingNextPage).toBe(false);
    fetchNextBranchesPage(key);
    await flush();
    expect(listRefsSpy).toHaveBeenCalledTimes(3);
    expect(getBranchesSnapshot(key).pages).toHaveLength(2);
    releaseSecond();
  });

  it("ignores a branch response that settles after its watcher is cleared", async () => {
    let resolveRequest!: (value: VcsListRefsResult) => void;
    listRefsSpy.mockReturnValue(
      new Promise<VcsListRefsResult>((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo/late", query: "" };
    const key = getBranchesTargetKey(target);

    const release = watchBranches(target);
    release();
    resetGitAtomsForTests();
    resolveRequest(makeRefsPage(0));
    await flush();

    expect(getBranchesSnapshot(key).pages).toHaveLength(0);
    expect(getBranchesSnapshot(key).isPending).toBe(true);
  });
});

describe("resolve pull request atoms", () => {
  it("resolves a reference and exposes the cached snapshot", async () => {
    const pullRequest = {
      number: 7,
      title: "Add feature",
      state: "open" as const,
      headBranch: "feature",
      baseBranch: "main",
      url: "https://example.test/pr/7",
    };
    resolvePullRequestSpy.mockResolvedValue({ pullRequest });

    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo", reference: "7" };
    const key = getResolvePullRequestTargetKey(target);

    const release = watchResolvePullRequest(target);
    await flush();

    const snapshot = getResolvePullRequestSnapshot(key);
    expect(snapshot.data).toEqual({ pullRequest });
    expect(snapshot.isPending).toBe(false);
    expect(snapshot.isFetching).toBe(false);
    expect(snapshot.isError).toBe(false);

    release();
  });

  it("captures resolution errors", async () => {
    resolvePullRequestSpy.mockRejectedValue(new Error("not found"));

    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo", reference: "999" };
    const key = getResolvePullRequestTargetKey(target);

    const release = watchResolvePullRequest(target);
    await flush();

    const snapshot = getResolvePullRequestSnapshot(key);
    expect(snapshot.data).toBeNull();
    expect(snapshot.isError).toBe(true);
    expect(snapshot.error?.message).toBe("not found");

    release();
  });

  it("resets a reused pull request atom on every lifecycle clear", async () => {
    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo/reused", reference: "7" };
    const key = getResolvePullRequestTargetKey(target);
    resolvePullRequestSpy.mockResolvedValue({ pullRequest: null });

    const releaseFirst = watchResolvePullRequest(target);
    await flush();
    releaseFirst();
    resetGitAtomsForTests();

    const releaseSecond = watchResolvePullRequest(target);
    await flush();
    expect(getResolvePullRequestSnapshot(key).data).toEqual({ pullRequest: null });
    releaseSecond();
    resetGitAtomsForTests();

    expect(getResolvePullRequestSnapshot(key)).toEqual({
      data: null,
      isPending: false,
      isFetching: false,
      isError: false,
      error: null,
    });
  });
});

describe("clearGitAtomStateForEnvironment", () => {
  const PULL_REQUEST = {
    number: 7,
    title: "Add feature",
    state: "open" as const,
    headBranch: "feature",
    baseBranch: "main",
    url: "https://example.test/pr/7",
  };

  it("resets one environment's branch state and keeps the other's", async () => {
    listRefsSpy.mockImplementation(async (input: { cursor?: number }) =>
      makeRefsPage(input.cursor ?? 0),
    );
    const targetA = { environmentId: ENVIRONMENT_A, cwd: "/repo", query: "" };
    const targetB = { environmentId: ENVIRONMENT_B, cwd: "/repo", query: "" };
    const keyA = getBranchesTargetKey(targetA);
    const keyB = getBranchesTargetKey(targetB);
    const releaseA = watchBranches(targetA);
    const releaseB = watchBranches(targetB);
    await flush();
    expect(getBranchesSnapshot(keyA).pages).toHaveLength(1);
    expect(getBranchesSnapshot(keyB).pages).toHaveLength(1);

    clearGitAtomStateForEnvironment(ENVIRONMENT_A);

    expect(getBranchesSnapshot(keyA).pages).toHaveLength(0);
    expect(getBranchesSnapshot(keyA).isPending).toBe(true);
    expect(getBranchesSnapshot(keyB).pages).toHaveLength(1);

    // Only the surviving environment still has a watcher to refetch.
    listRefsSpy.mockClear();
    invalidateScopes([gitScopeKey("/repo")]);
    await flush();
    expect(listRefsSpy).toHaveBeenCalledTimes(1);

    releaseA();
    releaseB();
  });

  it("resets one environment's pull request state and keeps the other's", async () => {
    resolvePullRequestSpy.mockResolvedValue({ pullRequest: PULL_REQUEST });
    const targetA = { environmentId: ENVIRONMENT_A, cwd: "/repo", reference: "7" };
    const targetB = { environmentId: ENVIRONMENT_B, cwd: "/repo", reference: "7" };
    const keyA = getResolvePullRequestTargetKey(targetA);
    const keyB = getResolvePullRequestTargetKey(targetB);
    const releaseA = watchResolvePullRequest(targetA);
    const releaseB = watchResolvePullRequest(targetB);
    await flush();

    clearGitAtomStateForEnvironment(ENVIRONMENT_A);

    expect(getResolvePullRequestSnapshot(keyA)).toEqual({
      data: null,
      isPending: false,
      isFetching: false,
      isError: false,
      error: null,
    });
    expect(getResolvePullRequestSnapshot(keyB).data).toEqual({ pullRequest: PULL_REQUEST });

    releaseA();
    releaseB();
  });

  it("ignores responses that settle after the clear and keeps the other environment's", async () => {
    const pending = new Map<string, (value: VcsListRefsResult) => void>();
    listRefsSpy.mockImplementation(
      (input: { cwd: string }) =>
        new Promise<VcsListRefsResult>((resolve) => {
          pending.set(input.cwd, resolve);
        }),
    );
    const watched = { environmentId: ENVIRONMENT_A, cwd: "/repo/watched", query: "" };
    const prefetchedA = { environmentId: ENVIRONMENT_A, cwd: "/repo/prefetch-a", query: "" };
    const prefetchedB = { environmentId: ENVIRONMENT_B, cwd: "/repo/prefetch-b", query: "" };
    const release = watchBranches(watched);
    prefetchBranches(prefetchedA);
    prefetchBranches(prefetchedB);
    await flush();
    expect(pending.size).toBe(3);

    clearGitAtomStateForEnvironment(ENVIRONMENT_A);
    for (const resolve of pending.values()) resolve(makeRefsPage(0));
    await flush();

    expect(getBranchesSnapshot(getBranchesTargetKey(watched)).pages).toHaveLength(0);
    expect(getBranchesSnapshot(getBranchesTargetKey(prefetchedA)).pages).toHaveLength(0);
    expect(getBranchesSnapshot(getBranchesTargetKey(prefetchedB)).pages).toHaveLength(1);
    release();
  });

  it("ignores a pull request response that settles after the clear", async () => {
    let resolveRequest!: (value: unknown) => void;
    resolvePullRequestSpy.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo/late", reference: "7" };
    const key = getResolvePullRequestTargetKey(target);
    const release = watchResolvePullRequest(target);

    clearGitAtomStateForEnvironment(ENVIRONMENT_A);
    resolveRequest({ pullRequest: PULL_REQUEST });
    await flush();

    expect(getResolvePullRequestSnapshot(key).data).toBeNull();
    expect(getResolvePullRequestSnapshot(key).isFetching).toBe(false);
    release();
  });

  it("does not let a later watcher adopt a list read before the clear", async () => {
    listRefsSpy.mockImplementation(async (input: { cursor?: number }) =>
      makeRefsPage(input.cursor ?? 0),
    );
    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo/adopt", query: "" };
    const key = getBranchesTargetKey(target);
    const releaseFirst = watchBranches(target);
    await flush();
    releaseFirst();

    clearGitAtomStateForEnvironment(ENVIRONMENT_A);
    const releaseSecond = watchBranches(target);
    await flush();

    expect(listRefsSpy).toHaveBeenCalledTimes(2);
    expect(getBranchesSnapshot(key).pages).toHaveLength(1);
    releaseSecond();
  });

  it("resets a reused key on every clear", async () => {
    listRefsSpy.mockResolvedValue(makeRefsPage(0));
    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo/reused", query: "" };
    const key = getBranchesTargetKey(target);

    for (let round = 0; round < 2; round += 1) {
      const release = watchBranches(target);
      await flush();
      expect(getBranchesSnapshot(key).pages).toHaveLength(1);
      release();
      clearGitAtomStateForEnvironment(ENVIRONMENT_A);
      expect(getBranchesSnapshot(key).pages).toHaveLength(0);
    }
  });

  it("keeps a newer branch watcher registered when a release from before the clear arrives", async () => {
    listRefsSpy.mockImplementation(async (input: { cursor?: number }) =>
      makeRefsPage(input.cursor ?? 0),
    );
    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo/stale", query: "" };
    const releaseStale = watchBranches(target);
    await flush();
    clearGitAtomStateForEnvironment(ENVIRONMENT_A);
    const releaseCurrent = watchBranches(target);
    await flush();

    releaseStale();
    // The newer watcher is still registered, so a later clear stops it.
    clearGitAtomStateForEnvironment(ENVIRONMENT_A);
    listRefsSpy.mockClear();
    invalidateScopes([gitScopeKey("/repo/stale")]);
    await flush();

    expect(listRefsSpy).not.toHaveBeenCalled();
    releaseCurrent();
  });

  it("keeps a newer pull request watcher registered when a release from before the clear arrives", async () => {
    let resolveRequest!: (value: unknown) => void;
    resolvePullRequestSpy.mockResolvedValueOnce({ pullRequest: PULL_REQUEST });
    resolvePullRequestSpy.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    );
    const target = { environmentId: ENVIRONMENT_A, cwd: "/repo/stale", reference: "7" };
    const key = getResolvePullRequestTargetKey(target);
    const releaseStale = watchResolvePullRequest(target);
    await flush();
    clearGitAtomStateForEnvironment(ENVIRONMENT_A);
    const releaseCurrent = watchResolvePullRequest(target);

    releaseStale();
    // The newer watcher is still registered, so a later clear fences its read.
    clearGitAtomStateForEnvironment(ENVIRONMENT_A);
    resolveRequest({ pullRequest: PULL_REQUEST });
    await flush();

    expect(getResolvePullRequestSnapshot(key).data).toBeNull();
    releaseCurrent();
  });

  it("leaves invalidation listeners and mutation counts alone", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeInvalidationScope(gitScopeKey("/repo"), listener);
    const key = "git-mutation:pull:environment-a:/repo";
    beginMutationTracking(key);

    clearGitAtomStateForEnvironment(ENVIRONMENT_A);

    invalidateScopes([gitScopeKey("/repo")]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(appAtomRegistry.get(getMutationRunningAtom(key))).toBe(1);

    endMutationTracking(key);
    unsubscribe();
  });
});
