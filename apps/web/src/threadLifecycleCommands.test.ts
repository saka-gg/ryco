import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  connected: true,
  dispatch: vi.fn(async (..._args: unknown[]) => undefined),
}));
vi.mock("./environmentApi", () => ({
  readEnvironmentApi: () => (state.connected ? {} : undefined),
}));
vi.mock("./localApi", () => ({ readLocalApi: () => undefined }));
vi.mock("./sidebarUndo", () => ({ sidebarUndo: { dispatch: state.dispatch } }));
vi.mock("./lib/utils", () => ({ newCommandId: () => "command" }));
vi.mock("./components/ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (options: unknown) => options,
}));

import { toastManager } from "./components/ui/toast";
import {
  dispatchThreadSettlement,
  dispatchThreadSnooze,
  requestThreadArchive,
} from "./threadLifecycleCommands";

const target = { environmentId: EnvironmentId.make("node"), threadId: ThreadId.make("thread") };
const thread = { title: "Fix the build", latestUserMessageAt: "2026-10-01T00:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  state.connected = true;
});

describe("thread settlement", () => {
  it("settles and moves back to Active through sidebar undo", async () => {
    await expect(dispatchThreadSettlement(target, true)).resolves.toBe(true);
    expect(state.dispatch).toHaveBeenLastCalledWith(target, {
      type: "thread.settle",
      commandId: "command",
      threadId: target.threadId,
    });
    await expect(dispatchThreadSettlement(target, false)).resolves.toBe(true);
    expect(state.dispatch).toHaveBeenLastCalledWith(target, {
      type: "thread.unsettle",
      commandId: "command",
      threadId: target.threadId,
      reason: "user",
    });
  });

  it("shows why it did not apply", async () => {
    state.dispatch.mockRejectedValueOnce(new Error("Thread changed."));
    await expect(dispatchThreadSettlement(target, true)).resolves.toBe(false);
    expect(toastManager.add).toHaveBeenCalledWith({
      type: "error",
      title: "Could not settle thread",
      description: "Thread changed.",
    });

    state.connected = false;
    await expect(dispatchThreadSettlement(target, false)).resolves.toBe(false);
    expect(state.dispatch).toHaveBeenCalledTimes(1);
    expect(toastManager.add).toHaveBeenLastCalledWith({
      type: "error",
      title: "Could not update thread",
      description: "The owning machine is not connected.",
    });
  });
});

describe("thread snooze", () => {
  it("snoozes until a time and wakes with null", async () => {
    await dispatchThreadSnooze(target, "2026-10-02T09:00:00.000Z");
    expect(state.dispatch).toHaveBeenLastCalledWith(target, {
      type: "thread.snooze",
      commandId: "command",
      threadId: target.threadId,
      snoozedUntil: "2026-10-02T09:00:00.000Z",
    });
    await dispatchThreadSnooze(target, null);
    expect(state.dispatch).toHaveBeenLastCalledWith(target, {
      type: "thread.unsnooze",
      commandId: "command",
      threadId: target.threadId,
    });
  });

  it("shows why it did not apply", async () => {
    state.dispatch.mockRejectedValueOnce(new Error("Snooze requires a future wake time."));
    await dispatchThreadSnooze(target, "2026-10-02T09:00:00.000Z");
    state.connected = false;
    await dispatchThreadSnooze(target, null);
    expect(state.dispatch).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toastManager.add).mock.calls.map(([toast]) => toast)).toEqual([
      {
        type: "error",
        title: "Could not update snooze",
        description: "Snooze requires a future wake time.",
      },
      {
        type: "error",
        title: "Could not update snooze",
        description: "The owning machine is not connected.",
      },
    ]);
  });
});

describe("thread archive", () => {
  const request = (
    overrides: Partial<Parameters<typeof requestThreadArchive>[0]> = {},
    confirmed = true,
  ) => {
    const archiveThread = vi.fn(async () => undefined);
    const confirm = vi.fn(async () => confirmed);
    const done = requestThreadArchive(
      { target, thread, isDraft: false, confirmThreadArchive: true, archiveThread, ...overrides },
      confirm,
    );
    return { archiveThread: overrides.archiveThread ?? archiveThread, confirm, done };
  };

  it("asks first when the setting says so, and archives only once confirmed", async () => {
    const cancelled = request({}, false);
    await cancelled.done;
    expect(cancelled.confirm).toHaveBeenCalledWith(expect.stringContaining('"Fix the build"'));
    expect(cancelled.archiveThread).not.toHaveBeenCalled();

    const accepted = request();
    await accepted.done;
    expect(accepted.archiveThread).toHaveBeenCalledWith(target);

    const unasked = request({ confirmThreadArchive: false });
    await unasked.done;
    expect(unasked.confirm).not.toHaveBeenCalled();
    expect(unasked.archiveThread).toHaveBeenCalledWith(target);
  });

  it("explains instead of asking when the thread has no conversation", async () => {
    const fresh = request({ thread: { ...thread, latestUserMessageAt: null } });
    await fresh.done;
    expect(fresh.confirm).not.toHaveBeenCalled();
    expect(fresh.archiveThread).not.toHaveBeenCalled();
    expect(toastManager.add).toHaveBeenCalledWith({
      type: "warning",
      title: "Send a message before archiving",
    });
    const draft = request({ isDraft: true });
    await draft.done;
    expect(draft.confirm).not.toHaveBeenCalled();
  });

  it("shows a failed archive", async () => {
    const failing = request({
      confirmThreadArchive: false,
      archiveThread: vi.fn(async () => {
        throw new Error("Cannot archive a running thread.");
      }),
    });
    await failing.done;
    expect(toastManager.add).toHaveBeenCalledWith({
      type: "error",
      title: "Failed to archive thread",
      description: "Cannot archive a running thread.",
    });
  });
});
