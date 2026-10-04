import type { ApprovalRequestId, EnvironmentApi, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-crypto", () => ({ randomUUID: () => `id-${Math.random().toString(16).slice(2)}` }));

import {
  interruptThreadTurn,
  renameThread,
  respondToThreadApproval,
  respondToThreadUserInput,
  revertThreadCheckpointWithGuards,
  setThreadArchived,
  setThreadSettled,
} from "./sessionActions";

const THREAD_ID = "thread-1" as ThreadId;
const REQUEST_ID = "req-1" as ApprovalRequestId;

function fakeApi() {
  const dispatchCommand = vi.fn(async (_command: unknown) => undefined);
  return {
    api: { orchestration: { dispatchCommand } } as unknown as EnvironmentApi,
    dispatchCommand,
  };
}

describe("sessionActions", () => {
  it("dispatches thread.turn.interrupt", async () => {
    const { api, dispatchCommand } = fakeApi();
    await interruptThreadTurn(api, THREAD_ID);
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    const command = dispatchCommand.mock.calls[0]![0] as unknown as {
      type: string;
      threadId: ThreadId;
      commandId: string;
    };
    expect(command.type).toBe("thread.turn.interrupt");
    expect(command.threadId).toBe(THREAD_ID);
    expect(command.commandId).toBeTruthy();
  });

  it("renames and archives through bounded thread commands", async () => {
    const { api, dispatchCommand } = fakeApi();

    await renameThread(api, THREAD_ID, "  Mobile polish  ");
    await setThreadArchived(api, THREAD_ID, true);
    await setThreadArchived(api, THREAD_ID, false);

    expect(dispatchCommand.mock.calls.map((call) => (call[0] as { type: string }).type)).toEqual([
      "thread.meta.update",
      "thread.archive",
      "thread.unarchive",
    ]);
    expect(dispatchCommand.mock.calls[0]![0]).toMatchObject({ title: "Mobile polish" });
  });

  it("dispatches thread.approval.respond with the decision", async () => {
    const { api, dispatchCommand } = fakeApi();
    await respondToThreadApproval({
      api,
      threadId: THREAD_ID,
      requestId: REQUEST_ID,
      decision: "approve" as never,
    });
    const command = dispatchCommand.mock.calls[0]![0] as unknown as {
      type: string;
      requestId: string;
      decision: string;
    };
    expect(command.type).toBe("thread.approval.respond");
    expect(command.requestId).toBe(REQUEST_ID);
    expect(command.decision).toBe("approve");
  });

  it("dispatches the exact settle and user-unsettle commands", async () => {
    const { api, dispatchCommand } = fakeApi();

    await setThreadSettled(api, THREAD_ID, true);
    await setThreadSettled(api, THREAD_ID, false);

    expect(dispatchCommand.mock.calls[0]![0]).toMatchObject({
      type: "thread.settle",
      threadId: THREAD_ID,
    });
    expect(dispatchCommand.mock.calls[1]![0]).toMatchObject({
      type: "thread.unsettle",
      threadId: THREAD_ID,
      reason: "user",
    });
  });

  it("dispatches thread.user-input.respond with the answers", async () => {
    const { api, dispatchCommand } = fakeApi();
    await respondToThreadUserInput({
      api,
      threadId: THREAD_ID,
      requestId: REQUEST_ID,
      answers: { q1: "yes" },
    });
    const command = dispatchCommand.mock.calls[0]![0] as unknown as {
      type: string;
      answers: Record<string, unknown>;
    };
    expect(command.type).toBe("thread.user-input.respond");
    expect(command.answers).toEqual({ q1: "yes" });
  });

  it("guards checkpoint revert: cancels when confirm is declined, dispatches when confirmed", async () => {
    const { api, dispatchCommand } = fakeApi();
    const base = {
      api,
      thread: { id: THREAD_ID },
      turnCount: 3,
      environmentUnavailable: false,
      environmentUnavailableLabel: null,
      turnInProgress: false,
      providerRefusal: null,
      confirmMessage: "Revert?",
    };

    const cancelled = await revertThreadCheckpointWithGuards({
      ...base,
      confirm: async () => false,
    });
    expect(cancelled).toEqual({ ok: false, reason: { type: "user-cancelled" } });
    expect(dispatchCommand).not.toHaveBeenCalled();

    const confirmed = await revertThreadCheckpointWithGuards({
      ...base,
      confirm: async () => true,
    });
    expect(confirmed).toEqual({ ok: true });
    const command = dispatchCommand.mock.calls[0]![0] as unknown as {
      type: string;
      turnCount: number;
    };
    expect(command.type).toBe("thread.checkpoint.revert");
    expect(command.turnCount).toBe(3);
  });

  it("blocks revert while a turn is in progress", async () => {
    const { api, dispatchCommand } = fakeApi();
    const result = await revertThreadCheckpointWithGuards({
      api,
      thread: { id: THREAD_ID },
      turnCount: 3,
      environmentUnavailable: false,
      environmentUnavailableLabel: null,
      turnInProgress: true,
      providerRefusal: null,
      confirmMessage: "Revert?",
      confirm: async () => true,
    });
    expect(result).toEqual({ ok: false, reason: { type: "turn-in-progress" } });
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it("refuses providers that cannot forget turns before asking for confirmation", async () => {
    const { api, dispatchCommand } = fakeApi();
    const confirm = vi.fn(async () => true);
    const result = await revertThreadCheckpointWithGuards({
      api,
      thread: { id: THREAD_ID },
      turnCount: 3,
      environmentUnavailable: false,
      environmentUnavailableLabel: null,
      turnInProgress: false,
      providerRefusal: "Cursor can't remove turns from its conversation.",
      confirmMessage: "Revert?",
      confirm,
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
