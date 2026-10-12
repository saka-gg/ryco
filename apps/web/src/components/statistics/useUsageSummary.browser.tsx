import { usageSummaryCache } from "@ryco/client-runtime/usage";
import {
  EnvironmentId,
  USAGE_CONTRACT_VERSION,
  type UsageSummary,
  type UsageSummaryRequest,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { renderHook } from "vitest-browser-react";

/*
 * A stand-in for the environment connection registry. `beforeSubscribe` runs
 * when the view subscribes, before its listener is attached, so a
 * registration there emits to nobody: the direct-load race where the primary
 * connection registers between the view's render and its subscription.
 */
const registry = vi.hoisted(() => ({
  connections: [] as unknown[],
  listeners: new Set<() => void>(),
  beforeSubscribe: null as (() => void) | null,
  primaryEnvironmentId: null as string | null,
}));

vi.mock("~/environments/runtime", () => ({
  listEnvironmentConnections: () => [...registry.connections],
  subscribeEnvironmentConnections: (listener: () => void) => {
    const pending = registry.beforeSubscribe;
    registry.beforeSubscribe = null;
    pending?.();
    registry.listeners.add(listener);
    return () => registry.listeners.delete(listener);
  },
}));

vi.mock("~/environments/primary", () => ({
  usePrimaryEnvironmentId: () => registry.primaryEnvironmentId,
}));

import { prefetchUsageSummary, useUsageSummary } from "./useUsageSummary";

function summary(request: UsageSummaryRequest, sourceId: string): UsageSummary {
  return {
    contractVersion: USAGE_CONTRACT_VERSION,
    ...(request.startDate === undefined ? {} : { startDate: request.startDate }),
    endDate: request.endDate,
    timeZone: request.timeZone,
    generatedAt: "2026-08-10T12:00:00.000Z",
    scanDurationMs: 1,
    buckets: [],
    sources: [
      {
        sourceId,
        provider: "claude",
        deduplicationKind: "physical",
        status: "complete",
        transcriptFileCount: 1,
        reusedCacheFileCount: 1,
        parsedFileCount: 0,
        skippedLineCount: 0,
        malformedLineCount: 0,
        distinctSessionCount: 0,
        distinctResponseCount: 0,
        scanStartedAt: "2026-08-10T12:00:00.000Z",
        scanFinishedAt: "2026-08-10T12:00:00.000Z",
        scanDurationMs: 1,
      },
    ],
    pricing: { state: "cached", recognizedModelCount: 0, unrecognizedModelCount: 0 },
  };
}

/** A connection whose summary requests settle only when the test releases them. */
function connection(id: string, label: string) {
  const releases: Array<() => void> = [];
  const signals: Array<AbortSignal | undefined> = [];
  const getUsageSummary = vi.fn(
    (request: UsageSummaryRequest, options?: { readonly signal?: AbortSignal }) =>
      new Promise<UsageSummary>((resolve) => {
        signals.push(options?.signal);
        releases.push(() => resolve(summary(request, `${id}-source`)));
      }),
  );
  return {
    value: {
      environmentId: EnvironmentId.make(id),
      knownEnvironment: { label },
      client: { server: { getUsageSummary } },
    },
    getUsageSummary,
    signals,
    releaseAll: () => {
      for (const release of releases.splice(0)) release();
    },
  };
}

afterEach(() => {
  registry.connections = [];
  registry.listeners.clear();
  registry.beforeSubscribe = null;
  registry.primaryEnvironmentId = null;
  usageSummaryCache.clear();
});

describe("useUsageSummary", () => {
  it("sees a connection that registered before the view subscribed", async () => {
    const local = connection("local", "This Mac");
    registry.primaryEnvironmentId = "local";
    registry.beforeSubscribe = () => {
      registry.connections.push(local.value);
      for (const listener of registry.listeners) listener();
    };
    const hook = await renderHook(() => useUsageSummary({ range: "30d" }));
    await expect.poll(() => local.getUsageSummary.mock.calls.length).toBe(1);
    expect(hook.result.current.connecting).toBe(false);
    expect(hook.result.current.pendingEnvironmentIds).toEqual(["local"]);
    await hook.act(() => local.releaseAll());
    await expect.poll(() => hook.result.current.merged?.sources.length).toBe(1);
    expect(hook.result.current.loading).toBe(false);
  });

  it("reports connecting while this app's own node has not registered yet", async () => {
    registry.primaryEnvironmentId = "local";
    const hook = await renderHook(() => useUsageSummary({ range: "30d" }));
    expect(hook.result.current.connecting).toBe(true);
    expect(hook.result.current.merged).toBeNull();
  });

  it("merges each environment as it answers and repaints the last result on remount", async () => {
    const fast = connection("fast", "Fast node");
    const slow = connection("slow", "Slow node");
    registry.connections = [fast.value, slow.value];
    const first = await renderHook(() => useUsageSummary({ range: "7d" }));
    await first.act(() => fast.releaseAll());
    // The slow node does not hide the fast one's result.
    await expect.poll(() => first.result.current.merged?.sources.length).toBe(1);
    expect(first.result.current.pendingEnvironmentIds).toEqual(["slow"]);
    expect(first.result.current.refreshing).toBe(true);
    await first.act(() => slow.releaseAll());
    await expect.poll(() => first.result.current.merged?.sources.length).toBe(2);
    await first.unmount();

    // A reopened view paints both cached results at once and revalidates them.
    const second = await renderHook(() => useUsageSummary({ range: "7d" }));
    expect(second.result.current.merged?.sources.length).toBe(2);
    expect(second.result.current.refreshing).toBe(true);
    expect(fast.getUsageSummary).toHaveBeenCalledTimes(2);
    expect(slow.getUsageSummary).toHaveBeenCalledTimes(2);
    await second.act(() => {
      fast.releaseAll();
      slow.releaseAll();
    });
    await expect.poll(() => second.result.current.loading).toBe(false);
  });

  it("joins the route's prefetch instead of asking again", async () => {
    const local = connection("local", "This Mac");
    const other = connection("other", "Other node");
    registry.connections = [local.value, other.value];
    // The route asked for one selected environment only.
    prefetchUsageSummary("30d", ["local"]);
    expect(local.getUsageSummary).toHaveBeenCalledTimes(1);
    expect(other.getUsageSummary).not.toHaveBeenCalled();
    const hook = await renderHook(() =>
      useUsageSummary({ range: "30d", environmentIds: ["local"] }),
    );
    expect(local.getUsageSummary).toHaveBeenCalledTimes(1);
    await hook.act(() => local.releaseAll());
    await expect.poll(() => hook.result.current.merged?.sources.length).toBe(1);
    expect(local.getUsageSummary).toHaveBeenCalledTimes(1);
  });

  it("skips prefetched answers only in the run a refresh triggers", async () => {
    const local = connection("local", "This Mac");
    registry.connections = [local.value];
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    let range: "7d" | "30d" = "7d";
    const hook = await renderHook(() => useUsageSummary({ range }));
    await expect.poll(() => local.getUsageSummary.mock.calls.length).toBe(1);
    await hook.act(() => local.releaseAll());
    await expect.poll(() => hook.result.current.loading).toBe(false);
    await hook.act(() => hook.result.current.refresh());
    await expect.poll(() => local.getUsageSummary.mock.calls.length).toBe(2);
    await hook.act(() => local.releaseAll());
    await expect.poll(() => hook.result.current.loading).toBe(false);
    // The route's prefetch for the next range answers before the view gets to it.
    prefetchUsageSummary("30d");
    expect(local.getUsageSummary).toHaveBeenCalledTimes(3);
    local.releaseAll();
    await expect
      .poll(() => usageSummaryCache.peek(local.value.environmentId, "30d", timeZone))
      .toBeDefined();
    range = "30d";
    await hook.rerender();
    await expect.poll(() => hook.result.current.loading).toBe(false);
    expect(local.getUsageSummary).toHaveBeenCalledTimes(3);
  });

  it("withdraws a superseded range request but lets an unmounted view finish", async () => {
    const local = connection("local", "This Mac");
    registry.connections = [local.value];
    let range: "7d" | "30d" = "7d";
    const hook = await renderHook(() => useUsageSummary({ range }));
    await expect.poll(() => local.getUsageSummary.mock.calls.length).toBe(1);
    range = "30d";
    await hook.rerender();
    await expect.poll(() => local.getUsageSummary.mock.calls.length).toBe(2);
    // The 7d scan nobody waits for any more is withdrawn; the 30d one is not.
    expect(local.signals[0]?.aborted).toBe(true);
    expect(local.signals[1]?.aborted).toBe(false);
    await hook.unmount();
    expect(local.signals[1]?.aborted).toBe(false);
    local.releaseAll();
    // Its answer still fills the cache for the next visit.
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    await expect
      .poll(() => usageSummaryCache.peek(local.value.environmentId, "30d", timeZone))
      .toBeDefined();
  });
});
