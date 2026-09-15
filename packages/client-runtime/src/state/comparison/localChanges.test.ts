import { describe, expect, it, vi } from "vite-plus/test";
import type { GitLocalChangesResult } from "@ryco/contracts";
import { createLocalChangesController } from "./localChanges.ts";

const snapshot = (revision: string): GitLocalChangesResult => ({
  worktreePath: "/repo",
  headOid: "head",
  branch: "main",
  indexIdentity: "index",
  revision,
  staged: { patch: "", files: [] },
  unstaged: { patch: "diff", files: [] },
});
const selection = { scope: "unstaged" as const, fileId: "file", hunkIndex: 1 };
describe("local changes controller", () => {
  it("binds mutations to the displayed snapshot, serializes and refreshes after success", async () => {
    let finish!: () => void;
    const apply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const read = vi.fn(async () => snapshot("first"));
    const c = createLocalChangesController({ cwd: "/repo", read, apply });
    await c.refresh();
    const request = c.apply(selection);
    await c.apply(selection);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith({ ...selection, cwd: "/repo", expectedRevision: "first" });
    read.mockResolvedValue(snapshot("after"));
    finish();
    await request;
    expect(c.getSnapshot().data?.revision).toBe("after");
  });
  it("does not replay failed or uncertain writes and requires fresh review to retry", async () => {
    const apply = vi.fn(async () => {
      throw new Error("Delivery uncertain");
    });
    const read = vi.fn(async () => snapshot("first"));
    const c = createLocalChangesController({ cwd: "/repo", read, apply });
    await c.refresh();
    await c.apply(selection);
    await c.apply(selection);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot()).toMatchObject({
      data: null,
      error: "Delivery uncertain",
      isApplying: false,
    });
  });
  it("ignores reads and write completion from an invalidated connection generation", async () => {
    let resolveRead!: (data: GitLocalChangesResult) => void;
    let resolveWrite!: () => void;
    const read = vi.fn(
      () =>
        new Promise<GitLocalChangesResult>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const apply = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const c = createLocalChangesController({ cwd: "/repo", read, apply });
    const request = c.refresh();
    await Promise.resolve();
    c.invalidate();
    resolveRead(snapshot("old"));
    await request;
    expect(c.getSnapshot().data).toBeNull();
    read.mockResolvedValue(snapshot("current"));
    await c.refresh();
    const write = c.apply(selection);
    c.invalidate();
    resolveWrite();
    await write;
    expect(c.getSnapshot()).toMatchObject({ data: null, isApplying: false });
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
