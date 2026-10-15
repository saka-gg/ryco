import { describe, expect, it, vi } from "vite-plus/test";

import {
  startStaggeredThreadPrefetch,
  THREAD_PREFETCH_STAGGER_MS,
} from "../../lib/staggeredThreadPrefetch";
import type { SessionTabItem } from "../../sessionTabs.selectors";
import {
  MAX_SPECULATIVE_SIBLING_TAB_PREFETCH,
  selectSpeculativeSiblingTabPrefetchKeys,
} from "./useChatSessionTabsPrefetch";

function tab(key: string): SessionTabItem {
  return {
    key,
    title: key,
    bucket: "idle",
  };
}

describe("selectSpeculativeSiblingTabPrefetchKeys", () => {
  it("caps speculative prefetch to nearby siblings around the active tab", () => {
    const tabs = Array.from({ length: 20 }, (_, index) => tab(`tab-${index}`));

    expect(selectSpeculativeSiblingTabPrefetchKeys(tabs, "tab-10")).toEqual([
      "tab-9",
      "tab-11",
      "tab-8",
      "tab-12",
      "tab-7",
      "tab-13",
    ]);
  });

  it("does not prefetch the active tab or more than the default cap", () => {
    const tabs = Array.from({ length: 30 }, (_, index) => tab(`tab-${index}`));
    const keys = selectSpeculativeSiblingTabPrefetchKeys(tabs, "tab-0");

    expect(keys).toHaveLength(MAX_SPECULATIVE_SIBLING_TAB_PREFETCH);
    expect(keys).not.toContain("tab-0");
    expect(keys).toEqual(["tab-1", "tab-2", "tab-3", "tab-4", "tab-5", "tab-6"]);
  });

  it("uses the first capped tabs when the active key is not in the sibling list", () => {
    const tabs = Array.from({ length: 10 }, (_, index) => tab(`tab-${index}`));

    expect(selectSpeculativeSiblingTabPrefetchKeys(tabs, "missing", 3)).toEqual([
      "tab-0",
      "tab-1",
      "tab-2",
    ]);
  });

  it("supports disabling speculative prefetch with a zero limit", () => {
    const tabs = [tab("tab-0"), tab("tab-1")];

    expect(selectSpeculativeSiblingTabPrefetchKeys(tabs, "tab-0", 0)).toEqual([]);
  });
});

describe("startStaggeredThreadPrefetch", () => {
  function manualTimers() {
    const idle: Array<() => void> = [];
    const timeouts = new Map<number, { callback: () => void; delayMs: number }>();
    let nextHandle = 1;
    return {
      idle,
      timeouts,
      timers: {
        scheduleIdle: (callback: () => void) => {
          idle.push(callback);
          return () => {
            const index = idle.indexOf(callback);
            if (index >= 0) idle.splice(index, 1);
          };
        },
        setTimeout: (callback: () => void, delayMs: number) => {
          const handle = nextHandle++;
          timeouts.set(handle, { callback, delayMs });
          return handle;
        },
        clearTimeout: (handle: unknown) => {
          timeouts.delete(handle as number);
        },
      },
      runTimeout() {
        const [handle, entry] = [...timeouts.entries()][0]!;
        timeouts.delete(handle);
        entry.callback();
        return entry.delayMs;
      },
    };
  }

  it("retains nothing until idle, then one key per stagger step", () => {
    const clock = manualTimers();
    const releases = new Map<string, ReturnType<typeof vi.fn>>();
    const retain = vi.fn((key: string) => {
      const release = vi.fn();
      releases.set(key, release);
      return release;
    });

    const stop = startStaggeredThreadPrefetch(["a", "b", "c"], retain, clock.timers);
    expect(retain).not.toHaveBeenCalled();

    clock.idle.shift()!();
    expect(retain.mock.calls.map(([key]) => key)).toEqual(["a"]);
    expect(clock.runTimeout()).toBe(THREAD_PREFETCH_STAGGER_MS);
    expect(retain.mock.calls.map(([key]) => key)).toEqual(["a", "b"]);

    stop();
    expect(clock.timeouts.size).toBe(0);
    expect(releases.get("a")).toHaveBeenCalledTimes(1);
    expect(releases.get("b")).toHaveBeenCalledTimes(1);
    expect(retain).toHaveBeenCalledTimes(2);
  });

  it("cancels the idle slot when stopped before it runs", () => {
    const clock = manualTimers();
    const retain = vi.fn(() => null);
    const stop = startStaggeredThreadPrefetch(["a"], retain, clock.timers);
    stop();
    expect(clock.idle).toHaveLength(0);
    expect(retain).not.toHaveBeenCalled();
  });
});
