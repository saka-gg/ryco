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
});
