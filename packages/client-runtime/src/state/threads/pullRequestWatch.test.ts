import {
  PullRequestWatchEndReason,
  ThreadId,
  WorktreeId,
  type SourceControlSetPullRequestWatchInput,
  type ThreadPullRequestWatchShell,
  type ThreadPullRequestWatchSummary,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  findPullRequestWatch,
  isPullRequestWatchedIn,
  pullRequestWatchEndedLabel,
  pullRequestWatchErrorMessage,
  pullRequestWatchInput,
  pullRequestWatchView,
  samePullRequestUrl,
  setPullRequestWatch,
} from "./pullRequestWatch.ts";

const threadId = ThreadId.make("thread-watch");
const URL_12 = "https://github.com/o/r/pull/12";

function summary(
  overrides: Partial<ThreadPullRequestWatchSummary> = {},
): ThreadPullRequestWatchSummary {
  return {
    watchId: "github.com/o/r#12",
    number: 12,
    url: URL_12,
    worktreeId: WorktreeId.make("worktree-watch"),
    startedAt: "2026-10-28T10:00:00.000Z",
    startedBy: "user",
    news: false,
    autoFix: { status: "watching", pauseReason: null, attempts: 0, maxAttempts: 3 },
    headSha: "abc1234def",
    failingChecks: 0,
    passed: false,
    conflicting: false,
    delivering: false,
    lastChangeAt: null,
    ...overrides,
  };
}

const autoFix = (
  status: "watching" | "fixing" | "paused",
  rest: Partial<NonNullable<ThreadPullRequestWatchSummary["autoFix"]>> = {},
): ThreadPullRequestWatchSummary["autoFix"] => ({
  status,
  pauseReason: null,
  attempts: 0,
  maxAttempts: 3,
  ...rest,
});

describe("pullRequestWatchView", () => {
  it("words a news-only watch the agent started", () => {
    expect(
      pullRequestWatchView(summary({ news: true, autoFix: null, startedBy: "agent" })),
    ).toEqual({
      label: "Watching · wakes the agent on failures, reviews and conflicts",
      tone: "muted",
      detail: null,
      autoFixOn: false,
      paused: false,
    });
  });

  it("words Auto-fix CI waiting for checks, with and without news", () => {
    expect(pullRequestWatchView(summary())).toEqual({
      label: "Watching the checks",
      tone: "muted",
      detail: "Starts a fix turn when checks fail, up to 3 attempts",
      autoFixOn: true,
      paused: false,
    });
    expect(pullRequestWatchView(summary({ news: true })).detail).toBe(
      "Also wakes the agent on failures, reviews and conflicts",
    );
    expect(
      pullRequestWatchView(summary({ autoFix: autoFix("watching", { maxAttempts: 1 }) })).detail,
    ).toBe("Starts a fix turn when checks fail, up to 1 attempt");
  });

  it("words a fix turn in progress", () => {
    expect(pullRequestWatchView(summary({ autoFix: autoFix("fixing", { attempts: 2 }) }))).toEqual({
      label: "Fixing CI · attempt 2 of 3",
      tone: "active",
      detail: "Waiting for the fix to be pushed",
      autoFixOn: true,
      paused: false,
    });
    expect(
      pullRequestWatchView(
        summary({ autoFix: autoFix("fixing", { attempts: 1 }), delivering: true }),
      ).detail,
    ).toBe("Starting the fix turn");
  });

  it("words each pause, keeps the switch on and offers to resume", () => {
    const paused = (pauseReason: "attempt-limit" | "no-push" | "start-failed", maxAttempts = 3) =>
      pullRequestWatchView(
        summary({
          autoFix: autoFix("paused", { pauseReason, attempts: maxAttempts, maxAttempts }),
        }),
      );
    expect(paused("attempt-limit")).toEqual({
      label: "Auto-fix paused: checks still fail after 3 fix attempts",
      tone: "warning",
      detail: null,
      autoFixOn: true,
      paused: true,
    });
    expect(paused("attempt-limit", 1).label).toBe(
      "Auto-fix paused: checks still fail after 1 fix attempt",
    );
    expect(paused("no-push").label).toBe("Auto-fix paused: the fix turn ended without a push");
    expect(paused("start-failed").label).toBe("Auto-fix paused: the fix turn did not start");
  });
});

describe("pullRequestWatchEndedLabel", () => {
  it("says why watching stopped, for every end reason", () => {
    const labels = Object.fromEntries(
      PullRequestWatchEndReason.literals.map((reason) => [
        reason,
        pullRequestWatchEndedLabel(reason),
      ]),
    );
    expect(labels).toEqual({
      unwatched: "Stopped watching: turned off",
      merged: "Stopped watching: merged",
      closed: "Stopped watching: closed",
      "comment-limit": "Stopped watching: too many comment-only updates",
      unreadable: "Stopped watching: could not read it several times in a row",
      settled: "Stopped watching: the chat was settled",
      archived: "Stopped watching: the chat was archived",
      trashed: "Stopped watching: the chat was moved to Trash",
      stopped: "Stopped watching: you stopped the chat",
      unlinked: "Stopped watching: no longer linked to the workspace",
      "scope-changed": "Stopped watching: the chat's permissions or checkout changed",
      rejected: "Stopped watching: the chat kept refusing its updates",
      expired: "Stopped watching: the chat could not take an update for a day",
    });
  });
});

describe("findPullRequestWatch", () => {
  const otherRepository = summary({
    watchId: "github.com/o/other#12",
    url: "https://github.com/o/other/pull/12",
  });
  const shell = (overrides: Partial<ThreadPullRequestWatchShell> = {}) => ({
    active: [otherRepository, summary()],
    ended: [],
    ...overrides,
  });

  it("finds the active watch by number and host URL", () => {
    expect(findPullRequestWatch(shell(), { number: 12, url: `${URL_12}/` })).toEqual({
      kind: "active",
      watch: summary(),
    });
    expect(
      findPullRequestWatch(shell(), {
        number: 12,
        url: "https://GitHub.com/o/r/pull/12?tab=checks",
      }),
    ).toMatchObject({ kind: "active", watch: { url: URL_12 } });
    // Without a URL the number decides (the first one).
    expect(findPullRequestWatch(shell(), { number: 12 })).toMatchObject({
      kind: "active",
      watch: otherRepository,
    });
  });

  it("falls back to why the latest watch of that number ended", () => {
    const ended = {
      watchId: "github.com/o/r#12",
      number: 12,
      reason: "merged" as const,
      endedAt: "2026-10-28T11:00:00.000Z",
    };
    expect(
      findPullRequestWatch({ active: [], ended: [ended] }, { number: 12, url: URL_12 }),
    ).toEqual({ kind: "ended", ended });
    expect(findPullRequestWatch({ active: [], ended: [ended] }, { number: 13 })).toBeNull();
    expect(findPullRequestWatch(undefined, { number: 12 })).toBeNull();
  });

  it("tells whether any thread watches a pull request", () => {
    const threads = [
      { id: ThreadId.make("a") },
      { id: ThreadId.make("b"), pullRequestWatches: shell({ active: [summary()] }) },
    ];
    expect(isPullRequestWatchedIn(threads, { number: 12, url: URL_12 })).toBe(true);
    expect(
      isPullRequestWatchedIn(threads, { number: 12, url: "https://github.com/o/other/pull/12" }),
    ).toBe(false);
    expect(isPullRequestWatchedIn(threads, { number: 7, url: URL_12 })).toBe(false);
  });

  it("compares host URLs without a trailing slash, query, fragment or host case", () => {
    expect(samePullRequestUrl(URL_12, "https://GITHUB.com/o/r/pull/12/#discussion")).toBe(true);
    expect(samePullRequestUrl(URL_12, "https://github.com/o/r/pull/120")).toBe(false);
    expect(samePullRequestUrl("not a url/", "not a url")).toBe(true);
  });
});

describe("pullRequestWatchInput and setPullRequestWatch", () => {
  const target = { threadId, number: 12, url: URL_12 };

  it("builds one request per action", () => {
    expect(pullRequestWatchInput(target, "auto-fix-on")).toEqual({ ...target, autoFix: true });
    expect(pullRequestWatchInput(target, "resume")).toEqual({ ...target, autoFix: true });
    expect(pullRequestWatchInput(target, "auto-fix-off")).toEqual({ ...target, autoFix: false });
    expect(pullRequestWatchInput(target, "stop")).toEqual({
      ...target,
      news: false,
      autoFix: false,
    });
    expect(pullRequestWatchInput({ threadId, number: 12, url: null }, "stop")).toEqual({
      threadId,
      number: 12,
      news: false,
      autoFix: false,
    });
  });

  it("sends the request through the environment's client", async () => {
    const result = { watch: null, now: "Checks passed." };
    const setWatch = vi.fn(async (_input: SourceControlSetPullRequestWatchInput) => result);
    await expect(
      setPullRequestWatch({ sourceControl: { setPullRequestWatch: setWatch } }, target, "stop"),
    ).resolves.toBe(result);
    expect(setWatch).toHaveBeenCalledWith({ ...target, news: false, autoFix: false });
  });

  it("reads the server's reason for a refusal", () => {
    expect(
      pullRequestWatchErrorMessage({
        _tag: "PullRequestWatchError",
        reason: "auto-fix-owned",
        detail: "Another chat already runs Auto-fix CI on #12.",
        message: "",
      }),
    ).toBe("Another chat already runs Auto-fix CI on #12.");
    expect(pullRequestWatchErrorMessage(new Error("Socket closed"))).toBe("Socket closed");
    expect(pullRequestWatchErrorMessage("nope")).toBeNull();
  });
});
