import type { EnvironmentApi, EnvironmentId, ProjectId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  prefetchWorktreeSend,
  resetWorktreeSendPrefetchForTests,
  WORKTREE_SEND_PREFETCH_INTERVAL_MS,
} from "./worktreeSendPrefetch";

const environmentId = "environment-prefetch" as EnvironmentId;
const projectId = "project-prefetch" as ProjectId;

function fakeApi(prefetchWorktreeBase: (input: unknown) => Promise<void>) {
  return {
    vcs: { prefetchWorktreeBase: vi.fn(prefetchWorktreeBase) },
    server: { getProjectPreferences: vi.fn(async () => null) },
  };
}

afterEach(() => {
  resetWorktreeSendPrefetchForTests();
});

describe("prefetchWorktreeSend", () => {
  it("asks the node to fetch the base once per interval", () => {
    let nowMs = 0;
    const api = fakeApi(async () => undefined);
    const prefetch = () =>
      prefetchWorktreeSend({
        environmentId,
        projectId,
        cwd: "/repo",
        refName: "origin/main",
        now: () => nowMs,
        readApi: () => api as unknown as EnvironmentApi,
      });

    prefetch();
    prefetch();
    expect(api.vcs.prefetchWorktreeBase).toHaveBeenCalledOnce();
    expect(api.vcs.prefetchWorktreeBase).toHaveBeenCalledWith({
      cwd: "/repo",
      refName: "origin/main",
    });
    nowMs += WORKTREE_SEND_PREFETCH_INTERVAL_MS;
    prefetch();
    expect(api.vcs.prefetchWorktreeBase).toHaveBeenCalledTimes(2);
  });

  it("stops asking a node that does not know the request", async () => {
    let nowMs = 0;
    const api = fakeApi(async () => {
      throw new Error("Unknown request tag: vcs.prefetchWorktreeBase");
    });
    const prefetch = (refName: string) =>
      prefetchWorktreeSend({
        environmentId,
        projectId,
        cwd: "/repo",
        refName,
        now: () => nowMs,
        readApi: () => api as unknown as EnvironmentApi,
      });

    prefetch("origin/main");
    await vi.waitFor(() => expect(api.vcs.prefetchWorktreeBase).toHaveBeenCalledOnce());
    await Promise.resolve();
    prefetch("origin/other");
    expect(api.vcs.prefetchWorktreeBase).toHaveBeenCalledOnce();
  });
});
