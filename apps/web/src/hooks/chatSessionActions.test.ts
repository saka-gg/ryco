import { ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  interruptThreadTurn,
  respondToThreadApproval,
  respondToThreadUserInput,
  revertThreadCheckpointWithGuards,
  revertThreadToTurnCount,
} from "./chatSessionActions";
import { revertCheckpointGuardFailureMessage } from "./useChatSessionActions";

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

  it("dispatches checkpoint revert after confirmation", async () => {
    const dispatchCommand = vi.fn(async () => undefined);
    const api = {
      orchestration: { dispatchCommand },
    } as const;
    const confirm = vi.fn(async () => true);

    const result = await revertThreadCheckpointWithGuards({
      api: api as never,
      localApi: { dialogs: { confirm } },
      thread: { id: ThreadId.make("thr_1") },
      turnCount: 2,
      environmentUnavailable: false,
      environmentUnavailableLabel: null,
      turnInProgress: false,
      providerRefusal: null,
      confirmMessage: "Revert?",
    });

    expect(result).toEqual({ ok: true });
    expect(confirm).toHaveBeenCalledWith("Revert?");
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.checkpoint.revert",
        turnCount: 2,
      }),
    );
  });

  it("skips checkpoint revert when the user cancels", async () => {
    const dispatchCommand = vi.fn(async () => undefined);
    const api = {
      orchestration: { dispatchCommand },
    } as const;

    const result = await revertThreadCheckpointWithGuards({
      api: api as never,
      localApi: { dialogs: { confirm: async () => false } },
      thread: { id: ThreadId.make("thr_1") },
      turnCount: 2,
      environmentUnavailable: false,
      environmentUnavailableLabel: null,
      turnInProgress: false,
      providerRefusal: null,
      confirmMessage: "Revert?",
    });

    expect(result).toEqual({ ok: false, reason: { type: "user-cancelled" } });
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it("rejects checkpoint revert while a turn is in progress", async () => {
    const result = await revertThreadCheckpointWithGuards({
      api: {} as never,
      localApi: { dialogs: { confirm: async () => true } },
      thread: { id: ThreadId.make("thr_1") },
      turnCount: 2,
      environmentUnavailable: false,
      environmentUnavailableLabel: null,
      turnInProgress: true,
      providerRefusal: null,
      confirmMessage: "Revert?",
    });

    expect(result).toEqual({ ok: false, reason: { type: "turn-in-progress" } });
  });

  it("refuses providers that cannot forget turns before asking for confirmation", async () => {
    const dispatchCommand = vi.fn(async () => undefined);
    const confirm = vi.fn(async () => true);
    const result = await revertThreadCheckpointWithGuards({
      api: { orchestration: { dispatchCommand } } as never,
      localApi: { dialogs: { confirm } },
      thread: { id: ThreadId.make("thr_1") },
      turnCount: 2,
      environmentUnavailable: false,
      environmentUnavailableLabel: null,
      turnInProgress: false,
      providerRefusal: "Cursor can't remove turns from its conversation.",
      confirmMessage: "Revert?",
    });

    expect(result).toEqual({
      ok: false,
      reason: {
        type: "provider-unsupported",
        message: "Cursor can't remove turns from its conversation.",
      },
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(dispatchCommand).not.toHaveBeenCalled();
  });
});

describe("revertThreadToTurnCount", () => {
  it("dispatches thread.checkpoint.revert", async () => {
    const dispatchCommand = vi.fn(async () => undefined);
    await revertThreadToTurnCount({
      api: { orchestration: { dispatchCommand } } as never,
      threadId: ThreadId.make("thr_1"),
      turnCount: 3,
    });
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "thread.checkpoint.revert",
        turnCount: 3,
      }),
    );
  });
});

describe("revertCheckpointGuardFailureMessage", () => {
  it("maps guard failures to user-facing errors", () => {
    expect(revertCheckpointGuardFailureMessage({ type: "user-cancelled" })).toBeNull();
    expect(revertCheckpointGuardFailureMessage({ type: "turn-in-progress" })).toBe(
      "Interrupt the current turn before reverting checkpoints.",
    );
    expect(
      revertCheckpointGuardFailureMessage({
        type: "environment-unavailable",
        label: "Office Mac",
      }),
    ).toBe("Reconnect Office Mac before reverting checkpoints.");
    expect(
      revertCheckpointGuardFailureMessage({
        type: "provider-unsupported",
        message: "Cursor can't remove turns from its conversation.",
      }),
    ).toBe("Cursor can't remove turns from its conversation.");
  });
});
