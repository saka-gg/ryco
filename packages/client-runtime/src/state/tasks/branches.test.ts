import type { VcsListRefsInput, VcsListRefsResult } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { nextFreeTaskBranch, readTaskRefNames } from "./branches.ts";

const refs = (names: ReadonlyArray<{ name: string; isRemote?: boolean; remoteName?: string }>) =>
  ({ refs: names }) as unknown as VcsListRefsResult;

describe("nextFreeTaskBranch", () => {
  it("moves past the task's branches that exist already, remote ones included", async () => {
    const listRefs = vi.fn(async (_input: VcsListRefsInput) =>
      refs([
        { name: "task/fix-queue" },
        { name: "origin/task/fix-queue-2", isRemote: true, remoteName: "origin" },
      ]),
    );
    await expect(
      nextFreeTaskBranch({ listRefs }, { cwd: "/repo", title: "Fix the queue", startBranches: [] }),
    ).resolves.toBe("task/fix-queue-3");
    expect(listRefs).toHaveBeenCalledWith({
      cwd: "/repo",
      query: "task/fix-queue",
      limit: 100,
    });
  });

  it("keeps the plain name when the check fails, throws or takes too long", async () => {
    const title = "Fix the queue";
    await expect(
      nextFreeTaskBranch(
        { listRefs: () => Promise.reject(new Error("offline")) },
        { cwd: "/repo", title, startBranches: [] },
      ),
    ).resolves.toBe("task/fix-queue");
    await expect(
      readTaskRefNames(
        {
          listRefs: () => {
            throw new Error("no method");
          },
        },
        "/repo",
        title,
      ),
    ).resolves.toEqual([]);
    vi.useFakeTimers();
    const slow = readTaskRefNames({ listRefs: () => new Promise(() => {}) }, "/repo", title, 50);
    await vi.advanceTimersByTimeAsync(50);
    await expect(slow).resolves.toEqual([]);
    vi.useRealTimers();
  });
});
