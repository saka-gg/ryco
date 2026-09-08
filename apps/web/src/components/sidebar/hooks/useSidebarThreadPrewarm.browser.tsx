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

import { useSidebarThreadPrewarm } from "./useSidebarThreadPrewarm";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");

function refs(...ids: string[]): ReadonlyArray<ScopedThreadRef> {
  return ids.map((id) => scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(id)));
}

function PrewarmProbe(props: {
  readonly enabled: boolean;
  readonly threadRefs: ReadonlyArray<ScopedThreadRef>;
}) {
  useSidebarThreadPrewarm(props.enabled, props.threadRefs);
  return null;
}

describe("useSidebarThreadPrewarm", () => {
  const idleCallbacks = new Map<number, () => void>();
  let nextIdleHandle = 1;

  beforeEach(() => {
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
    secondIdleCallback();
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
    [...idleCallbacks.values()][0]!();

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
    [...idleCallbacks.values()][0]!();
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
});
