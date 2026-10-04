import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi, beforeEach } from "vite-plus/test";

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock("expo-network", () => ({
  addNetworkStateListener: () => ({ remove: () => {} }),
  getNetworkStateAsync: async () => ({ isConnected: true }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
}));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));
vi.mock("expo-linking", () => ({ getInitialURL: async () => null }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { extra: {} } } }));
vi.mock("expo-crypto", () => ({ randomUUID: () => "id" }));

import {
  drainThreadOutbox,
  enqueueThreadOutboxMessage,
  listThreadOutboxMessages,
  resetThreadOutboxForTests,
} from "./threadOutbox";
import type { QueuedThreadMessage } from "./threadOutboxModel";
import { subscribeOutboxSettleDrain } from "./use-thread-outbox-drain";
import { useStore } from "./threadsRuntime";

function queued(): QueuedThreadMessage {
  return {
    environmentId: "env-a" as EnvironmentId,
    threadId: "t1" as ThreadId,
    messageId: "m1" as MessageId,
    commandId: "c1" as never,
    text: "queued while busy",
    attachments: [],
    createdAt: "2026-07-24T10:00:00.000Z",
  };
}

beforeEach(() => resetThreadOutboxForTests());

describe("outbox settle-edge drain (MAJOR 4)", () => {
  it("drains + delivers a queued message when the threads store changes (settle)", async () => {
    vi.useFakeTimers();
    enqueueThreadOutboxMessage(queued());

    const sendQueuedMessage = vi.fn(async () => undefined);
    const runDrain = () =>
      void drainThreadOutbox({
        readThreadDrainState: (ref) => ({
          // The thread has now settled.
          view: {
            ref,
            started: true,
            archived: false,
            detailLoaded: true,
            running: false,
            hasPendingApproval: false,
            hasPendingUserInput: false,
            session: null,
            latestTurn: null,
            latestTurnPlaceholderCheckpoint: false,
            projectedMessageIds: new Set(),
            turnStartFailures: [],
            steerFailedMessageIds: new Set(),
          },
          environment: { shellLive: true, mutationReady: true },
        }),
        sendQueuedMessage,
      });

    const unsubscribe = subscribeOutboxSettleDrain(runDrain, 10);

    // A thread settling notifies the store; the drain must fire (debounced).
    useStore.setState((state) => ({ ...state }));
    expect(sendQueuedMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);

    expect(sendQueuedMessage).toHaveBeenCalledTimes(1);
    expect(listThreadOutboxMessages()).toHaveLength(0);

    // After unsubscribe, further store changes do not drain.
    unsubscribe();
    enqueueThreadOutboxMessage(queued());
    useStore.setState((state) => ({ ...state }));
    await vi.advanceTimersByTimeAsync(20);
    expect(sendQueuedMessage).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
