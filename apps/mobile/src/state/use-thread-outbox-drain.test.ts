import type { CommandId, EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("expo-linking", () => ({ getInitialURL: async () => null }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "id" }));
const fakeApi = vi.hoisted(() => ({
  dispatchCommand: vi.fn(async (_command: unknown) => undefined),
  getThreadWindow: vi.fn(async () => {
    throw new Error("the subscribed state should have cleared this send");
  }),
}));
vi.mock("../connection/environmentApi", () => ({
  ensureEnvironmentApi: () => ({ orchestration: fakeApi }),
}));
vi.mock("../runtime/bootstrap", () => ({
  createMobileConnectionRegistry: () => ({ driver: { supervisor: { read: () => null } } }),
}));

import {
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionOpened,
  resetWsConnectionStateForTests,
} from "@ryco/client-runtime/rpc";

import type { QueueSendHooks } from "@ryco/client-runtime/state/message-queue";

import {
  drainThreadOutbox,
  enqueueThreadOutboxMessage,
  listThreadOutboxMessages,
  resetThreadOutboxForTests,
} from "./threadOutbox";
import type { QueuedThreadMessage } from "./threadOutboxModel";
import {
  createOutboxLimitWake,
  createThreadOutboxDetailRetention,
  readThreadDrainState,
  sendQueuedThreadMessage,
} from "./use-thread-outbox-drain";
import { writeEnvironmentServerConfig } from "./environmentServerConfigs";

const ENV_A = "env-node-a" as EnvironmentId;
const ENV_B = "env-node-b" as EnvironmentId;

const drainEnvironment = (environmentId: EnvironmentId) =>
  readThreadDrainState({ environmentId, threadId: "t1" as ThreadId }).environment;

function queuedFor(environmentId: EnvironmentId): QueuedThreadMessage {
  return {
    environmentId,
    threadId: "t1" as ThreadId,
    messageId: `m-${environmentId}` as MessageId,
    commandId: "c1" as CommandId,
    text: "queued while offline",
    attachments: [],
    createdAt: "2026-08-19T10:00:00.000Z",
  };
}

/** Simulate each environment's socket lifecycle the way the instrumented mobile
 * transports record it (attempt/opened/closed carrying the owning environment). */
function connectEnvironment(environmentId: EnvironmentId, url: string): void {
  recordWsConnectionAttempt(url, { connectionLabel: environmentId, environmentId });
  recordWsConnectionOpened({ connectionLabel: environmentId, environmentId });
}

function dropEnvironment(environmentId: EnvironmentId): void {
  recordWsConnectionClosed({ code: 1006, reason: "server stopped" }, { environmentId });
}

beforeEach(() => resetWsConnectionStateForTests());

/** A live shell snapshot for the environment: the readiness gate also needs it. */
async function bootstrapShell(...environmentIds: EnvironmentId[]): Promise<() => void> {
  const { useStore } = await import("./threadsRuntime");
  for (const environmentId of environmentIds) {
    useStore.getState().syncServerShellSnapshot(
      {
        snapshotSequence: 1,
        projects: [],
        worktrees: [],
        threads: [],
        updatedAt: "2026-08-23T00:00:00.000Z",
      } as never,
      environmentId,
    );
  }
  return () => {
    for (const environmentId of environmentIds) {
      useStore.getState().removeEnvironmentState(environmentId);
    }
  };
}

describe("outbox drain gate (two environments)", () => {
  it("does not judge a message for a disconnected environment drainable because another environment is connected", () => {
    // Node A connects, then its server stops.
    connectEnvironment(ENV_A, "ws://node-a.local:13773/ws");
    dropEnvironment(ENV_A);
    // Node B connects afterwards — the last writer to any global status.
    connectEnvironment(ENV_B, "ws://node-b.local:13774/ws");

    // The queued message targets node A, which is offline. It must stay queued.
    expect(drainEnvironment(ENV_A).mutationReady).toBe(false);
  });

  it("judges a message for the connected environment drainable (positive control)", async () => {
    const cleanup = await bootstrapShell(ENV_A, ENV_B);
    connectEnvironment(ENV_A, "ws://node-a.local:13773/ws");
    dropEnvironment(ENV_A);
    connectEnvironment(ENV_B, "ws://node-b.local:13774/ws");

    expect(drainEnvironment(ENV_B).mutationReady).toBe(true);
    expect(drainEnvironment(ENV_A).mutationReady).toBe(false);
    cleanup();
  });

  it("delivers once the message's own environment reconnects", async () => {
    const cleanup = await bootstrapShell(ENV_A, ENV_B);
    connectEnvironment(ENV_B, "ws://node-b.local:13774/ws");
    connectEnvironment(ENV_A, "ws://node-a.local:13773/ws");
    dropEnvironment(ENV_A);
    expect(drainEnvironment(ENV_A).mutationReady).toBe(false);

    // Node A comes back; its own slot — not node B's — must open the gate.
    connectEnvironment(ENV_A, "ws://node-a.local:13773/ws");
    expect(drainEnvironment(ENV_A).mutationReady).toBe(true);
    expect(drainEnvironment(ENV_B).mutationReady).toBe(true);
    cleanup();
  });

  it("uses the queued environment's shell readiness rather than the active environment", async () => {
    const { useStore } = await import("./threadsRuntime");
    const emptySnapshot = {
      snapshotSequence: 1,
      projects: [],
      worktrees: [],
      threads: [],
      updatedAt: "2026-08-23T00:00:00.000Z",
    } as never;

    // B is the active, fully bootstrapped node. A's socket is open but its
    // first authoritative shell snapshot has not landed yet.
    useStore.getState().syncServerShellSnapshot(emptySnapshot, ENV_B);
    useStore.getState().setActiveEnvironmentId(ENV_B);
    connectEnvironment(ENV_A, "ws://node-a.local:13773/ws");
    connectEnvironment(ENV_B, "ws://node-b.local:13774/ws");

    expect(drainEnvironment(ENV_A)).toEqual({ shellLive: false, mutationReady: false });
    expect(drainEnvironment(ENV_B)).toEqual({ shellLive: true, mutationReady: true });

    useStore.getState().removeEnvironmentState(ENV_A);
    useStore.getState().removeEnvironmentState(ENV_B);
  });

  it("never treats a cache-hydrated thread row as delivery-reconciled (wave 2)", async () => {
    const { useStore } = await import("./threadsRuntime");
    const { resolveQueueDrainStep } = await import("@ryco/client-runtime/state/message-queue");
    // Cold start: node A's rows come from the snapshot cache; its socket then
    // opens one RTT before the live shell snapshot lands. The cached idle row
    // must not read as "exists, not busy" — the message waits for the live
    // snapshot to clear the provenance stamp.
    useStore.getState().hydrateEnvironmentStateFromCache(
      {
        capturedAt: 1,
        projects: [],
        worktrees: [],
        threads: [
          {
            shell: {
              id: "t1",
              environmentId: ENV_A,
              codexThreadId: null,
              projectId: "p1",
              title: "cached",
              modelSelection: { model: "claude" },
              runtimeMode: "full-access",
              interactionMode: "default",
              error: null,
              createdAt: "2026-08-19T00:00:00.000Z",
              archivedAt: null,
              branch: null,
              worktreePath: null,
            },
            summary: {
              id: "t1",
              environmentId: ENV_A,
              projectId: "p1",
              title: "cached",
              interactionMode: "default",
              session: null,
              createdAt: "2026-08-19T00:00:00.000Z",
              archivedAt: null,
              latestTurn: null,
              branch: null,
              worktreePath: null,
              latestUserMessageAt: null,
              hasPendingApprovals: false,
              hasPendingUserInput: false,
              hasActionableProposedPlan: false,
            },
          },
        ],
      } as never,
      ENV_A,
    );
    connectEnvironment(ENV_A, "ws://node-a.local:13773/ws");

    const drain = readThreadDrainState({ environmentId: ENV_A, threadId: "t1" as ThreadId });
    expect(drain.view).not.toBeNull();
    expect(drain.environment).toEqual({ shellLive: false, mutationReady: false });
    expect(
      resolveQueueDrainStep({
        nowIso: "2026-08-19T10:00:00.000Z",
        queue: [{ id: queuedFor(ENV_A).messageId }],
        steerAttempts: {},
        hold: null,
        acknowledgedCauseKeys: [],
        headProviderInstanceId: null,
        view: drain.view,
        draft: false,
        environment: drain.environment,
        pendingDispatch: null,
        dispatchedMessageIds: new Set(),
        sender: "background",
      }),
    ).toEqual({ kind: "wait", reason: "environment" });

    useStore.getState().removeEnvironmentState(ENV_A);
  });

  it("treats an environment with no recorded socket as not connected", () => {
    connectEnvironment(ENV_B, "ws://node-b.local:13774/ws");

    expect(drainEnvironment(ENV_A).mutationReady).toBe(false);
  });
});

describe("outbox drain after a cold start with cached conversation text", () => {
  const environmentId = "env-cold-start" as EnvironmentId;
  const threadId = "t-cold" as ThreadId;
  const ref = { environmentId, threadId };
  const AT = "2026-08-19T10:00:00.000Z";
  const earlierMessage = {
    id: "m-earlier",
    role: "user",
    text: "an earlier question",
    createdAt: AT,
    completedAt: AT,
    turnId: null,
    streaming: false,
  };
  const queuedMessage: QueuedThreadMessage = {
    ...queuedFor(environmentId),
    threadId,
    messageId: "m-queued" as MessageId,
  };
  const wireThread = {
    id: threadId,
    projectId: "p1",
    title: "Cold start",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    worktreeId: null,
    manualStatusBucket: null,
    manualPosition: 0,
    latestTurn: null,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: AT,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
  const shellSnapshot = {
    snapshotSequence: 1,
    projects: [],
    worktrees: [],
    threads: [wireThread],
    updatedAt: AT,
  } as never;
  const threadWindow = (messages: ReadonlyArray<Record<string, unknown>>) =>
    ({
      ...wireThread,
      deletedAt: null,
      messages: messages.map((message) => ({ ...message, updatedAt: AT })),
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    }) as never;

  /**
   * The cached shell and text hydrate first, then the live shell lands and the
   * socket opens, but the thread's own window has not arrived. The cached text
   * predates the queued message, so it cannot say whether it was delivered.
   */
  async function coldStartBeforeLiveWindow() {
    const { useStore } = await import("./threadsRuntime");
    const store = useStore.getState();
    store.syncServerShellSnapshot(shellSnapshot, environmentId);
    const live = useStore.getState().environmentStateById[environmentId]!;
    const row = {
      shell: live.threadShellById[threadId]!,
      summary: live.sidebarThreadSummaryById[threadId]!,
    };
    store.removeEnvironmentState(environmentId);
    store.hydrateEnvironmentStateFromCache(
      {
        capturedAt: 1,
        projects: [],
        worktrees: [],
        threads: [{ ...row, content: { messages: [earlierMessage] } }],
      } as never,
      environmentId,
    );
    store.syncServerShellSnapshot(shellSnapshot, environmentId);
    connectEnvironment(environmentId, "ws://node-cold.local:13775/ws");

    resetThreadOutboxForTests();
    enqueueThreadOutboxMessage(queuedMessage);
    const sendQueuedMessage = vi.fn(
      async (_message: QueuedThreadMessage, hooks: QueueSendHooks) => {
        hooks.onBeforeTurnStart();
      },
    );
    return {
      store,
      sendQueuedMessage,
      drain: () => drainThreadOutbox({ readThreadDrainState, sendQueuedMessage }),
      cleanup: () => {
        resetThreadOutboxForTests();
        store.removeEnvironmentState(environmentId);
      },
    };
  }

  it("sends nothing until the thread's live window arrives, then drops a message it already holds", async () => {
    const { store, sendQueuedMessage, drain, cleanup } = await coldStartBeforeLiveWindow();
    try {
      const waiting = readThreadDrainState(ref);
      expect(waiting.environment).toEqual({ shellLive: true, mutationReady: true });
      expect(waiting.view?.detailLoaded).toBe(false);
      expect([...(waiting.view?.projectedMessageIds ?? [])]).toEqual([]);
      await drain();
      expect(sendQueuedMessage).not.toHaveBeenCalled();
      expect(listThreadOutboxMessages()).toHaveLength(1);

      // The send reached the node before the app was killed: the live window
      // shows it, so it is removed rather than sent a second time.
      store.syncServerThreadDetail(
        threadWindow([earlierMessage, { ...earlierMessage, id: queuedMessage.messageId }]),
        environmentId,
      );
      await drain();
      expect(sendQueuedMessage).not.toHaveBeenCalled();
      expect(listThreadOutboxMessages()).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("sends once the live window shows the message was not delivered", async () => {
    const { store, sendQueuedMessage, drain, cleanup } = await coldStartBeforeLiveWindow();
    try {
      await drain();
      expect(sendQueuedMessage).not.toHaveBeenCalled();

      store.syncServerThreadDetail(threadWindow([earlierMessage]), environmentId);
      await drain();
      expect(sendQueuedMessage).toHaveBeenCalledTimes(1);
      expect(sendQueuedMessage.mock.calls[0]?.[0].messageId).toBe(queuedMessage.messageId);
    } finally {
      cleanup();
    }
  });
});

describe("wsUiStateForEnvironment (device-offline overlay)", () => {
  it("reads offline for a never-connected environment when the device is offline", async () => {
    const { getWsConnectionStatusForEnvironment, setBrowserOnlineStatus } =
      await import("@ryco/client-runtime/rpc");
    const { wsUiStateForEnvironment } = await import("../rpc/wsConnectionState");

    connectEnvironment(ENV_A, "ws://node-a.local:13773/ws");
    setBrowserOnlineStatus(false);
    dropEnvironment(ENV_A);

    // Node A's own slot recorded the disconnect; node B never attempted a
    // socket this session. Both must read "offline" in airplane mode.
    expect(wsUiStateForEnvironment(getWsConnectionStatusForEnvironment(ENV_A))).toBe("offline");
    expect(wsUiStateForEnvironment(getWsConnectionStatusForEnvironment(ENV_B))).toBe("offline");

    setBrowserOnlineStatus(true);
    expect(wsUiStateForEnvironment(getWsConnectionStatusForEnvironment(ENV_B))).not.toBe("offline");
  });

  it("never masks a live socket", async () => {
    const { getWsConnectionStatusForEnvironment, setBrowserOnlineStatus } =
      await import("@ryco/client-runtime/rpc");
    const { wsUiStateForEnvironment } = await import("../rpc/wsConnectionState");

    connectEnvironment(ENV_A, "ws://node-a.local:13773/ws");
    setBrowserOnlineStatus(false);

    expect(wsUiStateForEnvironment(getWsConnectionStatusForEnvironment(ENV_A))).toBe("connected");
  });
});

describe("outbox thread-detail retention", () => {
  it("retains detail only for queued threads whose environment is connected", () => {
    let messages: QueuedThreadMessage[] = [queuedFor(ENV_A), queuedFor(ENV_B)];
    const ready = new Set<string>([ENV_B]);
    const releases = new Map<string, ReturnType<typeof vi.fn>>();
    const retain = vi.fn((ref: { environmentId: string; threadId: string }) => {
      const release = vi.fn();
      releases.set(ref.environmentId, release);
      return release;
    });
    const retention = createThreadOutboxDetailRetention({
      listMessages: () => messages,
      isEnvironmentReady: (environmentId) => ready.has(environmentId),
      retain,
    });

    retention.sync();
    expect(retain.mock.calls.map(([ref]) => ref.environmentId)).toEqual([ENV_B]);

    ready.add(ENV_A);
    retention.sync();
    expect(retain.mock.calls.map(([ref]) => ref.environmentId)).toEqual([ENV_B, ENV_A]);

    // Disconnects and drained queues release; nothing is retained twice.
    ready.delete(ENV_B);
    messages = [];
    retention.sync();
    expect(releases.get(ENV_A)).toHaveBeenCalledTimes(1);
    expect(releases.get(ENV_B)).toHaveBeenCalledTimes(1);
    retention.sync();
    expect(retain).toHaveBeenCalledTimes(2);
    retention.dispose();
  });
});

describe("outbox usage-limit wake", () => {
  it("keeps one timer for the earliest release and replaces it on each pass", () => {
    const run = vi.fn();
    const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = [];
    const wake = createOutboxLimitWake({
      run,
      setTimeout: (callback, ms) => {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (handle) => {
        (handle as { cleared: boolean }).cleared = true;
      },
    });
    wake.sync(10_000, 4_000);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(6_000);
    wake.sync(10_000, 5_000);
    expect(timers).toHaveLength(1);
    wake.sync(8_000, 5_000);
    expect(timers[0]?.cleared).toBe(true);
    expect(timers[1]?.ms).toBe(3_000);
    timers[1]?.callback();
    expect(run).toHaveBeenCalledTimes(1);
    wake.sync(null, 9_000);
    expect(timers).toHaveLength(2);
  });
});

describe("queued Claude send", () => {
  it("reuses the subscribed thread state instead of a review window read", async () => {
    const environmentId = "env-claude" as EnvironmentId;
    const threadId = "t-claude" as ThreadId;
    const modelSelection = { instanceId: "claude-1", model: "claude-opus" } as never;
    writeEnvironmentServerConfig(environmentId, {
      providers: [{ instanceId: "claude-1", driver: "claudeAgent" }],
    } as never);
    const cleanup = await bootstrapShell(environmentId);
    const { useStore } = await import("./threadsRuntime");
    useStore.getState().syncServerThreadDetail(
      {
        id: threadId,
        projectId: "p1",
        title: "Claude",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/repo",
        worktreeId: null,
        manualStatusBucket: null,
        manualPosition: 0,
        latestTurn: null,
        createdAt: "2026-08-19T10:00:00.000Z",
        updatedAt: "2026-08-19T10:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: {
          threadId,
          status: "ready",
          providerName: "claudeAgent",
          runtimeSessionId: "runtime-1",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-08-19T10:00:00.000Z",
        },
      } as never,
      environmentId,
    );
    fakeApi.dispatchCommand.mockClear();
    fakeApi.getThreadWindow.mockClear();
    try {
      await sendQueuedThreadMessage(
        {
          ...queuedFor(environmentId),
          threadId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
        } as QueuedThreadMessage,
        { onBeforeTurnStart: () => undefined } as never,
      );
    } finally {
      cleanup();
    }

    expect(fakeApi.getThreadWindow).not.toHaveBeenCalled();
    expect(
      fakeApi.dispatchCommand.mock.calls.map((call) => (call[0] as { type: string }).type),
    ).toEqual(["thread.turn.start"]);
  });
});
