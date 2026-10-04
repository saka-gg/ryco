import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ResumableSubscriptionOptions } from "../rpc/wsRpcClient.ts";
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
  connect: (record: Record, isCancelled: () => boolean) => Promise<EnvironmentConnection>,
  overrides: {
    readonly isHostedMode?: boolean;
    readonly records?: ReadonlyArray<Record>;
    readonly isSavedEnvironmentAwaitingRepair?: (environmentId: EnvironmentId) => boolean;
  } = {},
) {
  let resume: ((reason: string) => void) | null = null;
  let registryListener: (() => void) | null = null;
  const input = {
    isHostedMode: () => overrides.isHostedMode ?? false,
    syncThreadDetailSnapshot: () => undefined,
    syncThreadWindowSnapshot: () => undefined,
    applyThreadDetailEvent: () => undefined,
    isThreadDetailSubscriptionNonIdle: () => true,
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
    connectSavedEnvironment: (record: Record, isCancelled: () => boolean) =>
      connect(record, isCancelled),
    isSavedEnvironmentAwaitingRepair: overrides.isSavedEnvironmentAwaitingRepair,
    disconnectSavedEnvironment: () => Promise.resolve(),
    waitForPrimaryShellSnapshotApplied: () => Promise.resolve(),
    subscribeBrowserResume: (listener: (reason: string) => void) => {
      resume = listener;
      return () => {
        resume = null;
      };
    },
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

    // The stalled environments stay on the retry schedule, and the retry joins
    // the attempt still running rather than racing a second one beside it.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts.get(hungA)).toBe(1);
    expect(attempts.get(hungB)).toBe(1);

    const connectionA = connectionFor({ environmentId: hungA });
    settle.get(hungA)?.(connectionA);
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts.get(hungA)).toBe(1);
    stop();
  });

  it("keeps a Connect that joined a slow attempt when the slot gives up on it", async () => {
    let settle: ((connection: EnvironmentConnection) => void) | null = null;
    let cancelledWhenSettled: boolean | null = null;
    const { supervisor } = makeSupervisor(
      (_record, isCancelled) =>
        new Promise<EnvironmentConnection>((resolve) => {
          settle = (connection) => {
            cancelledWhenSettled = isCancelled();
            resolve(connection);
          };
        }),
    );
    const stop = supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(settle).not.toBeNull();

    // The user presses Connect (or pairs again) while the supervisor's attempt
    // is still waiting; both share the one pending connect.
    const joined = supervisor.ensureSavedEnvironmentConnection({ environmentId: remote }, () =>
      Promise.reject(new Error("a joined Connect never starts its own attempt")),
    );
    await vi.advanceTimersByTimeAsync(SAVED_ENVIRONMENT_CONNECT_TIMEOUT_MS);

    const connection = connectionFor({ environmentId: remote });
    settle!(connection);
    await expect(joined).resolves.toBe(connection);
    expect(cancelledWhenSettled).toBe(false);
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
