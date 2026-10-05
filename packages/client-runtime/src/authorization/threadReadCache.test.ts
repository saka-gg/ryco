import { EnvironmentId, ThreadId } from "@ryco/contracts";
import type { ThreadReadCacheThreadResponse } from "@ryco/contracts/thread-read-cache";
import { describe, expect, it, vi } from "vite-plus/test";

import { hostedHubStore, type HostedHubState } from "./state.ts";
import type { HostedHubNode } from "./types.ts";
import { startHostedThreadReadCache } from "./threadReadCache.ts";

const settle = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};

describe("shared hosted thread read cache", () => {
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
      account: { id: "account-a" },
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
