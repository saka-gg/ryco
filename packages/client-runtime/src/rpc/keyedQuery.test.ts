import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@ryco/contracts";
import type { AppLifecycleEvent, AppLifecycleService } from "../platform/index.ts";

import {
  createKeyedQueryRegistry,
  defineKeyedQueryByInput,
  type KeyedQueryRegistryConfig,
} from "./keyedQuery.ts";

interface State {
  readonly data: string | null;
  readonly fetching: boolean;
  readonly error: Error | null;
}

const initialState: State = { data: null, fetching: false, error: null };
const environmentId = EnvironmentId.make("environment-keyed-query-test");

function makeRegistry(input?: {
  readonly gcTime?: number;
  readonly maxEntries?: number;
  readonly lifecycle?: AppLifecycleService;
  readonly admission?: KeyedQueryRegistryConfig<State>["admission"];
}) {
  return createKeyedQueryRegistry<State>({
    labelPrefix: "keyed-query-test",
    initialState,
    gcTime: input?.gcTime ?? 20,
    maxEntries: input?.maxEntries ?? 16,
    ...(input?.lifecycle ? { lifecycle: input.lifecycle } : {}),
    ...(input?.admission ? { admission: input.admission } : {}),
    buildFetchingState: (current) => ({ ...current, fetching: true, error: null }),
    buildSuccessState: (data) => ({ data: data as string, fetching: false, error: null }),
    buildErrorState: (current, error) => ({ ...current, fetching: false, error }),
    isErrorState: (state) => state.error !== null,
  });
}

function createLifecycleHarness() {
  let foreground = true;
  let online = true;
  const listeners = new Set<(event: AppLifecycleEvent) => void>();
  const lifecycle: AppLifecycleService = {
    isForeground: () => foreground,
    isOnline: () => online,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    lifecycle,
    emit(event: AppLifecycleEvent) {
      if (event === "background") foreground = false;
      if (event === "foreground" || event === "resume") foreground = true;
      if (event === "offline") online = false;
      if (event === "online") online = true;
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

function makeBinding(
  registry: ReturnType<typeof makeRegistry>,
  run: (key: string) => Promise<string>,
) {
  return defineKeyedQueryByInput(
    registry,
    {
      label: "family",
      staleTime: 60_000,
      isEnabled: () => true,
      buildKey: (input: { readonly key: string }) => `${environmentId}\u0000${input.key}`,
      resolveEnvironmentId: () => environmentId,
      createControllerFields: () => ({}),
      run: (input) => run(input.key),
    },
    (controller) => !controller.hasData,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("keyed query retention", () => {
  it("evicts released entries after gcTime and releases their payload", async () => {
    vi.useFakeTimers();
    const registry = makeRegistry();
    const binding = makeBinding(registry, (key) => Promise.resolve(`value:${key}`));
    const input = { key: "one" };
    const compositeKey = binding.targetKey(input) as string;

    const release = binding.watch(input);
    await vi.runAllTicks();
    await registry.controllers.get(compositeKey)?.inFlightPromise;
    expect(binding.snapshotFor(input).data).toBe("value:one");

    release();
    await vi.advanceTimersByTimeAsync(21);
    expect(registry.controllers.has(compositeKey)).toBe(false);
    expect(binding.snapshotFor(input)).toEqual(initialState);
  });

  it("pins active and in-flight entries until they become safely evictable", async () => {
    vi.useFakeTimers();
    let resolveRun: ((value: string) => void) | undefined;
    const registry = makeRegistry();
    const binding = makeBinding(
      registry,
      () =>
        new Promise<string>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const input = { key: "pending" };
    const compositeKey = binding.targetKey(input) as string;
    const release = binding.watch(input);

    await vi.advanceTimersByTimeAsync(100);
    expect(registry.evict(compositeKey)).toBe(false);
    release();
    expect(registry.evict(compositeKey)).toBe(false);

    resolveRun?.("done");
    await registry.controllers.get(compositeKey)?.inFlightPromise;
    await vi.advanceTimersByTimeAsync(21);
    expect(registry.controllers.has(compositeKey)).toBe(false);
  });

  it("uses indexed environment and family lookups", () => {
    const registry = makeRegistry();
    const binding = makeBinding(registry, (key) => Promise.resolve(key));
    const releaseOne = binding.watch({ key: "one" });
    const releaseTwo = binding.watch({ key: "two" });

    expect(registry.controllerKeys({ environmentId }).size).toBe(2);
    expect(registry.controllerKeys({ family: "family" }).size).toBe(2);
    registry.clearEnvironment(environmentId);
    expect(registry.controllerKeys({ environmentId }).size).toBe(0);

    releaseOne();
    releaseTwo();
  });

  it("evicts least-recent idle entries before active entries at capacity", async () => {
    vi.useFakeTimers();
    const registry = makeRegistry({ gcTime: 60_000, maxEntries: 2 });
    const binding = makeBinding(registry, (key) => Promise.resolve(key));
    const releaseOne = binding.watch({ key: "one" });
    await registry.controllers.get(binding.targetKey({ key: "one" }) as string)?.inFlightPromise;
    releaseOne();

    const releaseTwo = binding.watch({ key: "two" });
    const releaseThree = binding.watch({ key: "three" });
    expect(registry.controllers.has(binding.targetKey({ key: "one" }) as string)).toBe(false);
    expect(registry.controllers.has(binding.targetKey({ key: "two" }) as string)).toBe(true);
    expect(registry.controllers.has(binding.targetKey({ key: "three" }) as string)).toBe(true);

    releaseTwo();
    releaseThree();
  });
});

describe("keyed query reconnect refresh", () => {
  it("retries an active failed query once across duplicate refresh requests", async () => {
    const registry = makeRegistry();
    const run = vi
      .fn<(key: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue("ready");
    const binding = makeBinding(registry, run);
    const input = { key: "failed" };
    const compositeKey = binding.targetKey(input) as string;
    const release = binding.watch(input);
    await registry.controllers.get(compositeKey)?.inFlightPromise;

    expect(binding.snapshotFor(input).error?.message).toBe("offline");
    await Promise.all([
      registry.refreshActiveEnvironment(environmentId),
      registry.refreshActiveEnvironment(environmentId),
    ]);

    expect(run).toHaveBeenCalledTimes(2);
    expect(binding.snapshotFor(input)).toEqual({ data: "ready", fetching: false, error: null });
    release();
    registry.dispose();
  });

  it("fences a late result from the superseded transport generation", async () => {
    const registry = makeRegistry();
    const resolvers: Array<(value: string) => void> = [];
    const binding = makeBinding(
      registry,
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const input = { key: "generation" };
    const compositeKey = binding.targetKey(input) as string;
    const release = binding.watch(input);
    const stale = registry.controllers.get(compositeKey)?.inFlightPromise;

    registry.fenceActiveEnvironment(environmentId);
    const current = registry.refreshActiveEnvironment(environmentId);
    expect(resolvers).toHaveLength(2);
    resolvers[1]?.("current");
    await current;
    resolvers[0]?.("stale");
    await stale;

    expect(binding.snapshotFor(input).data).toBe("current");
    release();
    registry.dispose();
  });
});

describe("keyed query polling", () => {
  it("shares one timer at the fastest subscriber cadence and reschedules after release", async () => {
    vi.useFakeTimers();
    const run = vi.fn((key: string) => Promise.resolve(`value:${key}`));
    const registry = makeRegistry({ gcTime: 60_000 });
    const binding = makeBinding(registry, run);
    const input = { key: "shared" };

    const releaseSlow = binding.watch(input, () => 30_000);
    const releaseFast = binding.watch(input, () => 10_000);
    await registry.controllers.get(binding.targetKey(input) as string)?.inFlightPromise;
    expect(run).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);

    releaseFast();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(3);

    releaseSlow();
  });

  it("pauses timers in the background and performs one eligible stale refresh on recovery", async () => {
    vi.useFakeTimers();
    const lifecycleHarness = createLifecycleHarness();
    const run = vi.fn((key: string) => Promise.resolve(`value:${key}`));
    const registry = makeRegistry({ gcTime: 60_000, lifecycle: lifecycleHarness.lifecycle });
    const binding = makeBinding(registry, run);
    const input = { key: "lifecycle" };

    const release = binding.watch(input, {
      resolveIntervalMs: () => 10_000,
      shouldRefreshOnLifecycle: ({ hasData, lastFetchedAt, staleTime }) =>
        !hasData || Date.now() - lastFetchedAt >= staleTime,
    });
    await registry.controllers.get(binding.targetKey(input) as string)?.inFlightPromise;
    expect(run).toHaveBeenCalledTimes(1);

    lifecycleHarness.emit("background");
    await vi.advanceTimersByTimeAsync(70_000);
    expect(run).toHaveBeenCalledTimes(1);

    lifecycleHarness.emit("foreground");
    await vi.runAllTicks();
    expect(run).toHaveBeenCalledTimes(2);

    lifecycleHarness.emit("offline");
    await vi.advanceTimersByTimeAsync(70_000);
    expect(run).toHaveBeenCalledTimes(2);
    lifecycleHarness.emit("online");
    await vi.runAllTicks();
    expect(run).toHaveBeenCalledTimes(3);

    release();
    registry.dispose();
    expect(lifecycleHarness.listenerCount()).toBe(0);
  });

  it("does not schedule or lifecycle-refresh a manual subscriber", async () => {
    vi.useFakeTimers();
    const lifecycleHarness = createLifecycleHarness();
    const run = vi.fn((key: string) => Promise.resolve(`value:${key}`));
    const registry = makeRegistry({ gcTime: 60_000, lifecycle: lifecycleHarness.lifecycle });
    const binding = makeBinding(registry, run);
    const input = { key: "manual" };

    const release = binding.watch(input, {
      resolveIntervalMs: () => false,
      shouldRefreshOnLifecycle: () => false,
    });
    await registry.controllers.get(binding.targetKey(input) as string)?.inFlightPromise;
    await vi.advanceTimersByTimeAsync(120_000);
    lifecycleHarness.emit("background");
    lifecycleHarness.emit("foreground");
    await vi.runAllTicks();

    expect(run).toHaveBeenCalledTimes(1);
    release();
    registry.dispose();
  });
});

describe("keyed query local writes", () => {
  function deferredRuns() {
    const resolvers: Array<(value: string) => void> = [];
    const run = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    return { run, resolvers };
  }

  it("keeps a local write when a read that started before it resolves late", async () => {
    const registry = makeRegistry();
    const { run, resolvers } = deferredRuns();
    const binding = makeBinding(registry, run);
    const input = { key: "optimistic" };
    const compositeKey = binding.targetKey(input) as string;
    const release = binding.watch(input);
    const staleRead = registry.controllers.get(compositeKey)?.inFlightPromise;

    binding.updateData(input, () => "optimistic");
    resolvers[0]?.("server-before-write");
    await staleRead;

    expect(binding.snapshotFor(input).data).toBe("optimistic");
    expect(registry.controllers.get(compositeKey)?.inFlightPromise).toBeNull();
    release();
    registry.dispose();
  });

  it("starts a fresh read for a refresh after a local write instead of joining the stale one", async () => {
    const registry = makeRegistry();
    const { run, resolvers } = deferredRuns();
    const binding = makeBinding(registry, run);
    const input = { key: "refresh-after-write" };
    const compositeKey = binding.targetKey(input) as string;
    const release = binding.watch(input);
    const staleRead = registry.controllers.get(compositeKey)?.inFlightPromise;

    binding.updateData(input, () => "optimistic");
    const fresh = binding.refreshAsync(input);
    expect(run).toHaveBeenCalledTimes(2);

    resolvers[1]?.("server-after-write");
    await fresh;
    resolvers[0]?.("server-before-write");
    await staleRead;

    expect(binding.snapshotFor(input).data).toBe("server-after-write");
    release();
    registry.dispose();
  });

  it("still dedupes concurrent reads when no local write intervened", async () => {
    const registry = makeRegistry();
    const { run, resolvers } = deferredRuns();
    const binding = makeBinding(registry, run);
    const input = { key: "dedupe" };
    const release = binding.watch(input);

    const first = binding.refreshAsync(input);
    const second = binding.refreshAsync(input);
    expect(run).toHaveBeenCalledTimes(1);
    resolvers[0]?.("value");
    await Promise.all([first, second]);

    expect(binding.snapshotFor(input).data).toBe("value");
    release();
    registry.dispose();
  });

  it("reports the superseded read's outcome so run bookkeeping stays balanced", async () => {
    const outcomes: Array<string> = [];
    let running = 0;
    const registry = createKeyedQueryRegistry<State>({
      labelPrefix: "keyed-query-bookkeeping-test",
      initialState,
      gcTime: 20,
      buildFetchingState: (current) => ({ ...current, fetching: true, error: null }),
      buildSuccessState: (data) => ({ data: data as string, fetching: false, error: null }),
      buildErrorState: (current, error) => ({ ...current, fetching: false, error }),
      onRunStart: () => {
        running += 1;
      },
      onRunEnd: (_controller, outcome) => {
        running -= 1;
        outcomes.push(outcome);
      },
    });
    const { run, resolvers } = deferredRuns();
    const binding = makeBinding(registry, run);
    const input = { key: "bookkeeping" };
    const compositeKey = binding.targetKey(input) as string;
    const release = binding.watch(input);
    const staleRead = registry.controllers.get(compositeKey)?.inFlightPromise;

    binding.updateData(input, () => "optimistic");
    resolvers[0]?.("server-before-write");
    await staleRead;

    expect(outcomes).toEqual(["success"]);
    expect(running).toBe(0);
    expect(binding.snapshotFor(input).data).toBe("optimistic");
    release();
    registry.dispose();
  });
});

describe("keyed query publish hook", () => {
  it("reports published reads only, never superseded or fenced ones", async () => {
    const published: Array<{ key: string; data: unknown }> = [];
    const registry = createKeyedQueryRegistry<State>({
      labelPrefix: "keyed-query-publish-test",
      initialState,
      gcTime: 20,
      buildFetchingState: (current) => ({ ...current, fetching: true, error: null }),
      buildSuccessState: (data) => ({ data: data as string, fetching: false, error: null }),
      buildErrorState: (current, error) => ({ ...current, fetching: false, error }),
      onPublish: (controller, data) => {
        published.push({ key: controller.compositeKey, data });
      },
    });
    const resolvers: Array<(value: string) => void> = [];
    const binding = makeBinding(
      registry,
      () =>
        new Promise<string>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const input = { key: "publish" };
    const compositeKey = binding.targetKey(input) as string;
    const release = binding.watch(input);

    // Superseded by a local write: not published, not reported.
    const superseded = registry.controllers.get(compositeKey)?.inFlightPromise;
    binding.updateData(input, () => "local");
    resolvers[0]?.("before-write");
    await superseded;
    expect(published).toEqual([]);

    // Fenced by a cancel: not reported either.
    binding.refresh(input);
    const controller = registry.controllers.get(compositeKey)!;
    const fenced = controller.inFlightPromise;
    registry.cancel(controller);
    resolvers[1]?.("fenced");
    await fenced;
    expect(published).toEqual([]);

    const fresh = binding.refreshAsync(input);
    resolvers[2]?.("fresh");
    await fresh;
    expect(published).toEqual([{ key: compositeKey, data: "fresh" }]);
    release();
    registry.dispose();
  });
});

describe("keyed query state tracking", () => {
  it("resets a key written again after a previous reset", () => {
    const registry = makeRegistry();
    const binding = makeBinding(registry, () => Promise.resolve("unused"));
    const input = { key: "rewritten" };

    binding.updateData(input, () => "first");
    registry.resetForTests();
    expect(binding.snapshotFor(input).data).toBeNull();

    binding.updateData(input, () => "second");
    registry.resetForTests();
    expect(binding.snapshotFor(input).data).toBeNull();
    registry.dispose();
  });
});

describe("keyed query read admission", () => {
  it("pauses watch, refresh and lifecycle reads, resumes mounted reads, and releases the authority listener", async () => {
    vi.useFakeTimers();
    const lifecycle = createLifecycleHarness();
    let key: string | null = null;
    let notify = () => {};
    const unsubscribe = vi.fn();
    const registry = makeRegistry({
      lifecycle: lifecycle.lifecycle,
      admission: {
        readState: () => ({ key, scope: "test-scope" }),
        subscribe: (listener) => {
          notify = listener;
          return unsubscribe;
        },
        buildPausedState: (current) => ({ ...current, fetching: false, error: null }),
      },
    });
    const run = vi.fn(async () => "fresh");
    const binding = makeBinding(registry, run);
    const input = { key: "admitted" };
    const release = binding.watch(input, () => 1_000);
    binding.refresh(input);
    lifecycle.emit("online");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).not.toHaveBeenCalled();
    key = "generation-1";
    notify();
    await registry.controllers.get(binding.targetKey(input)!)!.inFlightPromise;
    expect(run).toHaveBeenCalledOnce();
    key = null;
    notify();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(run).toHaveBeenCalledOnce();
    expect(binding.snapshotFor(input)).toEqual({ data: "fresh", fetching: false, error: null });
    release();
    registry.dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("clears data when retention authority changes even while reads remain paused", async () => {
    let key: string | null = "generation-1";
    let scope: string | null = "account-1";
    let notify = () => {};
    const registry = makeRegistry({
      admission: {
        readState: () => ({ key, scope }),
        subscribe: (listener) => {
          notify = listener;
          return () => {};
        },
        buildPausedState: (current, _controller, retainData) => ({
          data: retainData ? current.data : null,
          fetching: false,
          error: null,
        }),
      },
    });
    const run = vi.fn(async () => "private");
    const binding = makeBinding(registry, run);
    const input = { key: "retention" };
    const release = binding.watch(input);
    await registry.controllers.get(binding.targetKey(input)!)!.inFlightPromise;
    key = null;
    notify();
    expect(binding.snapshotFor(input).data).toBe("private");
    scope = null;
    notify();
    expect(binding.snapshotFor(input).data).toBeNull();
    expect(run).toHaveBeenCalledOnce();
    release();
    registry.dispose();
  });

  it("processes an authority change before joining an old read when notification is delayed", async () => {
    let key: string | null = "generation-1";
    let notify = () => {};
    const registry = makeRegistry({
      admission: {
        readState: () => ({ key, scope: "test-scope" }),
        subscribe: (listener) => {
          notify = listener;
          return () => {};
        },
        buildPausedState: (current) => ({ ...current, fetching: false, error: null }),
      },
    });
    let finish = (_value: string) => {};
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue("new");
    const binding = makeBinding(registry, run);
    const input = { key: "delayed-notification" };
    const release = binding.watch(input);
    const old = registry.controllers.get(binding.targetKey(input)!)!.inFlightPromise;
    key = "generation-2";
    await binding.refreshAsync(input);
    notify();
    finish("old");
    await old;
    expect(run).toHaveBeenCalledTimes(2);
    expect(binding.snapshotFor(input).data).toBe("new");
    key = null;
    await binding.refreshAsync(input);
    notify();
    expect(binding.snapshotFor(input)).toEqual({ data: "new", fetching: false, error: null });
    release();
    registry.dispose();
  });

  it("defers resumed non-polling reads until the browser is foreground and online", async () => {
    const lifecycle = createLifecycleHarness();
    let key: string | null = null;
    let notify = () => {};
    const registry = makeRegistry({
      lifecycle: lifecycle.lifecycle,
      admission: {
        readState: () => ({ key, scope: "test-scope" }),
        subscribe: (listener) => {
          notify = listener;
          return () => {};
        },
        buildPausedState: (current) => ({ ...current, fetching: false, error: null }),
      },
    });
    const run = vi.fn(async () => "fresh");
    const binding = makeBinding(registry, run);
    const input = { key: "background" };
    const release = binding.watch(input, { shouldRefreshOnLifecycle: () => false });
    lifecycle.emit("background");
    lifecycle.emit("offline");
    key = "generation-1";
    notify();
    lifecycle.emit("foreground");
    expect(run).not.toHaveBeenCalled();
    lifecycle.emit("online");
    await registry.controllers.get(binding.targetKey(input)!)!.inFlightPromise;
    expect(run).toHaveBeenCalledOnce();
    release();
    registry.dispose();
  });

  it("collects an unwatched pending read after admission cancels it", async () => {
    vi.useFakeTimers();
    let key: string | null = "generation-1";
    let notify = () => {};
    const registry = makeRegistry({
      admission: {
        readState: () => ({ key, scope: "test-scope" }),
        subscribe: (listener) => {
          notify = listener;
          return () => {};
        },
        buildPausedState: (current) => ({ ...current, fetching: false, error: null }),
      },
    });
    let finish = (_value: string) => {};
    const binding = makeBinding(
      registry,
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const input = { key: "unwatched" };
    const release = binding.watch(input);
    release();
    key = null;
    notify();
    await vi.advanceTimersByTimeAsync(21);
    expect(registry.controllers.size).toBe(0);
    finish("old");
    await Promise.resolve();
    expect(binding.snapshotFor(input)).toEqual(initialState);
    registry.dispose();
  });

  it.each(["success", "failure"] as const)(
    "fences an old %s when the authority generation changes while still admitted",
    async (outcome) => {
      let key = "generation-1";
      let notify = () => {};
      const registry = makeRegistry({
        admission: {
          readState: () => ({ key, scope: "test-scope" }),
          subscribe: (listener) => {
            notify = listener;
            return () => {};
          },
          buildPausedState: (current) => ({ ...current, fetching: false, error: null }),
        },
      });
      let resolve = (_value: string) => {};
      let reject = (_error: Error) => {};
      const run = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<string>((accept, refuse) => {
              resolve = accept;
              reject = refuse;
            }),
        )
        .mockResolvedValue("new");
      const binding = makeBinding(registry, run);
      const input = { key: "generation" };
      const release = binding.watch(input);
      const old = registry.controllers.get(binding.targetKey(input)!)!.inFlightPromise;
      key = "generation-2";
      notify();
      await registry.controllers.get(binding.targetKey(input)!)!.inFlightPromise;
      if (outcome === "success") resolve("old");
      else reject(new Error("old failure"));
      await old;
      expect(binding.snapshotFor(input)).toEqual({ data: "new", fetching: false, error: null });
      expect(run).toHaveBeenCalledTimes(2);
      release();
      registry.dispose();
    },
  );
});
