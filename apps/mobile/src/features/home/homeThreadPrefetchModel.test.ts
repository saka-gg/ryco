import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createHomeThreadPrefetch, type HomeThreadPrefetchDeps } from "./homeThreadPrefetchModel";

const ref = (threadId: string, environmentId = "env-a"): ScopedThreadRef => ({
  environmentId: environmentId as EnvironmentId,
  threadId: threadId as ThreadId,
});

function harness(overrides: Partial<HomeThreadPrefetchDeps> = {}) {
  vi.useFakeTimers();
  const held = new Map<string, number>();
  const released: Array<{ key: string; immediately: boolean }> = [];
  const retain = vi.fn((target: ScopedThreadRef) => {
    const key = `${target.environmentId}:${target.threadId}`;
    held.set(key, (held.get(key) ?? 0) + 1);
    return (options?: { readonly immediately?: boolean }) => {
      held.set(key, (held.get(key) ?? 1) - 1);
      released.push({ key, immediately: options?.immediately === true });
    };
  });
  const prefetch = createHomeThreadPrefetch({
    retain,
    isDetailLoaded: () => false,
    canRetain: () => true,
    keyOf: (target) => `${target.environmentId}:${target.threadId}`,
    idleMs: 100,
    blurReleaseMs: 200,
    topRows: 2,
    ...overrides,
  });
  const live = () => [...held].filter(([, count]) => count > 0).map(([key]) => key);
  return { prefetch, retain, live, released };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("home thread prefetch", () => {
  it("warms the top rows once Home has been still, and lets go of rows that left the top", () => {
    const { prefetch, live, released } = harness();
    prefetch.show([ref("t1"), ref("t2"), ref("t3")]);
    expect(live()).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(live()).toEqual(["env-a:t1", "env-a:t2"]);

    prefetch.show([ref("t3"), ref("t1")]);
    vi.advanceTimersByTime(100);
    expect(live().toSorted()).toEqual(["env-a:t1", "env-a:t3"]);
    expect(released).toEqual([{ key: "env-a:t2", immediately: true }]);
  });

  it("restarts the stillness wait while the rows keep changing", () => {
    const { prefetch, retain } = harness();
    prefetch.show([ref("t1")]);
    vi.advanceTimersByTime(80);
    prefetch.show([ref("t2")]);
    vi.advanceTimersByTime(80);
    expect(retain).not.toHaveBeenCalled();
    vi.advanceTimersByTime(20);
    expect(retain).toHaveBeenCalledTimes(1);
    expect(retain.mock.calls[0]![0]).toEqual(ref("t2"));
  });

  it("skips loaded threads and machines that are not live, and warms them once they are", () => {
    let liveMachine = false;
    const { prefetch, live } = harness({
      isDetailLoaded: (target) => target.threadId === "loaded",
      canRetain: () => liveMachine,
    });
    prefetch.show([ref("loaded"), ref("t1")]);
    vi.advanceTimersByTime(100);
    expect(live()).toEqual([]);
    liveMachine = true;
    prefetch.show([ref("loaded"), ref("t1")]);
    vi.advanceTimersByTime(100);
    expect(live()).toEqual(["env-a:t1"]);
  });

  it("keeps the warm set briefly after a blur, and drops it unless Home comes back", () => {
    const { prefetch, live } = harness();
    prefetch.show([ref("t1")]);
    vi.advanceTimersByTime(100);
    prefetch.blur();
    vi.advanceTimersByTime(150);
    expect(live()).toEqual(["env-a:t1"]);
    prefetch.show([ref("t1")]);
    vi.advanceTimersByTime(500);
    expect(live()).toEqual(["env-a:t1"]);
    prefetch.blur();
    vi.advanceTimersByTime(200);
    expect(live()).toEqual([]);
  });

  it("drops everything at once when the app goes to the background", () => {
    const { prefetch, live } = harness();
    prefetch.show([ref("t1")]);
    vi.advanceTimersByTime(100);
    prefetch.pressIn(ref("t9"));
    expect(live().toSorted()).toEqual(["env-a:t1", "env-a:t9"]);
    prefetch.background();
    expect(live()).toEqual([]);
  });

  it("retains a pressed row at once, through the shared navigation intent", () => {
    const { prefetch, live, released } = harness();
    prefetch.pressIn(ref("t5"));
    expect(live()).toEqual(["env-a:t5"]);
    vi.advanceTimersByTime(10_000);
    expect(live()).toEqual([]);
    expect(released).toEqual([{ key: "env-a:t5", immediately: true }]);
  });

  it("never retains while the machine is not live", () => {
    const { prefetch, retain } = harness({ canRetain: () => false });
    prefetch.pressIn(ref("t5"));
    prefetch.show([ref("t1")]);
    vi.advanceTimersByTime(1_000);
    expect(retain).not.toHaveBeenCalled();
  });
});
