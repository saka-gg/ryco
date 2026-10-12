import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const supervisor = vi.hoisted(() => {
  const refCounts = new Map<string, number>();
  const retain = vi.fn((environmentId: string, threadId: string) => {
    const key = `${environmentId}:${threadId}`;
    refCounts.set(key, (refCounts.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      refCounts.set(key, (refCounts.get(key) ?? 0) - 1);
    };
  });
  return { refCounts, retain };
});

vi.mock("../environments/runtime/service", () => ({
  retainThreadDetailSubscription: supervisor.retain,
}));

import {
  prewarmThreadDetailSubscription,
  releaseThreadDetailPrewarm,
  releaseThreadDetailPrewarmsExcept,
  resetThreadDetailPrewarmsForTests,
  THREAD_DETAIL_NAVIGATION_RETAIN_MS,
} from "./threadDetailPrewarm";

const environmentId = "env-1" as EnvironmentId;
const threadA = "thread-a" as ThreadId;
const threadB = "thread-b" as ThreadId;
const refCount = (threadId: ThreadId) => supervisor.refCounts.get(`${environmentId}:${threadId}`);

beforeEach(() => {
  vi.useFakeTimers();
  supervisor.refCounts.clear();
  supervisor.retain.mockClear();
});

afterEach(() => {
  resetThreadDetailPrewarmsForTests();
  vi.useRealTimers();
});

describe("prewarmThreadDetailSubscription", () => {
  it("retains synchronously, before any chunk or effect runs", () => {
    prewarmThreadDetailSubscription(environmentId, threadA);

    expect(supervisor.retain).toHaveBeenCalledWith(environmentId, threadA);
    expect(refCount(threadA)).toBe(1);
  });

  it("holds one retain per thread and refreshes its deadline on repeated calls", () => {
    prewarmThreadDetailSubscription(environmentId, threadA);
    vi.advanceTimersByTime(THREAD_DETAIL_NAVIGATION_RETAIN_MS - 1_000);
    // The welcome prewarm followed by the route loader, or a loader re-run.
    prewarmThreadDetailSubscription(environmentId, threadA);

    expect(supervisor.retain).toHaveBeenCalledOnce();
    expect(refCount(threadA)).toBe(1);
    vi.advanceTimersByTime(THREAD_DETAIL_NAVIGATION_RETAIN_MS - 1);
    expect(refCount(threadA)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(refCount(threadA)).toBe(0);
  });

  it("hands the subscription over once the view holds its own retain", () => {
    prewarmThreadDetailSubscription(environmentId, threadA);
    const releaseView = supervisor.retain(environmentId, threadA);

    releaseThreadDetailPrewarm(environmentId, threadA);
    expect(refCount(threadA)).toBe(1);
    // The deadline no longer applies to a released retain.
    vi.advanceTimersByTime(THREAD_DETAIL_NAVIGATION_RETAIN_MS);
    expect(refCount(threadA)).toBe(1);
    releaseView();
    expect(refCount(threadA)).toBe(0);

    // A later navigation to the same thread takes a fresh retain.
    prewarmThreadDetailSubscription(environmentId, threadA);
    expect(refCount(threadA)).toBe(1);
  });

  it("drops superseded navigation retains when the route settles on another thread or leaves", () => {
    prewarmThreadDetailSubscription(environmentId, threadA);
    prewarmThreadDetailSubscription(environmentId, threadB);

    releaseThreadDetailPrewarmsExcept({ environmentId, threadId: threadB });
    expect(refCount(threadA)).toBe(0);
    expect(refCount(threadB)).toBe(1);

    releaseThreadDetailPrewarmsExcept(null);
    expect(refCount(threadB)).toBe(0);
  });

  it("treats a failing retain as advisory", () => {
    supervisor.retain.mockImplementationOnce(() => {
      throw new Error("no supervisor");
    });

    expect(() => prewarmThreadDetailSubscription(environmentId, threadA)).not.toThrow();
    // Nothing was recorded, so the next navigation retries.
    prewarmThreadDetailSubscription(environmentId, threadA);
    expect(refCount(threadA)).toBe(1);
  });
});

describe("thread route subscription lifecycle", () => {
  it("retains in the navigation loader, skips intent preloads, and releases on leave", async () => {
    const { Route } = await import("../routes/_chat.$environmentId.$threadId");
    const options = Route.options as unknown as {
      loader: (input: { params: Record<string, string>; preload: boolean }) => void;
      onEnter: (match: { params: Record<string, string> }) => void;
      onStay: (match: { params: Record<string, string> }) => void;
      onLeave: (match: { params: Record<string, string> }) => void;
    };
    const params = (threadId: ThreadId) => ({ environmentId, threadId });

    options.loader({ params: params(threadA), preload: true });
    expect(supervisor.retain).not.toHaveBeenCalled();

    options.loader({ params: params(threadA), preload: false });
    options.onEnter({ params: params(threadA) });
    expect(refCount(threadA)).toBe(1);

    // A thread switch before the first view mounted: the superseded retain goes.
    options.loader({ params: params(threadB), preload: false });
    options.onStay({ params: params(threadB) });
    expect(refCount(threadA)).toBe(0);
    expect(refCount(threadB)).toBe(1);

    options.onLeave({ params: params(threadB) });
    expect(refCount(threadB)).toBe(0);
  });
});
