import { EnvironmentId, ThreadId, WorktreeId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { selectEnvironmentState, useStore } from "~/store";
import type { PrCheckStatusView } from "./prCheckStatus";
import {
  isWatchedOnServer,
  planPrCheckPassNotifications,
  type NotificationRecord,
  type PrCheckNotificationTarget,
} from "./usePrCheckPassNotifications";

const tier = vi.hoisted(() => ({ current: "desktop" as "desktop" | "phone" }));
vi.mock("~/lib/presentationTier", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/presentationTier")>()),
  getPresentationTier: () => tier.current,
}));

const env = EnvironmentId.make("environment-checks");
const NOW = "2026-10-28T10:00:00.000Z";

function target(
  kind: PrCheckStatusView["kind"],
  overrides: Partial<PrCheckNotificationTarget> = {},
): PrCheckNotificationTarget {
  return {
    environmentId: env,
    cwd: "/repo",
    provider: "github",
    number: 12,
    title: "Fix login",
    url: "https://github.com/o/r/pull/12",
    status: { kind, headSha: "abc1234" } as PrCheckStatusView,
    ...overrides,
  };
}

const KEY = [env, "/repo", "github", 12, "abc1234"].join("|");
const running: NotificationRecord = { key: KEY, status: "running", updatedAt: NOW };

describe("planPrCheckPassNotifications", () => {
  it("announces checks passing on a head this page saw running", () => {
    const plan = planPrCheckPassNotifications({
      records: [running],
      targets: [target("passed")],
      nowIso: NOW,
      isWatched: () => false,
    });
    expect(plan.notify.map((entry) => entry.number)).toEqual([12]);
    expect(plan.records).toEqual([{ key: KEY, status: "passed", updatedAt: NOW, notifiedAt: NOW }]);
  });

  it("leaves a watched pull request to its watch, recording the pass", () => {
    const plan = planPrCheckPassNotifications({
      records: [running],
      targets: [target("passed")],
      nowIso: NOW,
      isWatched: (entry) => entry.number === 12,
    });
    expect(plan.notify).toEqual([]);
    // Recorded as told, so the page stays quiet about this head after the watch ends too.
    expect(plan.records).toEqual([{ key: KEY, status: "passed", updatedAt: NOW, notifiedAt: NOW }]);
  });

  it("stays quiet about a head first seen passed, and records nothing new for one seen before", () => {
    expect(
      planPrCheckPassNotifications({
        records: [],
        targets: [target("passed")],
        nowIso: NOW,
        isWatched: () => false,
      }).notify,
    ).toEqual([]);
    expect(
      planPrCheckPassNotifications({
        records: [running],
        targets: [target("running")],
        nowIso: NOW,
        isWatched: () => false,
      }),
    ).toEqual({ records: null, notify: [] });
  });
});

describe("isWatchedOnServer", () => {
  const initialState = useStore.getState();
  afterEach(() => {
    tier.current = "desktop";
    useStore.setState(initialState, true);
  });

  function watchPullRequest(url: string) {
    const threadId = ThreadId.make("thread-watching");
    const base = selectEnvironmentState(useStore.getState(), env);
    useStore.setState({
      environmentStateById: {
        ...useStore.getState().environmentStateById,
        [env]: {
          ...base,
          sidebarThreadSummaryById: {
            [threadId]: {
              id: threadId,
              pullRequestWatches: {
                active: [
                  {
                    watchId: "github.com/o/r#12",
                    number: 12,
                    url,
                    worktreeId: WorktreeId.make("worktree-watch"),
                    startedAt: NOW,
                    startedBy: "user",
                    news: false,
                    autoFix: null,
                    headSha: "abc1234",
                    failingChecks: 0,
                    passed: false,
                    conflicting: false,
                    delivering: false,
                    lastChangeAt: null,
                  },
                ],
                ended: [],
              },
            } as never,
          },
        },
      },
    });
  }

  it("matches a thread's active watch by the pull request's host URL", () => {
    watchPullRequest("https://github.com/o/r/pull/12");
    expect(isWatchedOnServer(target("passed"))).toBe(true);
    expect(isWatchedOnServer(target("passed", { url: "https://github.com/o/other/pull/12" }))).toBe(
      false,
    );
    expect(isWatchedOnServer(target("passed", { url: undefined }))).toBe(false);
  });

  it("leaves the notice to the page on the phone tier, which shows no watch notice", () => {
    watchPullRequest("https://github.com/o/r/pull/12");
    tier.current = "phone";
    expect(isWatchedOnServer(target("passed"))).toBe(false);
  });
});
