import type { ApprovalRequestId, EnvironmentApi, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-crypto", () => ({ randomUUID: () => `id-${Math.random().toString(16).slice(2)}` }));

import {
  compactThreadNow,
  interruptThreadTurn,
  renameThread,
  respondToThreadApproval,
  respondToThreadUserInput,
  setThreadArchived,
  setThreadSettled,
  stopThreadSubagent,
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

  it("compacts on the thread's own model and modes, guarded to the turn it read", async () => {
    const { api, dispatchCommand } = fakeApi();
    const getThreadWindow = vi.fn(async () => ({
      thread: {
        modelSelection: { instanceId: "claude_work", model: "opus" },
        runtimeMode: "approval-required",
        interactionMode: "plan",
        tokenMode: "aggressive",
        latestTurn: { turnId: "turn-7" },
        session: {
          providerName: "claudeAgent",
          status: "ready",
          runtimeSessionId: "runtime-1",
          activeTurnId: null,
        },
      },
    }));
    Object.assign(api.orchestration, { getThreadWindow });
    const assertMutationReady = vi.fn();

    await compactThreadNow(api, THREAD_ID, assertMutationReady);

    // Before the read and again before the send.
    expect(assertMutationReady).toHaveBeenCalledTimes(2);
    expect(getThreadWindow).toHaveBeenCalledWith(expect.objectContaining({ threadId: THREAD_ID }));
    const command = dispatchCommand.mock.calls[0]![0] as {
      type: string;
      commandId: string;
      message: { messageId: string; text: string; attachments: unknown[] };
    };
    expect(command).toMatchObject({
      type: "thread.turn.start",
      threadId: THREAD_ID,
      modelSelection: { instanceId: "claude_work", model: "opus" },
      runtimeMode: "approval-required",
      interactionMode: "plan",
      tokenMode: "aggressive",
      claudeResumeGuard: {
        requireReady: true,
        runtimeSessionId: "runtime-1",
        latestTurnId: "turn-7",
      },
      message: { role: "user", text: "/compact", attachments: [] },
    });
    expect(command.commandId).toMatch(/^compact-now:/);
    expect(command.message.messageId).toBe(command.commandId);
  });

  it("refuses to compact once the connection changed, without reading or sending", async () => {
    const { api, dispatchCommand } = fakeApi();
    const getThreadWindow = vi.fn();
    Object.assign(api.orchestration, { getThreadWindow });

    await expect(
      compactThreadNow(api, THREAD_ID, () => {
        throw new Error("The connection changed. Reconnect and try again.");
      }),
    ).rejects.toThrow("The connection changed.");
    expect(getThreadWindow).not.toHaveBeenCalled();
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it("holds the node's follow-up queue with a person's Stop only when asked", async () => {
    const { api, dispatchCommand } = fakeApi();
    await interruptThreadTurn(api, THREAD_ID, { holdQueue: true });
    await interruptThreadTurn(api, THREAD_ID, { holdQueue: false });
    await interruptThreadTurn(api, THREAD_ID);
    const commands = dispatchCommand.mock.calls.map(
      ([command]) => command as { readonly holdQueue?: true },
    );
    expect(commands[0]?.holdQueue).toBe(true);
    expect("holdQueue" in commands[1]!).toBe(false);
    expect("holdQueue" in commands[2]!).toBe(false);
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

  it("stops one subagent's task activation, never the turn", async () => {
    const stopBackgroundTask = vi.fn(async (_input: unknown) => ({}));
    const { api, dispatchCommand } = fakeApi();
    const withStop = {
      orchestration: { ...api.orchestration, stopBackgroundTask },
    } as unknown as EnvironmentApi;
    await stopThreadSubagent(withStop, THREAD_ID, {
      taskId: "agent-1",
      runtimeSessionId: "rt-1",
      attempt: 0,
    });
    expect(stopBackgroundTask).toHaveBeenCalledWith({
      threadId: THREAD_ID,
      taskId: "agent-1",
      expected: { runtimeSessionId: "rt-1", attempt: 0 },
    });
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it("refuses to stop an agent on a node that can't", async () => {
    const { api } = fakeApi();
    await expect(
      stopThreadSubagent(api, THREAD_ID, {
        taskId: "agent-1",
        runtimeSessionId: "rt-1",
        attempt: 0,
      }),
    ).rejects.toThrow("This node can't stop single agents.");
  });
});
