import {
  EnvironmentId,
  ThreadId,
  WorktreeId,
  type ThreadPullRequestWatchShell,
  type ThreadPullRequestWatchSummary,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createPullRequestWatchPassTracker,
  pullRequestWatchPasses,
} from "./pullRequestWatchPasses.ts";

const env = EnvironmentId.make("environment-watch");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");

function watch(
  overrides: Partial<ThreadPullRequestWatchSummary> = {},
): ThreadPullRequestWatchSummary {
  return {
    watchId: "github.com/o/r#12",
    number: 12,
    url: "https://github.com/o/r/pull/12",
    worktreeId: WorktreeId.make("worktree-watch"),
    startedAt: "2026-10-28T10:00:00.000Z",
    startedBy: "user",
    news: false,
    autoFix: { status: "watching", pauseReason: null, attempts: 0, maxAttempts: 3 },
    headSha: "abc1234",
    failingChecks: 0,
    passed: false,
    conflicting: false,
    delivering: false,
    lastChangeAt: null,
    ...overrides,
  };
}

const shell = (...active: ThreadPullRequestWatchSummary[]): ThreadPullRequestWatchShell => ({
  active,
  ended: [],
});

describe("pullRequestWatchPasses", () => {
  it("reports checks passing on the same head", () => {
    const passed = watch({ passed: true });
    expect(pullRequestWatchPasses(shell(watch()), shell(passed))).toEqual([passed]);
  });

  it("reports a new head that passed between two reads", () => {
    const passed = watch({ passed: true, headSha: "def5678" });
    expect(pullRequestWatchPasses(shell(watch({ passed: true })), shell(passed))).toEqual([passed]);
  });

  it("stays quiet on first sight, an unchanged pass and a watch started again", () => {
    const passed = watch({ passed: true });
    expect(pullRequestWatchPasses(undefined, shell(passed))).toEqual([]);
    expect(pullRequestWatchPasses(shell(), shell(passed))).toEqual([]);
    expect(pullRequestWatchPasses(shell(passed), shell(passed))).toEqual([]);
    expect(
      pullRequestWatchPasses(
        shell(watch()),
        shell(watch({ passed: true, startedAt: "2026-10-28T12:00:00.000Z" })),
      ),
    ).toEqual([]);
    expect(pullRequestWatchPasses(shell(watch()), shell(watch({ failingChecks: 1 })))).toEqual([]);
    expect(pullRequestWatchPasses(shell(watch()), undefined)).toEqual([]);
  });
});

describe("createPullRequestWatchPassTracker", () => {
  it("baselines silently, then reports each pass once per pull request and head", () => {
    const tracker = createPullRequestWatchPassTracker();
    tracker.baseline(env, [
      { id: threadA, pullRequestWatches: shell(watch()) },
      { id: threadB, pullRequestWatches: shell(watch()) },
    ]);
    const passed = watch({ passed: true });

    expect(tracker.observe(env, threadA, shell(passed))).toEqual([
      { environmentId: env, threadId: threadA, watch: passed },
    ]);
    // Another thread watching the same pull request: one notice is enough.
    expect(tracker.observe(env, threadB, shell(passed))).toEqual([]);
    // Flapping back and forth on the same head is not news again.
    expect(tracker.observe(env, threadA, shell(watch()))).toEqual([]);
    expect(tracker.observe(env, threadA, shell(passed))).toEqual([]);
    // A new head that passes is.
    const nextHead = watch({ passed: true, headSha: "def5678" });
    expect(tracker.observe(env, threadA, shell(nextHead))).toHaveLength(1);
  });

  it("reports nothing for an environment it has not baselined, or a thread it first sees", () => {
    const tracker = createPullRequestWatchPassTracker();
    expect(tracker.observe(env, threadA, shell(watch({ passed: true })))).toEqual([]);

    tracker.baseline(env, []);
    expect(tracker.observe(env, threadA, shell(watch({ passed: true })))).toEqual([]);
  });

  it("forgets removed threads and cleared environments", () => {
    const tracker = createPullRequestWatchPassTracker();
    tracker.baseline(env, [{ id: threadA, pullRequestWatches: shell(watch()) }]);
    tracker.remove(env, threadA);
    expect(tracker.observe(env, threadA, shell(watch({ passed: true })))).toEqual([]);

    tracker.baseline(env, [{ id: threadA, pullRequestWatches: shell(watch()) }]);
    tracker.clear(env);
    expect(tracker.observe(env, threadA, shell(watch({ passed: true })))).toEqual([]);
  });

  it("keeps no watches for a thread whose shell lost them", () => {
    const tracker = createPullRequestWatchPassTracker();
    tracker.baseline(env, [{ id: threadA, pullRequestWatches: shell(watch()) }]);
    expect(tracker.observe(env, threadA, undefined)).toEqual([]);
    // Watching again is a first sight: a pass seen with it is not news.
    expect(tracker.observe(env, threadA, shell(watch({ passed: true })))).toEqual([]);
  });
});
