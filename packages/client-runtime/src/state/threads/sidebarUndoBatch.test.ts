import {
  CommandId,
  EnvironmentId,
  ThreadId,
  type EnvironmentApi,
  type ScopedThreadRef,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createSidebarUndoHistory,
  type SidebarUndoContext,
  type SidebarUndoDescribe,
  type SidebarUndoNotice,
} from "./sidebarUndo.ts";
import { dispatchSidebarUndoBatch, type SidebarBatchCommand } from "./sidebarUndoBatch.ts";

const nodeA = EnvironmentId.make("node-a");
const nodeB = EnvironmentId.make("node-b");
const ref = (id: string, environmentId = nodeA): ScopedThreadRef => ({
  environmentId,
  threadId: ThreadId.make(id),
});
const settle = (target: ScopedThreadRef): SidebarBatchCommand => ({
  type: "thread.settle",
  commandId: CommandId.make(`settle-${target.threadId}`),
  threadId: target.threadId,
});
const snooze = (target: ScopedThreadRef): SidebarBatchCommand => ({
  type: "thread.snooze",
  commandId: CommandId.make(`snooze-${target.threadId}`),
  threadId: target.threadId,
  snoozedUntil: "2026-10-24T08:00:00.000Z",
});
const unsettle = (target: ScopedThreadRef): SidebarBatchCommand => ({
  type: "thread.unsettle",
  commandId: CommandId.make(`unsettle-${target.threadId}`),
  threadId: target.threadId,
  reason: "user",
});

function setup() {
  const dispatch = vi.fn(
    async (_command: {
      type: string;
      threadId: string;
      commandId?: string;
      undoCommandId?: string;
    }) => ({ sequence: 1 }),
  );
  const api = { orchestration: { dispatchCommand: dispatch } } as unknown as EnvironmentApi;
  const contexts = new Map<EnvironmentId, SidebarUndoContext | null>([
    [nodeA, { generation: {}, api, supported: true }],
    [nodeB, { generation: {}, api, supported: true }],
  ]);
  const readContext = (target: ScopedThreadRef) => {
    const context = contexts.get(target.environmentId);
    if (context === undefined) throw new Error("Unknown node");
    return context;
  };
  let notices: readonly SidebarUndoNotice[] = [];
  const failed = vi.fn();
  let undoCount = 0;
  const newCommandId = () => CommandId.make(`undo-${++undoCount}`);
  const history = createSidebarUndoHistory({
    readContext,
    newCommandId,
    changed: (next) => {
      notices = next;
    },
    failed,
  });
  return {
    history,
    dispatch,
    failed,
    contexts,
    read: () => notices,
    /** Holds every `type` command until `open()`. */
    hold: (type: string) => {
      let open!: () => void;
      const gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      dispatch.mockImplementation(async (command) => {
        if (command.type === type) await gate;
        return { sequence: 1 };
      });
      return { open };
    },
    sent: (type: string) =>
      dispatch.mock.calls.map(([command]) => command).filter((command) => command.type === type),
    run: (
      targets: readonly ScopedThreadRef[],
      command: (target: ScopedThreadRef) => SidebarBatchCommand = settle,
      describe?: SidebarUndoDescribe,
    ) =>
      dispatchSidebarUndoBatch({
        history,
        readContext,
        newCommandId,
        targets,
        command,
        ...(describe && { describe }),
      }),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("bulk sidebar actions", () => {
  it("skips threads whose node is not ready and sends nothing for them", async () => {
    const s = setup();
    s.contexts.set(nodeB, null);
    const offline = ref("offline", nodeB);
    const unknown = ref("unknown", EnvironmentId.make("node-c"));
    const result = await s.run([ref("ready"), offline, unknown]);
    expect(result).toMatchObject({ applied: [ref("ready")], skipped: [offline, unknown] });
    expect(s.dispatch).toHaveBeenCalledTimes(1);
  });

  it("sends nothing more to a node that reconnects mid-batch", async () => {
    const s = setup();
    // node-a reconnects while its first command is out.
    s.dispatch.mockImplementationOnce(async () => {
      s.contexts.set(nodeA, { ...s.contexts.get(nodeA)!, generation: {} });
      return { sequence: 1 };
    });
    const result = await s.run([ref("a"), ref("b"), ref("c"), ref("d", nodeB)]);
    expect(s.sent("thread.settle").map((command) => command.threadId)).toEqual(["a", "d"]);
    expect(result).toMatchObject({
      applied: [ref("a"), ref("d", nodeB)],
      skipped: [ref("b"), ref("c")],
      failed: [],
    });
    // Only node-b's thread is still on the connection its command went out on.
    expect(s.read()).toMatchObject([{ target: ref("d", nodeB), count: undefined }]);
    s.history.dispose();
  });

  it("sends no Undo to a node that reconnects while Undo runs", async () => {
    const s = setup();
    await s.run([ref("a"), ref("b"), ref("c", nodeB)]);
    // node-b reconnects while the first Undo is out, before its own thread's turn.
    s.dispatch.mockImplementationOnce(async () => {
      s.contexts.set(nodeB, { ...s.contexts.get(nodeB)!, generation: {} });
      return { sequence: 2 };
    });
    await s.history.undo(s.read()[0]!.id);
    expect(s.sent("thread.sidebar.undo").map((command) => command.threadId)).toEqual(["a", "b"]);
    expect(s.failed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message:
          "1 of 3 threads could not be restored. Its machine reconnected before Undo was sent.",
      }),
    );
  });

  it("sends nothing for a queued thread that a newer action took over", async () => {
    const s = setup();
    const gate = s.hold("thread.settle");
    const run = s.run(["a", "b", "c", "d", "e"].map((id) => ref(id)));
    expect(s.dispatch).toHaveBeenCalledTimes(4);
    // The row's own Snooze on a thread whose settle has not gone out yet.
    await s.history.dispatch(ref("e"), snooze(ref("e")));
    gate.open();
    const result = await run;
    expect(s.sent("thread.settle").map((command) => command.threadId)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(result).toMatchObject({
      applied: ["a", "b", "c", "d"].map((id) => ref(id)),
      skipped: [],
      superseded: [ref("e")],
    });
    expect(s.read()).toMatchObject([
      { action: "settle", count: 4 },
      { action: "snooze", target: ref("e"), count: undefined },
    ]);
    s.history.dispose();
  });

  it("steps aside without a notice too, and for a later bulk action", async () => {
    const s = setup();
    const gate = s.hold("thread.unsettle");
    const run = s.run(
      ["a", "b", "c", "d", "e", "f"].map((id) => ref(id)),
      unsettle,
    );
    expect(s.dispatch).toHaveBeenCalledTimes(4);
    await s.history.dispatch(ref("e"), settle(ref("e")));
    await s.run([ref("f")], snooze);
    gate.open();
    expect(await run).toMatchObject({
      applied: ["a", "b", "c", "d"].map((id) => ref(id)),
      superseded: [ref("e"), ref("f")],
    });
    expect(s.dispatch.mock.calls.map(([command]) => `${command.type}:${command.threadId}`)).toEqual(
      [
        "thread.unsettle:a",
        "thread.unsettle:b",
        "thread.unsettle:c",
        "thread.unsettle:d",
        "thread.settle:e",
        "thread.snooze:f",
      ],
    );
    expect(s.read()).toMatchObject([
      { action: "settle", target: ref("e") },
      { action: "snooze", target: ref("f") },
    ]);
    s.history.dispose();
  });

  it("restores no thread that a newer action took over while Undo runs", async () => {
    const s = setup();
    await s.run(["a", "b", "c", "d", "e"].map((id) => ref(id)));
    const gate = s.hold("thread.sidebar.undo");
    const undo = s.history.undo(s.read()[0]!.id);
    await vi.waitFor(() => expect(s.sent("thread.sidebar.undo")).toHaveLength(4));
    await s.history.dispatch(ref("e"), snooze(ref("e")));
    gate.open();
    await undo;
    expect(s.sent("thread.sidebar.undo").map((command) => command.threadId)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(s.failed).not.toHaveBeenCalled();
    expect(s.read()).toMatchObject([{ action: "snooze", target: ref("e") }]);
    s.history.dispose();
  });

  it("counts no more of a node's threads than its 256 Undo receipts", async () => {
    const s = setup();
    // node-a keeps its 256 newest receipts and drops the oldest first.
    const receipts = new Set<string>();
    s.dispatch.mockImplementation(async (command) => {
      if (command.type === "thread.sidebar.undo") {
        if (!receipts.delete(command.undoCommandId!)) throw new Error("Undo expired.");
        return { sequence: 2 };
      }
      receipts.add(command.commandId!);
      if (receipts.size > 256) receipts.delete(receipts.values().next().value!);
      return { sequence: 1 };
    });
    const batch = (from: number, environmentId = nodeA) =>
      s.run(Array.from({ length: 100 }, (_, index) => ref(`t-${from + index}`, environmentId)));
    await batch(0);
    await batch(100);
    await batch(200);
    expect(s.read().map((notice) => notice.count)).toEqual([56, 100, 100]);
    expect(s.read()[0]).toMatchObject({ target: ref("t-44") });
    // Another node's receipts are its own.
    const otherNode = { orchestration: { dispatchCommand: async () => ({ sequence: 1 }) } };
    s.contexts.set(nodeB, {
      generation: {},
      api: otherNode as unknown as EnvironmentApi,
      supported: true,
    });
    await batch(0, nodeB);
    expect(s.read().map((notice) => notice.count)).toEqual([56, 100, 100, 100]);
    s.dispatch.mockClear();
    await s.history.undo(s.read()[0]!.id);
    expect(s.sent("thread.sidebar.undo")).toHaveLength(56);
    expect(s.failed).not.toHaveBeenCalled();
    s.history.dispose();
  });

  it("is the keyboard Undo's newest notice and undoes every thread by its id", async () => {
    const s = setup();
    await s.run([ref("a"), ref("b"), ref("c")]);
    expect(s.history.latest()).toMatchObject({ action: "settle", count: 3, pending: false });
    await s.history.dispatch(ref("single"), settle(ref("single")));
    expect(s.history.latest()).toMatchObject({ target: ref("single"), count: undefined });
    await s.history.undo(s.history.latest()!.id);
    const group = s.history.latest();
    expect(group).toMatchObject({ action: "settle", count: 3 });
    await s.history.undo(group!.id);
    expect(s.sent("thread.sidebar.undo").map((command) => command.threadId)).toEqual([
      "single",
      "a",
      "b",
      "c",
    ]);
    expect(s.history.latest()).toBeNull();
    expect(s.failed).not.toHaveBeenCalled();
  });

  it("sends at most four commands at once", async () => {
    const s = setup();
    const pending: (() => void)[] = [];
    s.dispatch.mockImplementation(
      () =>
        new Promise((resolve) => {
          pending.push(() => resolve({ sequence: 1 }));
        }),
    );
    const run = s.run(["1", "2", "3", "4", "5", "6"].map((id) => ref(id)));
    expect(s.dispatch).toHaveBeenCalledTimes(4);
    pending.shift()!();
    await vi.waitFor(() => expect(s.dispatch).toHaveBeenCalledTimes(5));
    expect(pending).toHaveLength(4);
    while (pending.length) pending.shift()!();
    await vi.waitFor(() => expect(s.dispatch).toHaveBeenCalledTimes(6));
    pending.shift()!();
    expect((await run).applied).toHaveLength(6);
  });

  it("offers one notice that applies until every command settled", async () => {
    const s = setup();
    let finish!: () => void;
    s.dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ sequence: 1 });
        }),
    );
    const run = s.run([ref("a"), ref("b"), ref("c", nodeB)]);
    expect(s.read()).toMatchObject([
      { action: "settle", target: ref("a"), count: 3, applying: true },
    ]);
    finish();
    await run;
    expect(s.read()).toMatchObject([{ count: 3, applying: false }]);
    s.history.dispose();
  });

  it("drops a failed thread from the notice and reports it", async () => {
    const s = setup();
    const error = new Error("refused");
    s.dispatch.mockImplementation(async (command) => {
      if (command.threadId === "b") throw error;
      return { sequence: 1 };
    });
    const result = await s.run([ref("a"), ref("b"), ref("c")]);
    expect(result).toMatchObject({
      applied: [ref("a"), ref("c")],
      failed: [{ target: ref("b"), error }],
    });
    expect(s.read()).toMatchObject([{ count: 2 }]);
    s.history.dispose();
  });

  it("holds an early Undo until every command settled, then restores what applied", async () => {
    const s = setup();
    let finish!: () => void;
    s.dispatch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve({ sequence: 1 });
          }),
      )
      .mockRejectedValueOnce(new Error("refused"));
    const run = s.run([ref("a"), ref("b"), ref("c")]);
    const undo = s.history.undo(s.read()[0]!.id);
    await vi.advanceTimersByTimeAsync(100);
    expect(s.read()).toMatchObject([{ count: 2, applying: true, pending: true }]);
    expect(s.sent("thread.sidebar.undo")).toEqual([]);
    finish();
    await run;
    await undo;
    expect(s.sent("thread.sidebar.undo").map((command) => command.threadId)).toEqual(["a", "c"]);
    expect(s.read()).toEqual([]);
  });

  it("undoes each thread with its own command", async () => {
    const s = setup();
    await s.run([ref("a"), ref("b", nodeB)]);
    await s.history.undo(s.read()[0]!.id);
    expect(s.sent("thread.sidebar.undo")).toEqual([
      {
        type: "thread.sidebar.undo",
        threadId: "a",
        commandId: "undo-1",
        undoCommandId: "settle-a",
      },
      {
        type: "thread.sidebar.undo",
        threadId: "b",
        commandId: "undo-2",
        undoCommandId: "settle-b",
      },
    ]);
    expect(s.read()).toEqual([]);
    expect(s.failed).not.toHaveBeenCalled();
  });

  it("does not restore threads whose node reconnected", async () => {
    const s = setup();
    await s.run([ref("a"), ref("b"), ref("c", nodeB)]);
    s.contexts.set(nodeB, { ...s.contexts.get(nodeB)!, generation: {} });
    await vi.advanceTimersByTimeAsync(100);
    expect(s.read()).toMatchObject([{ count: 2 }]);
    await s.history.undo(s.read()[0]!.id);
    expect(s.sent("thread.sidebar.undo").map((command) => command.threadId)).toEqual(["a", "b"]);
  });

  it("reports a partly failed Undo once", async () => {
    const s = setup();
    await s.run([ref("a"), ref("b"), ref("c")]);
    s.dispatch.mockImplementation(async (command) => {
      if (command.threadId !== "a") throw new Error("Changed by another client.");
      return { sequence: 2 };
    });
    await s.history.undo(s.read()[0]!.id);
    expect(s.failed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: "2 of 3 threads could not be restored. Changed by another client.",
      }),
    );
    expect(s.read()).toEqual([]);
  });

  it("applies on older nodes without offering their Undo", async () => {
    const s = setup();
    s.contexts.set(nodeB, { ...s.contexts.get(nodeB)!, supported: false });
    expect(await s.run([ref("old", nodeB)])).toMatchObject({
      applied: [ref("old", nodeB)],
      withoutUndo: 1,
    });
    expect(s.read()).toEqual([]);
    expect(await s.run([ref("a"), ref("old", nodeB)])).toMatchObject({ withoutUndo: 1 });
    expect(s.read()).toMatchObject([{ target: ref("a"), count: undefined }]);
    s.history.dispose();
  });

  it("offers no Undo for Move to Active and takes over older notices of its threads", async () => {
    const s = setup();
    await s.history.dispatch(ref("a"), settle(ref("a")));
    expect(s.read()).toHaveLength(1);
    const result = await s.run([ref("a"), ref("b")], (target) => ({
      type: "thread.unsettle",
      commandId: CommandId.make(`unsettle-${target.threadId}`),
      threadId: target.threadId,
      reason: "user",
    }));
    expect(result).toMatchObject({ applied: [ref("a"), ref("b")], withoutUndo: 0 });
    expect(s.read()).toEqual([]);
  });

  it("names a bulk snooze after its action, in the caller's copy", async () => {
    const s = setup();
    await s.run(
      [ref("a"), ref("b")],
      (target) => ({
        type: "thread.snooze",
        commandId: CommandId.make(`snooze-${target.threadId}`),
        threadId: target.threadId,
        snoozedUntil: "2026-10-24T08:00:00.000Z",
      }),
      ({ count }) => ({ title: `${count} threads snoozed`, undoLabel: "Undo snooze" }),
    );
    expect(s.read()).toMatchObject([
      { action: "snooze", count: 2, copy: { title: "2 threads snoozed" } },
    ]);
    s.history.dispose();
  });

  it("sends once per thread and refuses more than 100 threads", async () => {
    const s = setup();
    await s.run([ref("a"), ref("a"), ref("a", nodeB)]);
    expect(s.sent("thread.settle")).toHaveLength(2);
    s.dispatch.mockClear();
    const many = Array.from({ length: 101 }, (_, index) => ref(`thread-${index}`));
    await expect(s.run(many)).rejects.toThrow(RangeError);
    await expect(s.run([...many.slice(0, 100), many[0]!])).resolves.toMatchObject({
      skipped: [],
    });
    expect(s.dispatch).toHaveBeenCalledTimes(100);
    s.history.dispose();
  });

  it("refuses mixed commands before sending any", async () => {
    const s = setup();
    await expect(
      s.run([ref("a"), ref("b")], (target) =>
        target.threadId === "a"
          ? settle(target)
          : { type: "thread.unsnooze", commandId: CommandId.make("x"), threadId: target.threadId },
      ),
    ).rejects.toThrow("one command type");
    await expect(s.run([ref("a")], () => settle(ref("other")))).rejects.toThrow("its own thread");
    expect(s.dispatch).not.toHaveBeenCalled();
    expect(s.read()).toEqual([]);
  });
});
