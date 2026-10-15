import { statisticsSnapshotCache } from "@ryco/client-runtime/usage";
import type { StatisticsSnapshot } from "@ryco/contracts";
import { useSyncExternalStore } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook } from "vitest-browser-react";

const api = vi.hoisted(() => {
  const releases: Array<() => void> = [];
  const failures: Array<(error: Error) => void> = [];
  const getStatistics = vi.fn(
    () =>
      new Promise<StatisticsSnapshot>((resolve, reject) => {
        const call = releases.length + 1;
        releases.push(() => resolve({ generatedAt: `snapshot-${call}` } as StatisticsSnapshot));
        failures.push(reject);
      }),
  );
  return { getStatistics, releases, failures };
});

const primary = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let environmentId = "environment-a";
  return {
    read: () => environmentId,
    switchTo: (next: string) => {
      environmentId = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ server: { getStatistics: api.getStatistics } }),
}));

vi.mock("~/environments/primary", () => ({
  readPrimaryEnvironmentDescriptor: () => ({ environmentId: primary.read() }),
  usePrimaryEnvironmentId: () => useSyncExternalStore(primary.subscribe, primary.read),
}));

import { prefetchStatistics, useStatistics } from "./useStatistics";

describe("useStatistics", () => {
  it("joins the route's prefetch, refreshes on demand, and revalidates on remount", async () => {
    prefetchStatistics();
    prefetchStatistics();
    expect(api.getStatistics).toHaveBeenCalledTimes(1);
    const first = await renderHook(() => useStatistics());
    expect(api.getStatistics).toHaveBeenCalledTimes(1);
    await first.act(() => api.releases[0]?.());
    await expect.poll(() => first.result.current.snapshot?.generatedAt).toBe("snapshot-1");
    expect(first.result.current.loading).toBe(false);

    await first.act(() => first.result.current.refresh());
    expect(api.getStatistics).toHaveBeenCalledTimes(2);
    expect(first.result.current.refreshing).toBe(true);
    await first.act(() => api.releases[1]?.());
    await expect.poll(() => first.result.current.snapshot?.generatedAt).toBe("snapshot-2");
    await first.unmount();

    // A reopened view paints the last snapshot at once and asks again.
    const second = await renderHook(() => useStatistics());
    expect(second.result.current.snapshot?.generatedAt).toBe("snapshot-2");
    expect(api.getStatistics).toHaveBeenCalledTimes(3);
    await second.act(() => api.releases[2]?.());
    await expect.poll(() => second.result.current.loading).toBe(false);
  });

  it("hands a prefetch that settled before the view mounted to that view", async () => {
    // Request count via `releases`: the suite may reset mock call history between tests.
    const index = api.releases.length;
    prefetchStatistics();
    expect(api.releases).toHaveLength(index + 1);
    api.releases[index]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const hook = await renderHook(() => useStatistics());
    await expect
      .poll(() => hook.result.current.snapshot?.generatedAt)
      .toBe(`snapshot-${index + 1}`);
    await expect.poll(() => hook.result.current.loading).toBe(false);
    expect(api.releases).toHaveLength(index + 1);
    await hook.unmount();
  });

  it("never paints another environment's snapshot and reports a failed refresh", async () => {
    statisticsSnapshotCache.clear();
    primary.switchTo("environment-a");
    const index = api.releases.length;
    const hook = await renderHook(() => useStatistics());
    await hook.act(() => api.releases[index]?.());
    await expect
      .poll(() => hook.result.current.snapshot?.generatedAt)
      .toBe(`snapshot-${index + 1}`);

    // The primary node changes: A's data is gone at once, B is loading.
    await hook.act(() => primary.switchTo("environment-b"));
    expect(hook.result.current.snapshot).toBeNull();
    expect(hook.result.current.loading).toBe(true);
    await hook.act(() => api.failures[index + 1]?.(new Error("node B unavailable")));
    await expect.poll(() => hook.result.current.error).toBe("node B unavailable");
    expect(hook.result.current.snapshot).toBeNull();
    expect(statisticsSnapshotCache.peek("environment-b" as never)).toBeUndefined();

    // Back on A: its own last snapshot repaints, and a failed refresh is
    // reported next to it instead of being hidden by the stale data.
    await hook.act(() => primary.switchTo("environment-a"));
    expect(hook.result.current.snapshot?.generatedAt).toBe(`snapshot-${index + 1}`);
    await hook.act(() => api.failures[index + 2]?.(new Error("refresh failed")));
    await expect.poll(() => hook.result.current.error).toBe("refresh failed");
    expect(hook.result.current.snapshot?.generatedAt).toBe(`snapshot-${index + 1}`);
    expect(hook.result.current.loading).toBe(false);
    await hook.unmount();
  });
});
