import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationThreadShell,
  type ScopedThreadRef,
} from "@ryco/contracts";
import type { EnvironmentConnection, ShellAcceptance } from "@ryco/client-runtime/connection";
import { threadNotificationTag } from "@ryco/client-runtime/state/settings";
import {
  mapThreadShellSummary,
  type SidebarThreadOrStub,
  type ThreadNotificationSource,
} from "@ryco/client-runtime/state/threads";
import { describe, expect, it, vi } from "vite-plus/test";

// The tests pass their own platform; the native modules only need to load.
vi.mock("expo-notifications", () => ({}));
vi.mock("expo-linking", () => ({}));
vi.mock("react-native", () => ({}));

import type { Preferences } from "../state/preferencesStore";
import type { MobileThreadAlert } from "./threadAlerts.logic";
import { startMobileThreadAlerts, type MobileThreadAlertsPlatform } from "./threadAlerts";

const env = EnvironmentId.make("environment-alerts");
const T0 = "2026-10-20T10:00:00.000Z";
const T1 = "2026-10-20T11:00:00.000Z";

function turn(state: OrchestrationLatestTurn["state"]): OrchestrationLatestTurn {
  return {
    turnId: TurnId.make("turn-1"),
    state,
    requestedAt: T0,
    startedAt: T0,
    completedAt: state === "running" ? null : T1,
    assistantMessageId: null,
  };
}

function shell(
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-alerts"),
    title: `Thread ${id}`,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: turn("running"),
    goal: null,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: T0,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

const finished = (id: string) => shell(id, { latestTurn: turn("completed") });
const ref = (id: string): ScopedThreadRef => ({ environmentId: env, threadId: ThreadId.make(id) });

/**
 * One connected environment whose accepted shell is current, the app's
 * preferences and screen, and a native platform that records what it posts.
 */
function harness(input: { readonly threads?: ReadonlyArray<OrchestrationThreadShell> } = {}) {
  let token: object | null = {};
  let sequence = 10;
  const rows = new Map<ThreadId, SidebarThreadOrStub>();
  for (const thread of input.threads ?? []) rows.set(thread.id, mapThreadShellSummary(thread, env));
  const acceptanceListeners = new Set<(acceptance: ShellAcceptance) => void>();
  const connection = {
    environmentId: env,
    shellSnapshotReadiness: { read: () => token, subscribe: () => () => undefined },
  } as unknown as EnvironmentConnection;
  const source: ThreadNotificationSource = {
    subscribe: () => () => undefined,
    list: () => [connection],
    read: (environmentId) => (environmentId === env ? connection : null),
    readShellProjectionSequence: () => sequence,
    subscribeShellAcceptance: (listener) => {
      acceptanceListeners.add(listener);
      return () => acceptanceListeners.delete(listener);
    },
  };

  let preferences: Preferences = { threadAlerts: true };
  const preferenceListeners = new Set<() => void>();
  let visibleThread: ScopedThreadRef | null = null;
  let appActive = true;
  let ready: Promise<void> = Promise.resolve();
  const presented: MobileThreadAlert[] = [];
  const openedListeners = new Set<(data: unknown) => void>();
  const stopForeground = vi.fn();
  const platform: MobileThreadAlertsPlatform = {
    isAppActive: () => appActive,
    prepare: () => ready,
    present: async (alert) => {
      presented.push(alert);
    },
    presentInForeground: vi.fn(() => stopForeground),
    subscribeOpened: (listener) => {
      openedListeners.add(listener);
      return () => openedListeners.delete(listener);
    },
    openThread: vi.fn(),
  };

  return {
    platform,
    presented,
    stopForeground,
    start: () =>
      startMobileThreadAlerts(
        {
          source,
          readEnvironmentThreads: () => Array.from(rows.values()),
          readPreferences: () => preferences,
          subscribePreferences: (listener) => {
            preferenceListeners.add(listener);
            return () => preferenceListeners.delete(listener);
          },
          readVisibleThread: () => visibleThread,
        },
        platform,
      ),
    /** The stream accepts a newer shell of one thread. */
    accept: (thread: OrchestrationThreadShell) => {
      sequence += 1;
      rows.set(thread.id, mapThreadShellSummary(thread, env));
      const acceptance: ShellAcceptance = {
        kind: "events",
        environmentId: env,
        events: [{ kind: "thread-upserted", sequence, thread }],
      };
      for (const listener of Array.from(acceptanceListeners)) listener(acceptance);
    },
    /** A new socket attempt replaces the shell the pending alerts came from. */
    reconnect: () => {
      token = {};
    },
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
    setPreferences: (next: Preferences) => {
      preferences = next;
      for (const listener of Array.from(preferenceListeners)) listener();
    },
    setVisibleThread: (next: ScopedThreadRef | null) => {
      visibleThread = next;
    },
    setAppActive: (next: boolean) => {
      appActive = next;
    },
    /** The platform readies itself only once `release` runs. */
    holdReady: () => {
      let release!: () => void;
      ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release();
    },
    /** The user opens a notification carrying `data`. */
    open: (data: unknown) => {
      for (const listener of Array.from(openedListeners)) listener(data);
    },
  };
}

describe("mobile thread alerts", () => {
  it("posts one notification for a thread that finishes elsewhere", async () => {
    const test = harness({ threads: [shell("a"), shell("b")] });
    test.setVisibleThread(ref("a"));
    test.start();
    expect(test.platform.presentInForeground).toHaveBeenCalledOnce();

    test.accept(finished("b"));
    await test.settle();
    expect(test.presented).toEqual([
      {
        identifier: threadNotificationTag(ref("b")),
        title: "Finished",
        body: "Thread b",
        sound: false,
        ref: ref("b"),
      },
    ]);
  });

  it("stays quiet about the thread on screen until the app leaves the front", async () => {
    const test = harness({ threads: [shell("b"), shell("c")] });
    test.setVisibleThread(ref("b"));
    test.start();
    test.accept(finished("b"));
    await test.settle();
    expect(test.presented).toEqual([]);

    test.setAppActive(false);
    test.setVisibleThread(ref("c"));
    test.accept(finished("c"));
    await test.settle();
    expect(test.presented.map((alert) => alert.ref)).toEqual([ref("c")]);
  });

  it("plays the sound when alert sound is on", async () => {
    const test = harness({ threads: [shell("b")] });
    test.setPreferences({ threadAlerts: true, threadAlertSound: true });
    test.start();
    test.accept(shell("b", { hasPendingApprovals: true }));
    await test.settle();
    expect(test.presented).toMatchObject([{ title: "Needs approval", sound: true }]);
  });

  it("runs only while alerts are on, and starts from what is already finished", async () => {
    const test = harness({ threads: [shell("b"), shell("c"), shell("d")] });
    test.setPreferences({ threadAlertSound: true });
    test.start();
    test.accept(finished("b"));
    await test.settle();
    expect(test.presented).toEqual([]);

    test.setPreferences({ threadAlerts: true });
    await test.settle();
    expect(test.presented).toEqual([]);
    test.accept(finished("c"));
    await test.settle();
    expect(test.presented.map((alert) => alert.body)).toEqual(["Thread c"]);

    test.setPreferences({ threadAlerts: false });
    test.accept(finished("d"));
    await test.settle();
    expect(test.presented.map((alert) => alert.body)).toEqual(["Thread c"]);
  });

  it("drops an alert whose shell was replaced while the platform got ready", async () => {
    const test = harness({ threads: [shell("b")] });
    const release = test.holdReady();
    test.start();
    test.accept(finished("b"));
    await test.settle();

    test.reconnect();
    release();
    await test.settle();
    expect(test.presented).toEqual([]);
  });

  it("opens the thread of an opened notification, with alerts on or off", () => {
    const test = harness();
    const alerts = test.start();

    test.open({ environmentId: env, threadId: "thread-b" });
    expect(test.platform.openThread).toHaveBeenCalledWith({
      environmentId: env,
      threadId: ThreadId.make("thread-b"),
    });

    test.setPreferences({ threadAlerts: false });
    test.open({ environmentId: env, threadId: "thread-c" });
    test.open({ url: "https://example.com" });
    expect(vi.mocked(test.platform.openThread).mock.calls).toEqual([
      [{ environmentId: env, threadId: ThreadId.make("thread-b") }],
      [{ environmentId: env, threadId: ThreadId.make("thread-c") }],
    ]);

    alerts.stop();
    test.open({ environmentId: env, threadId: "thread-d" });
    expect(test.platform.openThread).toHaveBeenCalledTimes(2);
  });

  it("posts nothing once stopped", async () => {
    const test = harness({ threads: [shell("b")] });
    const alerts = test.start();
    alerts.stop();
    expect(test.stopForeground).toHaveBeenCalledOnce();

    test.accept(finished("b"));
    await test.settle();
    expect(test.presented).toEqual([]);
  });
});
