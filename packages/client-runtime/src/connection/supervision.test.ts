import type {
  EnvironmentId,
  OrchestrationEvent,
  OrchestrationSessionStatus,
  OrchestrationThreadWindowSnapshot,
  ScopedThreadRef,
  ThreadId,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ResumableSubscriptionOptions } from "../rpc/wsRpcClient.ts";
import type { SubscriptionFailureKind } from "../rpc/wsTransport.ts";
import { scopedThreadKey, scopeThreadRef } from "../scoped.ts";
import {
  applyOrchestrationEvent,
  demoteEnvironmentStateToCachedSnapshot,
  evictThreadBodies,
  hydrateEnvironmentStateFromCache,
  projectThreadReadCacheShell,
  syncServerShellSnapshot,
  syncServerThreadWindow,
  type AppState,
} from "../state/threads/store.ts";
import {
  isThreadNonIdle,
  selectThreadBodyUsage,
  THREAD_BODY_RECENT_ACCESS_MS,
  THREAD_BODY_RESIDENCY_BACKSTOP_MS,
  type ThreadBodyUsage,
} from "../state/threads/threadBodyResidency.ts";
import type { EnvironmentConnection } from "./connection.ts";
import {
  createEnvironmentConnectionSupervisor,
  type EnvironmentSupervisorInput,
  SAVED_ENVIRONMENT_CONNECT_TIMEOUT_MS,
  SavedEnvironmentCredentialError,
  savedEnvironmentRetryDelayMs,
} from "./supervision.ts";

type Record = { readonly environmentId: EnvironmentId; readonly lastConnectedAt?: string };

const remote = "env-remote" as EnvironmentId;

function makeSupervisor(
  connect: (
    record: Record,
    isCancelled: () => boolean,
    signal: AbortSignal,
  ) => Promise<EnvironmentConnection>,
  overrides: {
    readonly isHostedMode?: boolean;
    readonly records?: ReadonlyArray<Record>;
    readonly isSavedEnvironmentAwaitingRepair?: (environmentId: EnvironmentId) => boolean;
    readonly isThreadDetailSubscriptionNonIdle?: (
      environmentId: EnvironmentId,
      threadId: ThreadId,
    ) => boolean;
    readonly listThreadBodies?: () => ReadonlyArray<ThreadBodyUsage>;
    readonly evictThreadBodies?: (threadRefs: ReadonlyArray<ScopedThreadRef>) => void;
    readonly isThreadBodyProtected?: (threadRef: ScopedThreadRef) => boolean;
    readonly syncThreadWindowSnapshot?: (
      environmentId: EnvironmentId,
      snapshot: OrchestrationThreadWindowSnapshot,
    ) => void;
    readonly stateSink?: unknown;
    readonly scheduleShellFrame?: (callback: () => void) => void;
    readonly threadWindowActivityPayloads?: "preview";
    readonly disconnectSavedEnvironment?: (environmentId: EnvironmentId) => Promise<void>;
  } = {},
) {
  let resume: ((reason: string) => void) | null = null;
  let registryListener: (() => void) | null = null;
  const input = {
    isHostedMode: () => overrides.isHostedMode ?? false,
    syncThreadDetailSnapshot: () => undefined,
    syncThreadWindowSnapshot: overrides.syncThreadWindowSnapshot ?? (() => undefined),
    applyThreadDetailEvent: () => undefined,
    isThreadDetailSubscriptionNonIdle: overrides.isThreadDetailSubscriptionNonIdle ?? (() => true),
    listThreadBodies: overrides.listThreadBodies,
    evictThreadBodies: overrides.evictThreadBodies,
    isThreadBodyProtected: overrides.isThreadBodyProtected,
    now: () => Date.now(),
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
    clearTimeout: (timeoutId: ReturnType<typeof setTimeout>) => clearTimeout(timeoutId),
    createInvalidationThrottle: () => ({ maybeExecute: () => undefined, cancel: () => undefined }),
    resetProviderInvalidation: () => undefined,
    createPrimaryConnection: () => null,
    listSavedEnvironmentRecords: () => overrides.records ?? [{ environmentId: remote }],
    hasSavedEnvironmentRegistryHydrated: () => true,
    waitForSavedEnvironmentRegistryHydration: () => Promise.resolve(),
    subscribeSavedEnvironmentRegistry: (listener: () => void) => {
      registryListener = listener;
      return () => {
        registryListener = null;
      };
    },
    connectSavedEnvironment: (record: Record, isCancelled: () => boolean, signal: AbortSignal) =>
      connect(record, isCancelled, signal),
    isSavedEnvironmentAwaitingRepair: overrides.isSavedEnvironmentAwaitingRepair,
    disconnectSavedEnvironment: overrides.disconnectSavedEnvironment ?? (() => Promise.resolve()),
    waitForPrimaryShellSnapshotApplied: () => Promise.resolve(),
    subscribeBrowserResume: (listener: (reason: string) => void) => {
      resume = listener;
      return () => {
        resume = null;
      };
    },
    stateSink: overrides.stateSink ?? {
      applyShellEvents: (_environmentId: EnvironmentId, events: ReadonlyArray<unknown>) =>
        events.map(() => undefined),
      afterShellEventApplied: () => undefined,
      syncServerShellSnapshot: () => undefined,
      reconcileSnapshotDerivedState: () => undefined,
    },
    ...(overrides.scheduleShellFrame ? { scheduleShellFrame: overrides.scheduleShellFrame } : {}),
    ...(overrides.threadWindowActivityPayloads
      ? { threadWindowActivityPayloads: overrides.threadWindowActivityPayloads }
      : {}),
    onShellSnapshotReceived: () => undefined,
    onShellSnapshotCurrent: () => undefined,
    onShellSnapshotApplied: () => undefined,
    onShellSnapshotReady: () => undefined,
  } as unknown as EnvironmentSupervisorInput<Record>;
  const supervisor = createEnvironmentConnectionSupervisor(input);
  return {
    supervisor,
    resume: (reason: string) => resume?.(reason),
    notifyRegistry: () => registryListener?.(),
  };
}

const connectionFor = (record: Record) =>
  ({ environmentId: record.environmentId }) as unknown as EnvironmentConnection;

const numbered = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from }, (_, index) => `${prefix}${from + index}`);

describe("saved environment retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("backs off from five seconds to a one-minute ceiling", () => {
    expect(savedEnvironmentRetryDelayMs(1)).toBe(5_000);
    expect(savedEnvironmentRetryDelayMs(2)).toBe(10_000);
    expect(savedEnvironmentRetryDelayMs(4)).toBe(40_000);
    expect(savedEnvironmentRetryDelayMs(10)).toBe(60_000);
  });

  it("keeps trying an unreachable environment until it connects", async () => {
    let attempts = 0;
    const { supervisor } = makeSupervisor(async (record) => {
      attempts += 1;
      if (attempts < 3) throw new Error("connect ECONNREFUSED");
      return connectionFor(record);
    });
    const stop = supervisor.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts).toBe(3);
    stop();
  });

  it("does not retry a credential the user must replace by pairing again", async () => {
    let attempts = 0;
    const { supervisor } = makeSupervisor(async () => {
      attempts += 1;
      throw new SavedEnvironmentCredentialError("Pair it again.");
    });
    const stop = supervisor.start();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts).toBe(1);
    stop();
  });

  it("leaves an environment that needs pairing again out of background reconnects", async () => {
    const needsRepair = "env-needs-repair" as EnvironmentId;
    const offline = "env-offline" as EnvironmentId;
    const attempts = new Map<EnvironmentId, number>();
    let awaitingRepair = true;
    const { supervisor, notifyRegistry } = makeSupervisor(
      async (record) => {
        attempts.set(record.environmentId, (attempts.get(record.environmentId) ?? 0) + 1);
        if (record.environmentId === needsRepair) {
          throw new SavedEnvironmentCredentialError("Pair it again.");
        }
        throw new Error("connect ECONNREFUSED");
      },
      {
        records: [{ environmentId: needsRepair }, { environmentId: offline }],
        isSavedEnvironmentAwaitingRepair: (environmentId) =>
          awaitingRepair && environmentId === needsRepair,
      },
    );
    const stop = supervisor.start();

    // Every retry of the unreachable environment, and every registry change,
    // runs a full sync; none of them presents the rejected credential again.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10_000);
    notifyRegistry();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts.get(offline)).toBe(4);
    expect(attempts.get(needsRepair)).toBeUndefined();

    // Pairing again replaces the credential; the next sync reaches it.
    awaitingRepair = false;
    notifyRegistry();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts.get(needsRepair)).toBe(1);
    stop();
  });

  it("keeps Desktop Hub relay connections when the saved registry changes", async () => {
    const relay = "env-hub-relay" as EnvironmentId;
    const unlisted = "env-removed" as EnvironmentId;
    const disconnected: EnvironmentId[] = [];
    const { supervisor, notifyRegistry } = makeSupervisor(async (record) => connectionFor(record), {
      records: [],
      disconnectSavedEnvironment: async (environmentId) => void disconnected.push(environmentId),
    });
    const stop = supervisor.start();
    supervisor.register({
      environmentId: relay,
      kind: "saved",
      knownEnvironment: { source: "hub-hosted" },
    } as unknown as EnvironmentConnection);
    supervisor.register({
      environmentId: unlisted,
      kind: "saved",
      knownEnvironment: { source: "manual" },
    } as unknown as EnvironmentConnection);

    notifyRegistry();
    await vi.advanceTimersByTimeAsync(0);
    expect(disconnected).toContain(unlisted);
    expect(disconnected).not.toContain(relay);
    stop();
  });

  it("retries immediately when the device wakes or comes back online", async () => {
    let attempts = 0;
    const { supervisor, resume } = makeSupervisor(async () => {
      attempts += 1;
      throw new Error("offline");
    });
    const stop = supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toBe(2);

    resume("online");
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(3);
    stop();
  });

  it("does not let connects that never settle stall the other saved environments", async () => {
    const hungA = "env-hung-a" as EnvironmentId;
    const hungB = "env-hung-b" as EnvironmentId;
    const reachable = "env-reachable" as EnvironmentId;
    const attempts = new Map<EnvironmentId, number>();
    const settle = new Map<EnvironmentId, (connection: EnvironmentConnection) => void>();
    const { supervisor } = makeSupervisor(
      (record) => {
        attempts.set(record.environmentId, (attempts.get(record.environmentId) ?? 0) + 1);
        if (record.environmentId === reachable) return Promise.resolve(connectionFor(record));
        // An SSH password prompt or a keychain read can hold a connect far
        // longer than any bounded network step.
        return new Promise<EnvironmentConnection>((resolve) => {
          settle.set(record.environmentId, resolve);
        });
      },
      {
        records: [
          { environmentId: hungA, lastConnectedAt: "2026-10-03T00:00:02.000Z" },
          { environmentId: hungB, lastConnectedAt: "2026-10-03T00:00:01.000Z" },
          { environmentId: reachable, lastConnectedAt: "2026-10-03T00:00:00.000Z" },
        ],
      },
    );
    const stop = supervisor.start();

    await vi.advanceTimersByTimeAsync(0);
    expect(attempts.get(hungA)).toBe(1);
    expect(attempts.get(hungB)).toBe(1);
    expect(attempts.get(reachable)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(SAVED_ENVIRONMENT_CONNECT_TIMEOUT_MS);
    expect(attempts.get(reachable)).toBe(1);

    // The stalled attempts were given up: the retry starts a fresh one rather
    // than joining the hung attempt forever.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts.get(hungA)).toBe(2);
    expect(attempts.get(hungB)).toBe(2);

    const connectionA = connectionFor({ environmentId: hungA });
    settle.get(hungA)?.(connectionA);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts.get(hungA)).toBe(2);
    stop();
  });

  it("gives a slow attempt up for everyone that joined it and aborts its requests", async () => {
    let attempts = 0;
    let firstSignal: AbortSignal | null = null;
    let firstIsCancelled: (() => boolean) | null = null;
    const { supervisor } = makeSupervisor((_record, isCancelled, signal) => {
      attempts += 1;
      if (attempts === 1) {
        firstSignal = signal;
        firstIsCancelled = isCancelled;
      }
      return new Promise<EnvironmentConnection>(() => undefined);
    });
    const stop = supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);

    // The user presses Connect (or pairs again) while the supervisor's attempt
    // is still waiting; both share the one pending connect.
    const joined = supervisor.ensureSavedEnvironmentConnection({ environmentId: remote }, () =>
      Promise.reject(new Error("a joined Connect never starts its own attempt")),
    );
    const joinedOutcome = expect(joined).rejects.toThrow("did not connect in time");
    await vi.advanceTimersByTimeAsync(SAVED_ENVIRONMENT_CONNECT_TIMEOUT_MS);

    await joinedOutcome;
    expect(firstSignal!.aborted).toBe(true);
    expect(firstIsCancelled!()).toBe(true);

    // The next Connect starts a fresh attempt instead of joining the hung one.
    void supervisor
      .ensureSavedEnvironmentConnection(
        { environmentId: remote },
        (isCancelled, signal) =>
          new Promise<EnvironmentConnection>(() => {
            expect(isCancelled()).toBe(false);
            expect(signal.aborted).toBe(false);
            attempts += 1;
          }),
      )
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(2);
    stop();
  });

  it("never gives up an attempt that replaced the one its slot was waiting on", async () => {
    let supervisorAttempts = 0;
    const { supervisor } = makeSupervisor(() => {
      supervisorAttempts += 1;
      return new Promise<EnvironmentConnection>(() => undefined);
    });
    const stop = supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(supervisorAttempts).toBe(1);

    // A disconnect cancels the slot's attempt, and pairing again starts another.
    supervisor.cancelPendingSavedEnvironmentConnection(remote);
    let pairingSignal: AbortSignal | null = null;
    let pairingIsCancelled: (() => boolean) | null = null;
    let finishPairing: (connection: EnvironmentConnection) => void = () => undefined;
    const pairing = supervisor.ensureSavedEnvironmentConnection(
      { environmentId: remote },
      (isCancelled, signal) => {
        pairingSignal = signal;
        pairingIsCancelled = isCancelled;
        return new Promise<EnvironmentConnection>((resolve) => {
          finishPairing = resolve;
        });
      },
    );
    await vi.advanceTimersByTimeAsync(0);

    // The old slot runs out; the pairing's attempt keeps going.
    await vi.advanceTimersByTimeAsync(SAVED_ENVIRONMENT_CONNECT_TIMEOUT_MS);
    expect(pairingSignal!.aborted).toBe(false);
    expect(pairingIsCancelled!()).toBe(false);
    const connection = connectionFor({ environmentId: remote });
    finishPairing(connection);
    await expect(pairing).resolves.toBe(connection);
    stop();
  });

  it("stops retrying when supervision stops", async () => {
    let attempts = 0;
    const { supervisor } = makeSupervisor(async () => {
      attempts += 1;
      throw new Error("offline");
    });
    const stop = supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempts).toBe(1);
  });
});

describe("thread subscription resume", () => {
  function threadConnection(source: string) {
    let listener: ((item: any) => void) | undefined;
    let options: ResumableSubscriptionOptions | undefined;
    const connection = {
      kind: "saved",
      environmentId: remote,
      knownEnvironment: { source },
      client: {
        orchestration: {
          subscribeThread: () => () => undefined,
          subscribeThreadWindow: (
            _input: unknown,
            next: (item: any) => void,
            nextOptions?: ResumableSubscriptionOptions,
          ) => {
            listener = next;
            options = nextOptions;
            return () => undefined;
          },
        },
      },
    } as unknown as EnvironmentConnection;
    return {
      connection,
      emit: (item: unknown) => listener?.(item),
      resumeFrom: () => options?.resumeFromSequence?.() ?? null,
    };
  }

  const windowSnapshot = (snapshotSequence: number) => ({
    kind: "snapshot",
    snapshot: { snapshotSequence, thread: {}, history: {} },
  });

  it("resumes an open thread after the last event it applied", () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record));
    const thread = threadConnection("manual");
    supervisor.register(thread.connection);
    supervisor.retainThreadDetailSubscription(remote, "thread-1" as ThreadId);

    expect(thread.resumeFrom()).toBeNull();
    thread.emit(windowSnapshot(5));
    thread.emit({ kind: "event", event: { sequence: 7 } });
    expect(thread.resumeFrom()).toBe(7);
    thread.emit({ kind: "resumed", fromSequence: 7 });
    expect(thread.resumeFrom()).toBe(7);
  });

  it("always takes a fresh snapshot over the Hub relay", () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record));
    const thread = threadConnection("hub-hosted");
    supervisor.register(thread.connection);
    supervisor.retainThreadDetailSubscription(remote, "thread-1" as ThreadId);
    thread.emit(windowSnapshot(5));
    expect(thread.resumeFrom()).toBeNull();
  });

  it("always takes a fresh snapshot in hosted mode", () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record), {
      isHostedMode: true,
    });
    const thread = threadConnection("manual");
    supervisor.register(thread.connection);
    supervisor.retainThreadDetailSubscription(remote, "thread-1" as ThreadId);
    thread.emit(windowSnapshot(5));
    expect(thread.resumeFrom()).toBeNull();
  });
});

describe("thread subscription before the thread exists", () => {
  function countingConnection() {
    const subscribed: string[] = [];
    const connection = {
      kind: "saved",
      environmentId: remote,
      knownEnvironment: { source: "manual" },
      client: {
        orchestration: {
          subscribeThread: () => () => undefined,
          subscribeThreadWindow: (input: { readonly threadId: string }) => {
            subscribed.push(input.threadId);
            return () => undefined;
          },
        },
      },
    } as unknown as EnvironmentConnection;
    return { connection, subscribed };
  }

  const shellSnapshot = (snapshotSequence: number, threadIds: ReadonlyArray<string>) =>
    ({
      snapshotSequence,
      updatedAt: null,
      projects: [],
      worktrees: [],
      threads: threadIds.map((id) => ({ id })),
    }) as never;

  it("waits for the shell to list a draft's thread instead of requesting it", () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record));
    const { connection, subscribed } = countingConnection();
    supervisor.register(connection);
    supervisor.syncShellSnapshot(shellSnapshot(1, ["thread-existing"]), remote);

    supervisor.retainThreadDetailSubscription(remote, "thread-draft" as ThreadId);
    supervisor.retainThreadDetailSubscription(remote, "thread-existing" as ThreadId);
    expect(subscribed).toEqual(["thread-existing"]);

    // A reconnect's snapshot still lacks the draft: it stays retained and idle.
    supervisor.syncShellSnapshot(shellSnapshot(2, ["thread-existing"]), remote);
    expect(subscribed).toEqual(["thread-existing"]);

    // The first send creates the thread.
    supervisor.applyShellEvent(
      { kind: "thread-upserted", sequence: 3, thread: { id: "thread-draft" } } as never,
      remote,
    );
    supervisor.flushShellEvents();
    expect(subscribed).toEqual(["thread-existing", "thread-draft"]);
  });

  it("subscribes right away before any shell snapshot has been applied", () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record));
    const { connection, subscribed } = countingConnection();
    supervisor.register(connection);

    supervisor.retainThreadDetailSubscription(remote, "thread-1" as ThreadId);
    expect(subscribed).toEqual(["thread-1"]);
  });
});

describe("thread detail attach demand", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function newLog() {
    return { subscribed: [] as string[], unsubscribed: [] as string[] };
  }

  function trackedConnection(log: ReturnType<typeof newLog>, source = "manual") {
    return {
      kind: "saved",
      environmentId: remote,
      knownEnvironment: { source },
      dispose: () => Promise.resolve(),
      client: {
        orchestration: {
          subscribeThread: () => () => undefined,
          subscribeThreadWindow: (input: { readonly threadId: string }) => {
            log.subscribed.push(input.threadId);
            return () => {
              log.unsubscribed.push(input.threadId);
            };
          },
        },
      },
    } as unknown as EnvironmentConnection;
  }

  const shellSnapshot = (snapshotSequence: number, threadIds: ReadonlyArray<string>) =>
    ({
      snapshotSequence,
      updatedAt: null,
      projects: [],
      worktrees: [],
      threads: threadIds.map((id) => ({ id })),
    }) as never;

  const thread = (id: string) => id as ThreadId;

  it("does not start idle cached threads when a connection registers", () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record));
    const log = newLog();
    // Retained and released while no connection exists: an idle cached thread.
    supervisor.retainThreadDetailSubscription(remote, thread("thread-open"), { view: true });
    supervisor.retainThreadDetailSubscription(remote, thread("thread-idle"))();

    supervisor.register(trackedConnection(log));

    expect(log.subscribed).toEqual(["thread-open"]);
  });

  it("does not start idle cached threads after a shell snapshot", () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record));
    const log = newLog();
    supervisor.register(trackedConnection(log));
    supervisor.syncShellSnapshot(shellSnapshot(1, ["thread-live"]), remote);

    // Neither is listed yet, so neither starts; one is released meanwhile.
    supervisor.retainThreadDetailSubscription(remote, thread("thread-draft"));
    supervisor.retainThreadDetailSubscription(remote, thread("thread-idle"))();
    expect(log.subscribed).toEqual([]);

    supervisor.syncShellSnapshot(
      shellSnapshot(2, ["thread-live", "thread-draft", "thread-idle"]),
      remote,
    );
    expect(log.subscribed).toEqual(["thread-draft"]);
  });

  it("starts the threads a user has open first, then the most recently used", async () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record));
    const log = newLog();
    supervisor.retainThreadDetailSubscription(remote, thread("thread-view-older"), { view: true });
    await vi.advanceTimersByTimeAsync(10);
    supervisor.retainThreadDetailSubscription(remote, thread("thread-view-newer"), { view: true });
    await vi.advanceTimersByTimeAsync(10);
    supervisor.retainThreadDetailSubscription(remote, thread("thread-warm-older"));
    await vi.advanceTimersByTimeAsync(10);
    supervisor.retainThreadDetailSubscription(remote, thread("thread-warm-newer"));
    await vi.advanceTimersByTimeAsync(10);
    supervisor.retainThreadDetailSubscription(remote, thread("thread-idle"))();

    supervisor.register(trackedConnection(log));

    expect(log.subscribed).toEqual([
      "thread-view-newer",
      "thread-view-older",
      "thread-warm-newer",
      "thread-warm-older",
    ]);
  });

  it("starts an idle cached thread at once when it is retained again", () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record));
    const log = newLog();
    supervisor.retainThreadDetailSubscription(remote, thread("thread-idle"))();
    supervisor.register(trackedConnection(log));
    expect(log.subscribed).toEqual([]);

    supervisor.retainThreadDetailSubscription(remote, thread("thread-idle"), { view: true });
    expect(log.subscribed).toEqual(["thread-idle"]);
  });

  describe("when a connection is removed", () => {
    const removeAndRegisterAgain = async (
      source: string,
      overrides: { readonly isHostedMode?: boolean } = {},
    ) => {
      const { supervisor } = makeSupervisor(async (record) => connectionFor(record), {
        isThreadDetailSubscriptionNonIdle: () => false,
        ...overrides,
      });
      const log = newLog();
      supervisor.register(trackedConnection(log, source));
      supervisor.retainThreadDetailSubscription(remote, thread("thread-open"), { view: true });
      supervisor.retainThreadDetailSubscription(remote, thread("thread-idle"))();
      expect(log.subscribed).toEqual(["thread-open", "thread-idle"]);

      await supervisor.remove(remote);
      expect(log.unsubscribed.toSorted()).toEqual(["thread-idle", "thread-open"]);

      log.subscribed.length = 0;
      supervisor.register(trackedConnection(log, source));
      return { supervisor, log };
    };

    it("disposes the idle threads of a hub-hosted connection and keeps the open ones", async () => {
      const { supervisor, log } = await removeAndRegisterAgain("hub-hosted");
      expect(log.subscribed).toEqual(["thread-open"]);
      expect(supervisor.disposeThreadDetailSubscription(remote, thread("thread-idle"))).toBe(false);
      // The disposed thread has no eviction left to wait for.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("disposes the idle threads in hosted mode", async () => {
      const { supervisor, log } = await removeAndRegisterAgain("manual", { isHostedMode: true });
      expect(log.subscribed).toEqual(["thread-open"]);
      expect(supervisor.disposeThreadDetailSubscription(remote, thread("thread-idle"))).toBe(false);
    });

    it("keeps the idle threads of a direct connection cached but detached", async () => {
      const { supervisor, log } = await removeAndRegisterAgain("manual");
      expect(log.subscribed).toEqual(["thread-open"]);
      // Still cached, waiting for its idle window or the next retain.
      expect(vi.getTimerCount()).toBe(1);
      supervisor.retainThreadDetailSubscription(remote, thread("thread-idle"));
      expect(log.subscribed).toEqual(["thread-open", "thread-idle"]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});

describe("thread detail idle eviction", () => {
  const idleWindowMs = 5 * 60 * 1000;
  const minute = 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function setup(busy: ReadonlySet<string> = new Set()) {
    const unsubscribed: string[] = [];
    const connection = {
      kind: "saved",
      environmentId: remote,
      knownEnvironment: { source: "manual" },
      dispose: () => Promise.resolve(),
      client: {
        orchestration: {
          subscribeThread: () => () => undefined,
          subscribeThreadWindow: (input: { readonly threadId: string }) => () => {
            unsubscribed.push(input.threadId);
          },
        },
      },
    } as unknown as EnvironmentConnection;
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record), {
      isThreadDetailSubscriptionNonIdle: (_environmentId, threadId) => busy.has(threadId),
    });
    supervisor.register(connection);
    return { supervisor, unsubscribed };
  }

  const thread = (id: string) => id as ThreadId;

  it("arms one timer for every idle thread, however many an event chunk reconciles", async () => {
    const busy = new Set(Array.from({ length: 10 }, (_, index) => `thread-${index}`));
    const { supervisor, unsubscribed } = setup(busy);
    for (const id of busy) supervisor.retainThreadDetailSubscription(remote, thread(id))();
    // Busy threads are no candidates: nothing is armed.
    expect(vi.getTimerCount()).toBe(0);

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    busy.clear();
    supervisor.reconcileThreadDetailSubscriptionEvictionForEnvironment(remote);
    await vi.advanceTimersByTimeAsync(0);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);

    // Later chunks with nothing new to learn leave the timer alone.
    setTimeoutSpy.mockClear();
    for (let chunk = 0; chunk < 5; chunk += 1) {
      supervisor.reconcileThreadDetailSubscriptionEvictionForEnvironment(remote);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(idleWindowMs);
    expect(unsubscribed).toHaveLength(10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("disposes each idle thread at its own deadline", async () => {
    const { supervisor, unsubscribed } = setup();
    for (const id of ["thread-0", "thread-1", "thread-2"]) {
      supervisor.retainThreadDetailSubscription(remote, thread(id))();
      await vi.advanceTimersByTimeAsync(minute);
    }
    // One timer serves all three.
    expect(vi.getTimerCount()).toBe(1);

    // thread-0 went idle at minute 0, thread-1 at 1, thread-2 at 2; it is minute 3.
    await vi.advanceTimersByTimeAsync(minute);
    expect(unsubscribed).toEqual([]);
    await vi.advanceTimersByTimeAsync(minute);
    expect(unsubscribed).toEqual(["thread-0"]);
    await vi.advanceTimersByTimeAsync(minute);
    expect(unsubscribed).toEqual(["thread-0", "thread-1"]);
    await vi.advanceTimersByTimeAsync(minute);
    expect(unsubscribed).toEqual(["thread-0", "thread-1", "thread-2"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels only the eviction of a thread that is retained again", async () => {
    const { supervisor, unsubscribed } = setup();
    for (const id of ["thread-0", "thread-1", "thread-2"]) {
      supervisor.retainThreadDetailSubscription(remote, thread(id))();
      await vi.advanceTimersByTimeAsync(minute);
    }

    const release = supervisor.retainThreadDetailSubscription(remote, thread("thread-1"), {
      view: true,
    });
    await vi.advanceTimersByTimeAsync(10 * minute);
    expect(unsubscribed).toEqual(["thread-0", "thread-2"]);

    release();
    await vi.advanceTimersByTimeAsync(idleWindowMs);
    expect(unsubscribed).toEqual(["thread-0", "thread-2", "thread-1"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restarts a thread's window on activity but not on an environment pass", async () => {
    const { supervisor, unsubscribed } = setup();
    supervisor.retainThreadDetailSubscription(remote, thread("thread-active"))();
    supervisor.retainThreadDetailSubscription(remote, thread("thread-quiet"))();

    await vi.advanceTimersByTimeAsync(4 * minute);
    supervisor.reconcileThreadDetailSubscriptionEvictionForThread(remote, thread("thread-active"));
    supervisor.reconcileThreadDetailSubscriptionEvictionForEnvironment(remote);
    await vi.advanceTimersByTimeAsync(minute);
    expect(unsubscribed).toEqual(["thread-quiet"]);

    await vi.advanceTimersByTimeAsync(4 * minute);
    expect(unsubscribed).toEqual(["thread-quiet", "thread-active"]);
  });

  it("leaves a thread that became busy at its deadline until it is idle again", async () => {
    const busy = new Set<string>();
    const { supervisor, unsubscribed } = setup(busy);
    supervisor.retainThreadDetailSubscription(remote, thread("thread-1"))();

    await vi.advanceTimersByTimeAsync(4 * minute);
    busy.add("thread-1");
    await vi.advanceTimersByTimeAsync(minute);
    expect(unsubscribed).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    busy.delete("thread-1");
    supervisor.reconcileThreadDetailSubscriptionEvictionForEnvironment(remote);
    await vi.advanceTimersByTimeAsync(idleWindowMs - 1);
    expect(unsubscribed).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(unsubscribed).toEqual(["thread-1"]);
  });
});

describe("archived thread stubs", () => {
  function stubHarness() {
    const subscribed: string[] = [];
    const requested: Array<ReadonlyArray<string>> = [];
    const applied: Array<ReadonlyArray<string>> = [];
    const stubs = new Set(["thread-archived"]);
    const connection = {
      kind: "saved",
      environmentId: remote,
      knownEnvironment: { source: "manual" },
      dispose: () => Promise.resolve(),
      client: {
        orchestration: {
          subscribeThread: () => () => undefined,
          subscribeThreadWindow: (input: { readonly threadId: string }) => {
            subscribed.push(input.threadId);
            return () => undefined;
          },
          getThreadShells: (input: { readonly threadIds: ReadonlyArray<string> }) => {
            requested.push(input.threadIds);
            return Promise.resolve({
              snapshotSequence: 2,
              threads: input.threadIds.map((id) => ({ id })),
              remainingThreadIds: [],
            });
          },
        },
      },
    } as unknown as EnvironmentConnection;
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record), {
      stateSink: {
        applyShellEvents: (_environmentId: EnvironmentId, events: ReadonlyArray<unknown>) =>
          events.map(() => undefined),
        afterShellEventApplied: () => undefined,
        syncServerShellSnapshot: () => undefined,
        reconcileSnapshotDerivedState: () => undefined,
        isArchivedThreadStub: (_environmentId: EnvironmentId, threadId: ThreadId) =>
          stubs.has(threadId),
        applyLoadedThreadShells: (
          _environmentId: EnvironmentId,
          threads: ReadonlyArray<{ readonly id: string }>,
        ) => {
          applied.push(threads.map((thread) => thread.id));
          for (const thread of threads) stubs.delete(thread.id);
        },
      },
    });
    return { supervisor, connection, subscribed, requested, applied, stubs };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("keeps a stubbed thread's open subscription across a stubbed snapshot", () => {
    const { supervisor, connection, subscribed } = stubHarness();
    supervisor.register(connection);
    supervisor.syncShellSnapshot(
      {
        snapshotSequence: 1,
        updatedAt: null,
        projects: [],
        threads: [{ id: "thread-live" }],
        archivedThreadStubs: [{ id: "thread-archived" }],
      } as never,
      remote,
    );
    // The archived thread is listed (as a stub): opening it subscribes at once.
    supervisor.retainThreadDetailSubscription(remote, "thread-archived" as ThreadId, {
      view: true,
    });
    expect(subscribed).toEqual(["thread-archived"]);
  });

  const stubbedSnapshot = (snapshotSequence: number) =>
    ({
      snapshotSequence,
      updatedAt: null,
      projects: [],
      threads: [{ id: "thread-live" }],
      archivedThreadStubs: [{ id: "thread-archived" }],
    }) as never;

  it("loads an opened stub's full shell and applies it", async () => {
    const { supervisor, connection, requested, applied } = stubHarness();
    supervisor.register(connection);
    supervisor.syncShellSnapshot(stubbedSnapshot(1), remote);
    supervisor.retainThreadDetailSubscription(remote, "thread-archived" as ThreadId, {
      view: true,
    });
    supervisor.retainThreadDetailSubscription(remote, "thread-live" as ThreadId);
    await settle();
    expect(requested).toEqual([["thread-archived"]]);
    expect(applied).toEqual([["thread-archived"]]);
  });

  it("waits for the connection's snapshot before loading a stub opened earlier", async () => {
    const { supervisor, connection, requested, applied } = stubHarness();
    supervisor.register(connection);
    // Opened before any live snapshot: the stub can only be a cached one.
    supervisor.retainThreadDetailSubscription(remote, "thread-archived" as ThreadId, {
      view: true,
    });
    await settle();
    expect(requested).toEqual([]);
    supervisor.syncShellSnapshot(stubbedSnapshot(1), remote);
    await settle();
    expect(requested).toEqual([["thread-archived"]]);
    expect(applied).toEqual([["thread-archived"]]);
  });

  it("loads stubs a view asks for without opening them", async () => {
    const { supervisor, connection, requested } = stubHarness();
    supervisor.register(connection);
    supervisor.ensureArchivedThreadShells(remote, [
      "thread-archived" as ThreadId,
      "thread-live" as ThreadId,
    ]);
    await settle();
    expect(requested).toEqual([["thread-archived"]]);
  });

  it("drops a load whose connection went away before it answered", async () => {
    const { supervisor, connection, applied } = stubHarness();
    supervisor.register(connection);
    supervisor.ensureArchivedThreadShells(remote, ["thread-archived" as ThreadId]);
    await supervisor.remove(remote);
    await settle();
    expect(applied).toEqual([]);
  });
});

describe("thread window failures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function windowConnection() {
    const windows: Array<{
      readonly limits: { readonly messages: number; readonly activities: number };
      /** Fails the window the way the transport does: classified, never the raw error. */
      readonly onError: ((error: unknown) => void) | undefined;
    }> = [];
    let legacySubscriptions = 0;
    const connection = {
      kind: "saved",
      environmentId: remote,
      knownEnvironment: { source: "manual" },
      client: {
        orchestration: {
          subscribeThread: () => {
            legacySubscriptions += 1;
            return () => undefined;
          },
          subscribeThreadWindow: (
            input: { readonly limits: { readonly messages: number; readonly activities: number } },
            _next: unknown,
            options?: {
              readonly onError?: (kind?: SubscriptionFailureKind) => void;
              readonly classifyFailure?: (error: unknown) => SubscriptionFailureKind;
            },
          ) => {
            windows.push({
              limits: input.limits,
              onError: (error) => options?.onError?.(options.classifyFailure?.(error)),
            });
            return () => undefined;
          },
        },
      },
    } as unknown as EnvironmentConnection;
    return { connection, windows, legacySubscriptions: () => legacySubscriptions };
  }

  const openThread = () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record));
    const thread = windowConnection();
    supervisor.register(thread.connection);
    supervisor.retainThreadDetailSubscription(remote, "thread-1" as ThreadId);
    return thread;
  };

  it("falls back to the full legacy stream only for a server without bounded windows", () => {
    const thread = openThread();
    thread.windows[0]!.onError?.("Unknown request tag: orchestration.subscribeThreadWindow");
    expect(thread.legacySubscriptions()).toBe(1);
  });

  it("asks for a smaller window when the response does not fit the connection", () => {
    const thread = openThread();
    thread.windows[0]!.onError?.(
      new Error("The response exceeded the largest message this connection can carry."),
    );

    expect(thread.legacySubscriptions()).toBe(0);
    expect(thread.windows).toHaveLength(2);
    expect(thread.windows[1]!.limits).toMatchObject({ messages: 75, activities: 75 });
  });

  it("retries a window the server failed to load instead of loading the whole thread", async () => {
    const thread = openThread();
    thread.windows[0]!.onError?.(new Error("Failed to load bounded history for thread thread-1"));

    expect(thread.legacySubscriptions()).toBe(0);
    expect(thread.windows).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(thread.windows).toHaveLength(2);
    expect(thread.windows[1]!.limits).toMatchObject({ messages: 150, activities: 150 });
  });
});

describe("thread window activity previews", () => {
  function recordingConnection() {
    const windowInputs: Array<{ readonly [key: string]: unknown }> = [];
    const connection = {
      kind: "saved",
      environmentId: remote,
      knownEnvironment: { source: "manual" },
      client: {
        orchestration: {
          subscribeThread: () => () => undefined,
          subscribeThreadWindow: (input: { readonly [key: string]: unknown }) => {
            windowInputs.push(input);
            return () => undefined;
          },
        },
      },
    } as unknown as EnvironmentConnection;
    return { connection, windowInputs };
  }

  it("asks for previews only when the client fetches full payloads on demand", () => {
    for (const threadWindowActivityPayloads of ["preview", undefined] as const) {
      const { supervisor } = makeSupervisor(
        async (record) => connectionFor(record),
        threadWindowActivityPayloads ? { threadWindowActivityPayloads } : {},
      );
      const thread = recordingConnection();
      supervisor.register(thread.connection);
      supervisor.retainThreadDetailSubscription(remote, "thread-1" as ThreadId);
      expect(thread.windowInputs).toHaveLength(1);
      if (threadWindowActivityPayloads) {
        expect(thread.windowInputs[0]).toMatchObject({ activityPayloads: "preview" });
      } else {
        // Older clients' requests stay byte-identical: the field is absent, not "full".
        expect(thread.windowInputs[0]).not.toHaveProperty("activityPayloads");
      }
    }
  });
});

describe("thread detail cache accounting", () => {
  function streamingConnection() {
    const listeners = new Map<string, (item: unknown) => void>();
    const unsubscribed: string[] = [];
    const connection = {
      kind: "saved",
      environmentId: remote,
      knownEnvironment: { source: "manual" },
      client: {
        orchestration: {
          subscribeThread: () => () => undefined,
          subscribeThreadWindow: (
            input: { readonly threadId: string },
            next: (item: unknown) => void,
          ) => {
            listeners.set(input.threadId, next);
            return () => {
              unsubscribed.push(input.threadId);
            };
          },
        },
      },
    } as unknown as EnvironmentConnection;
    return { connection, listeners, unsubscribed };
  }

  const activityEvent = (sequence: number, activityId: string, bytes: number) => ({
    kind: "event",
    event: {
      sequence,
      type: "thread.activity-appended",
      payload: { activity: { id: activityId, payload: { output: "x".repeat(bytes) } } },
    },
  });

  it("keeps an idle cached thread while a pinned thread streams far past the byte budget", async () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record), {
      isThreadDetailSubscriptionNonIdle: (_environmentId, threadId) => threadId === "thread-hot",
    });
    const threads = streamingConnection();
    supervisor.register(threads.connection);
    supervisor.retainThreadDetailSubscription(remote, "thread-hot" as ThreadId);
    const releaseIdle = supervisor.retainThreadDetailSubscription(
      remote,
      "thread-idle" as ThreadId,
    );
    threads.listeners.get("thread-idle")?.({
      kind: "snapshot",
      snapshot: { snapshotSequence: 1, thread: { padding: "x".repeat(200_000) }, history: {} },
    });
    releaseIdle();

    // ~20 MiB of new tool output on the thread the user is watching.
    for (let index = 0; index < 200; index += 1) {
      threads.listeners.get("thread-hot")?.(activityEvent(index + 2, `tool-${index}`, 100_000));
    }
    await Promise.resolve();

    expect(threads.unsubscribed).not.toContain("thread-idle");
  });

  it("counts an activity updated in place once, not once per update", async () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record), {
      isThreadDetailSubscriptionNonIdle: () => false,
    });
    const threads = streamingConnection();
    supervisor.register(threads.connection);
    // Two idle cached threads; the older is evicted only if the newer's
    // estimate grows past the 12 MiB budget.
    const releaseOlder = supervisor.retainThreadDetailSubscription(
      remote,
      "thread-older" as ThreadId,
    );
    threads.listeners.get("thread-older")?.({
      kind: "snapshot",
      snapshot: { snapshotSequence: 1, thread: { padding: "x".repeat(1_000_000) }, history: {} },
    });
    releaseOlder();
    const releaseNewer = supervisor.retainThreadDetailSubscription(
      remote,
      "thread-newer" as ThreadId,
    );
    // A 100 KB progress row re-sent 200 times holds 100 KB, not 20 MB.
    for (let index = 0; index < 200; index += 1) {
      threads.listeners.get("thread-newer")?.(activityEvent(index + 2, "progress", 100_000));
    }
    await Promise.resolve();
    releaseNewer();

    expect(threads.unsubscribed).toEqual([]);
  });

  it("disposes an immediate release at once unless a view retained the thread meanwhile", () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record), {
      isThreadDetailSubscriptionNonIdle: () => false,
    });
    const threads = streamingConnection();
    supervisor.register(threads.connection);

    // An intent that led nowhere: disposed at once.
    const releaseDwell = supervisor.retainThreadDetailSubscription(
      remote,
      "thread-dwell" as ThreadId,
    );
    releaseDwell({ immediately: true });
    expect(threads.unsubscribed).toEqual(["thread-dwell"]);

    // An intent that opened the thread: the view came and went before the
    // intent's deadline, and the stream stays in the idle cache.
    const releaseIntent = supervisor.retainThreadDetailSubscription(
      remote,
      "thread-opened" as ThreadId,
    );
    const releaseView = supervisor.retainThreadDetailSubscription(
      remote,
      "thread-opened" as ThreadId,
      { view: true },
    );
    releaseView();
    releaseIntent({ immediately: true });
    expect(threads.unsubscribed).toEqual(["thread-dwell"]);

    // An intent on the thread that is already open: the user leaves it before
    // the intent's deadline, and the stream still reaches the idle cache.
    const releaseOpenView = supervisor.retainThreadDetailSubscription(
      remote,
      "thread-open" as ThreadId,
      { view: true },
    );
    const releaseOpenIntent = supervisor.retainThreadDetailSubscription(
      remote,
      "thread-open" as ThreadId,
    );
    releaseOpenView();
    releaseOpenIntent({ immediately: true });
    expect(threads.unsubscribed).toEqual(["thread-dwell"]);
  });

  it("counts only the activities the store keeps when a busy thread is released", async () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record), {
      isThreadDetailSubscriptionNonIdle: () => false,
    });
    const threads = streamingConnection();
    supervisor.register(threads.connection);
    const releaseOlder = supervisor.retainThreadDetailSubscription(
      remote,
      "thread-older" as ThreadId,
    );
    threads.listeners.get("thread-older")?.({
      kind: "snapshot",
      snapshot: { snapshotSequence: 1, thread: { padding: "x".repeat(200_000) }, history: {} },
    });
    releaseOlder();
    const releaseBusy = supervisor.retainThreadDetailSubscription(
      remote,
      "thread-busy" as ThreadId,
    );
    // ~20 MB of unique 10 KB tool rows; the store keeps the last 500 (~5 MB).
    for (let index = 0; index < 2_000; index += 1) {
      threads.listeners.get("thread-busy")?.(activityEvent(index + 2, `tool-${index}`, 10_000));
    }
    await Promise.resolve();
    releaseBusy();

    expect(threads.unsubscribed).toEqual([]);
  });
});

describe("thread body residency", () => {
  const minute = 60 * 1000;
  const other = "env-other" as EnvironmentId;
  const thread = (id: string) => id as ThreadId;
  const refOf = (id: string, environmentId: EnvironmentId = remote): ScopedThreadRef => ({
    environmentId,
    threadId: thread(id),
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const emptySnapshot = {
    kind: "snapshot",
    snapshot: { snapshotSequence: 1, thread: {}, history: {} },
  };

  /** A supervisor over a fake store whose bodies appear as threads are opened. */
  function setup(
    options: {
      readonly busy?: ReadonlySet<string>;
      readonly protectedThreads?: ReadonlySet<string>;
      readonly activeEnvironmentId?: EnvironmentId;
    } = {},
  ) {
    const bodies = new Map<string, ThreadBodyUsage>();
    const log: string[] = [];
    const evictions: string[][] = [];
    const listeners = new Map<string, (item: unknown) => void>();
    // The older history page each thread's server answers with.
    const historyPages = new Map<string, unknown>();
    const listThreadBodies = vi.fn(() => [...bodies.values()]);
    const evictThreadBodies = vi.fn((threadRefs: ReadonlyArray<ScopedThreadRef>) => {
      evictions.push(threadRefs.map((threadRef) => threadRef.threadId));
      for (const threadRef of threadRefs) {
        log.push(`evict:${threadRef.threadId}`);
        bodies.delete(scopedThreadKey(threadRef));
      }
    });
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record), {
      isThreadDetailSubscriptionNonIdle: (_environmentId, threadId) =>
        options.busy?.has(threadId) ?? false,
      isThreadBodyProtected: (threadRef) =>
        options.protectedThreads?.has(threadRef.threadId) ?? false,
      listThreadBodies,
      evictThreadBodies,
    });
    for (const environmentId of [remote, other]) {
      supervisor.register({
        kind: "saved",
        environmentId,
        knownEnvironment: { source: "manual" },
        dispose: () => Promise.resolve(),
        client: {
          orchestration: {
            subscribeThread: () => () => undefined,
            subscribeThreadWindow: (
              input: { readonly threadId: string },
              next: (item: unknown) => void,
            ) => {
              listeners.set(input.threadId, next);
              return () => {
                log.push(`unsubscribe:${input.threadId}`);
              };
            },
            getThreadHistoryPage: async (request: { readonly threadId: string }) =>
              historyPages.get(request.threadId),
          },
        },
      } as unknown as EnvironmentConnection);
    }
    /** The store receives the thread's body, as its window snapshot would deliver it. */
    const load = (id: string, environmentId: EnvironmentId = remote, lastActivityAt = 0) => {
      const threadRef = refOf(id, environmentId);
      bodies.set(scopedThreadKey(threadRef), {
        ref: threadRef,
        bytes: 10,
        environmentActive: environmentId === options.activeEnvironmentId,
        lastActivityAt,
        hasPendingMessages: false,
      });
    };
    /** A view opens the thread, its window snapshot lands, and the view leaves again. */
    const open = async (id: string, environmentId: EnvironmentId = remote) => {
      const release = supervisor.retainThreadDetailSubscription(environmentId, thread(id), {
        view: true,
      });
      listeners.get(id)?.(emptySnapshot);
      load(id, environmentId);
      release();
      await vi.advanceTimersByTimeAsync(1);
    };
    const bodyIds = () => [...bodies.values()].map(({ ref }) => ref.threadId);
    return {
      supervisor,
      bodies,
      bodyIds,
      load,
      open,
      log,
      evictions,
      listeners,
      historyPages,
      listThreadBodies,
      evictThreadBodies,
    };
  }

  it("runs one pass for a chunk of disposals, and drops nothing within the budget", async () => {
    const { supervisor, bodies, open, listThreadBodies, evictThreadBodies } = setup();
    for (const id of ["a", "b", "c"]) await open(id);
    listThreadBodies.mockClear();

    for (const id of ["a", "b", "c"]) {
      expect(supervisor.disposeThreadDetailSubscription(remote, thread(id))).toBe(true);
    }
    expect(listThreadBodies).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(listThreadBodies).toHaveBeenCalledTimes(1);
    expect(evictThreadBodies).not.toHaveBeenCalled();
    expect(bodies.size).toBe(3);

    // The next chunk gets its own pass.
    const release = supervisor.retainThreadDetailSubscription(remote, thread("d"));
    release();
    supervisor.disposeThreadDetailSubscription(remote, thread("d"));
    await vi.advanceTimersByTimeAsync(0);
    expect(listThreadBodies).toHaveBeenCalledTimes(2);
  });

  it("keeps the 64 most recently opened bodies while 100 threads are opened in turn", async () => {
    const { bodies, bodyIds, open, evictions } = setup();

    for (let index = 0; index < 100; index += 1) {
      await open(`thread-${index}`);
      expect(bodies.size).toBeLessThanOrEqual(64);
    }

    expect(bodyIds().toSorted()).toEqual(numbered("thread-", 36, 100).toSorted());
    // Each pass drops the single oldest body that is over the budget.
    expect(evictions.flat()).toEqual(numbered("thread-", 0, 36));
  });

  it("never drops a body that is open, busy, or holds unsent work, however old", async () => {
    const { supervisor, bodies, bodyIds, load, open, evictions } = setup({
      busy: new Set(["thread-busy"]),
      protectedThreads: new Set(["thread-unsent"]),
    });
    supervisor.retainThreadDetailSubscription(remote, thread("thread-open"), { view: true });
    for (const id of ["thread-open", "thread-busy", "thread-unsent"]) load(id);

    for (let index = 0; index < 100; index += 1) {
      await open(`thread-${index}`);
      expect(bodies.size).toBeLessThanOrEqual(64);
    }

    expect(bodyIds().toSorted()).toEqual(
      [...numbered("thread-", 39, 100), "thread-open", "thread-busy", "thread-unsent"].toSorted(),
    );
    expect(evictions.flat()).not.toContain("thread-open");
    expect(evictions.flat()).not.toContain("thread-busy");
    expect(evictions.flat()).not.toContain("thread-unsent");
  });

  it("keeps a retained thread's body even when only a background owner holds it", async () => {
    const { supervisor, bodyIds, load, open } = setup();
    supervisor.retainThreadDetailSubscription(remote, thread("thread-background"));
    load("thread-background");

    for (let index = 0; index < 70; index += 1) await open(`thread-${index}`);

    expect(bodyIds()).toContain("thread-background");
    expect(bodyIds()).not.toContain("thread-0");
  });

  it("keeps the recent threads of the active environment over older ones elsewhere, until they age", async () => {
    const { bodyIds, open, evictions } = setup({ activeEnvironmentId: remote });
    for (let index = 0; index < 33; index += 1) await open(`active-${index}`, remote);
    for (let index = 0; index < 33; index += 1) await open(`other-${index}`, other);

    // The active environment's threads are the oldest, yet the others make way.
    expect(bodyIds()).toHaveLength(64);
    expect(bodyIds()).toEqual(expect.arrayContaining(numbered("active-", 0, 33)));
    expect(evictions.flat()).toEqual(["other-0", "other-1"]);

    // Once they are older than the recent-access window they rank by age alone.
    await vi.advanceTimersByTimeAsync(6 * minute);
    await open("other-33", other);
    await vi.advanceTimersByTimeAsync(6 * minute);
    expect(evictions.flat().slice(2)).toEqual(["active-0"]);
  });

  it("drops a body no subscription ever delivered first, when a snapshot lands past the budget", async () => {
    const { load, open, evictions, bodyIds } = setup();
    for (const id of numbered("cached-", 0, 64)) load(id);

    await open("opened");

    expect(evictions).toEqual([["cached-0"]]);
    expect(bodyIds()).toHaveLength(64);
    expect(bodyIds()).toContain("opened");
  });

  it("drops the least recently active of the bodies no subscription delivered, whatever their order", async () => {
    const { load, open, evictions } = setup();
    // The most recently active threads were cached first.
    for (const [index, id] of numbered("cached-", 0, 64).entries()) {
      load(id, remote, 1_000 - index);
    }

    await open("opened-1");
    await open("opened-2");

    expect(evictions).toEqual([["cached-63"], ["cached-62"]]);
  });

  it("drops a cached body again when the store restores it", async () => {
    const { load, open, evictions } = setup();
    for (const [index, id] of numbered("cached-", 0, 64).entries()) load(id, remote, 100 + index);

    await open("opened-1");
    load("cached-0", remote, 100);
    await open("opened-2");

    // The restored body is the least recently active again, and goes first.
    expect(evictions).toEqual([["cached-0"], ["cached-0", "cached-1"]]);
  });

  it("holds every body opened in a burst in the active environment until their recency lapses", async () => {
    const { bodies, open, evictions } = setup({ activeEnvironmentId: remote });

    for (let index = 0; index < 100; index += 1) await open(`thread-${index}`);

    // All were accessed within the recent-access window: none may go yet.
    expect(bodies.size).toBe(100);
    expect(evictions).toEqual([]);

    // As each body leaves the window the store is checked again and settles
    // to the budget, oldest first.
    await vi.advanceTimersByTimeAsync(6 * minute);

    expect(bodies.size).toBe(64);
    expect(evictions.flat()).toEqual(numbered("thread-", 0, 36));
  });

  it("disposes an idle cached subscription before dropping its body", async () => {
    const protectedThreads = new Set(numbered("pinned-", 0, 64));
    const { load, open, log, evictions, bodyIds } = setup({ protectedThreads });
    for (const id of protectedThreads) load(id);

    // 64 pinned bodies leave no room for a 65th: the one just opened is the
    // only unprotected body, and its cached subscription goes first.
    await open("idle");

    expect(log).toEqual(["unsubscribe:idle", "evict:idle"]);
    expect(evictions).toEqual([["idle"]]);
    expect(bodyIds()).toHaveLength(64);
  });

  it("ranks a body by the supervisor's own byte estimate once it has one", async () => {
    const { supervisor, listeners, load, evictions, bodyIds } = setup();
    const hugeSnapshot = {
      kind: "snapshot",
      snapshot: { snapshotSequence: 1, thread: { padding: "x".repeat(11_000_000) }, history: {} },
    };

    for (let index = 0; index < 5; index += 1) {
      const id = `thread-${index}`;
      const release = supervisor.retainThreadDetailSubscription(remote, thread(id));
      listeners.get(id)?.(hugeSnapshot);
      load(id);
      release();
      await vi.advanceTimersByTimeAsync(1);
    }

    // Five ~11 MB threads outgrow the 48 MiB budget although the store's own
    // estimate of each is tiny: only the oldest goes.
    expect(evictions).toEqual([["thread-0"]]);
    expect(bodyIds()).toEqual(["thread-1", "thread-2", "thread-3", "thread-4"]);
  });

  it("re-checks the budget when an older history page grows a body past it", async () => {
    const { supervisor, listeners, historyPages, load, evictions, bodyIds } = setup();
    const hugeSnapshot = {
      kind: "snapshot",
      snapshot: { snapshotSequence: 1, thread: { padding: "x".repeat(11_000_000) }, history: {} },
    };
    for (let index = 0; index < 4; index += 1) {
      const id = `thread-${index}`;
      const release = supervisor.retainThreadDetailSubscription(remote, thread(id));
      listeners.get(id)?.(hugeSnapshot);
      load(id);
      release();
      await vi.advanceTimersByTimeAsync(1);
    }
    supervisor.retainThreadDetailSubscription(remote, thread("thread-open"), { view: true });
    listeners.get("thread-open")?.(emptySnapshot);
    load("thread-open");
    await vi.advanceTimersByTimeAsync(1);
    // About 44 MB of bodies: within the budget.
    expect(evictions).toEqual([]);

    historyPages.set("thread-open", {
      threadId: "thread-open",
      collection: "messages",
      items: [{ id: "older-message", text: "x".repeat(8_000_000) }],
    });
    await supervisor.loadOlderThreadHistory({
      environmentId: remote,
      threadId: thread("thread-open"),
      collection: "messages",
      page: { oldestCursor: "cursor-1", newestCursor: null, hasMoreBefore: true } as never,
      limit: 50,
    });
    await vi.advanceTimersByTimeAsync(0);

    // The page takes the open thread past the budget: the oldest body goes.
    expect(evictions).toEqual([["thread-0"]]);
    expect(bodyIds()).toEqual(["thread-1", "thread-2", "thread-3", "thread-open"]);
  });

  it("runs no pass for the disposals of a reset", async () => {
    const { supervisor, open, listThreadBodies, evictThreadBodies } = setup();
    await open("thread-0");
    listThreadBodies.mockClear();

    await supervisor.resetForTests();
    await vi.advanceTimersByTimeAsync(0);

    expect(listThreadBodies).not.toHaveBeenCalled();
    expect(evictThreadBodies).not.toHaveBeenCalled();

    // A disposal after the reset schedules a pass as usual.
    supervisor.retainThreadDetailSubscription(remote, thread("thread-1"))();
    supervisor.disposeThreadDetailSubscription(remote, thread("thread-1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(listThreadBodies).toHaveBeenCalledTimes(1);
  });

  it("drops nothing when the store inputs are absent", async () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record), {
      isThreadDetailSubscriptionNonIdle: () => false,
    });
    supervisor.retainThreadDetailSubscription(remote, thread("thread-0"))();
    expect(supervisor.disposeThreadDetailSubscription(remote, thread("thread-0"))).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("thread body residency over the store", () => {
  const second = 1000;
  const minute = 60 * second;
  const projectId = "project-1";
  const at = (minuteOffset: number) =>
    new Date(Date.UTC(2026, 9, 1, 0, minuteOffset)).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 1, 12));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const session = (threadId: string, status: OrchestrationSessionStatus) => ({
    threadId,
    status,
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: status === "running" ? "turn-1" : null,
    lastError: null,
    updatedAt: at(0),
  });
  const latestTurn = (
    state: "running" | "completed",
    overrides: { [key: string]: unknown } = {},
  ) => ({
    turnId: "turn-1",
    state,
    requestedAt: at(0),
    startedAt: at(0),
    completedAt: state === "completed" ? at(1) : null,
    assistantMessageId: null,
    ...overrides,
  });

  /** A thread as the shell lists it. */
  function shellThread(id: string, overrides: { [key: string]: unknown } = {}) {
    return {
      id,
      projectId,
      title: `Thread ${id}`,
      modelSelection: { instanceId: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      worktreeId: null,
      manualStatusBucket: null,
      manualPosition: 0,
      latestTurn: null,
      createdAt: at(0),
      updatedAt: at(0),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      session: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      ...overrides,
    };
  }
  type ShellThread = ReturnType<typeof shellThread>;

  const shellSnapshot = (threads: ReadonlyArray<ShellThread>) =>
    ({
      snapshotSequence: 1,
      projects: [
        {
          id: projectId,
          title: "Project",
          workspaceRoot: "/workspace/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at(0),
          updatedAt: at(0),
        },
      ],
      threads,
      updatedAt: at(0),
    }) as never;

  /** The window a thread subscription delivers: the shell's thread with two messages. */
  function makeWindow(shell: ShellThread): OrchestrationThreadWindowSnapshot {
    const {
      latestUserMessageAt: _latest,
      hasPendingApprovals: _approvals,
      hasPendingUserInput: _input,
      hasActionableProposedPlan: _plan,
      ...thread
    } = shell;
    const historyPage = { oldestCursor: null, newestCursor: null, hasMoreBefore: false };
    return {
      snapshotSequence: 10,
      thread: {
        ...thread,
        deletedAt: null,
        messages: [1, 2].map((index) => ({
          id: `${shell.id}-message-${index}`,
          role: index === 1 ? "user" : "assistant",
          text: `Message ${index}`,
          turnId: null,
          streaming: false,
          createdAt: at(index),
          updatedAt: at(index),
        })),
        proposedPlans: [],
        activities: [],
        checkpoints: [],
      },
      history: {
        messages: historyPage,
        proposedPlans: historyPage,
        activities: historyPage,
        checkpoints: historyPage,
      },
    } as unknown as OrchestrationThreadWindowSnapshot;
  }

  /**
   * A supervisor wired to a real store the way the apps wire theirs: the store
   * lists and drops bodies, and its own predicate says which threads are busy.
   */
  function storeHarness(
    options: { readonly isThreadBodyProtected?: (threadRef: ScopedThreadRef) => boolean } = {},
  ) {
    let state: AppState = { activeEnvironmentId: remote, environmentStateById: {} };
    const shellThreads = new Map<string, ShellThread>();
    const listeners = new Map<string, (item: unknown) => void>();
    const unsubscribed: string[] = [];
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record), {
      isThreadDetailSubscriptionNonIdle: (environmentId, threadId) =>
        isThreadNonIdle(state, scopeThreadRef(environmentId, threadId)),
      listThreadBodies: () => selectThreadBodyUsage(state),
      evictThreadBodies: (threadRefs) => {
        state = evictThreadBodies(state, threadRefs);
      },
      isThreadBodyProtected: (threadRef) => options.isThreadBodyProtected?.(threadRef) ?? false,
      syncThreadWindowSnapshot: (environmentId, snapshot) => {
        state = syncServerThreadWindow(state, snapshot, environmentId);
      },
    });
    supervisor.register({
      kind: "saved",
      environmentId: remote,
      knownEnvironment: { source: "manual" },
      dispose: () => Promise.resolve(),
      client: {
        orchestration: {
          subscribeThread: () => () => undefined,
          subscribeThreadWindow: (
            input: { readonly threadId: string },
            next: (item: unknown) => void,
          ) => {
            listeners.set(input.threadId, next);
            return () => {
              unsubscribed.push(input.threadId);
            };
          },
        },
      },
    } as unknown as EnvironmentConnection);

    const update = (transition: (current: AppState) => AppState) => {
      state = transition(state);
    };
    const remember = (threads: ReadonlyArray<ShellThread>) => {
      for (const shell of threads) shellThreads.set(shell.id, shell);
    };
    /** A live shell snapshot lists the threads. */
    const listShell = (threads: ReadonlyArray<ShellThread>) => {
      remember(threads);
      update((current) => syncServerShellSnapshot(current, shellSnapshot(threads), remote));
    };
    /** The read cache restores the threads, with content for `withContent`. */
    const hydrate = (
      threads: ReadonlyArray<ShellThread>,
      withContent: ReadonlyArray<string>,
      hydrateOptions?: { readonly replaceCached?: boolean },
    ) => {
      remember(threads);
      const contents = new Map(
        withContent.map((id) => [
          id as ThreadId,
          {
            messages: [
              {
                id: `${id}-cached` as never,
                role: "user" as const,
                text: "cached",
                createdAt: at(1),
                streaming: false,
              },
            ],
          },
        ]),
      );
      update((current) =>
        hydrateEnvironmentStateFromCache(
          current,
          projectThreadReadCacheShell(shellSnapshot(threads), remote, Date.now(), contents),
          remote,
          hydrateOptions,
        ),
      );
    };
    const retain = (id: string, retainOptions?: { readonly view?: boolean }) =>
      supervisor.retainThreadDetailSubscription(remote, id as ThreadId, retainOptions);
    /** The thread's window snapshot lands. */
    const deliverWindow = (id: string) =>
      listeners.get(id)?.({
        kind: "snapshot",
        snapshot: makeWindow(shellThreads.get(id) ?? shellThread(id)),
      });
    /**
     * The user opens each thread in turn, one a second: the view retains it,
     * its window lands, and the previous view goes. The last one stays open.
     */
    const openInTurn = async (ids: ReadonlyArray<string>) => {
      let releasePrevious: (() => void) | null = null;
      for (const id of ids) {
        const release = retain(id, { view: true });
        deliverWindow(id);
        releasePrevious?.();
        releasePrevious = release;
        await vi.advanceTimersByTimeAsync(second);
      }
    };
    const bodyIds = () => selectThreadBodyUsage(state).map(({ ref }) => ref.threadId as string);
    return {
      supervisor,
      update,
      listShell,
      hydrate,
      retain,
      deliverWindow,
      openInTurn,
      bodyIds,
      unsubscribed,
    };
  }

  it("keeps at most the budget once 100 completed threads were opened in turn, never-opened bodies first out", async () => {
    const harness = storeHarness();
    const cachedOnly = numbered("cached-", 0, 74);
    const opened = numbered("opened-", 0, 100);
    // The node leaves every session ready once its turn completed.
    const threads = [...cachedOnly, ...opened].map((id) =>
      shellThread(id, { session: session(id, "ready"), latestTurn: latestTurn("completed") }),
    );
    harness.hydrate(threads, cachedOnly);
    harness.listShell(threads);
    expect(harness.bodyIds()).toHaveLength(74);

    await harness.openInTurn(opened);
    await vi.advanceTimersByTimeAsync(7 * minute);

    const kept = harness.bodyIds();
    expect(kept.length).toBeLessThanOrEqual(64 + 1);
    expect(kept.filter((id) => id.startsWith("cached-"))).toEqual([]);
    expect(kept).toContain("opened-99");
    // The most recently accessed ones stay.
    expect(kept.toSorted()).toEqual(opened.slice(-kept.length).toSorted());
  });

  it("drops threads that wait on a proposed plan decision like any idle thread", async () => {
    const harness = storeHarness();
    const opened = numbered("opened-", 0, 100);
    const withPlan = new Set(opened.slice(0, 22));
    const threads = opened.map((id, index) =>
      shellThread(id, {
        session: session(id, "stopped"),
        latestTurn: latestTurn(
          "completed",
          withPlan.has(id) && index % 2 === 0
            ? { sourceProposedPlan: { threadId: id, planId: `${id}-plan` } }
            : {},
        ),
        hasActionableProposedPlan: withPlan.has(id),
      }),
    );
    harness.listShell(threads);

    await harness.openInTurn(opened);
    await vi.advanceTimersByTimeAsync(7 * minute);

    const kept = harness.bodyIds();
    expect(kept.length).toBeLessThanOrEqual(64 + 1);
    expect(kept.filter((id) => withPlan.has(id))).toEqual([]);
    expect(kept.toSorted()).toEqual(opened.slice(-kept.length).toSorted());
  });

  it("drops a burst opened inside the recency window once it lapses, with no later snapshot or disposal", async () => {
    const harness = storeHarness();
    const ids = numbered("burst-", 0, 100);
    harness.listShell(
      ids.map((id, index) =>
        shellThread(id, index % 2 === 0 ? { session: session(id, "stopped") } : {}),
      ),
    );

    // Each thread is pressed, its window lands, and the press lets go at once.
    const firstAccessAt = Date.now();
    for (const id of ids) {
      const release = harness.retain(id);
      harness.deliverWindow(id);
      release({ immediately: true });
      await vi.advanceTimersByTimeAsync(second);
    }
    const lastAccessAt = firstAccessAt + 99 * second;
    expect(harness.unsubscribed).toHaveLength(100);
    expect(harness.bodyIds()).toHaveLength(100);

    await vi.advanceTimersByTimeAsync(
      firstAccessAt + THREAD_BODY_RECENT_ACCESS_MS - 1 - Date.now(),
    );
    expect(harness.bodyIds()).toHaveLength(100);

    await vi.advanceTimersByTimeAsync(lastAccessAt + THREAD_BODY_RECENT_ACCESS_MS - Date.now());
    expect(harness.bodyIds().toSorted()).toEqual(ids.slice(36).toSorted());
  });

  it("never drops a viewed, working, waiting, queued or pending-message thread under pressure", async () => {
    const harness = storeHarness({
      isThreadBodyProtected: (threadRef) => threadRef.threadId === "queued",
    });
    const filler = numbered("filler-", 0, 150);
    harness.listShell([
      shellThread("viewed", { session: session("viewed", "stopped") }),
      shellThread("working", {
        session: session("working", "running"),
        latestTurn: latestTurn("running"),
      }),
      shellThread("approval", { session: session("approval", "ready"), hasPendingApprovals: true }),
      shellThread("input", { hasPendingUserInput: true }),
      shellThread("queued"),
      ...filler.map((id) => shellThread(id, { session: session(id, "stopped") })),
    ]);

    // The least recently accessed thread is the one still on screen.
    harness.retain("viewed", { view: true });
    harness.deliverWindow("viewed");
    await vi.advanceTimersByTimeAsync(second);
    for (const id of ["working", "approval", "input", "queued"]) {
      const release = harness.retain(id, { view: true });
      harness.deliverWindow(id);
      release();
      await vi.advanceTimersByTimeAsync(second);
    }
    // A message that arrived before its thread's shell.
    harness.update((current) =>
      applyOrchestrationEvent(
        current,
        {
          sequence: 2,
          eventId: "event-pending",
          aggregateKind: "thread",
          aggregateId: "pending",
          occurredAt: at(2),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: {
            threadId: "pending",
            messageId: "pending-message",
            role: "assistant",
            text: "early",
            turnId: null,
            streaming: true,
            createdAt: at(2),
            updatedAt: at(2),
          },
        } as unknown as OrchestrationEvent,
        remote,
      ),
    );
    expect(harness.bodyIds()).toContain("pending");

    await harness.openInTurn(filler);
    await vi.advanceTimersByTimeAsync(10 * minute);

    const kept = harness.bodyIds();
    expect(kept.length).toBeLessThanOrEqual(64);
    expect(kept).toEqual(
      expect.arrayContaining(["viewed", "working", "approval", "input", "queued", "pending"]),
    );
    expect(harness.unsubscribed).not.toContain("viewed");
    expect(harness.unsubscribed).not.toContain("working");
  });

  it("arms one residency timer at a time, none once within budget, and a reset clears it", async () => {
    const harness = storeHarness();
    const ids = numbered("burst-", 0, 140);
    harness.listShell(ids.map((id) => shellThread(id)));
    const burst = async (burstIds: ReadonlyArray<string>) => {
      for (const id of burstIds) {
        const release = harness.retain(id);
        harness.deliverWindow(id);
        release({ immediately: true });
        await vi.advanceTimersByTimeAsync(second);
      }
    };

    await burst(ids.slice(0, 70));
    // Over budget while every body is recent: one timer re-checks.
    expect(harness.bodyIds()).toHaveLength(70);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(2 * minute);
    expect(vi.getTimerCount()).toBe(1);

    // The pass that settles the store within budget arms nothing.
    await vi.advanceTimersByTimeAsync(THREAD_BODY_RECENT_ACCESS_MS);
    expect(harness.bodyIds()).toHaveLength(64);
    expect(vi.getTimerCount()).toBe(0);

    // A second burst outgrows the budget again with recent bodies only.
    await burst(ids.slice(70));
    expect(harness.bodyIds()).toEqual(ids.slice(70));
    expect(vi.getTimerCount()).toBe(1);
    await harness.supervisor.resetForTests();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds bodies the read cache restores after the last pass at the next idle sweep, restored ones first", async () => {
    const harness = storeHarness();
    const opened = numbered("opened-", 0, 40);
    const restored = numbered("restored-", 0, 80);
    const threads = [...opened, ...restored].map((id) =>
      shellThread(id, { session: session(id, "stopped") }),
    );
    harness.listShell(threads);
    await harness.openInTurn(opened);
    // Within budget, with idle cached subscriptions waiting for their sweep.
    expect(harness.bodyIds()).toHaveLength(40);
    expect(vi.getTimerCount()).toBe(1);

    // The node goes away and the read cache refills the bodies the store lacks.
    harness.update((current) =>
      demoteEnvironmentStateToCachedSnapshot(current, remote, Date.now()),
    );
    harness.hydrate(threads, restored, { replaceCached: true });
    expect(harness.bodyIds()).toHaveLength(120);

    await vi.advanceTimersByTimeAsync(6 * minute);

    const kept = harness.bodyIds();
    expect(kept.length).toBeLessThanOrEqual(64 + 1);
    expect(kept).toEqual(expect.arrayContaining(opened));
  });

  it("bounds restored bodies a pass could not drop once the backstop fires", async () => {
    let protectRestored = true;
    const harness = storeHarness({
      isThreadBodyProtected: (threadRef) =>
        protectRestored && threadRef.threadId.startsWith("restored-"),
    });
    const restored = numbered("restored-", 0, 80);
    harness.hydrate(
      [...restored, "opened"].map((id) => shellThread(id)),
      restored,
    );

    // One unrelated window lands; its pass ends over the thread limit.
    harness.retain("opened", { view: true });
    harness.deliverWindow("opened");
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.bodyIds()).toHaveLength(81);

    // Nothing else happens in supervision; the bodies are no longer protected.
    protectRestored = false;
    await vi.advanceTimersByTimeAsync(THREAD_BODY_RESIDENCY_BACKSTOP_MS);

    const kept = harness.bodyIds();
    expect(kept.length).toBeLessThanOrEqual(64 + 1);
    expect(kept).toContain("opened");
  });

  it("arms no timer after a pass that leaves the store within budget", async () => {
    const harness = storeHarness();
    const restored = numbered("restored-", 0, 10);
    harness.hydrate(
      [...restored, "opened"].map((id) => shellThread(id)),
      restored,
    );

    const release = harness.retain("opened");
    harness.deliverWindow("opened");
    release({ immediately: true });
    await vi.advanceTimersByTimeAsync(1);

    expect(harness.bodyIds()).toHaveLength(11);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("shell frame batching", () => {
  function recordingSink() {
    const calls: string[] = [];
    let applied = 0;
    const sink = {
      applyShellEvents: (_environmentId: EnvironmentId, events: ReadonlyArray<any>) => {
        calls.push(
          `commit:${events.map((event) => (event.kind === "thread-priorities" ? "priorities" : event.sequence)).join(",")}`,
        );
        return events.map((event) => {
          applied += 1;
          return `context:${event.kind === "thread-priorities" ? "priorities" : event.sequence}`;
        });
      },
      afterShellEventApplied: (_environmentId: EnvironmentId, event: any, context: unknown) => {
        // After-hooks run once the whole batch is committed.
        calls.push(`after:${event.sequence}:${String(context)}:applied=${applied}`);
      },
      syncServerShellSnapshot: (_environmentId: EnvironmentId, snapshot: any) => {
        calls.push(`snapshot:${snapshot.snapshotSequence}`);
      },
      reconcileSnapshotDerivedState: () => undefined,
    };
    return { sink, calls };
  }

  const upsert = (sequence: number, threadId = "thread-1") =>
    ({ kind: "thread-upserted", sequence, thread: { id: threadId } }) as never;
  const shellSnapshot = (snapshotSequence: number) =>
    ({
      snapshotSequence,
      updatedAt: `2026-10-12T00:00:0${snapshotSequence % 10}.000Z`,
      projects: [],
      worktrees: [],
      threads: [{ id: "thread-1" }],
    }) as never;

  it("commits a frame's shell items once, then runs the after-hooks against the applied state", () => {
    const { sink, calls } = recordingSink();
    const frames: Array<() => void> = [];
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record), {
      stateSink: sink,
      scheduleShellFrame: (callback) => frames.push(callback),
    });

    supervisor.applyShellEvent(upsert(1), remote);
    supervisor.applyShellEvent(upsert(2), remote);
    supervisor.applyThreadPriorities({ kind: "thread-priorities", priorities: [] }, remote);
    supervisor.applyShellEvent(upsert(3), remote);
    expect(calls).toEqual([]);

    frames.splice(0).forEach((frame) => frame());
    expect(calls).toEqual([
      "commit:1,2,priorities,3",
      "after:1:context:1:applied=4",
      "after:2:context:2:applied=4",
      "after:3:context:3:applied=4",
    ]);
  });

  it("drops events the projection already holds but always applies a ranking", () => {
    const { sink, calls } = recordingSink();
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record), {
      stateSink: sink,
      scheduleShellFrame: () => undefined,
    });
    supervisor.syncShellSnapshot(shellSnapshot(5), remote);
    calls.length = 0;

    supervisor.applyShellEvent(upsert(4), remote);
    supervisor.applyThreadPriorities({ kind: "thread-priorities", priorities: [] }, remote);
    supervisor.applyShellEvent(upsert(6), remote);
    supervisor.flushShellEvents();

    expect(calls).toEqual(["commit:priorities,6", "after:6:context:6:applied=2"]);
  });

  it("applies buffered items before a snapshot, a projection reset or a resume read", () => {
    const { sink, calls } = recordingSink();
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record), {
      stateSink: sink,
      scheduleShellFrame: () => undefined,
    });

    supervisor.applyShellEvent(upsert(1), remote);
    supervisor.syncShellSnapshot(shellSnapshot(2), remote);
    expect(calls.slice(0, 3)).toEqual(["commit:1", "after:1:context:1:applied=1", "snapshot:2"]);

    supervisor.applyShellEvent(upsert(3), remote);
    expect(supervisor.readShellProjectionSequence(remote)).toBe(3);

    calls.length = 0;
    supervisor.applyShellEvent(upsert(4), remote);
    supervisor.resetShellProjection(remote);
    expect(calls[0]).toBe("commit:4");
    expect(supervisor.readShellProjectionSequence(remote)).toBeNull();
  });
});

describe("thread history recovery mode", () => {
  function historyConnection() {
    const subscriptions: Array<{
      readonly mode: () => string | undefined;
    }> = [];
    const modeChanges: Array<{ readonly threadId: string; readonly mode: string }> = [];
    const connection = {
      kind: "saved",
      environmentId: remote,
      knownEnvironment: { source: "manual" },
      client: {
        orchestration: {
          subscribeThread: () => () => undefined,
          subscribeThreadWindow: (
            _input: unknown,
            _next: unknown,
            options?: { readonly historyRecovery?: () => string },
          ) => {
            subscriptions.push({ mode: () => options?.historyRecovery?.() });
            return () => undefined;
          },
          setThreadHistoryRecovery: async (input: { threadId: string; mode: string }) => {
            modeChanges.push(input);
            return {};
          },
        },
      },
    } as unknown as EnvironmentConnection;
    return { connection, subscriptions, modeChanges };
  }

  it("opens a prewarm passive and a view active", () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record));
    const history = historyConnection();
    supervisor.register(history.connection);

    supervisor.retainThreadDetailSubscription(remote, "thread-prewarm" as ThreadId);
    supervisor.retainThreadDetailSubscription(remote, "thread-view" as ThreadId, { view: true });

    expect(history.subscriptions.map((subscription) => subscription.mode())).toEqual([
      "passive",
      "active",
    ]);
    expect(history.modeChanges).toEqual([]);
  });

  it("turns a running prewarm active while a view holds it, and passive once it leaves", () => {
    const { supervisor } = makeSupervisor(async (record) => connectionFor(record));
    const history = historyConnection();
    supervisor.register(history.connection);
    const thread = "thread-1" as ThreadId;

    const releasePrewarm = supervisor.retainThreadDetailSubscription(remote, thread);
    const releaseView = supervisor.retainThreadDetailSubscription(remote, thread, { view: true });
    // A second view does not announce again.
    const releaseSecondView = supervisor.retainThreadDetailSubscription(remote, thread, {
      view: true,
    });
    expect(history.modeChanges).toEqual([{ threadId: thread, mode: "active" }]);
    // A replacement subscription (a reconnect) asks with the current mode.
    expect(history.subscriptions[0]!.mode()).toBe("active");

    releaseView();
    expect(history.modeChanges).toHaveLength(1);
    releaseSecondView();
    expect(history.modeChanges).toEqual([
      { threadId: thread, mode: "active" },
      { threadId: thread, mode: "passive" },
    ]);
    expect(history.subscriptions[0]!.mode()).toBe("passive");
    releasePrewarm();
  });
});
