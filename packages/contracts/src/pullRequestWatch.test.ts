import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import * as Orchestration from "./orchestration.ts";
import {
  ThreadPullRequestWatch,
  ThreadPullRequestWatches,
  ThreadPullRequestWatchShell,
} from "./pullRequestWatch.ts";
import { SourceControlSetPullRequestWatchInput } from "./pullRequestWatchRpc.ts";
import * as RuntimeModes from "./runtimeMode.ts";

const watch = {
  watchId: "github.com/o/r#12",
  number: 12,
  url: "https://github.com/o/r/pull/12",
  provider: "github",
  worktreeId: "worktree-1",
  revision: 2,
  startedAt: "2026-10-02T12:00:00.000Z",
  startedBy: "agent",
  runtimeMode: "auto-accept-edits",
  worktreePath: "/tmp/worktree",
  headSha: "abc1234",
  failedChecks: ["CI\u0000lint"],
  passed: false,
  passedChecks: [],
  remarksThrough: "2026-10-02T12:00:00.000Z",
  remarkIds: [],
  outsideRemarks: 0,
  conflicting: false,
  wakes: 0,
  news: true,
  requiredChecks: null,
  failingChecks: 1,
  autoFix: {
    status: "fixing",
    pauseReason: null,
    attempts: 1,
    lastHandledHeadSha: "abc1234",
    fixRequestedAt: "2026-10-02T12:10:00.000Z",
  },
  delivery: {
    messageId: "pull-request-watch:t:1",
    kind: "fix",
    sentAt: "2026-10-02T12:10:00.000Z",
  },
  beforeWake: null,
  lastChangeAt: "2026-10-02T12:10:00.000Z",
};

describe("pull request watch contracts", () => {
  it("round-trips a watch with Auto-fix CI and a pending delivery", () => {
    const decoded = Schema.decodeUnknownSync(ThreadPullRequestWatch)(watch);
    expect(decoded).toEqual(watch);
    expect(Schema.encodeSync(ThreadPullRequestWatch)(decoded)).toEqual(watch);
    expect(
      Schema.decodeUnknownSync(ThreadPullRequestWatches)({
        active: [watch],
        ended: [
          { watchId: "github.com/o/r#9", number: 9, reason: "trashed", endedAt: watch.startedAt },
        ],
      }).ended[0]?.reason,
    ).toBe("trashed");
  });

  it("keeps only ids and times in a delivery and rejects revision 0", () => {
    const decode = Schema.decodeUnknownSync(ThreadPullRequestWatch);
    expect(() => decode({ ...watch, revision: 0 })).toThrow();
    expect(() => decode({ ...watch, delivery: { ...watch.delivery, kind: "notice" } })).toThrow();
    expect(() =>
      decode({ ...watch, autoFix: { ...watch.autoFix, pauseReason: "tired" } }),
    ).toThrow();
  });

  it("accepts a shell with summaries and a set-watch input by number or url", () => {
    expect(
      Schema.decodeUnknownSync(ThreadPullRequestWatchShell)({ active: [], ended: [] }),
    ).toEqual({ active: [], ended: [] });
    const decode = Schema.decodeUnknownSync(SourceControlSetPullRequestWatchInput);
    expect(decode({ threadId: "thread-1", autoFix: true })).toEqual({
      threadId: "thread-1",
      autoFix: true,
    });
    expect(decode({ threadId: "thread-1", url: watch.url, news: true })).toMatchObject({
      url: watch.url,
    });
    expect(() => decode({ threadId: "thread-1", number: 0 })).toThrow();
  });

  it("keeps RuntimeMode in a leaf module that orchestration re-exports", () => {
    expect(Orchestration.RuntimeMode).toBe(RuntimeModes.RuntimeMode);
    expect(Orchestration.DEFAULT_RUNTIME_MODE).toBe("full-access");
  });
});
