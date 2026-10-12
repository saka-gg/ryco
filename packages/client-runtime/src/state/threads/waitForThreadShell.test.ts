import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { AppState } from "./store.ts";
import type { ThreadShell } from "./types.ts";
import { waitForThreadShell, type ThreadShellSource } from "./waitForThreadShell.ts";

const environmentId = EnvironmentId.make("environment-local");
const threadId = ThreadId.make("fork-thread");

function stateWith(shell: Partial<ThreadShell> | null): AppState {
  return {
    activeEnvironmentId: environmentId,
    environmentStateById: {
      [environmentId]: {
        threadShellById: shell ? { [threadId]: { id: threadId, ...shell } } : {},
      },
    },
  } as unknown as AppState;
}

function fakeStore(initial: AppState) {
  let state = initial;
  const listeners = new Set<(state: AppState) => void>();
  const store: ThreadShellSource & { set: (next: AppState) => void; listeners: number } = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set: (next) => {
      state = next;
      for (const listener of listeners) listener(next);
    },
    get listeners() {
      return listeners.size;
    },
  };
  return store;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForThreadShell", () => {
  it("resolves immediately when the shell is already there", async () => {
    const store = fakeStore(stateWith({ worktreeId: null }));
    await expect(
      waitForThreadShell({ environmentId, threadId, timeoutMs: 10, store }),
    ).resolves.toBe(true);
    expect(store.listeners).toBe(0);
  });

  it("resolves once the shell arrives and unsubscribes", async () => {
    const store = fakeStore(stateWith(null));
    const waiting = waitForThreadShell({ environmentId, threadId, timeoutMs: 1_000, store });
    expect(store.listeners).toBe(1);
    store.set(stateWith({ worktreeId: null }));
    await expect(waiting).resolves.toBe(true);
    expect(store.listeners).toBe(0);
  });

  it("waits for the requested worktree attachment", async () => {
    const store = fakeStore(stateWith(null));
    const waiting = waitForThreadShell({
      environmentId,
      threadId,
      worktreeId: "worktree-fork",
      timeoutMs: 1_000,
      store,
    });
    store.set(stateWith({ worktreeId: null }));
    expect(store.listeners).toBe(1);
    store.set(stateWith({ worktreeId: "worktree-fork" }));
    await expect(waiting).resolves.toBe(true);
  });

  it("resolves false on timeout or abort without leaking the subscription", async () => {
    vi.useFakeTimers();
    const store = fakeStore(stateWith(null));
    const timedOut = waitForThreadShell({ environmentId, threadId, timeoutMs: 500, store });
    await vi.advanceTimersByTimeAsync(500);
    await expect(timedOut).resolves.toBe(false);
    expect(store.listeners).toBe(0);

    const controller = new AbortController();
    const aborted = waitForThreadShell({
      environmentId,
      threadId,
      timeoutMs: 5_000,
      signal: controller.signal,
      store,
    });
    controller.abort();
    await expect(aborted).resolves.toBe(false);
    expect(store.listeners).toBe(0);
    // A late shell after settling changes nothing.
    store.set(stateWith({ worktreeId: null }));
  });
});
