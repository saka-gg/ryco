import type { SavedEnvironmentRuntimeState } from "@ryco/client-runtime/connection";
import { dailyRecapCache } from "@ryco/client-runtime/state/dailyRecap";
import { calendarDateInZone, currentTimeZone } from "@ryco/client-runtime/usage";
import { EnvironmentId, type DailyRecapRequest, type DailyRecapSnapshot } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook } from "vitest-browser-react";

/*
 * Stand-ins for the connection registry, the saved connections' runtime
 * state, hosted mode with each node's session capability, and the thread
 * store, so the hook runs without the app's connection graph.
 */
const registry = vi.hoisted(() => ({
  connections: [] as unknown[],
  listeners: new Set<() => void>(),
  runtimeById: {} as Record<string, unknown>,
  runtimeListeners: new Set<() => void>(),
  hosted: false,
  capabilityById: {} as Record<string, { allowed: boolean; kind: string }>,
}));

vi.mock("~/environments/runtime", () => ({
  listEnvironmentConnections: () => [...registry.connections],
  subscribeEnvironmentConnections: (listener: () => void) => {
    registry.listeners.add(listener);
    return () => registry.listeners.delete(listener);
  },
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({ byId: registry.runtimeById }),
    subscribe: (listener: () => void) => {
      registry.runtimeListeners.add(listener);
      return () => registry.runtimeListeners.delete(listener);
    },
  },
}));

vi.mock("~/environments/primary", () => ({ usePrimaryEnvironmentId: () => null }));

vi.mock("~/env", () => ({ isHostedHubMode: () => registry.hosted }));

vi.mock("~/hostedHub/capabilities", () => ({
  readHostedRpcCapability: (_method: string, environmentId: string) => ({
    hosted: true,
    reason: null,
    ...registry.capabilityById[environmentId],
  }),
  subscribeHostedRpcCapabilities: () => () => undefined,
}));

vi.mock("~/store", async () => {
  const { create } = await import("zustand");
  return { useStore: create(() => ({ environmentStateById: {} })) };
});

import { useStore } from "~/store";

import { prefetchDailyRecap, useDailyRecap } from "./useDailyRecap";

const NOW_MS = Date.parse("2026-10-24T12:00:00.000Z");
const TODAY = calendarDateInZone(NOW_MS, currentTimeZone());
const emptySection = { totalThreads: 0, threads: [], truncated: false };

function snapshot(request: DailyRecapRequest, completedTurns: number): DailyRecapSnapshot {
  return {
    date: request.date,
    timeZone: request.timeZone,
    generatedAt: "2026-10-24T12:00:00.000Z",
    from: "2026-10-23T22:00:00.000Z",
    to: "2026-10-24T22:00:00.000Z",
    counts: { completedTurns, failedTurns: 0, interruptedTurns: 0 },
    completed: emptySection,
    failed: emptySection,
    needsAttention: emptySection,
  };
}

/** A node whose recap requests settle only when the test answers them. */
function node(id: string, kind: "primary" | "saved" = "primary") {
  const calls: Array<{
    readonly request: DailyRecapRequest;
    readonly resolve: (snapshot: DailyRecapSnapshot) => void;
    readonly reject: (cause: unknown) => void;
  }> = [];
  const getDailyRecap = vi.fn(
    (request: DailyRecapRequest) =>
      new Promise<DailyRecapSnapshot>((resolve, reject) => {
        calls.push({ request, resolve, reject });
      }),
  );
  const environmentId = EnvironmentId.make(id);
  return {
    environmentId,
    getDailyRecap,
    value: {
      kind,
      environmentId,
      knownEnvironment: { label: id },
      client: { server: { getDailyRecap } },
    },
    /** The dates asked so far, in order. */
    dates: () => calls.map((call) => call.request.date),
    requests: () => calls.map((call) => call.request),
    /** Answer every open request: today's with `completedTurns`, the day before's with 1. */
    answerAll: (completedTurns: number) => {
      for (const call of calls.splice(0)) {
        call.resolve(snapshot(call.request, call.request.date === TODAY ? completedTurns : 1));
      }
    },
    failAll: () => {
      for (const call of calls.splice(0)) call.reject(new Error("socket closed"));
    },
    get open() {
      return calls.length;
    },
  };
}

function setSavedRuntime(
  environmentId: EnvironmentId,
  patch: Partial<SavedEnvironmentRuntimeState>,
): void {
  registry.runtimeById = {
    ...registry.runtimeById,
    [environmentId]: {
      connectionState: "connected",
      role: "owner",
      disconnectedAt: null,
      ...patch,
    },
  };
  for (const listener of registry.runtimeListeners) listener();
}

/** Each node's live shell with one chat whose turn finished at `completedAt`. */
function setFinishedTurns(finished: Record<string, string>): void {
  const environmentStateById = Object.fromEntries(
    Object.entries(finished).map(([environmentId, completedAt]) => [
      environmentId,
      {
        bootstrapComplete: true,
        sidebarThreadSummaryById: {
          chat: { id: "chat", latestTurn: { state: "completed", completedAt } },
        },
      },
    ]),
  );
  useStore.setState({ environmentStateById } as never);
}

afterEach(() => {
  vi.useRealTimers();
  registry.connections = [];
  registry.listeners.clear();
  registry.runtimeById = {};
  registry.runtimeListeners.clear();
  registry.hosted = false;
  registry.capabilityById = {};
  useStore.setState({ environmentStateById: {} } as never);
  dailyRecapCache.clear();
});

describe("useDailyRecap", () => {
  it("asks ready nodes, reports a disconnected one at once and waits for a connecting one", async () => {
    const local = node("local");
    const box = node("box", "saved");
    const mini = node("mini", "saved");
    const studio = node("studio", "saved");
    registry.connections = [local.value, box.value, mini.value, studio.value];
    setSavedRuntime(box.environmentId, {});
    setSavedRuntime(mini.environmentId, { connectionState: "disconnected" });
    setSavedRuntime(studio.environmentId, { connectionState: "connecting" });
    const hook = await renderHook(() => useDailyRecap({ nowMs: NOW_MS }));

    await expect.poll(() => local.open + box.open).toBe(2);
    expect(mini.open).toBe(0);
    expect(studio.open).toBe(0);
    await hook.act(() => {
      local.answerAll(3);
      box.answerAll(2);
    });
    await expect.poll(() => hook.result.current.today?.counts.completedTurns).toBe(5);
    const statuses = Object.fromEntries(
      hook.result.current.nodes.map((entry) => [entry.label, entry.result?.status]),
    );
    expect(statuses).toEqual({ local: "ready", box: "ready", mini: "offline", studio: undefined });
    expect(hook.result.current.pendingEnvironmentIds).toEqual([studio.environmentId]);

    await hook.act(() => setSavedRuntime(studio.environmentId, {}));
    await expect.poll(() => studio.open).toBe(1);
  });

  it("follows each hosted node's own session", async () => {
    registry.hosted = true;
    const selected = node("selected");
    const warm = node("warm");
    const member = node("member");
    registry.connections = [selected.value, warm.value, member.value];
    registry.capabilityById = {
      selected: { allowed: true, kind: "ready" },
      warm: { allowed: false, kind: "establishing" },
      member: { allowed: false, kind: "role" },
    };
    const hook = await renderHook(() => useDailyRecap({ nowMs: NOW_MS }));
    await expect.poll(() => selected.open).toBe(1);
    expect(warm.open + member.open).toBe(0);
    await hook.act(() => selected.answerAll(2));
    await expect.poll(() => hook.result.current.today?.counts.completedTurns).toBe(2);
    expect(hook.result.current.nodes.map((entry) => entry.result?.status)).toEqual([
      "ready",
      undefined,
      "forbidden",
    ]);
    expect(hook.result.current.pendingEnvironmentIds).toEqual([warm.environmentId]);
  });

  it("asks for the day before only once a node's today has answered", async () => {
    const local = node("local");
    registry.connections = [local.value];
    const hook = await renderHook(() => useDailyRecap({ nowMs: NOW_MS }));
    await expect.poll(() => local.open).toBe(1);
    expect(local.dates()).toEqual([TODAY]);

    await hook.act(() => local.answerAll(4));
    await expect.poll(() => local.open).toBe(1);
    const [yesterday] = local.requests();
    expect(yesterday).toMatchObject({ limit: 1 });
    expect((yesterday?.date ?? TODAY) < TODAY).toBe(true);
    await hook.act(() => local.answerAll(4));
    await expect.poll(() => hook.result.current.yesterday?.counts.completedTurns).toBe(1);
    expect(hook.result.current.today?.counts.completedTurns).toBe(4);
  });

  it("keeps a node's last recap when a refresh fails", async () => {
    const local = node("local");
    registry.connections = [local.value];
    const hook = await renderHook(() => useDailyRecap({ nowMs: NOW_MS }));
    await expect.poll(() => local.open).toBe(1);
    await hook.act(() => local.answerAll(4));
    await expect.poll(() => hook.result.current.today?.counts.completedTurns).toBe(4);
    await expect.poll(() => local.open).toBe(1);
    await hook.act(() => local.answerAll(4));

    expect(hook.result.current.nodes[0]?.stale).toBe(false);

    await hook.act(() => hook.result.current.refresh());
    await expect.poll(() => hook.result.current.refreshing).toBe(true);
    // Asked again, it keeps its answer meanwhile.
    expect(hook.result.current.nodes[0]).toMatchObject({
      stale: false,
      result: { status: "ready" },
    });
    expect(hook.result.current.loading).toBe(false);
    await hook.act(() => local.failAll());
    await expect.poll(() => hook.result.current.nodes[0]?.result?.status).toBe("failed");
    expect(hook.result.current.nodes[0]).toMatchObject({
      stale: true,
      recap: { snapshot: { counts: { completedTurns: 4 } } },
    });
    expect(hook.result.current.today?.counts.completedTurns).toBe(4);
    expect(hook.result.current.loading).toBe(false);
    expect(hook.result.current.refreshing).toBe(false);

    // A failed node asked again keeps its status meanwhile, so its footer note holds still.
    await hook.act(() => hook.result.current.refresh());
    await expect.poll(() => hook.result.current.refreshing).toBe(true);
    expect(hook.result.current.nodes[0]?.result?.status).toBe("failed");
  });

  it("does not spin Refresh for devices that are still connecting", async () => {
    const local = node("local");
    const box = node("box", "saved");
    const studio = node("studio", "saved");
    registry.connections = [local.value, box.value, studio.value];
    // Dropped, and trying again on its backoff.
    setSavedRuntime(box.environmentId, {
      connectionState: "connecting",
      disconnectedAt: "2026-10-24T11:00:00.000Z",
    });
    // Its first connection since the app started.
    setSavedRuntime(studio.environmentId, { connectionState: "connecting" });
    const hook = await renderHook(() => useDailyRecap({ nowMs: NOW_MS }));
    await expect.poll(() => local.open).toBe(1);
    await hook.act(() => local.answerAll(3));
    await expect.poll(() => hook.result.current.today?.counts.completedTurns).toBe(3);

    expect(box.open + studio.open).toBe(0);
    expect(hook.result.current.nodes.map((entry) => entry.result?.status)).toEqual([
      "ready",
      "offline",
      undefined,
    ]);
    expect(hook.result.current.pendingEnvironmentIds).toEqual([studio.environmentId]);
    expect(hook.result.current.refreshing).toBe(false);
  });

  it("asks only a node that finished a turn again, at most every 20 seconds", async () => {
    // The test clock starts at the real one: the recap cache stamps requests with the real clock.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.now() });
    const local = node("local");
    const other = node("other");
    registry.connections = [local.value, other.value];
    setFinishedTurns({ local: "2026-10-24T11:00:00.000Z", other: "2026-10-24T11:00:00.000Z" });
    const hook = await renderHook(() => useDailyRecap({ nowMs: NOW_MS }));
    await expect.poll(() => local.open + other.open).toBe(2);
    await hook.act(() => {
      local.answerAll(1);
      other.answerAll(1);
    });
    await expect.poll(() => local.open + other.open).toBe(2);
    await hook.act(() => {
      local.answerAll(1);
      other.answerAll(1);
    });
    await expect.poll(() => hook.result.current.yesterday).not.toBeNull();
    const todayAsks = (entry: ReturnType<typeof node>) =>
      entry.getDailyRecap.mock.calls.filter(([request]) => request.date === TODAY).length;

    await hook.act(() =>
      setFinishedTurns({ local: "2026-10-24T11:58:00.000Z", other: "2026-10-24T11:00:00.000Z" }),
    );
    await expect.poll(() => todayAsks(local)).toBe(2);
    expect(todayAsks(other)).toBe(1);
    await hook.act(() => local.answerAll(2));
    await expect.poll(() => hook.result.current.today?.counts.completedTurns).toBe(3);

    // A second turn within 20 s waits for the rest of them.
    await hook.act(() => vi.advanceTimersByTime(5_000));
    await hook.act(() =>
      setFinishedTurns({ local: "2026-10-24T11:59:00.000Z", other: "2026-10-24T11:00:00.000Z" }),
    );
    await hook.act(() => vi.advanceTimersByTime(14_000));
    expect(todayAsks(local)).toBe(2);
    await hook.act(() => vi.advanceTimersByTime(1_000));
    await expect.poll(() => todayAsks(local)).toBe(3);
    expect(todayAsks(other)).toBe(1);
  });

  it("polls every 5 minutes and asks again on focus after a minute", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: Date.now() });
    const local = node("local");
    registry.connections = [local.value];
    const hook = await renderHook(() => useDailyRecap({ nowMs: NOW_MS }));
    await expect.poll(() => local.open).toBe(1);
    await hook.act(() => local.answerAll(1));
    await expect.poll(() => local.open).toBe(1);
    await hook.act(() => local.answerAll(1));
    const todayAsks = () =>
      local.getDailyRecap.mock.calls.filter(([request]) => request.date === TODAY).length;

    await hook.act(() => window.dispatchEvent(new Event("focus")));
    expect(todayAsks()).toBe(1);
    await hook.act(() => vi.advanceTimersByTime(60_000));
    await hook.act(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(todayAsks).toBe(2);
    await hook.act(() => local.answerAll(2));

    // The poll counts from that ask.
    await hook.act(() => vi.advanceTimersByTime(5 * 60_000 - 1));
    expect(todayAsks()).toBe(2);
    await hook.act(() => vi.advanceTimersByTime(1));
    await expect.poll(todayAsks).toBe(3);
    // The day before is not asked again on its own.
    expect(local.getDailyRecap).toHaveBeenCalledTimes(4);
  });

  it("asks for the new day after midnight", async () => {
    const local = node("local");
    registry.connections = [local.value];
    let nowMs = NOW_MS;
    const hook = await renderHook(() => useDailyRecap({ nowMs }));
    await expect.poll(() => local.open).toBe(1);
    await hook.act(() => local.answerAll(4));
    await expect.poll(() => local.open).toBe(1);
    await hook.act(() => local.answerAll(4));

    nowMs += 86_400_000;
    await hook.rerender();
    const tomorrow = calendarDateInZone(nowMs, currentTimeZone());
    await expect.poll(() => local.dates()).toEqual([tomorrow]);
    // Nothing of the day before is shown as the new day.
    expect(hook.result.current.today).toBeNull();
  });

  it("joins the route's prefetch and never asks a node it would not ask", async () => {
    // The prefetch asks for the day of the real clock: pin it to the day the view shows.
    vi.useFakeTimers({ toFake: ["Date"], now: NOW_MS });
    const local = node("local");
    const mini = node("mini", "saved");
    registry.connections = [local.value, mini.value];
    setSavedRuntime(mini.environmentId, { connectionState: "error" });
    prefetchDailyRecap();
    expect(local.dates()).toEqual([TODAY]);
    expect(mini.getDailyRecap).not.toHaveBeenCalled();
    const hook = await renderHook(() => useDailyRecap({ nowMs: NOW_MS }));
    await hook.act(() => local.answerAll(2));
    await expect.poll(() => hook.result.current.today?.counts.completedTurns).toBe(2);
    expect(
      local.getDailyRecap.mock.calls.filter(([request]) => request.date === TODAY),
    ).toHaveLength(1);
    expect(mini.getDailyRecap).not.toHaveBeenCalled();
  });
});
