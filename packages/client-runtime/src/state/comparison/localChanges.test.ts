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
const stagedSnapshot = (stagedRevision?: string): GitLocalChangesResult => ({
  ...snapshot("review"),
  ...(stagedRevision ? { stagedRevision } : {}),
  staged: {
    patch: "diff",
    files: [{ id: "file", hunkCount: 1, fileAction: true, hunkAction: true }],
  },
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
  it("commits only the displayed staged revision, once, and refreshes after success", async () => {
    let finish!: () => void;
    const commit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const read = vi.fn(async () => stagedSnapshot("reviewed"));
    const c = createLocalChangesController({ cwd: "/repo", read, apply: vi.fn() });
    await c.refresh();
    const request = c.commitStaged(commit);
    expect(c.getSnapshot().isCommitting).toBe(true);
    expect(await c.commitStaged(commit)).toBe(false);
    await c.apply(selection);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith({ cwd: "/repo", expectedRevision: "reviewed" });
    read.mockResolvedValue(snapshot("after"));
    finish();
    expect(await request).toBe(true);
    expect(c.getSnapshot()).toMatchObject({ isCommitting: false, error: null });
    expect(c.getSnapshot().data?.revision).toBe("after");
  });
  it("needs staged changes and a staged revision, and requires fresh review after failure", async () => {
    const commit = vi.fn(async () => {
      throw new Error("The staged changes, HEAD or branch moved since your review.");
    });
    const read = vi.fn(async () => stagedSnapshot());
    const c = createLocalChangesController({ cwd: "/repo", read, apply: vi.fn() });
    await c.refresh();
    expect(await c.commitStaged(commit)).toBe(false);
    read.mockResolvedValue(snapshot("nothing staged"));
    await c.refresh();
    expect(await c.commitStaged(commit)).toBe(false);
    expect(commit).not.toHaveBeenCalled();
    read.mockResolvedValue(stagedSnapshot("reviewed"));
    await c.refresh();
    expect(await c.commitStaged(commit)).toBe(false);
    expect(await c.commitStaged(commit)).toBe(false);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(3);
    expect(c.getSnapshot()).toMatchObject({
      data: null,
      error: "The staged changes, HEAD or branch moved since your review.",
      isCommitting: false,
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
