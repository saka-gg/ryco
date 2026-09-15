import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi, beforeEach } from "vite-plus/test";

vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} },
}));

import {
  drainThreadOutbox,
  enqueueThreadOutboxMessage,
  listThreadOutboxMessages,
  resetThreadOutboxForTests,
} from "./threadOutbox";
import type { QueuedThreadMessage } from "./threadOutboxModel";

const ENV = "env-a" as EnvironmentId;
const THREAD = "t1" as ThreadId;

function queued(id: string, createdAt: string): QueuedThreadMessage {
  return {
    environmentId: ENV,
    threadId: THREAD,
    messageId: id as MessageId,
    commandId: `cmd-${id}` as never,
    text: `msg ${id}`,
    attachments: [],
    createdAt,
  };
}

const liveConnected = () => ({
  threadExists: true,
  shellStatus: "live" as const,
  environmentConnected: true,
  threadBusy: false,
});

beforeEach(() => resetThreadOutboxForTests());

describe("threadOutbox store + drain", () => {
  it("enqueues (deduped) and lists persisted messages", () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    enqueueThreadOutboxMessage(queued("m2", "2026-07-24T11:00:00.000Z"));
    // re-enqueue m1 replaces rather than duplicates
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:30:00.000Z"));
    expect(
      listThreadOutboxMessages()
        .map((m) => m.messageId)
        .toSorted(),
    ).toEqual(["m1", "m2"]);
  });

  it("sends deliverable messages and removes them on success", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    enqueueThreadOutboxMessage(queued("m2", "2026-07-24T11:00:00.000Z"));
    const sendQueuedMessage = vi.fn(async () => undefined);

    await drainThreadOutbox({ readThreadDeliveryState: liveConnected, sendQueuedMessage });

    expect(sendQueuedMessage).toHaveBeenCalledTimes(2);
    expect(listThreadOutboxMessages()).toHaveLength(0);
  });

  it("removes an already projected message without sending it again", async () => {
    enqueueThreadOutboxMessage(queued("m-steered", "2026-08-17T10:00:00.000Z"));
    const sendQueuedMessage = vi.fn(async () => undefined);

    await drainThreadOutbox({
      readThreadDeliveryState: () => ({ ...liveConnected(), alreadyDelivered: true }),
      sendQueuedMessage,
    });

    expect(sendQueuedMessage).not.toHaveBeenCalled();
    expect(listThreadOutboxMessages()).toHaveLength(0);
  });

  it("waits for detailed message reconciliation before delivery", async () => {
    enqueueThreadOutboxMessage(queued("m-unknown", "2026-08-17T10:00:00.000Z"));
    const sendQueuedMessage = vi.fn(async () => undefined);

    await drainThreadOutbox({
      readThreadDeliveryState: () => ({ ...liveConnected(), deliveryReconciled: false }),
      sendQueuedMessage,
    });

    expect(sendQueuedMessage).not.toHaveBeenCalled();
    expect(listThreadOutboxMessages()).toHaveLength(1);
  });

  it("retains a message on a transient send failure (retry)", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    const sendQueuedMessage = vi.fn(async () => {
      throw { _tag: "ConnectionTransientError" };
    });

    await drainThreadOutbox({ readThreadDeliveryState: liveConnected, sendQueuedMessage });

    expect(listThreadOutboxMessages().map((m) => m.messageId)).toEqual(["m1"]);
  });

  it("discards a message on a permanent send failure", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    const sendQueuedMessage = vi.fn(async () => {
      throw new Error("bad request");
    });

    await drainThreadOutbox({ readThreadDeliveryState: liveConnected, sendQueuedMessage });

    expect(listThreadOutboxMessages()).toHaveLength(0);
  });

  it("removes a queued message whose thread has vanished from a live shell", async () => {
    enqueueThreadOutboxMessage(queued("m1", "2026-07-24T10:00:00.000Z"));
    const sendQueuedMessage = vi.fn(async () => undefined);

    await drainThreadOutbox({
      readThreadDeliveryState: () => ({
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadBusy: false,
      }),
      sendQueuedMessage,
    });

    expect(sendQueuedMessage).not.toHaveBeenCalled();
    expect(listThreadOutboxMessages()).toHaveLength(0);
  });
});

it("keeps legacy memory requests without dispatching a changed prompt or later queued messages", async () => {
  const legacy = {
    ...queued("legacy", "2026-09-15T10:00:00.000Z"),
    projectMemory: { projectId: "old", references: [] },
  };
  enqueueThreadOutboxMessage(legacy);
  enqueueThreadOutboxMessage(queued("later", "2026-09-15T11:00:00.000Z"));
  const sendQueuedMessage = vi.fn(async () => undefined);
  await drainThreadOutbox({ readThreadDeliveryState: liveConnected, sendQueuedMessage });
  expect(sendQueuedMessage).not.toHaveBeenCalled();
  expect(listThreadOutboxMessages()).toEqual([
    legacy,
    expect.objectContaining({ messageId: "later" }),
  ]);
});
