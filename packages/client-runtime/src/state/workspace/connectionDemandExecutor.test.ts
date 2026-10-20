import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  UNIFIED_WORKSPACE_WARM_LEASE_TTL_MS,
  UNIFIED_WORKSPACE_WARM_RESTORE_COOLDOWN_MS,
  type WorkspaceConnectionScope,
} from "./connectionDemand.js";
import {
  createConnectionDemandExecutor,
  isWarmRestoreForegroundSettled,
  warmRestoreWaitsForForeground,
  type ConnectionDemandConnectResult,
  type ConnectionDemandExecutor,
} from "./connectionDemandExecutor.js";

const env = Array.from({ length: 5 }, (_, index) => EnvironmentId.make(`env-${index + 1}`));

const view = (index: number): WorkspaceConnectionScope => ({
  type: "thread-detail",
  threadId: ThreadId.make(`thread-${index}`),
});

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

interface ConnectCall extends Deferred<ConnectionDemandConnectResult> {
  readonly environmentId: EnvironmentId;
  readonly at: number;
  readonly signal: AbortSignal;
}

interface ReleaseCall extends Deferred<void> {
  readonly environmentId: EnvironmentId;
  readonly at: number;
  resolvedAt: number | null;
}

function createHarness(
  options: {
    readonly maxConnections?: number;
    readonly wakeStaggerMs?: number;
    readonly leaseTtlMs?: number;
    /** Resolve every release after this many milliseconds; `null` resolves them by hand. */
    readonly releaseMs?: number | null;
    readonly beforePlan?: (executor: ConnectionDemandExecutor) => void;
    readonly warmRestore?: (
      recent: ReadonlyArray<EnvironmentId>,
    ) => ReadonlyArray<EnvironmentId> | null;
  } = {},
) {
  const maxConnections = options.maxConnections ?? 3;
  const connects: ConnectCall[] = [];
  const releases: ReleaseCall[] = [];
  /** Channels the platform holds: from a connect call until its release resolved or it failed. */
  const live = new Set<EnvironmentId>();
  let maxLive = 0;
  let maxSlots = 0;
  let changes = 0;
  const executor: ConnectionDemandExecutor = createConnectionDemandExecutor({
    maxConnections,
    wakeStaggerMs: options.wakeStaggerMs ?? 750,
    ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
    ports: {
      now: () => Date.now(),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
      connect: (environmentId, signal) => {
        live.add(environmentId);
        maxLive = Math.max(maxLive, live.size);
        const call = { ...deferred<ConnectionDemandConnectResult>(), environmentId, signal };
        connects.push({ ...call, at: Date.now() });
        return call.promise.then(
          (result) => {
            if (result === "refused") live.delete(environmentId);
            return result;
          },
          (error: unknown) => {
            live.delete(environmentId);
            throw error;
          },
        );
      },
      release: (environmentId) => {
        const call: ReleaseCall = {
          ...deferred<void>(),
          environmentId,
          at: Date.now(),
          resolvedAt: null,
        };
        releases.push(call);
        const releaseMs = options.releaseMs === undefined ? 0 : options.releaseMs;
        if (releaseMs !== null) setTimeout(() => call.resolve(), releaseMs);
        return call.promise.then(() => {
          call.resolvedAt = Date.now();
          live.delete(environmentId);
        });
      },
      ...(options.beforePlan ? { beforePlan: () => options.beforePlan!(executor) } : {}),
      ...(options.warmRestore ? { warmRestore: options.warmRestore } : {}),
      onChange: () => {
        changes += 1;
        const snapshot = executor.snapshot();
        maxSlots = Math.max(
          maxSlots,
          snapshot.activeConnectionCount + snapshot.releasingEnvironmentIds.length,
        );
      },
    },
  });
  return {
    executor,
    connects,
    releases,
    connectsFor: (environmentId: EnvironmentId) =>
      connects.filter((call) => call.environmentId === environmentId),
    maxLive: () => maxLive,
    maxSlots: () => maxSlots,
    changes: () => changes,
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("connection demand executor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts the foreground at once and re-arms the staggered wakes from its plan", async () => {
    const harness = createHarness();
    harness.executor.retain({ environmentId: env[0]!, scope: view(1) });
    harness.executor.retain({ environmentId: env[1]!, scope: view(2) });
    harness.executor.retain({ environmentId: env[2]!, scope: view(3) });
    await flush();
    expect(harness.connects.map((call) => [call.environmentId, call.at])).toEqual([[env[0], 0]]);
    expect(harness.executor.snapshot().pendingWakes).toEqual([
      { environmentId: env[1], dueAt: 750 },
      { environmentId: env[2], dueAt: 1500 },
    ]);

    await vi.advanceTimersByTimeAsync(10);
    harness.executor.setForeground(env[2]!);
    await flush();
    expect(harness.connectsFor(env[2]!)).toMatchObject([{ at: 10 }]);
    expect(harness.executor.snapshot().pendingWakes).toEqual([
      { environmentId: env[1], dueAt: 760 },
    ]);

    await vi.advanceTimersByTimeAsync(749);
    expect(harness.connectsFor(env[1]!)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.connects.map((call) => [call.environmentId, call.at])).toEqual([
      [env[0], 0],
      [env[2], 10],
      [env[1], 760],
    ]);
  });

  it("keeps the stagger when an earlier wake finishes first", async () => {
    const harness = createHarness();
    for (let index = 0; index < 3; index += 1) {
      harness.executor.retain({ environmentId: env[index]!, scope: view(index) });
    }
    await flush();
    harness.connects[0]!.resolve("connected");
    harness.executor.reconcile();
    await flush();
    expect(harness.connects).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(750);
    harness.connects[1]!.resolve("connected");
    harness.executor.reconcile();
    await flush();
    expect(harness.connects.map((call) => call.at)).toEqual([0, 750]);
    await vi.advanceTimersByTimeAsync(750);
    expect(harness.connects.map((call) => call.at)).toEqual([0, 750, 1500]);
  });

  it("coalesces reconciles and joins an environment's in-flight connect", async () => {
    const harness = createHarness({ wakeStaggerMs: 0 });
    harness.executor.retain({ environmentId: env[0]!, scope: view(1) });
    harness.executor.reconcile();
    harness.executor.reconcile();
    await flush();
    harness.executor.reconcile();
    await flush();
    expect(harness.connectsFor(env[0]!)).toHaveLength(1);

    // Another environment does not wait for the first one's connect.
    harness.executor.retain({ environmentId: env[1]!, scope: view(2) });
    await flush();
    expect(harness.connectsFor(env[1]!)).toHaveLength(1);
    expect(harness.executor.snapshot().connectingEnvironmentIds).toEqual([env[0], env[1]]);
  });

  it("connects a foreground only after the preempted environment's release resolved", async () => {
    const harness = createHarness({ maxConnections: 1, releaseMs: 5 });
    harness.executor.retain({
      environmentId: env[0]!,
      scope: { type: "interactive" },
      preemptible: true,
    });
    await flush();
    harness.connects[0]!.resolve("connected");
    await flush();
    expect(harness.executor.snapshot().activeConnectionCount).toBe(1);

    await vi.advanceTimersByTimeAsync(100);
    harness.executor.retain({ environmentId: env[1]!, scope: view(2) });
    harness.executor.setForeground(env[1]!);
    await flush();
    expect(harness.releases).toMatchObject([{ environmentId: env[0], at: 100 }]);
    expect(harness.connectsFor(env[1]!)).toHaveLength(0);
    expect(harness.executor.snapshot().queuedEnvironmentIds).toEqual([env[0]]);

    await vi.advanceTimersByTimeAsync(4);
    expect(harness.connectsFor(env[1]!)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.connectsFor(env[1]!)).toMatchObject([{ at: 105 }]);
    expect(harness.releases[0]!.resolvedAt).toBe(105);
    expect(harness.maxSlots()).toBe(1);
    expect(harness.maxLive()).toBe(1);
    // The preempted environment keeps its lease and waits for a free slot.
    expect(harness.executor.isDemanded(env[0]!)).toBe(true);
    expect(harness.executor.snapshot().queuedEnvironmentIds).toEqual([env[0]]);
  });

  it("never holds two channels when a single slot swaps back and forth", async () => {
    let routed = env[0]!;
    const leases = new Map<EnvironmentId, string>();
    const harness = createHarness({
      maxConnections: 1,
      releaseMs: 3,
      beforePlan: (executor) => {
        for (const [environmentId, leaseId] of Array.from(leases)) {
          if (environmentId === routed) continue;
          executor.releaseLease(leaseId);
          leases.delete(environmentId);
        }
        const existing = leases.get(routed);
        if (existing === undefined || !executor.renew(existing)) {
          leases.set(routed, executor.retain({ environmentId: routed, scope: view(0) }));
        }
      },
    });
    const route = async (environmentId: EnvironmentId) => {
      routed = environmentId;
      harness.executor.setForeground(environmentId);
      harness.executor.reconcile();
      await flush();
    };
    await route(env[0]!);
    for (const next of [env[1]!, env[0]!, env[1]!]) {
      harness.connects.at(-1)!.resolve("connected");
      await flush();
      await route(next);
      await vi.advanceTimersByTimeAsync(3);
      expect(harness.connects.at(-1)!.environmentId).toBe(next);
    }
    expect(harness.connects.map((call) => call.environmentId)).toEqual([
      env[0],
      env[1],
      env[0],
      env[1],
    ]);
    expect(harness.maxLive()).toBe(1);
    expect(harness.maxSlots()).toBe(1);
  });

  it("connects waiting demand when the platform reports a disconnect", async () => {
    const harness = createHarness({ maxConnections: 1 });
    harness.executor.retain({ environmentId: env[0]!, scope: view(1) });
    await flush();
    harness.connects[0]!.resolve("connected");
    await flush();

    await vi.advanceTimersByTimeAsync(10);
    harness.executor.retain({ environmentId: env[1]!, scope: view(2) });
    await flush();
    expect(harness.connectsFor(env[1]!)).toHaveLength(0);
    expect(harness.executor.snapshot().queuedEnvironmentIds).toEqual([env[1]]);

    // The session ended on the platform's side; no reconcile follows.
    harness.executor.reportConnected(env[0]!, false);
    await flush();
    expect(harness.connectsFor(env[1]!)).toMatchObject([{ at: 10 }]);
    expect(harness.executor.snapshot()).toMatchObject({
      activeConnectionCount: 1,
      queuedEnvironmentIds: [env[0]],
    });
    expect(harness.releases).toEqual([]);
    expect(harness.maxSlots()).toBe(1);
  });

  it("keeps its snapshot and stays silent when a plan changes nothing", async () => {
    const harness = createHarness({ wakeStaggerMs: 0 });
    harness.executor.retain({ environmentId: env[0]!, scope: view(1) });
    await flush();
    harness.connects[0]!.resolve("connected");
    await flush();
    harness.executor.reportConnected(env[0]!, true);
    const snapshot = harness.executor.snapshot();
    const changes = harness.changes();

    for (let round = 0; round < 5; round += 1) {
      harness.executor.reconcile();
      await flush();
    }
    expect(harness.changes()).toBe(changes);
    expect(harness.executor.snapshot()).toBe(snapshot);

    harness.executor.retain({ environmentId: env[1]!, scope: view(2) });
    await flush();
    expect(harness.changes()).toBe(changes + 1);
    expect(harness.executor.snapshot()).not.toBe(snapshot);
  });

  it("queues a foreground behind three mounted views without releasing any", async () => {
    const harness = createHarness({ wakeStaggerMs: 0 });
    for (let index = 0; index < 3; index += 1) {
      harness.executor.retain({ environmentId: env[index]!, scope: view(index) });
    }
    await flush();
    for (const call of harness.connects) call.resolve("connected");
    await flush();

    harness.executor.retain({ environmentId: env[3]!, scope: view(3) });
    harness.executor.setForeground(env[3]!);
    await flush();
    expect(harness.releases).toEqual([]);
    expect(harness.connects).toHaveLength(3);
    expect(harness.executor.snapshot()).toMatchObject({
      queuedEnvironmentIds: [env[3]],
      activeConnectionCount: 3,
    });
  });

  it("renews leases through beforePlan when a throttled wake fires after their TTL", async () => {
    const scopes = new Map([
      ["first", { environmentId: env[0]!, scope: view(1) }],
      ["second", { environmentId: env[1]!, scope: view(2) }],
    ]);
    const leaseIds = new Map<string, string>();
    let renewals = 0;
    const harness = createHarness({
      leaseTtlMs: 45_000,
      // A hidden tab runs its timers at most about once a minute.
      wakeStaggerMs: 60_000,
      beforePlan: (executor) => {
        for (const [key, entry] of scopes) {
          const leaseId = leaseIds.get(key);
          if (leaseId !== undefined && executor.renew(leaseId)) {
            renewals += 1;
            continue;
          }
          leaseIds.set(key, executor.retain(entry));
        }
      },
    });
    harness.executor.reconcile();
    await flush();
    expect(harness.connects.map((call) => call.environmentId)).toEqual([env[0]]);
    harness.connects[0]!.resolve("connected");
    await flush();
    const renewalsAtStart = renewals;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(renewals).toBe(renewalsAtStart + 2);
    expect(harness.connectsFor(env[1]!)).toMatchObject([{ at: 60_000 }]);

    await vi.advanceTimersByTimeAsync(10_000);
    harness.executor.reconcile();
    await flush();
    expect(harness.releases).toEqual([]);
    expect(harness.executor.snapshot().demand.leases.map((lease) => lease.expiresAt)).toEqual([
      115_000, 115_000,
    ]);

    // Without the sync the second lease would have expired before its wake.
    const unsynced = createHarness({ leaseTtlMs: 45_000, wakeStaggerMs: 60_000 });
    unsynced.executor.retain({ environmentId: env[0]!, scope: view(1) });
    unsynced.executor.retain({ environmentId: env[1]!, scope: view(2) });
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(unsynced.connectsFor(env[1]!)).toHaveLength(0);
  });

  it("releases an interrupted environment only when nothing demands it", async () => {
    const harness = createHarness({ wakeStaggerMs: 0, releaseMs: null });
    harness.executor.retain({ environmentId: env[0]!, scope: view(1) });
    const warm = harness.executor.retain({ environmentId: env[1]!, scope: view(2) });
    await flush();
    for (const call of harness.connects) call.resolve("connected");
    await flush();
    harness.executor.releaseLease(warm);
    await flush();
    expect(harness.releases).toEqual([]);

    harness.executor.reportInterrupted(env[0]!);
    expect(harness.releases).toEqual([]);
    harness.executor.reportInterrupted(env[1]!);
    harness.executor.reportInterrupted(env[1]!);
    expect(harness.releases.map((call) => call.environmentId)).toEqual([env[1]]);
    expect(harness.executor.isDemanded(env[1]!)).toBe(false);

    // A foreground environment is demanded without a lease.
    harness.executor.reportConnected(env[2]!, true);
    harness.executor.setForeground(env[2]!);
    harness.executor.reportInterrupted(env[2]!);
    expect(harness.releases.map((call) => call.environmentId)).toEqual([env[1]]);

    harness.releases[0]!.resolve();
    await flush();
    harness.executor.reconcile();
    await flush();
    expect(harness.connectsFor(env[1]!)).toHaveLength(1);
  });

  it("parks a refused environment until it is unparked or demanded anew", async () => {
    const harness = createHarness({ wakeStaggerMs: 0 });
    harness.executor.retain({ environmentId: env[0]!, scope: view(1) });
    await flush();
    harness.connects[0]!.resolve("refused");
    await flush();
    expect(harness.executor.snapshot()).toMatchObject({
      parkedEnvironmentIds: [env[0]],
      activeConnectionCount: 0,
      queuedEnvironmentIds: [],
    });
    for (let round = 0; round < 3; round += 1) {
      harness.executor.reconcile();
      await flush();
    }
    expect(harness.connects).toHaveLength(1);

    // A new lease is a new demand edge.
    harness.executor.retain({ environmentId: env[0]!, scope: { type: "interactive" } });
    await flush();
    expect(harness.connects).toHaveLength(2);
    harness.connects[1]!.resolve("refused");
    await flush();

    // So is becoming the foreground.
    harness.executor.setForeground(env[0]!);
    await flush();
    expect(harness.connects).toHaveLength(3);
    harness.connects[2]!.resolve("refused");
    await flush();
    for (let round = 0; round < 3; round += 1) {
      harness.executor.reconcile();
      await flush();
    }
    expect(harness.connects).toHaveLength(3);

    harness.executor.unpark(env[0]!);
    await flush();
    expect(harness.connects).toHaveLength(4);
    harness.connects[3]!.resolve("connected");
    await flush();
    expect(harness.executor.snapshot()).toMatchObject({
      parkedEnvironmentIds: [],
      activeConnectionCount: 1,
    });
    expect(harness.executor.snapshot().demand.connections).toMatchObject([
      { environmentId: env[0], connected: true },
    ]);
  });

  it("retries a rejected connect on the next reconcile, not on its own", async () => {
    const harness = createHarness({ maxConnections: 1, wakeStaggerMs: 0 });
    harness.executor.retain({ environmentId: env[0]!, scope: view(1) });
    await flush();
    harness.connects[0]!.reject(new Error("directory is not current"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.connects).toHaveLength(1);
    expect(harness.executor.snapshot().activeConnectionCount).toBe(0);

    harness.executor.reconcile();
    await flush();
    expect(harness.connects).toHaveLength(2);
  });

  it("releases one environment while another connects, and reconnects it after its own release", async () => {
    const harness = createHarness({ wakeStaggerMs: 0, releaseMs: null });
    const first = harness.executor.retain({ environmentId: env[0]!, scope: view(1) });
    await flush();
    harness.connects[0]!.resolve("connected");
    await flush();
    harness.executor.releaseLease(first);
    harness.executor.reportInterrupted(env[0]!);
    expect(harness.executor.snapshot().releasingEnvironmentIds).toEqual([env[0]]);

    harness.executor.retain({ environmentId: env[1]!, scope: view(2) });
    await flush();
    expect(harness.connectsFor(env[1]!)).toHaveLength(1);
    expect(harness.releases[0]!.resolvedAt).toBeNull();

    harness.executor.retain({ environmentId: env[0]!, scope: view(1) });
    await flush();
    expect(harness.connectsFor(env[0]!)).toHaveLength(1);

    harness.releases[0]!.resolve();
    await flush();
    expect(harness.connectsFor(env[0]!)).toHaveLength(2);
    expect(harness.maxSlots()).toBeLessThanOrEqual(3);
  });

  it("cancels wakes and aborts connects without a lease when backgrounded", async () => {
    const harness = createHarness();
    const first = harness.executor.retain({ environmentId: env[0]!, scope: view(1) });
    harness.executor.retain({ environmentId: env[1]!, scope: view(2) });
    await flush();
    await vi.advanceTimersByTimeAsync(1);
    harness.executor.retain({ environmentId: env[2]!, scope: view(3) });
    await flush();
    expect(harness.connects.map((call) => call.environmentId)).toEqual([env[0], env[2]]);
    expect(harness.executor.snapshot().pendingWakes).toMatchObject([{ environmentId: env[1] }]);

    harness.executor.releaseLease(first);
    harness.executor.setBackgrounded(true);
    await flush();
    expect(harness.executor.snapshot().pendingWakes).toEqual([]);
    expect(harness.connects[0]!.signal.aborted).toBe(true);
    expect(harness.connects[1]!.signal.aborted).toBe(false);

    // The aborted connect settles before its environment is released.
    expect(harness.releases).toEqual([]);
    harness.connects[0]!.reject(new Error("aborted"));
    await flush();
    expect(harness.releases.map((call) => call.environmentId)).toEqual([env[0]]);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.connectsFor(env[1]!)).toHaveLength(0);

    harness.executor.setBackgrounded(false);
    await flush();
    expect(harness.connectsFor(env[1]!)).toHaveLength(1);
  });

  it("cancels wakes and aborts connects when disposed", async () => {
    const harness = createHarness();
    for (let index = 0; index < 3; index += 1) {
      harness.executor.retain({ environmentId: env[index]!, scope: view(index) });
    }
    await flush();
    expect(harness.executor.snapshot().pendingWakes).toHaveLength(2);

    harness.executor.dispose();
    expect(harness.connects[0]!.signal.aborted).toBe(true);
    expect(harness.executor.snapshot().pendingWakes).toEqual([]);
    harness.connects[0]!.resolve("connected");
    harness.executor.retain({ environmentId: env[3]!, scope: view(3) });
    harness.executor.reconcile();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.connects).toHaveLength(1);
    expect(harness.releases).toEqual([]);
    expect(harness.executor.isDemanded(env[0]!)).toBe(false);
  });

  it("rejects a cap above the assessed ceiling", () => {
    expect(() =>
      createConnectionDemandExecutor({
        maxConnections: 4,
        wakeStaggerMs: 750,
        ports: {
          now: () => 0,
          setTimeout: () => null,
          clearTimeout: () => undefined,
          connect: async () => "connected",
          release: async () => undefined,
        },
      }),
    ).toThrow(RangeError);
  });
});

/** A harness whose warm restore port answers whatever the test last set; `null` until then. */
function warmHarness(
  options: Omit<Parameters<typeof createHarness>[0] & object, "warmRestore"> = {},
) {
  let answer: ReadonlyArray<EnvironmentId> | null = null;
  const asked: Array<ReadonlyArray<EnvironmentId>> = [];
  const harness = createHarness({
    ...options,
    warmRestore: (recent) => {
      asked.push(recent);
      return answer;
    },
  });
  return {
    ...harness,
    asked,
    answerWith: (next: ReadonlyArray<EnvironmentId> | null) => {
      answer = next;
    },
  };
}

describe("connection demand executor warm set", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restores the warm set once the port answers, in its order and staggered", async () => {
    const harness = warmHarness();
    expect(harness.executor.snapshot().warmRestorePending).toBe(true);
    harness.executor.pollWarmRestore();
    await flush();
    expect(harness.asked).toEqual([[]]);
    expect(harness.connects).toEqual([]);
    expect(harness.executor.snapshot().warmRestorePending).toBe(true);

    harness.answerWith([env[1]!, env[0]!, env[1]!]);
    harness.executor.pollWarmRestore();
    await flush();
    expect(harness.connects.map((call) => [call.environmentId, call.at])).toEqual([[env[1], 0]]);
    expect(harness.executor.snapshot()).toMatchObject({
      warmEnvironmentIds: [env[1], env[0]],
      warmRestorePending: false,
      pendingWakes: [{ environmentId: env[0], dueAt: 750 }],
    });
    await vi.advanceTimersByTimeAsync(750);
    expect(harness.connects.map((call) => [call.environmentId, call.at])).toEqual([
      [env[1], 0],
      [env[0], 750],
    ]);

    // It ran once: nothing more is owed.
    const asked = harness.asked.length;
    harness.executor.pollWarmRestore();
    harness.executor.reconcile();
    await flush();
    expect(harness.asked).toHaveLength(asked);
  });

  it("owes the restore again after every background and restores only in the foreground", async () => {
    const harness = warmHarness({ wakeStaggerMs: 0 });
    harness.answerWith([env[0]!, env[1]!]);
    harness.executor.pollWarmRestore();
    await flush();
    for (const call of harness.connects) call.resolve("connected");
    await flush();

    harness.executor.setBackgrounded(true);
    await flush();
    expect(harness.executor.snapshot()).toMatchObject({
      warmEnvironmentIds: [],
      warmRestorePending: true,
      recentEnvironmentIds: [],
      warmCooldownEnvironmentIds: [],
    });
    expect(harness.releases.map((call) => call.environmentId).toSorted()).toEqual([env[0], env[1]]);

    const asked = harness.asked.length;
    harness.executor.pollWarmRestore();
    harness.executor.requestWarmRestore();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.asked).toHaveLength(asked);
    expect(harness.connects).toHaveLength(2);

    harness.executor.setBackgrounded(false);
    await flush();
    expect(harness.connects.map((call) => call.environmentId)).toEqual([
      env[0],
      env[1],
      env[0],
      env[1],
    ]);
    expect(harness.executor.snapshot().warmRestorePending).toBe(false);
  });

  it("restores what was warm before the background, not what was opened while it waited", async () => {
    let ready = false;
    const harness = createHarness({
      wakeStaggerMs: 0,
      warmRestore: (recent) => (ready ? recent : null),
    });
    harness.executor.noteUsed(env[1]!);
    harness.executor.noteUsed(env[0]!);
    harness.executor.setBackgrounded(true);
    harness.executor.setBackgrounded(false);
    await flush();
    harness.executor.noteUsed(env[2]!);

    ready = true;
    harness.executor.pollWarmRestore();
    await flush();
    expect(harness.executor.snapshot()).toMatchObject({
      warmEnvironmentIds: [env[0], env[1]],
      recentEnvironmentIds: [env[2], env[0], env[1]],
    });
  });

  it("wakes the warm set only after the foreground", async () => {
    const harness = warmHarness();
    harness.answerWith([env[0]!, env[1]!]);
    harness.executor.retain({ environmentId: env[2]!, scope: view(2) });
    harness.executor.setForeground(env[2]!);
    await flush();
    expect(harness.connects.map((call) => [call.environmentId, call.at])).toEqual([[env[2], 0]]);
    expect(harness.executor.snapshot().pendingWakes).toEqual([
      { environmentId: env[0], dueAt: 750 },
      { environmentId: env[1], dueAt: 1500 },
    ]);
  });

  it("yields warm environments to a view or the foreground and keeps their leases queued out of sight", async () => {
    const harness = warmHarness({ wakeStaggerMs: 0 });
    harness.answerWith([env[0]!, env[1]!, env[2]!]);
    harness.executor.pollWarmRestore();
    await flush();
    for (const call of harness.connects) call.resolve("connected");
    await flush();

    harness.executor.retain({ environmentId: env[3]!, scope: view(3) });
    await flush();
    expect(harness.releases.map((call) => call.environmentId)).toEqual([env[2]]);
    expect(harness.connectsFor(env[3]!)).toHaveLength(1);
    harness.connectsFor(env[3]!)[0]!.resolve("connected");
    await flush();
    // The platform hears of the release it ran; the displaced lease stays.
    harness.executor.reportConnected(env[2]!, false);
    await flush();
    expect(harness.executor.snapshot()).toMatchObject({
      queuedEnvironmentIds: [],
      warmQueuedEnvironmentIds: [env[2]],
      warmEnvironmentIds: [env[0], env[1], env[2]],
      warmCooldownEnvironmentIds: [],
    });

    harness.executor.retain({ environmentId: env[4]!, scope: view(4) });
    harness.executor.setForeground(env[4]!);
    await flush();
    expect(harness.releases.map((call) => call.environmentId)).toEqual([env[2], env[1]]);
    expect(harness.connectsFor(env[4]!)).toHaveLength(1);
    expect(harness.executor.snapshot().queuedEnvironmentIds).toEqual([]);
    expect(harness.executor.snapshot().warmQueuedEnvironmentIds.toSorted()).toEqual([
      env[1],
      env[2],
    ]);
    expect(harness.maxSlots()).toBeLessThanOrEqual(3);
    expect(harness.maxLive()).toBeLessThanOrEqual(3);
  });

  it("never lists a warm environment among the demand waiting for a slot", async () => {
    const harness = warmHarness({ wakeStaggerMs: 0 });
    for (let index = 0; index < 3; index += 1) {
      harness.executor.retain({ environmentId: env[index]!, scope: view(index) });
    }
    await flush();
    for (const call of harness.connects) call.resolve("connected");
    await flush();

    harness.answerWith([env[3]!, env[4]!]);
    harness.executor.requestWarmRestore();
    await flush();
    expect(harness.connects).toHaveLength(3);
    expect(harness.executor.snapshot()).toMatchObject({
      queuedEnvironmentIds: [],
      warmQueuedEnvironmentIds: [env[3], env[4]],
    });
  });

  it("gives a warm-only environment one attempt: interrupted, refused or failed, it is dropped", async () => {
    const harness = warmHarness({ wakeStaggerMs: 0, releaseMs: null });
    harness.answerWith([env[0]!, env[1]!, env[2]!]);
    harness.executor.pollWarmRestore();
    await flush();
    harness.connects[0]!.resolve("connected");
    harness.connects[1]!.resolve("refused");
    harness.connects[2]!.reject(new Error("relay unavailable"));
    await flush();
    harness.executor.reportInterrupted(env[0]!);
    expect(harness.releases.map((call) => call.environmentId)).toEqual([env[0]]);
    harness.releases[0]!.resolve();
    await flush();

    expect(harness.executor.snapshot()).toMatchObject({
      warmEnvironmentIds: [],
      parkedEnvironmentIds: [],
      queuedEnvironmentIds: [],
      warmQueuedEnvironmentIds: [],
    });
    expect(harness.executor.snapshot().warmCooldownEnvironmentIds.toSorted()).toEqual([
      env[0],
      env[1],
      env[2],
    ]);
    harness.executor.reconcile();
    harness.executor.requestWarmRestore();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.connects).toHaveLength(3);
  });

  it("skips parked environments and never unparks them", async () => {
    const harness = warmHarness({ wakeStaggerMs: 0 });
    harness.executor.retain({ environmentId: env[0]!, scope: view(0) });
    await flush();
    harness.connects[0]!.resolve("refused");
    await flush();

    harness.answerWith([env[0]!, env[1]!]);
    harness.executor.requestWarmRestore();
    await flush();
    expect(harness.executor.snapshot()).toMatchObject({
      warmEnvironmentIds: [env[1]],
      parkedEnvironmentIds: [env[0]],
    });
    expect(harness.connects.map((call) => call.environmentId)).toEqual([env[0], env[1]]);
  });

  it("notes use without creating a lease, renews a held warm lease silently, and reports order changes", async () => {
    const harness = warmHarness({ wakeStaggerMs: 0 });
    const changes = harness.changes();
    harness.executor.noteUsed(env[0]!);
    expect(harness.changes()).toBe(changes + 1);
    expect(harness.executor.snapshot()).toMatchObject({
      recentEnvironmentIds: [env[0]],
      warmEnvironmentIds: [],
    });
    expect(harness.executor.snapshot().demand.leases).toEqual([]);

    harness.answerWith(harness.executor.snapshot().recentEnvironmentIds);
    harness.executor.pollWarmRestore();
    await flush();
    expect(harness.executor.snapshot().warmEnvironmentIds).toEqual([env[0]]);

    await vi.advanceTimersByTimeAsync(1_000);
    const before = harness.changes();
    harness.executor.noteUsed(env[0]!);
    expect(harness.changes()).toBe(before);
    expect(harness.executor.snapshot().demand.leases).toMatchObject([
      { environmentId: env[0], warm: true, expiresAt: 1_000 + UNIFIED_WORKSPACE_WARM_LEASE_TTL_MS },
    ]);

    harness.executor.noteUsed(env[1]!);
    expect(harness.changes()).toBe(before + 1);
    expect(harness.executor.snapshot()).toMatchObject({
      recentEnvironmentIds: [env[1], env[0]],
      warmEnvironmentIds: [env[0]],
    });
    expect(
      harness.executor.snapshot().demand.leases.some((lease) => lease.environmentId === env[1]),
    ).toBe(false);
  });

  it("drops the warm set, the recent list and the owed restore on reset", async () => {
    const harness = warmHarness({ wakeStaggerMs: 0 });
    harness.executor.noteUsed(env[0]!);
    harness.answerWith([env[0]!]);
    harness.executor.pollWarmRestore();
    await flush();
    harness.connects[0]!.resolve("connected");
    await flush();
    harness.executor.setBackgrounded(true);
    await flush();
    harness.executor.setBackgrounded(false);
    harness.executor.resetWarmSet();
    await flush();

    expect(harness.executor.snapshot()).toMatchObject({
      warmEnvironmentIds: [],
      recentEnvironmentIds: [],
      warmRestorePending: false,
    });
    const asked = harness.asked.length;
    harness.executor.pollWarmRestore();
    await flush();
    expect(harness.asked).toHaveLength(asked);
    expect(harness.connects).toHaveLength(1);
  });

  it("never holds more than three slots, nor aborts a connect, while restoring a warm set among five environments", async () => {
    const harness = warmHarness({ wakeStaggerMs: 0, releaseMs: 5 });
    harness.executor.retain({ environmentId: env[3]!, scope: view(3) });
    const fifth = harness.executor.retain({ environmentId: env[4]!, scope: view(4) });
    harness.answerWith([env[0]!, env[1]!, env[2]!]);
    harness.executor.pollWarmRestore();
    await flush();
    expect(harness.connects.map((call) => call.environmentId).toSorted()).toEqual([
      env[0],
      env[3],
      env[4],
    ]);
    // The fifth environment's connect is still in flight.
    harness.connectsFor(env[0]!)[0]!.resolve("connected");
    harness.connectsFor(env[3]!)[0]!.resolve("connected");
    await flush();
    expect(harness.executor.snapshot().warmQueuedEnvironmentIds).toEqual([env[1], env[2]]);

    // Nothing retains it any more, yet the warm set waiting for a slot never
    // aborts it.
    harness.executor.releaseLease(fifth);
    await vi.advanceTimersByTimeAsync(10);
    expect(harness.connectsFor(env[4]!)[0]!.signal.aborted).toBe(false);
    expect(harness.releases).toEqual([]);
    expect(harness.connectsFor(env[1]!)).toEqual([]);

    // Its failure frees the slot the next warm environment takes.
    harness.connectsFor(env[4]!)[0]!.reject(new Error("relay unavailable"));
    await vi.advanceTimersByTimeAsync(10);
    expect(harness.connectsFor(env[1]!)).toHaveLength(1);
    expect(harness.connectsFor(env[2]!)).toEqual([]);
    expect(harness.maxSlots()).toBeLessThanOrEqual(3);
    expect(harness.maxLive()).toBeLessThanOrEqual(3);
  });

  it("changes nothing without a warm restore port", async () => {
    const harness = createHarness({ wakeStaggerMs: 0 });
    harness.executor.noteUsed(env[0]!);
    harness.executor.requestWarmRestore();
    harness.executor.pollWarmRestore();
    harness.executor.setBackgrounded(true);
    await flush();
    harness.executor.setBackgrounded(false);
    await flush();
    expect(harness.connects).toEqual([]);
    expect(harness.executor.snapshot()).toMatchObject({
      warmEnvironmentIds: [],
      warmQueuedEnvironmentIds: [],
      warmRestorePending: false,
      demand: { leases: [] },
    });
  });

  it("never retries a rejected connect for a restore trigger while the restore waits", async () => {
    const harness = warmHarness({ wakeStaggerMs: 0 });
    harness.executor.retain({ environmentId: env[0]!, scope: view(0) });
    await flush();
    harness.connects[0]!.reject(new Error("transport backoff"));
    await flush();
    for (let round = 0; round < 3; round += 1) {
      harness.executor.pollWarmRestore();
      harness.executor.requestWarmRestore();
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(harness.connectsFor(env[0]!)).toHaveLength(1);
    expect(harness.executor.snapshot().warmRestorePending).toBe(true);

    harness.executor.reconcile();
    await flush();
    expect(harness.connectsFor(env[0]!)).toHaveLength(2);
    harness.connects[1]!.reject(new Error("transport backoff"));
    await flush();
    harness.executor.pollWarmRestore();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.connectsFor(env[0]!)).toHaveLength(2);

    harness.executor.unpark(env[0]!);
    await flush();
    expect(harness.connectsFor(env[0]!)).toHaveLength(3);
  });

  it("drops a warm-only environment that stops being live", async () => {
    const harness = warmHarness({ wakeStaggerMs: 0 });
    harness.answerWith([env[0]!]);
    harness.executor.pollWarmRestore();
    await flush();
    harness.connects[0]!.resolve("connected");
    await flush();

    harness.executor.reportConnected(env[0]!, false);
    harness.executor.reconcile();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.connects).toHaveLength(1);
    expect(harness.executor.snapshot()).toMatchObject({
      warmEnvironmentIds: [],
      warmCooldownEnvironmentIds: [env[0]],
      queuedEnvironmentIds: [],
      warmQueuedEnvironmentIds: [],
    });
  });

  it("drops a suspended warm-only environment without a cooldown, so the next foreground restores it", async () => {
    const harness = warmHarness({ wakeStaggerMs: 0 });
    harness.answerWith([env[0]!, env[1]!]);
    harness.executor.pollWarmRestore();
    await flush();
    for (const call of harness.connects) call.resolve("connected");
    await flush();

    // Every connection is suspended before the background is planned.
    harness.executor.reportConnected(env[0]!, false, { suspended: true });
    harness.executor.reportConnected(env[1]!, false, { suspended: true });
    await flush();
    expect(harness.connects).toHaveLength(2);
    expect(harness.executor.snapshot()).toMatchObject({
      warmEnvironmentIds: [],
      warmCooldownEnvironmentIds: [],
      warmQueuedEnvironmentIds: [],
    });

    harness.executor.setBackgrounded(true);
    await flush();
    harness.executor.setBackgrounded(false);
    await flush();
    expect(harness.connects.map((call) => call.environmentId)).toEqual([
      env[0],
      env[1],
      env[0],
      env[1],
    ]);
    expect(harness.executor.snapshot().warmEnvironmentIds).toEqual([env[0], env[1]]);
  });

  it("reconnects a warm environment a view or the foreground also holds", async () => {
    const harness = warmHarness({ wakeStaggerMs: 0 });
    harness.answerWith([env[0]!, env[1]!]);
    harness.executor.retain({ environmentId: env[0]!, scope: view(0) });
    harness.executor.setForeground(env[1]!);
    await flush();
    for (const call of harness.connects) call.resolve("connected");
    await flush();

    harness.executor.reportConnected(env[0]!, false);
    harness.executor.reportConnected(env[1]!, false);
    await flush();
    expect(harness.connectsFor(env[0]!)).toHaveLength(2);
    expect(harness.connectsFor(env[1]!)).toHaveLength(2);
    expect(harness.executor.snapshot()).toMatchObject({
      warmEnvironmentIds: [env[0], env[1]],
      warmCooldownEnvironmentIds: [],
    });
  });

  it("restores a refused warm environment only after its cooldown or a demand edge for it", async () => {
    const harness = warmHarness({ wakeStaggerMs: 0 });
    harness.answerWith([env[0]!]);
    const refuseLatest = async () => {
      harness.connects.at(-1)!.resolve("refused");
      await flush();
    };
    harness.executor.pollWarmRestore();
    await flush();
    await refuseLatest();
    expect(harness.executor.snapshot().warmCooldownEnvironmentIds).toEqual([env[0]]);

    harness.executor.requestWarmRestore();
    await flush();
    expect(harness.connects).toHaveLength(1);
    expect(harness.executor.snapshot().warmEnvironmentIds).toEqual([]);

    await vi.advanceTimersByTimeAsync(UNIFIED_WORKSPACE_WARM_RESTORE_COOLDOWN_MS);
    harness.executor.requestWarmRestore();
    await flush();
    expect(harness.connects).toHaveLength(2);
    await refuseLatest();

    harness.executor.unpark(env[0]!);
    harness.executor.requestWarmRestore();
    await flush();
    expect(harness.connects).toHaveLength(3);
    await refuseLatest();

    // A lease retained and released again is still a demand edge.
    harness.executor.releaseLease(
      harness.executor.retain({ environmentId: env[0]!, scope: view(0) }),
    );
    harness.executor.requestWarmRestore();
    await flush();
    expect(harness.connects).toHaveLength(4);
    await refuseLatest();

    harness.executor.setForeground(env[0]!);
    harness.executor.setForeground(null);
    harness.executor.requestWarmRestore();
    await flush();
    expect(harness.connects).toHaveLength(5);
  });
});

describe("warm restore and the environment in view", () => {
  const session = (
    sessionEstablished: boolean,
    transportStatus: "connecting" | "online" | "terminal-failure",
  ) => ({ sessionEstablished, transportStatus });

  it("treats an established or terminally failed session as settled", () => {
    expect(isWarmRestoreForegroundSettled(session(true, "online"))).toBe(true);
    expect(isWarmRestoreForegroundSettled(session(false, "terminal-failure"))).toBe(true);
    expect(isWarmRestoreForegroundSettled(session(false, "connecting"))).toBe(false);
  });

  it("waits only for a connectable, unparked environment whose session has not settled", () => {
    const waits = (input: Partial<Parameters<typeof warmRestoreWaitsForForeground>[0]>) =>
      warmRestoreWaitsForForeground({
        connectable: true,
        parked: false,
        session: session(false, "connecting"),
        ...input,
      });
    expect(waits({})).toBe(true);
    expect(waits({ session: undefined })).toBe(true);
    expect(waits({ session: session(true, "online") })).toBe(false);
    expect(waits({ session: session(false, "terminal-failure") })).toBe(false);
    expect(waits({ connectable: false })).toBe(false);
    expect(waits({ parked: true })).toBe(false);
  });
});
