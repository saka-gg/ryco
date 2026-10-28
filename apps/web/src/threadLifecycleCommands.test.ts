import type { SidebarUndoDescribe } from "@ryco/client-runtime/state/threads";
import { EnvironmentId, ThreadId } from "@ryco/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  connected: true,
  dispatch: vi.fn(async (..._args: unknown[]) => undefined),
  // Bulk actions: what each thread's node is sent, and which nodes are not
  // ready or cannot undo.
  send: vi.fn(async (_command: { readonly threadId: string }) => undefined),
  generation: {},
  notReady: new Set<string>(),
  withoutUndo: new Set<string>(),
  track: vi.fn((_input: { readonly describe?: unknown }) => ({ drop: vi.fn(), applied: vi.fn() })),
}));
vi.mock("./environmentApi", () => ({
  readEnvironmentApi: () => (state.connected ? {} : undefined),
}));
vi.mock("./localApi", () => ({ readLocalApi: () => undefined }));
vi.mock("./sidebarUndo", () => ({
  sidebarUndo: {
    dispatch: state.dispatch,
    supersede: vi.fn(),
    stamp: () => 0,
    track: state.track,
  },
  readSidebarUndoContext: (target: { readonly threadId: string }) =>
    state.notReady.has(target.threadId)
      ? null
      : {
          generation: state.generation,
          api: { orchestration: { dispatchCommand: state.send } },
          supported: !state.withoutUndo.has(target.threadId),
        },
}));
vi.mock("./lib/utils", () => ({ newCommandId: () => "command" }));
vi.mock("./components/ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (options: unknown) => options,
}));

import { toastManager } from "./components/ui/toast";
import {
  dispatchThreadSettlement,
  dispatchThreadSettlementBatch,
  dispatchThreadSnooze,
  dispatchThreadSnoozeBatch,
  requestThreadArchive,
} from "./threadLifecycleCommands";

const target = { environmentId: EnvironmentId.make("node"), threadId: ThreadId.make("thread") };
const thread = { title: "Fix the build", latestUserMessageAt: "2026-10-01T00:00:00.000Z" };

beforeEach(() => {
  vi.clearAllMocks();
  state.connected = true;
  state.notReady.clear();
  state.withoutUndo.clear();
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

describe("bulk lifecycle actions", () => {
  const ref = (threadId: string) => ({
    environmentId: EnvironmentId.make("node"),
    threadId: ThreadId.make(threadId),
  });
  const sent = () => state.send.mock.calls.map(([command]) => command);
  const noticeCopy = () => state.track.mock.calls[0]![0].describe as SidebarUndoDescribe;

  it("settles threads with one Undo, and moves them back to Active without one", async () => {
    const targets = [ref("a"), ref("b")];
    await expect(dispatchThreadSettlementBatch(targets, true)).resolves.toEqual({
      applied: targets,
      skipped: [],
      superseded: [],
      failed: [],
      withoutUndo: 0,
    });
    expect(sent()).toEqual([
      { type: "thread.settle", commandId: "command", threadId: "a" },
      { type: "thread.settle", commandId: "command", threadId: "b" },
    ]);
    expect(state.track).toHaveBeenCalledWith(
      expect.objectContaining({ action: "settle", members: targets }),
    );
    expect(noticeCopy()({ count: 2, applying: true })).toEqual({
      title: "Settling 2 threads…",
      undoLabel: "Undo settle for 2 threads",
    });
    expect(noticeCopy()({ count: 1, applying: false })).toEqual({
      title: "1 thread settled",
      undoLabel: "Undo settle for 1 thread",
    });

    vi.clearAllMocks();
    await dispatchThreadSettlementBatch(targets, false);
    expect(sent()).toEqual([
      { type: "thread.unsettle", commandId: "command", threadId: "a", reason: "user" },
      { type: "thread.unsettle", commandId: "command", threadId: "b", reason: "user" },
    ]);
    expect(state.track).not.toHaveBeenCalled();
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("snoozes threads until a time with one Undo, and wakes them without one", async () => {
    const targets = [ref("a"), ref("b"), ref("c")];
    await dispatchThreadSnoozeBatch(targets, "2026-10-02T09:00:00.000Z");
    expect(sent()).toEqual(
      ["a", "b", "c"].map((threadId) => ({
        type: "thread.snooze",
        commandId: "command",
        threadId,
        snoozedUntil: "2026-10-02T09:00:00.000Z",
      })),
    );
    expect(noticeCopy()({ count: 3, applying: false })).toEqual({
      title: "3 threads snoozed",
      undoLabel: "Undo snooze for 3 threads",
    });

    vi.clearAllMocks();
    await dispatchThreadSnoozeBatch(targets, null);
    expect(sent()).toEqual(
      ["a", "b", "c"].map((threadId) => ({
        type: "thread.unsnooze",
        commandId: "command",
        threadId,
      })),
    );
    expect(state.track).not.toHaveBeenCalled();
  });

  it("shows one toast for the failed threads and one for the skipped ones", async () => {
    state.send
      .mockRejectedValueOnce(new Error("Thread a changed."))
      .mockRejectedValueOnce(new Error("Thread b changed."));
    state.notReady.add("c");
    state.notReady.add("d");
    await dispatchThreadSettlementBatch([ref("a"), ref("b"), ref("c"), ref("d"), ref("e")], true);
    expect(sent().map((command) => command.threadId)).toEqual(["a", "b", "e"]);
    expect(vi.mocked(toastManager.add).mock.calls.map(([toast]) => toast)).toEqual([
      { type: "error", title: "Could not settle 2 threads", description: "Thread a changed." },
      {
        type: "warning",
        title: "Skipped 2 threads",
        description: "Their machine is not ready. Try again when it reconnects.",
      },
    ]);
  });

  it("says which threads its Undo leaves out", async () => {
    state.withoutUndo.add("b");
    await dispatchThreadSnoozeBatch([ref("a"), ref("b")], "2026-10-02T09:00:00.000Z");
    expect(state.track).toHaveBeenCalledWith(expect.objectContaining({ members: [ref("a")] }));
    expect(toastManager.add).toHaveBeenCalledWith({
      type: "info",
      title: "1 thread cannot be undone",
      description: "Update its machine to use Undo.",
    });

    // Without a notice there is nothing to explain, as for one thread.
    vi.clearAllMocks();
    state.withoutUndo.add("a");
    await dispatchThreadSnoozeBatch([ref("a"), ref("b")], "2026-10-02T09:00:00.000Z");
    expect(state.track).not.toHaveBeenCalled();
    expect(toastManager.add).not.toHaveBeenCalled();
  });

  it("reports a batch over the limit instead of rejecting", async () => {
    const targets = Array.from({ length: 101 }, (_, index) => ref(`thread-${index}`));
    await expect(dispatchThreadSettlementBatch(targets, true)).resolves.toBeNull();
    expect(state.send).not.toHaveBeenCalled();
    expect(toastManager.add).toHaveBeenCalledWith({
      type: "error",
      title: "Could not settle 101 threads",
      description: "A bulk action changes at most 100 threads.",
    });
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
