import { CommandId, EnvironmentId, ThreadId, type EnvironmentApi } from "@ryco/contracts";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createSidebarUndoHistory,
  type SidebarUndoNotice,
  type SidebarUndoContext,
  type SidebarUndoLocalContext,
} from "./sidebarUndo.ts";

const target = { environmentId: EnvironmentId.make("node-a"), threadId: ThreadId.make("thread-a") };
function setup() {
  const dispatch = vi.fn(async (_command: unknown) => ({ sequence: 1 }));
  let context: SidebarUndoContext | null = {
    generation: {},
    api: { orchestration: { dispatchCommand: dispatch } } as unknown as EnvironmentApi,
    supported: true,
  };
  let notices: readonly SidebarUndoNotice[] = [];
  const localListeners = new Set<() => void>();
  let localContext: SidebarUndoLocalContext | null = {
    threadRevision: "cached-thread",
    parentRevision: {},
    subscribe: (listener) => {
      localListeners.add(listener);
      return () => {
        localListeners.delete(listener);
      };
    },
  };
  const failed = vi.fn();
  const history = createSidebarUndoHistory({
    readContext: () => context,
    readLocalContext: () => localContext,
    newCommandId: () => CommandId.make("undo"),
    changed: (next) => {
      notices = next;
    },
    failed,
  });
  return {
    history,
    dispatch,
    failed,
    read: () => notices,
    context: () => context,
    localContext: () => localContext,
    localListeners,
    replaceLocal: (next: SidebarUndoLocalContext | null) => {
      localContext = next;
      for (const listener of localListeners) listener();
    },
    replace: (next: SidebarUndoContext | null) => {
      context = next;
    },
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe("sidebar undo history", () => {
  it.each(["archive", "settle", "snooze"] as const)(
    "offers immediate %s undo bound to its owning command and node",
    async (action) => {
      const s = setup();
      const commandId = CommandId.make("original");
      const original = s.history.dispatch(
        target,
        action === "snooze"
          ? {
              type: "thread.snooze",
              commandId,
              threadId: target.threadId,
              snoozedUntil: "2026-10-01T12:00:00.000Z",
            }
          : { type: `thread.${action}`, commandId, threadId: target.threadId },
      );
      expect(s.read()).toMatchObject([{ action, target, pending: false }]);
      await original;
      await s.history.undo(s.read()[0]!.id);
      expect(s.dispatch).toHaveBeenLastCalledWith({
        type: "thread.sidebar.undo",
        commandId: "undo",
        threadId: "thread-a",
        undoCommandId: "original",
      });
      expect(s.read()).toEqual([]);
      s.history.dispose();
    },
  );
  it("queues one early undo behind the original acknowledgment", async () => {
    const s = setup();
    let complete!: (value: { sequence: number }) => void;
    s.dispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const original = s.history.dispatch(target, {
      type: "thread.settle",
      commandId: CommandId.make("original"),
      threadId: target.threadId,
    });
    const id = s.read()[0]!.id;
    const undo = s.history.undo(id);
    await s.history.undo(id);
    expect(s.dispatch).toHaveBeenCalledTimes(1);
    complete({ sequence: 1 });
    await original;
    await undo;
    expect(s.dispatch).toHaveBeenCalledTimes(2);
  });
  it("drops failed originals and reports failed undo without rolling authoritative state back locally", async () => {
    const s = setup();
    s.dispatch.mockRejectedValueOnce(new Error("original failure"));
    await expect(
      s.history.dispatch(target, {
        type: "thread.archive",
        commandId: CommandId.make("original"),
        threadId: target.threadId,
      }),
    ).rejects.toThrow("original failure");
    expect(s.read()).toEqual([]);
    await s.history.dispatch(target, {
      type: "thread.settle",
      commandId: CommandId.make("accepted"),
      threadId: target.threadId,
    });
    s.dispatch.mockRejectedValueOnce(new Error("changed by another client"));
    await s.history.undo(s.read()[0]!.id);
    expect(s.failed).toHaveBeenCalledWith(
      expect.objectContaining({ message: "changed by another client" }),
    );
    expect(s.read()).toEqual([]);
  });
  it.each(["expiry", "disconnect", "generation", "removal"])(
    "refuses %s before undo and after delayed acknowledgment",
    async (reason) => {
      const s = setup();
      let complete!: (value: { sequence: number }) => void;
      s.dispatch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      const original = s.history.dispatch(target, {
        type: "thread.settle",
        commandId: CommandId.make("original"),
        threadId: target.threadId,
      });
      const id = s.read()[0]!.id;
      const undo = s.history.undo(id);
      if (reason === "expiry") await vi.advanceTimersByTimeAsync(5000);
      else s.replace(reason === "generation" ? { ...s.context()!, generation: {} } : null);
      complete({ sequence: 1 });
      await original;
      await undo;
      expect(s.dispatch).toHaveBeenCalledTimes(1);
      expect(s.read()).toEqual([]);
    },
  );
  it("bounds notices, keeps different threads independent, and supersedes rapid actions on one thread", async () => {
    const s = setup();
    for (let i = 0; i < 8; i++) {
      const ref = { ...target, threadId: ThreadId.make(`thread-${i}`) };
      await s.history.dispatch(ref, {
        type: "thread.settle",
        commandId: CommandId.make(`original-${i}`),
        threadId: ref.threadId,
      });
    }
    expect(s.read()).toHaveLength(5);
    const oldest = s.read()[0]!;
    await s.history.undo(oldest.id);
    expect(s.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ threadId: oldest.target.threadId }),
    );
    await s.history.dispatch(target, {
      type: "thread.settle",
      commandId: CommandId.make("first"),
      threadId: target.threadId,
    });
    const previous = s.read().at(-1)!.id;
    await s.history.dispatch(target, {
      type: "thread.snooze",
      commandId: CommandId.make("second"),
      threadId: target.threadId,
      snoozedUntil: "2026-10-01T12:00:00.000Z",
    });
    const count = s.dispatch.mock.calls.length;
    await s.history.undo(previous);
    expect(s.dispatch).toHaveBeenCalledTimes(count);
    s.history.dispose();
  });
  it("does not offer server undo to an older environment", async () => {
    const s = setup();
    s.replace({ ...s.context()!, supported: false });
    await s.history.dispatch(target, {
      type: "thread.settle",
      commandId: CommandId.make("original"),
      threadId: target.threadId,
    });
    expect(s.dispatch).toHaveBeenCalledTimes(1);
    expect(s.read()).toEqual([]);
  });
  it("restores local unpin and refuses ABA pin changes", async () => {
    const s = setup();
    let pinned = true;
    const listeners = new Set<() => void>();
    const pin = {
      read: () => pinned,
      write: (next: boolean) => {
        pinned = next;
        for (const listener of listeners) listener();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };

    s.history.unpin(target, pin);
    expect(pinned).toBe(false);
    await s.history.undo(s.read()[0]!.id);
    expect(pinned).toBe(true);
    expect(listeners.size).toBe(0);
    s.history.unpin(target, pin);
    pin.write(true);
    pin.write(false);
    await s.history.undo(s.read()[0]!.id);
    expect(pinned).toBe(false);
    expect(s.failed).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
    expect(s.localListeners.size).toBe(0);
  });
});

it.each([false, true])("archive Undo respects manual navigation: %s", async (manualNavigation) => {
  const s = setup();
  let route = "thread";
  const reopen = vi.fn(() => {
    route = "thread";
  });
  await s.history.archive(target, CommandId.make("archive"), {
    currentRoute: () => route,
    shouldLeave: () => true,
    leave: async () => {
      route = "fallback";
      return route;
    },
    reopen,
  });
  expect(route).toBe("fallback");
  if (manualNavigation) route = "another-thread";
  await s.history.undo(s.read()[0]!.id);
  expect(reopen).toHaveBeenCalledTimes(manualNavigation ? 0 : 1);
  s.history.dispose();
});
it("an early archive Undo waits for automatic navigation to finish before reopening", async () => {
  const s = setup();
  let route = "thread";
  let finishNavigation!: () => void;
  const original = s.history.archive(target, CommandId.make("archive"), {
    currentRoute: () => route,
    shouldLeave: () => true,
    leave: async () => {
      await new Promise<void>((resolve) => {
        finishNavigation = resolve;
      });
      route = "fallback";
      return route;
    },
    reopen: () => {
      route = "thread";
    },
  });
  await vi.waitFor(() => expect(finishNavigation).toBeTypeOf("function"));
  const undo = s.history.undo(s.read()[0]!.id);
  await Promise.resolve();
  expect(route).toBe("thread");
  finishNavigation();
  await original;
  await undo;
  expect(route).toBe("thread");
  s.history.dispose();
});
it("does not navigate on a stale archive acknowledgment", async () => {
  const s = setup();
  let finish!: (value: { sequence: number }) => void;
  s.dispatch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const leave = vi.fn(async () => "fallback");
  const original = s.history.archive(target, CommandId.make("archive"), {
    currentRoute: () => "thread",
    shouldLeave: () => true,
    leave,
    reopen: vi.fn(),
  });
  s.replace(null);
  finish({ sequence: 1 });
  await original;
  expect(leave).not.toHaveBeenCalled();
  expect(s.read()).toEqual([]);
});

it("keeps identical thread IDs on different nodes and their APIs independent", async () => {
  const a = { ...target, environmentId: EnvironmentId.make("node-a") };
  const b = { ...target, environmentId: EnvironmentId.make("node-b") };
  const apiA = vi.fn(async () => ({ sequence: 1 }));
  const apiB = vi.fn(async () => ({ sequence: 2 }));
  const contexts = new Map(
    [a, b].map((ref, index) => [
      ref.environmentId,
      {
        generation: {},
        api: {
          orchestration: { dispatchCommand: index === 0 ? apiA : apiB },
        } as unknown as EnvironmentApi,
        supported: true,
      },
    ]),
  );
  let notices: readonly SidebarUndoNotice[] = [];
  const history = createSidebarUndoHistory({
    readContext: (ref) => contexts.get(ref.environmentId) ?? null,
    newCommandId: () => CommandId.make("undo"),
    changed: (next) => {
      notices = next;
    },
    failed: vi.fn(),
  });
  try {
    await history.dispatch(a, {
      type: "thread.settle",
      commandId: CommandId.make("a"),
      threadId: a.threadId,
    });
    await history.dispatch(b, {
      type: "thread.settle",
      commandId: CommandId.make("b"),
      threadId: b.threadId,
    });
    expect(notices).toHaveLength(2);
    await history.undo(notices[1]!.id);
    expect(apiA).toHaveBeenCalledTimes(1);
    expect(apiB).toHaveBeenCalledTimes(2);
    expect(apiB).toHaveBeenLastCalledWith(expect.objectContaining({ undoCommandId: "b" }));
  } finally {
    history.dispose();
  }
});
it("refuses local unpin restoration after a newer cached thread revision", async () => {
  const s = setup();
  let pinned = true;
  s.history.unpin(target, {
    read: () => pinned,
    write: (next) => {
      pinned = next;
    },
    subscribe: () => () => {},
  });
  const id = s.read()[0]!.id;
  s.replaceLocal({ ...s.localContext()!, threadRevision: {} });
  await s.history.undo(id);
  expect(pinned).toBe(false);
  expect(s.failed).not.toHaveBeenCalled();
  expect(s.read()).toEqual([]);
});

it("applies local Unpin without mutation readiness and restores using only local state", async () => {
  const s = setup();
  s.replace(null);
  let pinned = true;
  s.history.unpin(target, {
    read: () => pinned,
    write: (next) => {
      pinned = next;
    },
    subscribe: () => () => {},
  });
  expect(pinned).toBe(false);
  expect(s.read()).toMatchObject([{ action: "unpin" }]);
  await s.history.undo(s.read()[0]!.id);
  expect(pinned).toBe(true);
  expect(s.dispatch).not.toHaveBeenCalled();
  expect(s.failed).not.toHaveBeenCalled();
  expect(s.localListeners.size).toBe(0);
});

it("still applies local Unpin without a cached thread but offers no Undo", () => {
  const s = setup();
  s.replace(null);
  s.replaceLocal(null);
  let pinned = true;
  s.history.unpin(target, {
    read: () => pinned,
    write: (next) => {
      pinned = next;
    },
    subscribe: () => () => {},
  });
  expect(pinned).toBe(false);
  expect(s.read()).toEqual([]);
  expect(s.localListeners.size).toBe(0);
});

it.each(["revision ABA", "thread removal ABA", "parent replacement"])(
  "refuses local %s without overwriting the pin",
  async (change) => {
    const s = setup();
    const local = s.localContext()!;
    let pinned = true;
    s.history.unpin(target, {
      read: () => pinned,
      write: (next) => {
        pinned = next;
      },
      subscribe: () => () => {},
    });
    const id = s.read()[0]!.id;
    s.replaceLocal(
      change === "thread removal ABA"
        ? null
        : {
            ...local,
            ...(change === "revision ABA"
              ? { threadRevision: "newer-thread" }
              : { parentRevision: {} }),
          },
    );
    s.replaceLocal(local);
    await s.history.undo(id);
    expect(pinned).toBe(false);
    expect(s.read()).toEqual([]);
    expect(s.localListeners.size).toBe(0);
    expect(s.dispatch).not.toHaveBeenCalled();
  },
);

it("finishes a submitted Undo and archive reopening even when acknowledgment crosses the notice deadline", async () => {
  const s = setup();
  let route = "thread";
  const reopen = vi.fn(() => {
    route = "thread";
  });
  await s.history.archive(target, CommandId.make("archive"), {
    currentRoute: () => route,
    shouldLeave: () => true,
    leave: async () => {
      route = "fallback";
      return route;
    },
    reopen,
  });
  let finish!: (value: { sequence: number }) => void;
  s.dispatch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const undo = s.history.undo(s.read()[0]!.id);
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await vi.advanceTimersByTimeAsync(5_000);
  expect(s.read()).toMatchObject([{ pending: true }]);
  finish({ sequence: 2 });
  await undo;
  expect(reopen).toHaveBeenCalledTimes(1);
  expect(s.read()).toEqual([]);
});

it("local pin revisions tolerate response progress but detect ordering and lifecycle changes", async () => {
  const { sidebarUndoThreadRevision } = await import("./sidebarUndo.ts");
  const thread = {
    ...target,
    id: target.threadId,
    projectId: "project",
    title: "Synthetic",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T01:00:00.000Z",
    latestUserMessageAt: "2026-09-30T00:30:00.000Z",
    manualPosition: 17,
    archivedAt: null,
    snoozedUntil: null,
  } as unknown as import("./types.ts").SidebarThreadSummary;
  const revision = sidebarUndoThreadRevision(thread);
  expect(sidebarUndoThreadRevision({ ...thread, updatedAt: "2026-09-30T01:01:00.000Z" })).toBe(
    revision,
  );
  expect(sidebarUndoThreadRevision({ ...thread, manualPosition: 18 })).not.toBe(revision);
  expect(
    sidebarUndoThreadRevision({ ...thread, latestUserMessageAt: "2026-09-30T01:01:00.000Z" }),
  ).not.toBe(revision);
  expect(
    sidebarUndoThreadRevision({ ...thread, snoozedUntil: "2026-10-01T00:00:00.000Z" }),
  ).not.toBe(revision);
  const withoutMessage = { ...thread, latestUserMessageAt: null };
  expect(
    sidebarUndoThreadRevision({ ...withoutMessage, updatedAt: "2026-09-30T01:01:00.000Z" }),
  ).not.toBe(sidebarUndoThreadRevision(withoutMessage));
});
