import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ResumableSubscriptionOptions } from "../rpc/wsRpcClient.ts";
import type { EnvironmentConnection } from "./connection.ts";
import {
  createEnvironmentConnectionSupervisor,
  type EnvironmentSupervisorInput,
  SavedEnvironmentCredentialError,
  savedEnvironmentRetryDelayMs,
} from "./supervision.ts";

type Record = { readonly environmentId: EnvironmentId };

const remote = "env-remote" as EnvironmentId;

function makeSupervisor(
  connect: (record: Record) => Promise<EnvironmentConnection>,
  overrides: { readonly isHostedMode?: boolean } = {},
) {
  let resume: ((reason: string) => void) | null = null;
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
    listSavedEnvironmentRecords: () => [{ environmentId: remote }],
    hasSavedEnvironmentRegistryHydrated: () => true,
    waitForSavedEnvironmentRegistryHydration: () => Promise.resolve(),
    subscribeSavedEnvironmentRegistry: () => () => undefined,
    connectSavedEnvironment: (record: Record) => connect(record),
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
  return { supervisor, resume: (reason: string) => resume?.(reason) };
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
