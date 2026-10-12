import type { StatisticsSnapshot } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { renderHook } from "vitest-browser-react";

const api = vi.hoisted(() => {
  const releases: Array<() => void> = [];
  const getStatistics = vi.fn(
    () =>
      new Promise<StatisticsSnapshot>((resolve) => {
        const call = releases.length + 1;
        releases.push(() => resolve({ generatedAt: `snapshot-${call}` } as StatisticsSnapshot));
      }),
  );
  return { getStatistics, releases };
});

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ server: { getStatistics: api.getStatistics } }),
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
});
