import type { ApprovalRequestId, EnvironmentApi, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-crypto", () => ({ randomUUID: () => `id-${Math.random().toString(16).slice(2)}` }));

import {
  interruptThreadTurn,
  renameThread,
  respondToThreadApproval,
  respondToThreadUserInput,
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
});
