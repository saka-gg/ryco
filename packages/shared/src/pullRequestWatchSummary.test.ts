import type {
  MessageId,
  ThreadPullRequestWatch,
  ThreadPullRequestWatches,
  WorktreeId,
} from "@ryco/contracts";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PULL_REQUEST_WATCHES,
  PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
  PULL_REQUEST_WATCH_ENDED_KEPT,
  PULL_REQUEST_WATCH_ENDED_SHELL_MS,
  endPullRequestWatches,
  pullRequestWatchShellAt,
  summarizePullRequestWatch,
  summarizePullRequestWatches,
  upsertPullRequestWatch,
} from "./pullRequestWatchSummary.ts";

const NOW = "2026-10-02T12:30:00.000Z";
const NOW_MS = Date.parse(NOW);

const watch = (overrides: Partial<ThreadPullRequestWatch> = {}): ThreadPullRequestWatch => ({
  watchId: "github.com/o/r#1",
  number: 1,
  url: "https://github.com/o/r/pull/1",
  provider: "github",
  worktreeId: "worktree-1" as WorktreeId,
  revision: 3,
  startedAt: "2026-10-02T12:00:00.000Z",
  startedBy: "user",
  runtimeMode: "full-access",
  worktreePath: "/tmp/worktree",
  headSha: "aaaaaaaaaa",
  failedChecks: ["lint", "test"],
  passed: false,
  passedChecks: [],
  remarksThrough: NOW,
  remarkIds: [],
  outsideRemarks: 0,
  conflicting: true,
  wakes: 0,
  news: false,
  requiredChecks: [],
  // One more fails than was told: Auto-fix CI holds it back until the checks settle.
  failingChecks: 3,
  autoFix: {
    status: "fixing",
    pauseReason: null,
    attempts: 2,
    lastHandledHeadSha: "aaaaaaaaaa",
    fixRequestedAt: NOW,
  },
  delivery: { messageId: "pull-request-watch:t:1" as MessageId, kind: "fix", sentAt: NOW },
  beforeWake: null,
  lastChangeAt: NOW,
  ...overrides,
});

describe("summarizePullRequestWatch", () => {
  it("carries what clients show, including the attempt bound", () => {
    expect(summarizePullRequestWatch(watch())).toEqual({
      watchId: "github.com/o/r#1",
      number: 1,
      url: "https://github.com/o/r/pull/1",
      worktreeId: "worktree-1",
      startedAt: "2026-10-02T12:00:00.000Z",
      startedBy: "user",
      news: false,
      autoFix: {
        status: "fixing",
        pauseReason: null,
        attempts: 2,
        maxAttempts: PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
      },
      headSha: "aaaaaaaaaa",
      failingChecks: 3,
      passed: false,
      conflicting: true,
      delivering: true,
      lastChangeAt: NOW,
    });
    expect(summarizePullRequestWatch(watch({ autoFix: null, delivery: null }))).toMatchObject({
      autoFix: null,
      delivering: false,
    });
  });
});

describe("thread watch lists", () => {
  it("ends the named watches (or all), newest first, keeping a few", () => {
    const second = watch({ watchId: "github.com/o/r#2", number: 2 });
    const both = { active: [watch(), second], ended: [] };
    const one = endPullRequestWatches(both, {
      watchIds: new Set(["github.com/o/r#2"]),
      reason: "unwatched",
      endedAt: NOW,
    });
    expect(one.active).toEqual([watch()]);
    expect(one.ended).toEqual([
      { watchId: "github.com/o/r#2", number: 2, reason: "unwatched", endedAt: NOW },
    ]);

    let crowded: ThreadPullRequestWatches = { active: [watch()], ended: one.ended };
    for (let index = 0; index < PULL_REQUEST_WATCH_ENDED_KEPT + 2; index += 1) {
      crowded = endPullRequestWatches(
        { active: [watch({ watchId: `github.com/o/r#${index + 10}` })], ended: crowded.ended },
        { reason: "settled", endedAt: NOW },
      );
    }
    expect(crowded.ended).toHaveLength(PULL_REQUEST_WATCH_ENDED_KEPT);
    expect(crowded.ended[0]?.watchId).toBe(`github.com/o/r#${PULL_REQUEST_WATCH_ENDED_KEPT + 11}`);
  });

  it("returns the same list when nothing is active, so callers skip a no-op event", () => {
    expect(
      endPullRequestWatches(EMPTY_PULL_REQUEST_WATCHES, { reason: "archived", endedAt: NOW }),
    ).toBe(EMPTY_PULL_REQUEST_WATCHES);
  });

  it("replaces a watch in place or adds it", () => {
    const next = watch({ revision: 4 });
    const second = watch({ watchId: "github.com/o/r#2" });
    expect(upsertPullRequestWatch({ active: [watch(), second], ended: [] }, next).active).toEqual([
      next,
      second,
    ]);
    expect(upsertPullRequestWatch(EMPTY_PULL_REQUEST_WATCHES, next).active).toEqual([next]);
  });
});

describe("pullRequestWatchShellAt", () => {
  const ended = (endedAt: string) => ({
    watchId: "github.com/o/r#9",
    number: 9,
    reason: "merged" as const,
    endedAt,
  });

  it("leaves ended watches out of shells after a day, and the key out when nothing is left", () => {
    const old = new Date(NOW_MS - PULL_REQUEST_WATCH_ENDED_SHELL_MS).toISOString();
    const recent = new Date(NOW_MS - 60_000).toISOString();
    expect(pullRequestWatchShellAt({ active: [], ended: [ended(old)] }, NOW_MS)).toBeNull();
    expect(
      pullRequestWatchShellAt({ active: [], ended: [ended(recent), ended(old)] }, NOW_MS),
    ).toEqual({ active: [], ended: [ended(recent)] });
    const shell = summarizePullRequestWatches({ active: [watch()], ended: [ended(old)] });
    expect(pullRequestWatchShellAt(shell, NOW_MS)).toEqual({ active: shell.active, ended: [] });
    expect(pullRequestWatchShellAt(undefined, NOW_MS)).toBeNull();
  });
});

describe("module boundary", () => {
  it("imports only contract types, so the boot path never loads the decision module", () => {
    const source = readFileSync(new URL("./pullRequestWatchSummary.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+"([^"]+)";/gmu)];
    expect(imports.map((match) => [match[1]?.trim() ?? "value", match[2]])).toEqual([
      ["type", "@ryco/contracts"],
    ]);
  });
});
