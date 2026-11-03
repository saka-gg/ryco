import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CommandId, EnvironmentId, ThreadId } from "@ryco/contracts";
import { createSidebarUndoHistory } from "@ryco/client-runtime/state/threads";
import { sortThreadsWithPinned } from "./components/Sidebar.logic";
import { useUiStateStore } from "./uiStateStore";

const state = vi.hoisted(() => ({
  generation: {} as object | null,
  thread: { title: "Synthetic Thread", projectId: "project" } as object | null,
  project: {} as object | null,
  supported: true,
  hosted: false,
  mutable: true,
  listeners: new Set<() => void>(),
  dispatch: vi.fn(),
}));
vi.mock("./environmentApi", () => ({
  readEnvironmentApi: () => ({ orchestration: { dispatchCommand: state.dispatch } }),
}));
vi.mock("./localApi", () => ({ readLocalApi: () => undefined }));
vi.mock("./environments/runtime", () => ({
  readEnvironmentConnection: () => ({ shellSnapshotReadiness: { read: () => state.generation } }),
  getSavedEnvironmentRuntimeState: () => ({
    descriptor: { capabilities: { threadSidebarUndo: state.supported } },
  }),
}));
vi.mock("./environments/primary", () => ({ readPrimaryEnvironmentDescriptor: () => null }));
vi.mock("./hostedHub/hostedConnectionCoordinator", () => ({
  readHostedWorkspaceState: () => ({
    machines: [
      {
        environmentId: "node",
        canMutate: state.mutable,
        connectionState: "connected",
        cacheDisposition: "available",
        capabilities: { threadSidebarUndo: state.supported },
      },
    ],
  }),
}));
vi.mock("./env", () => ({ isHostedHubMode: () => state.hosted }));
vi.mock("./store", () => ({
  selectSidebarThreadSummaryByRef: () => state.thread,
  selectProjectByRef: () => state.project,
  useStore: {
    getState: () => ({}),
    subscribe: (listener: () => void) => {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
  },
}));
vi.mock("./lib/utils", () => ({ newCommandId: () => "command" }));
vi.mock("./components/ui/toast", () => ({
  toastManager: { add: vi.fn(), close: vi.fn(), update: vi.fn() },
  stackedThreadToast: (options: unknown) => options,
}));
import {
  presentSidebarUndoNotices,
  readSidebarUndoContext,
  readSidebarUndoLocalContext,
  sidebarUndo,
} from "./sidebarUndo";
import { requestThreadPinChange } from "./threadPinning";
import { toastManager } from "./components/ui/toast";
const target = { environmentId: EnvironmentId.make("node"), threadId: ThreadId.make("thread") };
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  state.generation = {};
  state.thread = { title: "Synthetic Thread", projectId: "project" };
  state.project = {};
  state.supported = true;
  state.hosted = false;
  state.mutable = true;
  useUiStateStore.setState({ pinnedThreadKeys: {} });
});
afterEach(() => {
  sidebarUndo.dispose();
  state.listeners.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe("web sidebar undo readiness and ordering", () => {
  it.each(["shell", "thread", "project", "authorization"])("drops %s invalidation", (boundary) => {
    expect(readSidebarUndoContext(target)).not.toBeNull();
    if (boundary === "shell") state.generation = null;
    if (boundary === "thread") state.thread = null;
    if (boundary === "project") state.project = null;
    if (boundary === "authorization") {
      state.hosted = true;
      state.mutable = false;
    }
    expect(readSidebarUndoContext(target)).toBeNull();
  });
  it("restores the exact position among pins using the existing sorter without changing priority data", async () => {
    const key = "node:thread";
    useUiStateStore.setState({
      pinnedThreadKeys: { "node:newer": true, [key]: true, "node:older": true },
    });
    const rows = ["older", "thread", "newer"].map((id, index) => ({
      id: ThreadId.make(id),
      createdAt: `2026-09-0${index + 1}T00:00:00.000Z`,
      updatedAt: "2026-09-01T00:00:00.000Z",
      priority: { rank: index + 1 },
    }));
    const order = () =>
      sortThreadsWithPinned({
        threads: rows,
        sortOrder: "created_at",
        pinnedThreadKeys: new Set(Object.keys(useUiStateStore.getState().pinnedThreadKeys)),
        getThreadKey: (thread) => `node:${thread.id}`,
      }).map((thread) => thread.id);
    const original = order();
    let id = 0;
    const history = createSidebarUndoHistory({
      readContext: () => null,
      readLocalContext: readSidebarUndoLocalContext,
      newCommandId: () => CommandId.make("undo"),
      changed: (notices) => {
        id = notices[0]?.id ?? id;
      },
      failed: vi.fn(),
    });
    try {
      history.unpin(target, {
        read: () => useUiStateStore.getState().pinnedThreadKeys[key] === true,
        write: (next) => useUiStateStore.getState().setThreadPinned(key, next),
        subscribe: useUiStateStore.subscribe,
      });
      expect(order()).not.toEqual(original);
      await history.undo(id);
      expect(order()).toEqual(original);
      expect(rows.map((row) => row.priority.rank)).toEqual([1, 2, 3]);
    } finally {
      history.dispose();
    }
  });
});

describe("web sidebar undo notices", () => {
  const shown = (options: unknown) => {
    const { title, description, actionProps } = options as Parameters<typeof toastManager.add>[0];
    return { title, description, undoLabel: actionProps?.["aria-label"] };
  };
  const added = () => shown(vi.mocked(toastManager.add).mock.lastCall?.[0]);
  const updated = () => shown(vi.mocked(toastManager.update).mock.lastCall?.[1]);

  it("shows a bulk notice in its own words, and follows its count", () => {
    vi.mocked(toastManager.add).mockReturnValueOnce("bulk");
    const bulk = {
      id: 100,
      action: "settle" as const,
      target,
      count: 3,
      pending: false,
      applying: true,
      copy: { title: "Settling 3 threads…", undoLabel: "Undo settle for 3 threads" },
    };
    presentSidebarUndoNotices([bulk]);
    expect(added()).toEqual({
      title: "Settling 3 threads…",
      description: undefined,
      undoLabel: "Undo settle for 3 threads",
    });

    presentSidebarUndoNotices([
      { ...bulk, count: 2, copy: { title: "Settling 2 threads…", undoLabel: "Undo for 2" } },
    ]);
    presentSidebarUndoNotices([
      {
        ...bulk,
        count: undefined,
        applying: false,
        copy: { title: "1 thread settled", undoLabel: "Undo settle for 1 thread" },
      },
    ]);
    expect(toastManager.add).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toastManager.update).mock.calls.map(([id]) => id)).toEqual(["bulk", "bulk"]);
    expect(updated()).toEqual({
      title: "1 thread settled",
      description: undefined,
      undoLabel: "Undo settle for 1 thread",
    });
  });

  it("names the thread of a single notice", () => {
    presentSidebarUndoNotices([
      {
        id: 101,
        action: "settle",
        target,
        pending: false,
        applying: false,
        threadTitle: "Synthetic Thread",
      },
    ]);
    expect(added()).toEqual({
      title: "Thread settled",
      description: "Synthetic Thread",
      undoLabel: "Undo settle Synthetic Thread",
    });
  });
});

const pinKey = "node:thread";
const changePin = (pinned: boolean) =>
  requestThreadPinChange({
    threadKey: pinKey,
    threadTitle: "Synthetic Thread",
    pinned,
    confirmUnpin: false,
  });
const isPinned = () => useUiStateStore.getState().pinnedThreadKeys[pinKey] === true;
async function clickDefaultUndo() {
  const undo = vi.spyOn(sidebarUndo, "undo");
  const action = vi.mocked(toastManager.add).mock.calls.at(-1)?.[0].actionProps?.onClick;
  expect(action).toBeTypeOf("function");
  action!({} as never);
  await undo.mock.results.at(-1)!.value;
}
function notifyCachedStateChange() {
  for (const listener of state.listeners) listener();
}
describe("default local pin integration", () => {
  it.each(["offline", "hosted viewer"])("allows Pin, Unpin and local Undo for %s", async (mode) => {
    if (mode === "offline") state.generation = null;
    else {
      state.hosted = true;
      state.mutable = false;
    }
    expect(readSidebarUndoContext(target)).toBeNull();
    await expect(changePin(true)).resolves.toBe("changed");
    expect(isPinned()).toBe(true);
    await expect(changePin(false)).resolves.toBe("changed");
    expect(isPinned()).toBe(false);
    expect(toastManager.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Thread unpinned" }),
    );
    await clickDefaultUndo();
    expect(isPinned()).toBe(true);
    expect(state.dispatch).not.toHaveBeenCalled();
    expect(state.listeners.size).toBe(0);
  });
  it.each(["thread", "project"])(
    "applies Unpin without a cached %s and omits Undo",
    async (missing) => {
      state.generation = null;
      if (missing === "thread") state.thread = null;
      else state.project = null;
      await changePin(true);
      await expect(changePin(false)).resolves.toBe("changed");
      expect(isPinned()).toBe(false);
      expect(toastManager.add).not.toHaveBeenCalled();
      expect(state.dispatch).not.toHaveBeenCalled();
    },
  );
  it.each(["pin ABA", "thread revision ABA", "thread removal ABA", "project removal ABA"])(
    "refuses %s through the default store subscriptions",
    async (change) => {
      state.generation = null;
      await changePin(true);
      await changePin(false);
      const originalThread = state.thread;
      const originalProject = state.project;
      if (change === "pin ABA") {
        useUiStateStore.getState().setThreadPinned(pinKey, true);
        useUiStateStore.getState().setThreadPinned(pinKey, false);
      } else {
        if (change === "thread revision ABA")
          state.thread = { ...state.thread, title: "Newer title" };
        if (change === "thread removal ABA") state.thread = null;
        if (change === "project removal ABA") state.project = null;
        notifyCachedStateChange();
        state.thread = originalThread;
        state.project = originalProject;
        notifyCachedStateChange();
      }
      await clickDefaultUndo();
      expect(isPinned()).toBe(false);
      expect(toastManager.close).toHaveBeenCalled();
      expect(state.listeners.size).toBe(0);
      expect(state.dispatch).not.toHaveBeenCalled();
      expect(toastManager.add).toHaveBeenCalledTimes(1);
    },
  );
  it("keeps local Undo after disconnect or a change to viewer authorization", async () => {
    await changePin(true);
    await changePin(false);
    state.generation = null;
    state.hosted = true;
    state.mutable = false;
    sidebarUndo.invalidate();
    await clickDefaultUndo();
    expect(isPinned()).toBe(true);
    expect(state.dispatch).not.toHaveBeenCalled();
  });
  it("expires local Undo and releases both store subscriptions", async () => {
    await changePin(true);
    await changePin(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(toastManager.close).toHaveBeenCalled();
    expect(state.listeners.size).toBe(0);
    await clickDefaultUndo();
    expect(isPinned()).toBe(false);
  });
});
