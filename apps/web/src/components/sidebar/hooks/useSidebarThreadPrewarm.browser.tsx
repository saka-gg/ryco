import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@ryco/contracts";
import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

const prewarmHarness = vi.hoisted(() => ({
  retain: vi.fn(),
}));

vi.mock("../../../environments/runtime/service", () => ({
  retainThreadDetailSubscription: prewarmHarness.retain,
}));

import { THREAD_PREFETCH_STAGGER_MS } from "../../../lib/staggeredThreadPrefetch";
import {
  SIDEBAR_PREWARM_FOREGROUND_WAIT_MS,
  useSidebarThreadPrewarm,
} from "./useSidebarThreadPrewarm";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function refs(...ids: string[]): ReadonlyArray<ScopedThreadRef> {
  return ids.map((id) => scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(id)));
}

function PrewarmProbe(props: {
  readonly enabled: boolean;
  readonly threadRefs: ReadonlyArray<ScopedThreadRef>;
  readonly foregroundReady?: boolean;
  readonly foregroundKey?: string | null;
}) {
  useSidebarThreadPrewarm(
    props.enabled,
    props.threadRefs,
    props.foregroundReady,
    props.foregroundKey,
  );
  return null;
}

/** Runs the idle slot, then every stagger step after it. */
function runStaggeredRetains(idleCallback: () => void, count: number) {
  idleCallback();
  vi.advanceTimersByTime(THREAD_PREFETCH_STAGGER_MS * (count - 1));
}

describe("useSidebarThreadPrewarm", () => {
  const idleCallbacks = new Map<number, () => void>();
  let nextIdleHandle = 1;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    idleCallbacks.clear();
    nextIdleHandle = 1;
    prewarmHarness.retain.mockReset();
    prewarmHarness.retain.mockImplementation(() => vi.fn());
    vi.stubGlobal(
      "requestIdleCallback",
      vi.fn((callback: () => void) => {
        const handle = nextIdleHandle++;
        idleCallbacks.set(handle, () => {
          idleCallbacks.delete(handle);
          callback();
        });
        return handle;
      }),
    );
    vi.stubGlobal(
      "cancelIdleCallback",
      vi.fn((handle: number) => {
        idleCallbacks.delete(handle);
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("runs only after idle and releases prior demand immediately on mode or list changes", async () => {
    const firstRefs = refs("thread-1", "thread-2", "thread-3");
    const mounted = await render(<PrewarmProbe enabled={false} threadRefs={firstRefs} />);

    expect(idleCallbacks.size).toBe(0);
    expect(prewarmHarness.retain).not.toHaveBeenCalled();

    await mounted.rerender(<PrewarmProbe enabled threadRefs={firstRefs} />);
    expect(idleCallbacks.size).toBe(1);
    expect(prewarmHarness.retain).not.toHaveBeenCalled();

    const firstIdleCallback = [...idleCallbacks.values()][0]!;
    firstIdleCallback();
    // One retain per stagger step, never all three at once.
    expect(prewarmHarness.retain).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(THREAD_PREFETCH_STAGGER_MS);
    expect(prewarmHarness.retain).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(THREAD_PREFETCH_STAGGER_MS);
    expect(prewarmHarness.retain).toHaveBeenCalledTimes(3);
    const firstReleases = prewarmHarness.retain.mock.results.map(
      (result) => result.value as ReturnType<typeof vi.fn>,
    );

    const secondRefs = refs("thread-4", "thread-5", "thread-6");
    await mounted.rerender(<PrewarmProbe enabled threadRefs={secondRefs} />);

    for (const release of firstReleases) {
      expect(release).toHaveBeenCalledWith({ immediately: true });
    }
    expect(prewarmHarness.retain).toHaveBeenCalledTimes(3);
    expect(idleCallbacks.size).toBe(1);

    const secondIdleCallback = [...idleCallbacks.values()][0]!;
    runStaggeredRetains(secondIdleCallback, 3);
    expect(prewarmHarness.retain).toHaveBeenCalledTimes(6);
    const secondReleases = prewarmHarness.retain.mock.results
      .slice(3)
      .map((result) => result.value as ReturnType<typeof vi.fn>);

    await mounted.rerender(<PrewarmProbe enabled={false} threadRefs={secondRefs} />);
    for (const release of secondReleases) {
      expect(release).toHaveBeenCalledWith({ immediately: true });
    }

    await mounted.unmount();
  });

  it("cancels stale list work before the idle callback runs", async () => {
    const mounted = await render(<PrewarmProbe enabled threadRefs={refs("thread-old")} />);
    const staleIdleCallback = [...idleCallbacks.values()][0]!;

    await mounted.rerender(<PrewarmProbe enabled threadRefs={refs("thread-new")} />);
    staleIdleCallback();

    expect(prewarmHarness.retain).not.toHaveBeenCalled();
    expect(idleCallbacks.size).toBe(1);

    [...idleCallbacks.values()][0]!();
    expect(prewarmHarness.retain).toHaveBeenCalledOnce();
    expect(prewarmHarness.retain).toHaveBeenCalledWith(ENVIRONMENT_ID, ThreadId.make("thread-new"));

    await mounted.unmount();
  });

  it("keeps existing demand when an equal ref list is recreated", async () => {
    const mounted = await render(
      <PrewarmProbe enabled threadRefs={refs("thread-1", "thread-2")} />,
    );
    runStaggeredRetains([...idleCallbacks.values()][0]!, 2);

    const releases = prewarmHarness.retain.mock.results.map(
      (result) => result.value as ReturnType<typeof vi.fn>,
    );
    await mounted.rerender(<PrewarmProbe enabled threadRefs={refs("thread-1", "thread-2")} />);

    expect(prewarmHarness.retain).toHaveBeenCalledTimes(2);
    expect(idleCallbacks.size).toBe(0);
    for (const release of releases) {
      expect(release).not.toHaveBeenCalled();
    }

    await mounted.unmount();
    for (const release of releases) {
      expect(release).toHaveBeenCalledWith({ immediately: true });
    }
  });
  it("preserves overlapping demand and ignores reordering", async () => {
    const mounted = await render(<PrewarmProbe enabled threadRefs={refs("a", "b", "c")} />);
    runStaggeredRetains([...idleCallbacks.values()][0]!, 3);
    const [releaseA, releaseB, releaseC] = prewarmHarness.retain.mock.results.map(
      (result) => result.value as ReturnType<typeof vi.fn>,
    );

    await mounted.rerender(<PrewarmProbe enabled threadRefs={refs("b", "a", "c")} />);
    expect(idleCallbacks.size).toBe(0);
    expect(prewarmHarness.retain).toHaveBeenCalledTimes(3);

    await mounted.rerender(<PrewarmProbe enabled threadRefs={refs("d", "a", "b")} />);
    expect(releaseC).toHaveBeenCalledWith({ immediately: true });
    expect(releaseA).not.toHaveBeenCalled();
    expect(releaseB).not.toHaveBeenCalled();
    expect(prewarmHarness.retain).toHaveBeenCalledTimes(3);
    [...idleCallbacks.values()][0]!();
    expect(prewarmHarness.retain).toHaveBeenCalledTimes(4);
    expect(prewarmHarness.retain).toHaveBeenLastCalledWith(ENVIRONMENT_ID, ThreadId.make("d"));
    await mounted.unmount();
    expect(releaseA).toHaveBeenCalledWith({ immediately: true });
    expect(releaseB).toHaveBeenCalledWith({ immediately: true });
  });

  it("starts new retains only once the foreground thread is live and keeps held ones", async () => {
    const mounted = await render(
      <PrewarmProbe enabled foregroundReady={false} threadRefs={refs("a", "b")} />,
    );
    expect(idleCallbacks.size).toBe(0);
    expect(prewarmHarness.retain).not.toHaveBeenCalled();

    await mounted.rerender(<PrewarmProbe enabled foregroundReady threadRefs={refs("a", "b")} />);
    runStaggeredRetains([...idleCallbacks.values()][0]!, 2);
    expect(prewarmHarness.retain).toHaveBeenCalledTimes(2);
    const [releaseA, releaseB] = prewarmHarness.retain.mock.results.map(
      (result) => result.value as ReturnType<typeof vi.fn>,
    );

    // Navigating to another thread: held retains stay, the new one waits.
    await mounted.rerender(
      <PrewarmProbe enabled foregroundReady={false} threadRefs={refs("a", "c")} />,
    );
    expect(releaseB).toHaveBeenCalledWith({ immediately: true });
    expect(releaseA).not.toHaveBeenCalled();
    expect(idleCallbacks.size).toBe(0);
    expect(prewarmHarness.retain).toHaveBeenCalledTimes(2);

    await mounted.rerender(<PrewarmProbe enabled foregroundReady threadRefs={refs("a", "c")} />);
    runStaggeredRetains([...idleCallbacks.values()][0]!, 1);
    expect(prewarmHarness.retain).toHaveBeenCalledTimes(3);
    expect(prewarmHarness.retain).toHaveBeenLastCalledWith(ENVIRONMENT_ID, ThreadId.make("c"));
    await mounted.unmount();
  });

  it("stops waiting for a foreground thread that never loads", async () => {
    const mounted = await render(
      <PrewarmProbe
        enabled
        foregroundReady={false}
        foregroundKey="stalled"
        threadRefs={refs("a")}
      />,
    );
    vi.advanceTimersByTime(SIDEBAR_PREWARM_FOREGROUND_WAIT_MS - 1);
    await Promise.resolve();
    expect(idleCallbacks.size).toBe(0);

    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(idleCallbacks.size).toBe(1));
    runStaggeredRetains([...idleCallbacks.values()][0]!, 1);
    expect(prewarmHarness.retain).toHaveBeenCalledTimes(1);

    // Opening another thread waits for that one again.
    await mounted.rerender(
      <PrewarmProbe
        enabled
        foregroundReady={false}
        foregroundKey="loading"
        threadRefs={refs("a", "b")}
      />,
    );
    expect(idleCallbacks.size).toBe(0);
    expect(prewarmHarness.retain).toHaveBeenCalledTimes(1);
    await mounted.unmount();
  });
});
