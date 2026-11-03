import type { EnvironmentId, ModelSelection, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { QueuedThreadMessage } from "../../state/threadOutboxModel";
import {
  resolveThreadSendAction,
  sendThreadTurn,
  type SendThreadTurnContext,
} from "./sendThreadTurn";

const modelSelection = { instanceId: "i1", model: "m", options: [] } as unknown as ModelSelection;

function context(overrides: Partial<SendThreadTurnContext> = {}): SendThreadTurnContext {
  return {
    environmentId: "env-a" as EnvironmentId,
    threadId: "t1" as ThreadId,
    text: "hi",
    attachments: [],
    modelSelection,
    runtimeMode: "approval-required" as never,
    interactionMode: "code" as never,
    tokenMode: "balanced" as never,
    threadBusy: false,
    connected: true,
    ...overrides,
  };
}

function deps(dispatch = vi.fn(async () => true)) {
  const enqueue = vi.fn();
  return {
    enqueue,
    dispatch,
    seams: {
      newMessageId: () => "msg-1",
      newCommandId: () => "cmd-1",
      now: () => "2026-07-24T00:00:00.000Z",
      enqueue,
      dispatch,
    },
  };
}

describe("resolveThreadSendAction", () => {
  it("enqueues while a turn runs or the socket is disconnected; dispatches when idle+connected", () => {
    expect(resolveThreadSendAction({ threadBusy: true, connected: true })).toBe("enqueue");
    expect(resolveThreadSendAction({ threadBusy: false, connected: false })).toBe("enqueue");
    expect(resolveThreadSendAction({ threadBusy: false, connected: true })).toBe("dispatch");
  });

  it("queues a busy send on a node that keeps the queue; offline sends stay in the outbox", () => {
    expect(resolveThreadSendAction({ threadBusy: true, connected: true, serverQueue: true })).toBe(
      "queue-on-server",
    );
    expect(resolveThreadSendAction({ threadBusy: true, connected: false, serverQueue: true })).toBe(
      "enqueue",
    );
    expect(resolveThreadSendAction({ threadBusy: false, connected: true, serverQueue: true })).toBe(
      "dispatch",
    );
  });

  it("queues behind the node's queue when it is about to send, though no turn runs", () => {
    // The node's dispatch leaves the session ready while its head's turn starts.
    expect(
      resolveThreadSendAction({
        threadBusy: false,
        connected: true,
        serverQueue: true,
        serverQueueWaiting: true,
      }),
    ).toBe("queue-on-server");
    // This device's outbox still holds messages for the thread: behind them, in the outbox.
    expect(
      resolveThreadSendAction({ threadBusy: false, connected: true, serverQueueWaiting: true }),
    ).toBe("enqueue");
  });
});

describe("sendThreadTurn", () => {
  it("ENQUEUES (not dispatches) when the thread turn is running", async () => {
    const d = deps();
    const result = await sendThreadTurn(context({ threadBusy: true }), d.seams);
    expect(d.enqueue).toHaveBeenCalledTimes(1);
    expect(d.dispatch).not.toHaveBeenCalled();
    // Queued item carries the composer payload keyed by thread.
    expect(d.enqueue.mock.calls[0]![0]).toMatchObject({
      threadId: "t1",
      text: "hi",
      messageId: "msg-1",
    });
    // Enqueue is a success — the composer clears its input.
    expect(result).toBe(true);
  });

  it("enqueues when the socket is disconnected", async () => {
    const d = deps();
    await sendThreadTurn(context({ threadBusy: false, connected: false }), d.seams);
    expect(d.enqueue).toHaveBeenCalledTimes(1);
    expect(d.dispatch).not.toHaveBeenCalled();
  });

  it("DISPATCHES when idle and connected, returning the dispatch result", async () => {
    const d = deps(vi.fn(async () => false));
    const result = await sendThreadTurn(context({ threadBusy: false, connected: true }), d.seams);
    expect(d.dispatch).toHaveBeenCalledTimes(1);
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it("steers a redirect's message right after enqueueing it", async () => {
    const d = deps();
    const order: string[] = [];
    d.enqueue.mockImplementation(() => order.push("enqueue"));
    const steer = vi.fn((_message: QueuedThreadMessage) => {
      order.push("steer");
    });
    const result = await sendThreadTurn(context({ threadBusy: true }), {
      ...d.seams,
      beforeEnqueue: async (message) => {
        expect(message).toMatchObject({ text: "hi", messageId: "msg-1" });
        return "steer";
      },
      steer,
    });
    expect(result).toBe(true);
    expect(order).toEqual(["enqueue", "steer"]);
    expect(steer.mock.calls[0]![0]).toBe(d.enqueue.mock.calls[0]![0]);
  });

  it("sends nothing and keeps the draft when the redirect refuses", async () => {
    const d = deps();
    const steer = vi.fn();
    const result = await sendThreadTurn(context({ threadBusy: true }), {
      ...d.seams,
      beforeEnqueue: async () => "refuse",
      steer,
    });
    expect(result).toBe(false);
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(steer).not.toHaveBeenCalled();
  });

  it("queues without steering when the redirect leaves approvals alone", async () => {
    const d = deps();
    const steer = vi.fn();
    await sendThreadTurn(context({ threadBusy: true }), {
      ...d.seams,
      beforeEnqueue: async () => "queue",
      steer,
    });
    expect(d.enqueue).toHaveBeenCalledTimes(1);
    expect(steer).not.toHaveBeenCalled();
  });

  it("queues a busy send on the node instead of the outbox, under its own message id", async () => {
    const d = deps();
    const queueOnServer = vi.fn(async (_message: QueuedThreadMessage) => true);
    const result = await sendThreadTurn(context({ threadBusy: true, serverQueue: true }), {
      ...d.seams,
      queueOnServer,
    });
    expect(result).toBe(true);
    expect(d.enqueue).not.toHaveBeenCalled();
    expect(d.dispatch).not.toHaveBeenCalled();
    expect(queueOnServer).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "msg-1", text: "hi", modelSelection }),
      { steer: false },
    );
  });

  it("keeps the draft when the node refuses the queued send", async () => {
    const d = deps();
    const result = await sendThreadTurn(context({ threadBusy: true, serverQueue: true }), {
      ...d.seams,
      queueOnServer: async () => false,
    });
    expect(result).toBe(false);
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it("steers a redirect's message on the node after queueing it there", async () => {
    const d = deps();
    const steer = vi.fn();
    const queueOnServer = vi.fn(async () => true);
    await sendThreadTurn(context({ threadBusy: true, serverQueue: true }), {
      ...d.seams,
      beforeEnqueue: async () => "steer",
      steer,
      queueOnServer,
    });
    expect(queueOnServer).toHaveBeenCalledWith(expect.anything(), { steer: true });
    expect(steer).not.toHaveBeenCalled();
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it("still uses the outbox offline, or where the node keeps no queue", async () => {
    const offline = deps();
    const queueOnServer = vi.fn(async () => true);
    await sendThreadTurn(context({ threadBusy: true, connected: false, serverQueue: true }), {
      ...offline.seams,
      queueOnServer,
    });
    expect(offline.enqueue).toHaveBeenCalledTimes(1);

    const olderNode = deps();
    await sendThreadTurn(context({ threadBusy: true, serverQueue: false }), {
      ...olderNode.seams,
      queueOnServer,
    });
    expect(olderNode.enqueue).toHaveBeenCalledTimes(1);
    expect(queueOnServer).not.toHaveBeenCalled();
  });

  it("does not start a turn ahead of the node's queue", async () => {
    const d = deps();
    const queueOnServer = vi.fn(async () => true);
    await sendThreadTurn(
      context({ threadBusy: false, serverQueue: true, serverQueueWaiting: true }),
      { ...d.seams, queueOnServer },
    );
    expect(queueOnServer).toHaveBeenCalledTimes(1);
    expect(d.dispatch).not.toHaveBeenCalled();
  });
});
