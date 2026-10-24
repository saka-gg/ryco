import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";
import type { ScopedThreadRef } from "@ryco/contracts";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import { threadNotificationTag } from "@ryco/client-runtime/state/settings";
import type {
  ThreadNotificationCandidate,
  ThreadNotificationKind,
} from "@ryco/client-runtime/state/threads";
import { describe, expect, it } from "vite-plus/test";

import {
  planMobileThreadAlert,
  threadAlertLinkPath,
  threadAlertModeOf,
  threadAlertRefOf,
} from "./threadAlerts.logic";

const ref = (threadId: string): ScopedThreadRef => ({
  environmentId: EnvironmentId.make("environment-alerts"),
  threadId: ThreadId.make(threadId),
});

function candidate(
  kind: ThreadNotificationKind,
  input: { readonly threadId?: string; readonly delegated?: boolean } = {},
): ThreadNotificationCandidate {
  const threadRef = ref(input.threadId ?? "thread-b");
  return {
    event: {
      id: `${kind}:1`,
      groupKey: scopedThreadKey(threadRef),
      ref: threadRef,
      kind,
      title: "Fix the login form",
      turnId: null,
      sequence: 1,
      generation: {},
    },
    delegated: input.delegated ?? false,
  };
}

const quietScreen = { appActive: true, visibleThread: null } as const;

describe("thread alert mode", () => {
  it("is off until alerts are turned on, and the sound needs alerts", () => {
    expect(threadAlertModeOf({})).toBe("off");
    expect(threadAlertModeOf({ threadAlertSound: true })).toBe("off");
    expect(threadAlertModeOf({ threadAlerts: false, threadAlertSound: true })).toBe("off");
    expect(threadAlertModeOf({ threadAlerts: true })).toBe("notifications");
    expect(threadAlertModeOf({ threadAlerts: true, threadAlertSound: false })).toBe(
      "notifications",
    );
    expect(threadAlertModeOf({ threadAlerts: true, threadAlertSound: true })).toBe(
      "notifications-and-sound",
    );
  });
});

describe("planMobileThreadAlert", () => {
  it("names the thread with each kind's alert title, under the thread's tag", () => {
    const titles: Record<ThreadNotificationKind, string> = {
      approval: "Needs approval",
      input: "Needs your answer",
      "plan-ready": "Plan ready",
      completed: "Finished",
      failed: "Failed",
      stopped: "Stopped",
    };
    for (const [kind, title] of Object.entries(titles) as Array<[ThreadNotificationKind, string]>) {
      expect(
        planMobileThreadAlert({
          candidate: candidate(kind),
          mode: "notifications",
          ...quietScreen,
          // A stopped turn alerts only in the background (see the next case).
          appActive: kind !== "stopped",
        }),
      ).toEqual({
        identifier: threadNotificationTag(ref("thread-b")),
        title,
        body: "Fix the login form",
        sound: false,
        ref: ref("thread-b"),
      });
    }
  });

  it("keeps a stopped turn quiet while the app is in front, where it is your own Stop", () => {
    expect(
      planMobileThreadAlert({
        candidate: candidate("stopped"),
        mode: "notifications-and-sound",
        ...quietScreen,
      }),
    ).toBeNull();
  });

  it("stays quiet with alerts off", () => {
    expect(
      planMobileThreadAlert({ candidate: candidate("approval"), mode: "off", ...quietScreen }),
    ).toBeNull();
    expect(
      planMobileThreadAlert({
        candidate: candidate("approval"),
        mode: "off",
        appActive: false,
        visibleThread: null,
      }),
    ).toBeNull();
  });

  it("stays quiet about the thread on screen while the app is in front", () => {
    const onScreen = {
      candidate: candidate("completed"),
      mode: "notifications-and-sound",
    } as const;
    expect(
      planMobileThreadAlert({ ...onScreen, appActive: true, visibleThread: ref("thread-b") }),
    ).toBeNull();
    expect(
      planMobileThreadAlert({ ...onScreen, appActive: true, visibleThread: ref("thread-a") }),
    ).toMatchObject({ title: "Finished", sound: true });
    expect(
      planMobileThreadAlert({ ...onScreen, appActive: false, visibleThread: ref("thread-b") }),
    ).toMatchObject({ title: "Finished", sound: true });
  });

  it("plays the sound only in the sound mode", () => {
    for (const appActive of [true, false]) {
      expect(
        planMobileThreadAlert({
          candidate: candidate("failed"),
          mode: "notifications",
          appActive,
          visibleThread: null,
        })?.sound,
      ).toBe(false);
      expect(
        planMobileThreadAlert({
          candidate: candidate("failed"),
          mode: "notifications-and-sound",
          appActive,
          visibleThread: null,
        })?.sound,
      ).toBe(true);
    }
  });

  it("alerts for a delegated thread only when it waits for you", () => {
    for (const kind of ["completed", "failed", "plan-ready"] as const) {
      expect(
        planMobileThreadAlert({
          candidate: candidate(kind, { delegated: true }),
          mode: "notifications",
          ...quietScreen,
        }),
      ).toBeNull();
    }
    for (const kind of ["approval", "input"] as const) {
      expect(
        planMobileThreadAlert({
          candidate: candidate(kind, { delegated: true }),
          mode: "notifications",
          appActive: false,
          visibleThread: null,
        }),
      ).not.toBeNull();
    }
  });
});

describe("opening a thread alert", () => {
  it("links to the thread route", () => {
    expect(threadAlertLinkPath(ref("thread-b"))).toBe("threads/environment-alerts/thread-b");
    expect(
      threadAlertLinkPath({
        environmentId: EnvironmentId.make("env/one"),
        threadId: ThreadId.make("thread b"),
      }),
    ).toBe("threads/env%2Fone/thread%20b");
  });

  it("reads the thread back from the notification's data and ignores other data", () => {
    expect(threadAlertRefOf({ environmentId: "environment-alerts", threadId: "thread-b" })).toEqual(
      ref("thread-b"),
    );
    for (const data of [
      null,
      undefined,
      "thread-b",
      {},
      { environmentId: "environment-alerts" },
      { environmentId: "environment-alerts", threadId: 7 },
      { environmentId: " ", threadId: "thread-b" },
    ]) {
      expect(threadAlertRefOf(data)).toBeNull();
    }
  });
});
