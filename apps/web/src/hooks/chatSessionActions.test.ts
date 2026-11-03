import { ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  interruptThreadTurn,
  respondToThreadApproval,
  respondToThreadUserInput,
} from "./chatSessionActions";

describe("chatSessionActions", () => {
  it("dispatches thread.turn.interrupt", async () => {
    const dispatchCommand = vi.fn(async () => undefined);
    const api = {
      orchestration: { dispatchCommand },
    } as const;

    await interruptThreadTurn(api as never, ThreadId.make("thr_1"));

    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.turn.interrupt",
        threadId: "thr_1",
      }),
    );
  });

  it("dispatches thread.approval.respond", async () => {
    const dispatchCommand = vi.fn(async () => undefined);
    const api = {
      orchestration: { dispatchCommand },
    } as const;

    await respondToThreadApproval({
      api: api as never,
      threadId: ThreadId.make("thr_1"),
      requestId: "req_1" as never,
      decision: "accept",
    });

    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.approval.respond",
        requestId: "req_1",
        decision: "accept",
      }),
    );
  });

  it("dispatches thread.user-input.respond", async () => {
    const dispatchCommand = vi.fn(async () => undefined);
    const api = {
      orchestration: { dispatchCommand },
    } as const;

    await respondToThreadUserInput({
      api: api as never,
      threadId: ThreadId.make("thr_1"),
      requestId: "req_input_1" as never,
      answers: { q1: "yes" },
    });

    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.user-input.respond",
        answers: { q1: "yes" },
      }),
    );
  });
});
