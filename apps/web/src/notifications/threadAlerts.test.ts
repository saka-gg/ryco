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
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@ryco/contracts/settings";
import type { EnvironmentConnection, ShellAcceptance } from "@ryco/client-runtime/connection";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { threadNotificationTag } from "@ryco/client-runtime/state/settings";
import {
  mapThreadShellSummary,
  type SidebarThreadOrStub,
  type ThreadNotificationSource,
} from "@ryco/client-runtime/state/threads";
import { isThreadSnoozed } from "@ryco/shared/threadSnooze";
import { describe, expect, it, vi } from "vite-plus/test";

import { stackedThreadToast } from "../components/ui/toastHelpers";
import type { ThreadAlertAudioContext } from "./threadAlertSound";
import { startThreadAlerts, type ThreadAlertsPlatform } from "./threadAlerts";

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

const finished = (id: string, overrides: Partial<OrchestrationThreadShell> = {}) =>
  shell(id, { latestTurn: turn("completed"), ...overrides });
const ref = (id: string): ScopedThreadRef => scopeThreadRef(env, ThreadId.make(id));

/** A quiet audio context that counts the notes it plays. */
function fakeAudio() {
  const audio = {
    notes: 0,
    state: "running",
    currentTime: 0,
    destination: {},
    resume: async () => undefined,
    close: async () => undefined,
    createOscillator: () => ({
      type: "sine",
      frequency: { setValueAtTime: () => (audio.notes += 1) },
      connect: (node: unknown) => node,
      start: () => undefined,
      stop: () => undefined,
    }),
    createGain: () => ({
      gain: { setValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined },
      connect: (node: unknown) => node,
    }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return audio;
}

/**
 * One connected environment whose accepted shell is current, the app around
 * the alerts (settings, toasts, route), and the browser they run in.
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

  let settings: ClientSettings | null = DEFAULT_CLIENT_SETTINGS;
  const settingsListeners = new Set<() => void>();
  let visible: ReadonlyArray<ScopedThreadRef> = [];
  let phoneTier = false;
  let appFocused = true;
  let permission: NotificationPermission = "granted";
  const focusListeners = new Set<() => void>();
  const audio = fakeAudio();
  const webNotifications: Array<{
    readonly title: string;
    readonly body: string;
    readonly tag: string;
    readonly onClick: () => void;
    readonly close: ReturnType<typeof vi.fn>;
  }> = [];
  let toastCount = 0;
  const toastManager = {
    add: vi.fn((_options: unknown) => `toast-${(toastCount += 1)}`),
    close: vi.fn((_id?: string) => undefined),
  };
  const navigateToThread = vi.fn((_ref: ScopedThreadRef) => undefined);
  const platform: ThreadAlertsPlatform = {
    readAppFocused: () => appFocused,
    subscribeWindowFocus: (listener) => {
      focusListeners.add(listener);
      return () => focusListeners.delete(listener);
    },
    focusWindow: vi.fn(),
    showWebNotification: ({ title, body, tag, onClick, onClose }) => {
      if (permission !== "granted") return null;
      const notification = { title, body, tag, onClick, close: vi.fn(onClose) };
      webNotifications.push(notification);
      return notification;
    },
    desktopBridge: undefined,
    createAudioContext: () => audio as unknown as ThreadAlertAudioContext,
    gestureTarget: new EventTarget(),
    hasUserActivation: () => true,
  };

  const start = (overrides: Partial<ThreadAlertsPlatform> = {}) =>
    startThreadAlerts(
      {
        source,
        readEnvironmentThreads: () => Array.from(rows.values()),
        isThreadSnoozed,
        readSettings: () => settings,
        subscribeSettings: (listener) => {
          settingsListeners.add(listener);
          return () => settingsListeners.delete(listener);
        },
        toastManager,
        stackedThreadToast,
        navigateToThread,
        readVisibleThreadRefs: () => visible,
        isPhoneTier: () => phoneTier,
      },
      { ...platform, ...overrides },
    );

  return {
    start,
    toastManager,
    navigateToThread,
    platform,
    webNotifications,
    audio,
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
    setSettings: (next: ClientSettings | null) => {
      settings = next;
      for (const listener of Array.from(settingsListeners)) listener();
    },
    patchSettings: (patch: Partial<ClientSettings>) => {
      settings = { ...DEFAULT_CLIENT_SETTINGS, ...settings, ...patch };
      for (const listener of Array.from(settingsListeners)) listener();
    },
    setVisible: (refs: ReadonlyArray<ScopedThreadRef>) => {
      visible = refs;
    },
    setPhoneTier: (next: boolean) => {
      phoneTier = next;
    },
    setAppFocused: (next: boolean) => {
      appFocused = next;
    },
    setPermission: (next: NotificationPermission) => {
      permission = next;
    },
    focusWindow: () => {
      for (const listener of Array.from(focusListeners)) listener();
    },
  };
}

type AddedToast = ReturnType<typeof stackedThreadToast>;
const addedToasts = (test: ReturnType<typeof harness>) =>
  test.toastManager.add.mock.calls.map(([options]) => options as AddedToast);

describe("thread alerts", () => {
  it("shows an Open thread toast for another thread while Ryco is in front", async () => {
    const test = harness({ threads: [shell("a"), shell("b")] });
    test.setVisible([ref("a")]);
    test.start();

    test.accept(finished("b"));
    await test.settle();
    const [toast, ...rest] = addedToasts(test);
    expect(rest).toEqual([]);
    expect(toast).toMatchObject({
      type: "success",
      title: "Finished",
      description: "Thread b",
      timeout: 0,
      data: { hideCopyButton: true, dismissAfterVisibleMs: 10_000, actionVariant: "outline" },
    });
    expect(toast?.data?.threadRef).toBeUndefined();
    expect(test.webNotifications).toEqual([]);

    expect(toast?.actionProps?.children).toBe("Open thread");
    toast?.actionProps?.onClick?.({} as never);
    expect(test.navigateToThread).toHaveBeenCalledWith({
      environmentId: env,
      threadId: ThreadId.make("b"),
    });
    expect(test.toastManager.close).toHaveBeenCalledWith("toast-1");
  });

  it("stays quiet about the thread on screen", async () => {
    const test = harness({ threads: [shell("b")] });
    test.patchSettings({ threadNotificationSound: true });
    test.setVisible([ref("b")]);
    test.start();

    test.accept(finished("b"));
    await test.settle();
    expect(test.toastManager.add).not.toHaveBeenCalled();
    expect(test.audio.notes).toBe(0);
  });

  it("notifies through the browser while Ryco is in the background", async () => {
    const test = harness({ threads: [shell("b")] });
    test.setAppFocused(false);
    test.start();

    test.accept(finished("b"));
    await test.settle();
    expect(test.toastManager.add).not.toHaveBeenCalled();
    const [notification] = test.webNotifications;
    expect(notification).toMatchObject({
      title: "Finished",
      body: "Thread b",
      tag: threadNotificationTag(ref("b")),
    });
    expect(notification?.tag).toMatch(/^[0-9a-f]{16}$/);

    notification?.onClick();
    expect(test.platform.focusWindow).toHaveBeenCalled();
    expect(test.navigateToThread).toHaveBeenCalledWith(ref("b"));
    expect(notification?.close).toHaveBeenCalled();
  });

  it("closes browser notifications when Ryco gets focus again", async () => {
    const test = harness({ threads: [shell("b")] });
    test.setAppFocused(false);
    test.start();
    test.accept(finished("b"));
    await test.settle();

    test.focusWindow();
    expect(test.webNotifications[0]?.close).toHaveBeenCalled();
  });

  it("shows no browser notification without permission", async () => {
    const test = harness({ threads: [shell("b")] });
    test.setAppFocused(false);
    test.setPermission("denied");
    test.start();

    test.accept(finished("b"));
    await test.settle();
    expect(test.webNotifications).toEqual([]);
  });

  it("notifies through the desktop app when it runs there", async () => {
    const test = harness({ threads: [shell("b")] });
    const notifyTurnComplete = vi.fn(async () => undefined);
    test.setAppFocused(false);
    test.start({ desktopBridge: { notifyTurnComplete } });

    test.accept(finished("b"));
    await test.settle();
    expect(notifyTurnComplete).toHaveBeenCalledWith({
      threadId: ThreadId.make("b"),
      environmentId: env,
      title: "Finished",
      body: "Thread b",
    });
    expect(test.webNotifications).toEqual([]);
  });

  it("drops an alert whose shell was replaced before it was delivered", async () => {
    const test = harness({ threads: [shell("b")] });
    test.start();

    test.accept(finished("b"));
    test.reconnect();
    await test.settle();
    expect(test.toastManager.add).not.toHaveBeenCalled();
  });

  it("keeps one toast per thread", async () => {
    const test = harness({ threads: [shell("b")] });
    test.start();

    test.accept(shell("b", { hasPendingApprovals: true }));
    await test.settle();
    test.accept(finished("b"));
    await test.settle();
    expect(addedToasts(test).map((toast) => toast.title)).toEqual(["Needs approval", "Finished"]);
    expect(test.toastManager.close).toHaveBeenCalledWith("toast-1");
  });

  it("closes a thread's toast when it comes on screen", async () => {
    const test = harness({ threads: [shell("b")] });
    const alerts = test.start();
    test.accept(finished("b"));
    await test.settle();

    test.setVisible([ref("b")]);
    alerts.syncVisibleThreads();
    expect(test.toastManager.close).toHaveBeenCalledWith("toast-1");
  });

  it("waits for settings to load and stops while every alert is off", async () => {
    const test = harness({ threads: [shell("b"), shell("c"), shell("d")] });
    test.setSettings(null);
    test.start();
    test.accept(finished("b"));
    await test.settle();

    test.setSettings({
      ...DEFAULT_CLIENT_SETTINGS,
      notifyOnTurnCompleteWhenUnfocused: false,
      threadNotificationToasts: false,
    });
    test.accept(finished("c"));
    await test.settle();
    expect(test.toastManager.add).not.toHaveBeenCalled();

    // Turned back on, the feed starts from what is already finished.
    test.patchSettings({ threadNotificationToasts: true });
    await test.settle();
    expect(test.toastManager.add).not.toHaveBeenCalled();
    test.accept(finished("d"));
    await test.settle();
    expect(addedToasts(test).map((toast) => toast.description)).toEqual(["Thread d"]);
  });

  it("alerts nothing on the phone tier", async () => {
    const test = harness({ threads: [shell("b")] });
    test.setPhoneTier(true);
    test.setAppFocused(false);
    test.patchSettings({ threadNotificationSound: true });
    test.start();

    test.accept(finished("b"));
    await test.settle();
    expect(test.toastManager.add).not.toHaveBeenCalled();
    expect(test.webNotifications).toEqual([]);
    expect(test.audio.notes).toBe(0);
  });

  it("alerts about a delegated thread only when it waits for you", async () => {
    const lineage = {
      parentThreadId: ThreadId.make("parent"),
      rootThreadId: ThreadId.make("parent"),
      relationship: "delegated",
    };
    const test = harness({ threads: [shell("child", { lineage }), shell("other", { lineage })] });
    test.start();

    test.accept(finished("child", { lineage }));
    test.accept(shell("other", { lineage, hasPendingApprovals: true }));
    await test.settle();
    expect(addedToasts(test).map((toast) => toast.description)).toEqual(["Thread other"]);
  });

  it("chimes in a sound mode for a thread that is not on screen", async () => {
    const test = harness({ threads: [shell("b")] });
    test.patchSettings({ threadNotificationSound: true });
    test.start();

    test.accept(finished("b"));
    await test.settle();
    expect(test.audio.notes).toBeGreaterThan(0);
  });

  it("closes what it showed when stopped", async () => {
    const test = harness({ threads: [shell("b"), shell("c")] });
    const alerts = test.start();
    test.accept(finished("b"));
    await test.settle();

    alerts.stop();
    expect(test.toastManager.close).toHaveBeenCalledWith("toast-1");
    test.accept(finished("c"));
    await test.settle();
    expect(test.toastManager.add).toHaveBeenCalledTimes(1);
  });
});
