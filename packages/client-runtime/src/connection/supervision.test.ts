import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ResumableSubscriptionOptions } from "../rpc/wsRpcClient.ts";
import type { SubscriptionFailureKind } from "../rpc/wsTransport.ts";
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
    syncThreadWindowSnapshot: () => undefined,
    applyThreadDetailEvent: () => undefined,
    isThreadDetailSubscriptionNonIdle: overrides.isThreadDetailSubscriptionNonIdle ?? (() => true),
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
