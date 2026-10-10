import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const toasts = vi.hoisted(() => ({
  add: vi.fn((_options: unknown) => "toast-1"),
  update: vi.fn(),
  close: vi.fn(),
}));
vi.mock("./components/ui/toast", () => ({
  toastManager: toasts,
  stackedThreadToast: (options: unknown) => options,
}));

import {
  createGitActionReporter,
  gitActionNoticeKind,
  presentGitActionNotices,
  type GitActionNotice,
} from "./gitActionNotices";

const reporter = () =>
  createGitActionReporter({ id: "run-1", kind: "push", environmentId: "env", cwd: "/repo" });

afterEach(() => {
  vi.clearAllMocks();
});

describe("git action notices", () => {
  it("names a stacked action by its last step", () => {
    expect(gitActionNoticeKind("commit")).toBe("commit");
    expect(gitActionNoticeKind("commit_push")).toBe("push");
    expect(gitActionNoticeKind("commit_push_pr")).toBe("pr");
  });

  it("reports to the checkout's presenter in place of toasts", () => {
    const seen: GitActionNotice[] = [];
    const release = presentGitActionNotices("env", "/repo", (notice) => seen.push(notice));
    const run = reporter();
    run.running("Pushing...", "1s");
    run.succeeded({ title: "Pushed", description: "to origin" });
    release();

    expect(seen).toEqual([
      { id: "run-1", kind: "push", status: "running", title: "Pushing...", description: "1s" },
      {
        id: "run-1",
        kind: "push",
        status: "success",
        title: "Pushed",
        description: "to origin",
        action: undefined,
      },
    ]);
    expect(toasts.add).not.toHaveBeenCalled();
  });

  it("falls back to one toast per run, and to it when the presenter goes away mid-run", () => {
    const run = reporter();
    run.running("Pushing...");
    run.running("Pushing...", "2s");
    expect(toasts.add).toHaveBeenCalledTimes(1);
    expect(toasts.update).toHaveBeenCalledWith(
      "toast-1",
      expect.objectContaining({ type: "loading", description: "2s" }),
    );

    // A presenter appearing takes over and closes the toast.
    const seen: GitActionNotice[] = [];
    const release = presentGitActionNotices("env", "/repo", (notice) => seen.push(notice));
    run.running("Pushing...", "3s");
    expect(toasts.close).toHaveBeenCalledWith("toast-1");
    release();
    run.failed({ title: "Action failed", description: "rejected" });
    expect(toasts.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "error", title: "Action failed" }),
    );
    expect(seen).toHaveLength(1);
  });

  it("ignores presenters of other checkouts and lets the latest presenter win", () => {
    const other = vi.fn();
    const first = vi.fn();
    const latest = vi.fn();
    const releaseOther = presentGitActionNotices("env", "/elsewhere", other);
    const releaseFirst = presentGitActionNotices("env", "/repo", first);
    const releaseLatest = presentGitActionNotices("env", "/repo", latest);
    reporter().running("Pushing...");
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    expect(other).not.toHaveBeenCalled();
    releaseLatest();
    reporter().running("Pushing...");
    expect(first).toHaveBeenCalledTimes(1);
    releaseFirst();
    releaseOther();
  });
});
