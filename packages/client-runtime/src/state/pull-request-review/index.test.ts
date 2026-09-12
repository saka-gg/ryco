import { describe, expect, it, vi } from "vitest";

import { createPullRequestReviewController, type PullRequestReviewData } from "./index.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const initial: PullRequestReviewData = {
  provider: "github",
  capability: { storage: "host" },
  headSha: "head-1",
  files: [
    { path: "a.ts", state: "stale" },
    { path: "b.ts", state: "unviewed" },
  ],
};
type WriteResult = { path: string; state: "viewed" | "unviewed" | "stale"; headSha: string };

describe("pull request review state", () => {
  it("optimistically updates and rolls back exactly the failed file, preserving stale state", async () => {
    const a = deferred<WriteResult>();
    const b = deferred<WriteResult>();
    const write = vi.fn(({ path }: { path: string }) => (path === "a.ts" ? a.promise : b.promise));
    const controller = createPullRequestReviewController({ read: async () => initial, write });
    await controller.refresh();
    const first = controller.setViewed("a.ts", true);
    const second = controller.setViewed("b.ts", true);
    await controller.setViewed("a.ts", false);
    expect(write).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().data?.files.map((file) => file.state)).toEqual([
      "viewed",
      "viewed",
    ]);
    expect(write).toHaveBeenCalledWith({ path: "a.ts", viewed: true, expectedHeadSha: "head-1" });
    b.resolve({ path: "b.ts", state: "viewed", headSha: "head-1" });
    await second;
    a.reject(new Error("Request failed"));
    await first;
    expect(controller.getSnapshot().data?.files.map((file) => file.state)).toEqual([
      "stale",
      "viewed",
    ]);
    expect(controller.getSnapshot().pendingPaths.size).toBe(0);
    expect(controller.getSnapshot().error).toBe("Request failed");
  });

  it("does not let an older read erase a completed mutation", async () => {
    const read = deferred<PullRequestReviewData>();
    const controller = createPullRequestReviewController({
      read: vi
        .fn()
        .mockResolvedValueOnce(initial)
        .mockImplementation(() => read.promise),
      write: async ({ path }) => ({ path, state: "viewed", headSha: "head-1" }),
    });
    await controller.refresh();
    const refresh = controller.refresh();
    await controller.setViewed("a.ts", true);
    read.resolve(initial);
    await refresh;
    expect(controller.getSnapshot().data?.files[0]?.state).toBe("viewed");
  });

  it("preserves a pending optimistic change when refresh returns", async () => {
    const write = deferred<WriteResult>();
    const controller = createPullRequestReviewController({
      read: async () => initial,
      write: () => write.promise,
    });
    await controller.refresh();
    const change = controller.setViewed("a.ts", true);
    await controller.refresh();
    expect(controller.getSnapshot().data?.files[0]?.state).toBe("viewed");
    write.reject(new Error("Offline"));
    await change;
    expect(controller.getSnapshot().data?.files[0]?.state).toBe("stale");
  });

  it("accepts a new head and ignores a late mutation response for the old head", async () => {
    const write = deferred<WriteResult>();
    const updated = { ...initial, headSha: "head-2" };
    const controller = createPullRequestReviewController({
      read: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(updated),
      write: () => write.promise,
    });
    await controller.refresh();
    const change = controller.setViewed("a.ts", true);
    await controller.refresh();
    write.resolve({ path: "a.ts", state: "viewed", headSha: "head-1" });
    await change;
    expect(controller.getSnapshot().data).toEqual(updated);
  });

  it.each([false, true])(
    "rejects a mismatched write head without overwriting a newer snapshot (%s)",
    async (advanceHead) => {
      const write = deferred<WriteResult>();
      const updated = { ...initial, headSha: "head-2" };
      const controller = createPullRequestReviewController({
        read: vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(updated),
        write: () => write.promise,
      });
      await controller.refresh();
      const change = controller.setViewed("a.ts", true);
      if (advanceHead) await controller.refresh();
      write.resolve({ path: "a.ts", state: "viewed", headSha: "head-2" });
      await change;
      expect(controller.getSnapshot().data).toEqual(advanceHead ? updated : initial);
      expect(controller.getSnapshot().pendingPaths.size).toBe(0);
      expect(controller.getSnapshot().error).toContain("pull request changed");
    },
  );

  it("ignores out-of-order reads and retains data when a refresh fails", async () => {
    const oldRead = deferred<PullRequestReviewData>();
    const latestRead = deferred<PullRequestReviewData>();
    const read = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(latestRead.promise)
      .mockRejectedValueOnce(new Error("Offline"));
    const controller = createPullRequestReviewController({ read, write: vi.fn() });
    await controller.refresh();
    const old = controller.refresh();
    const latest = controller.refresh();
    const updated = { ...initial, headSha: "head-2" };
    latestRead.resolve(updated);
    await latest;
    oldRead.resolve(initial);
    await old;
    await controller.refresh();
    expect(controller.getSnapshot().data).toEqual(updated);
    expect(controller.getSnapshot().error).toBe("Offline");
    expect(controller.getSnapshot().isLoading).toBe(false);
  });

  it("disposal makes late reads and writes inert", async () => {
    const read = deferred<PullRequestReviewData>();
    const write = deferred<WriteResult>();
    const controller = createPullRequestReviewController({
      read: vi.fn().mockResolvedValueOnce(initial).mockReturnValue(read.promise),
      write: () => write.promise,
    });
    await controller.refresh();
    const listener = vi.fn();
    controller.subscribe(listener);
    const change = controller.setViewed("a.ts", true);
    const refresh = controller.refresh();
    controller.dispose();
    const snapshot = controller.getSnapshot();
    listener.mockClear();
    write.resolve({ path: "a.ts", state: "viewed", headSha: "head-1" });
    read.resolve(initial);
    await Promise.all([change, refresh]);
    expect(controller.getSnapshot()).toBe(snapshot);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not write unsupported, unknown, or headless files", async () => {
    const write = vi.fn();
    for (const data of [
      initial,
      { ...initial, headSha: null },
      { ...initial, capability: { storage: "unsupported" as const } },
    ]) {
      const controller = createPullRequestReviewController({ read: async () => data, write });
      await controller.refresh();
      await controller.setViewed(data === initial ? "unknown.ts" : "a.ts", true);
    }
    expect(write).not.toHaveBeenCalled();
  });
});
