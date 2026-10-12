import { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { ThreadReadCacheThreadResponse } from "@ryco/contracts/thread-read-cache";
import { describe, expect, it, vi } from "vite-plus/test";

import { hostedHubStore, type HostedHubState } from "./state.ts";
import type { HostedHubAccount, HostedHubNode } from "./types.ts";
import { startHostedThreadReadCache } from "./threadReadCache.ts";

const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};

describe("shared hosted thread read cache", () => {
  it("finishes a slow detail read during repeated pushes and refreshes hidden changes on foreground", async () => {
    const environmentId = EnvironmentId.make("environment-a");
    const threadId = ThreadId.make("thread-a");
    const node = {
      id: "node-a",
      environmentId,
      effectiveRole: "owner",
      revokedAt: null,
    } as HostedHubNode;
    const state = {
      ...hostedHubStore.getInitialState(),
      accountStatus: "authenticated",
      directoryStatus: "ready",
      browserStatus: "current",
      account: { id: "account-a" } as HostedHubAccount,
      nodes: [node],
    } as HostedHubState;
    let invalidate = () => {};
    let visibilityChanged = () => {};
    let visible = true;
    let finishRead = () => {};
    let signal: AbortSignal | undefined;
    const detail: ThreadReadCacheThreadResponse = {
      protocolVersion: 1,
      generation: 1,
      revision: 1,
      storedAt: 1,
      threadId,
      snapshot: { messages: [] },
    };
    const readThread = vi.fn(async (_node: string, _thread: string, _signal: AbortSignal) => ({
      ...detail,
      revision: 2,
    }));
    readThread.mockImplementationOnce((_node, _thread, readSignal) => {
      signal = readSignal;
      return new Promise((resolve) => {
        finishRead = () => resolve(detail);
      });
    });
    const applySnapshot = vi.fn();
    const stop = startHostedThreadReadCache({
      readState: () => state,
      subscribeState: () => () => {},
      readRoute: () => ({ nodeId: node.id, environmentId, threadId }),
      subscribeRoute: () => () => {},
      subscribeInvalidation: (listener) => {
        invalidate = listener;
        return () => {};
      },
      subscribeVisibility: (listener) => {
        visibilityChanged = listener;
        return () => {};
      },
      isSubscriptionOnline: () => true,
      readShell: async () => ({
        protocolVersion: 1,
        generation: 1,
        revision: 1,
        storedAt: 1,
        snapshot: {
          snapshotSequence: 1,
          updatedAt: "2026-10-05T00:00:00.000Z",
          projects: [],
          threads: [],
        },
      }),
      readThread,
      applySnapshot,
      isVisible: () => visible,
      now: () => 1,
      setInterval: () => 1,
      clearInterval: () => {},
    });
    try {
      await settle();
      for (let i = 0; i < 20; i++) invalidate();
      expect(readThread).toHaveBeenCalledOnce();
      expect(signal?.aborted).toBe(false);
      finishRead();
      await settle();
      expect(readThread).toHaveBeenCalledTimes(2);
      expect(applySnapshot.mock.calls.at(-1)?.[2].get(threadId)?.revision).toBe(2);
      visible = false;
      invalidate();
      await settle();
      expect(readThread).toHaveBeenCalledTimes(2);
      visible = true;
      visibilityChanged();
      await settle();
      expect(readThread).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
  });

  it("refreshes immediately from Hub notifications, coalesces changes during a read, and polls only as fallback", async () => {
    const environmentId = EnvironmentId.make("environment-a");
    const node = {
      id: "node-a",
      environmentId,
      effectiveRole: "owner",
      revokedAt: null,
    } as HostedHubNode;
    const state = {
      ...hostedHubStore.getInitialState(),
      accountStatus: "authenticated",
      directoryStatus: "ready",
      browserStatus: "current",
      account: { id: "account-a" } as HostedHubAccount,
      nodes: [node],
    } as HostedHubState;
    let invalidate = () => {};
    let tick = () => {};
    let now = 1;
    let online = true;
    let revision = 1;
    const response = () => ({
      protocolVersion: 1 as const,
      generation: 1,
      revision,
      storedAt: now,
      snapshot: {
        snapshotSequence: revision,
        updatedAt: "2026-10-05T00:00:00.000Z",
        projects: [],
        threads: [],
      },
    });
    const readShell = vi.fn(async () => response());
    const readThread = vi.fn();
    const unsubscribe = vi.fn();
    const applySnapshot = vi.fn();
    const stop = startHostedThreadReadCache({
      readState: () => state,
      subscribeState: () => () => {},
      readRoute: () => ({ nodeId: node.id, environmentId, threadId: null }),
      subscribeRoute: () => () => {},
      subscribeInvalidation: (listener) => {
        invalidate = listener;
        return unsubscribe;
      },
      isSubscriptionOnline: () => online,
      readShell,
      readThread,
      applySnapshot,
      isVisible: () => true,
      now: () => now,
      setInterval: (callback) => {
        tick = callback;
        return 1;
      },
      clearInterval: () => {},
    });
    try {
      await settle();
      expect(readShell).toHaveBeenCalledTimes(1);
      now += 60_000;
      tick();
      await settle();
      expect(readShell).toHaveBeenCalledTimes(1);

      let finishRead = () => {};
      readShell.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRead = () => resolve(response());
          }),
      );
      revision = 2;
      invalidate();
      expect(readShell).toHaveBeenCalledTimes(2);
      for (let i = 0; i < 10; i++) invalidate();
      expect(readShell).toHaveBeenCalledTimes(2);
      finishRead();
      await settle();
      expect(readShell).toHaveBeenCalledTimes(3);
      expect(applySnapshot.mock.calls.at(-1)?.[1].revision).toBe(2);
      online = false;
      now += 60_000;
      tick();
      await settle();
      expect(readShell).toHaveBeenCalledTimes(4);
      stop();
      invalidate();
      await settle();
      expect(readShell).toHaveBeenCalledTimes(4);
      expect(unsubscribe).toHaveBeenCalledOnce();
    } finally {
      stop();
    }
  });

  it("projects only matching-generation details and stops publication after disposal", async () => {
    const environmentId = EnvironmentId.make("environment-a");
    const threadId = ThreadId.make("thread-a");
    const node = {
      id: "node-a",
      environmentId,
      effectiveRole: "owner",
      revokedAt: null,
    } as HostedHubNode;
    const state = {
      ...hostedHubStore.getInitialState(),
      accountStatus: "authenticated",
      directoryStatus: "ready",
      browserStatus: "current",
      account: { id: "account-a" } as HostedHubAccount,
      nodes: [node],
    } as HostedHubState;
    let tick = () => {};
    let now = 1;
    const detail: ThreadReadCacheThreadResponse = {
      protocolVersion: 1,
      generation: 1,
      revision: 1,
      storedAt: 1,
      threadId,
      snapshot: { messages: [] },
    };
    const readThread = vi.fn(async () => detail);
    const applySnapshot = vi.fn();
    const stop = startHostedThreadReadCache({
      readState: () => state,
      subscribeState: () => () => {},
      readRoute: () => ({ nodeId: node.id, environmentId, threadId }),
      subscribeRoute: () => () => {},
      readShell: async () => ({
        protocolVersion: 1,
        generation: 2,
        revision: 1,
        storedAt: 2,
        snapshot: {
          snapshotSequence: 1,
          updatedAt: "2026-10-04T00:00:00.000Z",
          projects: [],
          threads: [],
        },
      }),
      readThread,
      applySnapshot,
      isVisible: () => true,
      now: () => now,
      setInterval: (callback) => {
        tick = callback;
        return 1;
      },
      clearInterval: () => {},
    });
    try {
      await settle();
      expect(applySnapshot.mock.calls.at(-1)?.[2].size).toBe(0);
      readThread.mockResolvedValueOnce({ ...detail, generation: 2 });
      now += 15_000;
      tick();
      await settle();
      expect(applySnapshot.mock.calls.at(-1)?.[2].get(threadId)?.generation).toBe(2);
      const calls = applySnapshot.mock.calls.length;
      const reads = readThread.mock.calls.length;
      stop();
      tick();
      await settle();
      expect(applySnapshot).toHaveBeenCalledTimes(calls);
      expect(readThread).toHaveBeenCalledTimes(reads);
    } finally {
      stop();
    }
  });

  describe("conditional reads and the routed prefetch", () => {
    const environmentId = EnvironmentId.make("environment-a");
    const threadId = ThreadId.make("thread-a");
    const node = {
      id: "node-a",
      environmentId,
      effectiveRole: "owner",
      revokedAt: null,
    } as HostedHubNode;
    const authenticated = {
      ...hostedHubStore.getInitialState(),
      accountStatus: "authenticated",
      directoryStatus: "ready",
      browserStatus: "current",
      account: { id: "account-a" } as HostedHubAccount,
      nodes: [node],
    } as HostedHubState;
    const shell = (revision: number) => ({
      protocolVersion: 1 as const,
      generation: 1,
      revision,
      storedAt: 1,
      snapshot: {
        snapshotSequence: revision,
        updatedAt: "2026-10-05T00:00:00.000Z",
        projects: [],
        threads: [],
      },
    });
    const detail = (revision: number): ThreadReadCacheThreadResponse => ({
      protocolVersion: 1,
      generation: 1,
      revision,
      storedAt: 1,
      threadId,
      snapshot: { messages: [] },
    });
    function start(input: {
      readonly state: () => HostedHubState;
      readonly accessPending?: () => boolean;
      readonly readShell: ReturnType<typeof vi.fn>;
      readonly readThread: ReturnType<typeof vi.fn>;
      readonly route?: { nodeId: string; environmentId: string; threadId: string };
    }) {
      let stateChanged = () => {};
      let invalidate = () => {};
      const applySnapshot = vi.fn();
      const stop = startHostedThreadReadCache({
        readState: input.state,
        subscribeState: (listener) => {
          stateChanged = listener;
          return () => {};
        },
        readRoute: () => input.route ?? { nodeId: node.id, environmentId, threadId },
        subscribeRoute: () => () => {},
        subscribeInvalidation: (listener) => {
          invalidate = listener;
          return () => {};
        },
        isSubscriptionOnline: () => true,
        readShell: input.readShell as never,
        readThread: input.readThread as never,
        ...(input.accessPending ? { isAccessPending: input.accessPending } : {}),
        applySnapshot,
        isVisible: () => true,
        now: () => 1,
        setInterval: () => 1,
        clearInterval: () => {},
      });
      return {
        stop,
        applySnapshot,
        stateChanged: () => stateChanged(),
        invalidate: () => invalidate(),
      };
    }

    it("presents the held version and keeps it when the Hub answers unchanged", async () => {
      const readShell = vi.fn(async (..._args: unknown[]) => shell(1));
      const readThread = vi.fn(async (..._args: unknown[]) => detail(1));
      const cache = start({ state: () => authenticated, readShell, readThread });
      try {
        await settle();
        expect(readShell.mock.calls[0]?.[2]).toBeUndefined();
        expect(cache.applySnapshot).toHaveBeenCalled();
        const applied = cache.applySnapshot.mock.calls.length;
        readShell.mockResolvedValueOnce(null as never);
        readThread.mockResolvedValueOnce(null as never);
        cache.invalidate();
        await settle();
        expect(readShell.mock.calls[1]?.[2]).toEqual(shell(1));
        expect(readThread.mock.calls[1]?.[3]).toEqual(detail(1));
        expect(cache.applySnapshot).toHaveBeenCalledTimes(applied);
      } finally {
        cache.stop();
      }
    });

    it("reads the routed shell and thread beside the access check and adopts them without a second read", async () => {
      let state = {
        ...hostedHubStore.getInitialState(),
        accountStatus: "signed-out",
      } as HostedHubState;
      let pending = true;
      let finishShell = (_value: unknown) => {};
      const readShell = vi.fn(
        () =>
          new Promise((resolve) => {
            finishShell = resolve;
          }),
      );
      const readThread = vi.fn(async () => detail(1));
      const cache = start({
        state: () => state,
        accessPending: () => pending,
        readShell,
        readThread,
      });
      try {
        await settle();
        expect(readShell).toHaveBeenCalledOnce();
        expect(readThread).toHaveBeenCalledOnce();
        // Held: nothing is shown before the session and directory validate it.
        expect(cache.applySnapshot).not.toHaveBeenCalled();
        state = { ...authenticated, directoryStatus: "loading", nodes: [] };
        pending = false;
        cache.stateChanged();
        await settle();
        expect(cache.applySnapshot).not.toHaveBeenCalled();
        state = authenticated;
        cache.stateChanged();
        finishShell(shell(1));
        await settle();
        expect(readShell).toHaveBeenCalledOnce();
        expect(readThread).toHaveBeenCalledOnce();
        expect(cache.applySnapshot.mock.calls.at(-1)?.[2].get(threadId)?.revision).toBe(1);
        // A Hub invalidation still reads again.
        cache.invalidate();
        await settle();
        expect(readShell).toHaveBeenCalledTimes(2);
        expect(readThread).toHaveBeenCalledTimes(2);
      } finally {
        cache.stop();
      }
    });

    it("drops a held prefetch when the check ends without a session", async () => {
      let state = {
        ...hostedHubStore.getInitialState(),
        accountStatus: "signed-out",
      } as HostedHubState;
      let pending = true;
      const signals: AbortSignal[] = [];
      const readShell = vi.fn((_node: string, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise(() => {});
      });
      const readThread = vi.fn((_node: string, _thread: string, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise(() => {});
      });
      const cache = start({
        state: () => state,
        accessPending: () => pending,
        readShell,
        readThread,
      });
      try {
        await settle();
        expect(signals).toHaveLength(2);
        pending = false;
        state = { ...state, accountStatus: "unavailable" } as HostedHubState;
        cache.stateChanged();
        expect(signals.every((signal) => signal.aborted)).toBe(true);
      } finally {
        cache.stop();
      }
    });

    it("never applies a prefetch for a node the directory lists with another environment", async () => {
      let state = {
        ...hostedHubStore.getInitialState(),
        accountStatus: "signed-out",
      } as HostedHubState;
      let pending = true;
      const readShell = vi.fn(async () => shell(1));
      const readThread = vi.fn(async () => detail(1));
      const cache = start({
        state: () => state,
        accessPending: () => pending,
        readShell,
        readThread,
        route: { nodeId: node.id, environmentId: "environment-b", threadId },
      });
      try {
        await settle();
        expect(readShell).toHaveBeenCalledOnce();
        pending = false;
        state = authenticated;
        cache.stateChanged();
        await settle();
        expect(cache.applySnapshot.mock.calls.every(([, , details]) => details.size === 0)).toBe(
          true,
        );
        expect(readThread).toHaveBeenCalledOnce();
      } finally {
        cache.stop();
      }
    });
  });
});
