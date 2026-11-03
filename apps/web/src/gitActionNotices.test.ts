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
  GitActionResultUnavailableError,
  GitActionStoppedError,
  GitCommandError,
  type GitActionProgressEvent,
  type GitCancelStackedActionResult,
} from "@ryco/contracts";

import {
  createGitActionReporter,
  GIT_ACTION_RECONNECTING_DESCRIPTION,
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

describe("a git action that outlives its connection", () => {
  const started = {
    kind: "action_started",
    actionId: "run-1",
    cwd: "/repo",
    action: "push",
    phases: ["push"],
  } satisfies GitActionProgressEvent;
  const failed = {
    kind: "action_failed",
    actionId: "run-1",
    cwd: "/repo",
    action: "push",
    phase: "push",
    message: "Stopped.",
  } satisfies GitActionProgressEvent;

  // A test that fails before its own release must not route the next tests' toasts to its presenter.
  const presenterReleases: Array<() => void> = [];
  afterEach(() => {
    for (const release of presenterReleases.splice(0)) release();
  });

  function stoppableRun(stop: () => Promise<GitCancelStackedActionResult> | undefined) {
    const seen: GitActionNotice[] = [];
    const release = presentGitActionNotices("env", "/repo", (notice) => seen.push(notice));
    presenterReleases.push(release);
    const run = createGitActionReporter({
      id: "run-1",
      kind: "push",
      environmentId: "env",
      cwd: "/repo",
      stop,
    });
    run.running("Pushing...", "Running for 1s");
    run.onRecoveryState({ kind: "started", recoverable: true });
    return { run, seen, release, latest: () => seen.at(-1)! };
  }

  it("offers Stop once the node reported the run, and stops it in place", async () => {
    const stop = vi.fn(() => Promise.resolve({ cancelled: true }));
    const { run, seen, release, latest } = stoppableRun(stop);
    // Before the node reported the run, a Stop could race its start.
    expect(latest().action).toBeUndefined();
    run.onProgress(started);
    expect(latest()).toMatchObject({
      status: "running",
      title: "Pushing...",
      action: { label: "Stop" },
    });

    latest().action!.onClick();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(latest()).toMatchObject({ status: "running", description: "Stopping..." });
    expect(latest().action).toBeUndefined();
    await Promise.resolve();
    // The ticker keeps reporting the step; "Stopping..." holds until the result.
    run.running("Pushing...", "Running for 2s");
    expect(latest()).toMatchObject({ description: "Stopping...", action: undefined });

    expect(
      run.rejected(
        new GitActionStoppedError({ actionId: "run-1", phase: "push", reason: "requested" }),
        "Action failed",
      ),
    ).toBe(true);
    expect(latest()).toMatchObject({
      status: "cancelled",
      title: "Stopped",
      description: "Steps that already finished stay done.",
    });
    const count = seen.length;
    run.onRecoveryState({ kind: "reconnecting" });
    expect(seen).toHaveLength(count);
    release();
  });

  it("keeps Stop and the running notice when a Stop fails, with the reason", async () => {
    const stop = vi
      .fn<() => Promise<GitCancelStackedActionResult> | undefined>()
      .mockRejectedValueOnce(new Error("Request refused."))
      .mockReturnValueOnce(undefined);
    const { run, release, latest } = stoppableRun(stop);
    run.onProgress(started);

    latest().action!.onClick();
    await vi.waitFor(() =>
      expect(latest()).toMatchObject({
        status: "running",
        title: "Pushing...",
        description: "Couldn't stop: Request refused.",
        action: { label: "Stop" },
      }),
    );
    run.running("Pushing...", "Running for 3s");
    expect(latest().description).toBe("Couldn't stop: Request refused.");
    // No connection can carry the Stop right now.
    latest().action!.onClick();
    await vi.waitFor(() =>
      expect(latest().description).toBe(
        "Couldn't stop: Not connected to the node. Try again once it reconnects.",
      ),
    );
    // The next step clears the reason.
    run.running("Creating pull request...", "Running for 0s");
    expect(latest()).toMatchObject({ description: "Running for 0s", action: { label: "Stop" } });
    release();
  });

  it("says it is reconnecting over a failed Stop, and drops that reason once it follows again", async () => {
    const stop = vi.fn(() => Promise.reject(new Error("Socket closed.")));
    const { run, release, latest } = stoppableRun(stop);
    run.onProgress(started);
    latest().action!.onClick();
    await vi.waitFor(() => expect(latest().description).toBe("Couldn't stop: Socket closed."));

    run.onRecoveryState({ kind: "reconnecting" });
    expect(latest()).toMatchObject({
      description: GIT_ACTION_RECONNECTING_DESCRIPTION,
      action: { label: "Stop" },
    });
    run.onRecoveryState({ kind: "reattached" });
    run.running("Pushing...", "Running for 7s");
    expect(latest()).toMatchObject({ description: "Running for 7s", action: { label: "Stop" } });
    release();
  });

  it("says when nothing is left to stop, and drops Stop once the action reported its end", async () => {
    const stop = vi.fn(() => Promise.resolve({ cancelled: false }));
    const first = stoppableRun(stop);
    first.run.onProgress(started);
    first.latest().action!.onClick();
    await vi.waitFor(() =>
      expect(first.latest()).toMatchObject({
        description: "Nothing left to stop. Waiting for the result...",
        action: undefined,
      }),
    );
    first.release();

    const second = stoppableRun(stop);
    second.run.onProgress(started);
    expect(second.latest().action?.label).toBe("Stop");
    second.run.onProgress(failed);
    expect(second.latest()).toMatchObject({ status: "running", action: undefined });
    second.release();
  });

  it("says it is reconnecting, and offers no Stop on a request-owned run", () => {
    const stop = vi.fn(() => Promise.resolve({ cancelled: true }));
    const { run, release, latest } = stoppableRun(stop);
    run.onProgress(started);
    run.onRecoveryState({ kind: "reconnecting" });
    run.running("Pushing...", "Running for 9s");
    expect(latest()).toMatchObject({
      description: GIT_ACTION_RECONNECTING_DESCRIPTION,
      action: { label: "Stop" },
    });
    run.onRecoveryState({ kind: "reattached" });
    expect(latest()).toMatchObject({ description: "Running for 9s", action: { label: "Stop" } });
    release();

    const owned = stoppableRun(stop);
    owned.run.onRecoveryState({ kind: "started", recoverable: false });
    owned.run.onProgress(started);
    owned.run.running("Pushing...", "Running for 1s");
    expect(owned.latest().action).toBeUndefined();
    owned.release();
  });

  it("ends with what the client knows: stopped, unconfirmed or failed", () => {
    const outcome = (error: unknown) => {
      const { run, release, latest } = stoppableRun(() => undefined);
      const reread = run.rejected(error, "Action failed");
      release();
      return { reread, notice: latest() };
    };
    expect(
      outcome(new GitActionResultUnavailableError({ actionId: "run-1", reason: "missing" })),
    ).toEqual({
      reread: true,
      notice: expect.objectContaining({
        status: "error",
        title: "Couldn't confirm the Git action",
        description: "Check the repository status before trying again.",
      }),
    });
    expect(
      outcome(
        new GitActionStoppedError({ actionId: "run-1", phase: null, reason: "access-revoked" }),
      ),
    ).toEqual({
      reread: true,
      notice: expect.objectContaining({
        status: "cancelled",
        title: "Stopped",
        description: "Access to this node was revoked. Steps that already finished stay done.",
      }),
    });
    const failure = new GitCommandError({
      operation: "git push",
      command: "git push",
      cwd: "/repo",
      detail: "rejected",
    });
    expect(outcome(failure)).toEqual({
      reread: false,
      notice: expect.objectContaining({
        status: "error",
        title: "Action failed",
        description: failure.message,
      }),
    });
  });

  it("puts Stop on the running toast and never leaves it on the result", () => {
    const stop = vi.fn(() => Promise.resolve({ cancelled: true }));
    const run = createGitActionReporter({
      id: "run-1",
      kind: "push",
      environmentId: "env",
      cwd: "/repo",
      stop,
    });
    run.running("Pushing...", "Waiting for Git...");
    run.onRecoveryState({ kind: "started", recoverable: true });
    run.onProgress(started);
    const shown = toasts.update.mock.calls.at(-1) as unknown as [
      string,
      { actionProps?: { children: string; onClick: () => void }; description?: string },
    ];
    expect(shown[1]).toMatchObject({ type: "loading", actionProps: { children: "Stop" } });
    shown[1].actionProps!.onClick();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(toasts.close).not.toHaveBeenCalled();
    expect(toasts.update).toHaveBeenLastCalledWith(
      "toast-1",
      expect.objectContaining({ description: "Stopping...", actionProps: undefined }),
    );

    run.failed({ title: "Action failed", description: "rejected" });
    const result = toasts.update.mock.calls.at(-1) as unknown as [string, object];
    expect(result[1]).toHaveProperty("actionProps", undefined);
    expect(result[1]).toMatchObject({ type: "error", title: "Action failed" });
  });

  it("lets a Stopped toast go once seen, like a result", () => {
    const run = reporter();
    run.running("Pushing...", "Running for 4s");
    run.rejected(
      new GitActionStoppedError({ actionId: "run-1", phase: "push", reason: "requested" }),
      "Action failed",
    );
    expect(toasts.update).toHaveBeenLastCalledWith(
      "toast-1",
      expect.objectContaining({
        type: "info",
        title: "Stopped",
        timeout: 0,
        data: { dismissAfterVisibleMs: 10_000 },
      }),
    );
  });

  it("never leaves the running line under a result that has none", () => {
    const run = reporter();
    run.running("Pushing...", "Running for 24s");
    run.succeeded({ title: "Pushed 027d927 to origin/main" });
    expect(toasts.update).toHaveBeenLastCalledWith(
      "toast-1",
      expect.objectContaining({ type: "success", description: undefined, actionProps: undefined }),
    );
    expect(toasts.update.mock.calls.at(-1)?.[1]).toHaveProperty("description", undefined);
  });
});
