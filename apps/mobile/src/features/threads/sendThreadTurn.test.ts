import type { EnvironmentId, ModelSelection, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

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
});
