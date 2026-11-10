import type { EnvironmentId, LocalTask } from "@ryco/contracts";
import { selectLocalTasksEnvironment, useLocalTasksStore } from "@ryco/client-runtime/state/tasks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DESKTOP_TASK_LIST_WRITE_DELAY_MS,
  hydrateDesktopTaskList,
  installDesktopTaskListCache,
  isDesktopTaskListCopy,
  resetDesktopTaskListCacheForTests,
} from "./desktopTaskListCache";

// The workspace bridge's setting and state, driven by the tests.
const workspace = vi.hoisted(() => {
  const settingListeners = new Set<() => void>();
  const stateListeners = new Set<() => void>();
  const state = {
    enabled: null as boolean | null,
    workspace: { localEnvironmentId: null as string | null } as object,
  };
  return {
    state,
    settingListeners,
    stateListeners,
    setEnabled(enabled: boolean) {
      state.enabled = enabled;
      for (const listener of settingListeners) listener();
    },
    changeWorkspace(next: { localEnvironmentId: string | null }) {
      state.workspace = { ...next };
      for (const listener of stateListeners) listener();
    },
  };
});
vi.mock("./desktopWorkspace", () => ({
  readDesktopThreadContentCacheEnabled: () => workspace.state.enabled,
  subscribeDesktopThreadContentCacheEnabled: (listener: () => void) => {
    workspace.settingListeners.add(listener);
    return () => workspace.settingListeners.delete(listener);
  },
  readDesktopWorkspaceState: () => workspace.state.workspace,
  subscribeDesktopWorkspaceState: (listener: () => void) => {
    workspace.stateListeners.add(listener);
    return () => workspace.stateListeners.delete(listener);
  },
}));
const setDesktopThreadContentCacheEnabled = async (enabled: boolean) =>
  workspace.setEnabled(enabled);

const environmentId = "environment-desktop-tasks" as EnvironmentId;

function task(taskId: string, title = `Task ${taskId}`): LocalTask {
  return {
    taskId,
    revision: 1,
    title,
    notes: "",
    priority: "normal",
    dueAt: null,
    projectId: null,
    links: [],
    files: [],
    state: "todo",
    createdAt: "2026-10-10T00:00:00.000Z",
    updatedAt: "2026-10-10T00:00:00.000Z",
    status: "todo",
    delegations: [],
  } as LocalTask;
}

let stored: unknown = null;
let read = vi.fn(async (_environmentId: EnvironmentId): Promise<unknown> => stored);
const publish = vi.fn(async (_environmentId: EnvironmentId, list: unknown) => {
  stored = list;
  return true;
});

beforeEach(async () => {
  vi.useFakeTimers();
  stored = null;
  publish.mockClear();
  read = vi.fn(async (_environmentId: EnvironmentId): Promise<unknown> => stored);
  workspace.settingListeners.clear();
  workspace.stateListeners.clear();
  workspace.state.enabled = null;
  workspace.state.workspace = { localEnvironmentId: null };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktopBridge: {
        publishDesktopTaskList: publish,
        getDesktopTaskList: (environmentId: EnvironmentId) => read(environmentId),
      },
    },
  });
  await setDesktopThreadContentCacheEnabled(true);
  await installDesktopTaskListCache(useLocalTasksStore);
});

afterEach(() => {
  resetDesktopTaskListCacheForTests();
  useLocalTasksStore.getState().clear(environmentId);
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "window");
});

const shown = () => selectLocalTasksEnvironment(useLocalTasksStore.getState(), environmentId);

describe("Desktop saved task lists", () => {
  it("saves a read list after a quiet period and paints it on the next launch", async () => {
    useLocalTasksStore
      .getState()
      .applyList(environmentId, [task("a", "Saved title")], { since: 0, readAt: 42 });
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(DESKTOP_TASK_LIST_WRITE_DELAY_MS);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]![0]).toBe(environmentId);

    // Next launch: nothing read yet, the copy paints.
    useLocalTasksStore.getState().clear(environmentId);
    await hydrateDesktopTaskList(environmentId);
    expect(Object.values(shown().tasks).map((entry) => entry.title)).toEqual(["Saved title"]);
    expect(isDesktopTaskListCopy(environmentId)).toBe(true);
    // A copy painted is not written back.
    await vi.advanceTimersByTimeAsync(DESKTOP_TASK_LIST_WRITE_DELAY_MS * 2);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("never replaces a live read", async () => {
    stored = { version: 1, readAt: 1, tasks: [task("old")] };
    useLocalTasksStore.getState().applyList(environmentId, [task("live")], { since: 0, readAt: 9 });
    await hydrateDesktopTaskList(environmentId);
    expect(Object.keys(shown().tasks)).toEqual(["live"]);
    expect(isDesktopTaskListCopy(environmentId)).toBe(false);
  });

  it("drops a painted copy and writes nothing once the setting is off", async () => {
    stored = { version: 1, readAt: 1, tasks: [task("copy")] };
    await hydrateDesktopTaskList(environmentId);
    expect(Object.keys(shown().tasks)).toEqual(["copy"]);
    await setDesktopThreadContentCacheEnabled(false);
    expect(Object.keys(shown().tasks)).toEqual([]);
    useLocalTasksStore.getState().applyList(environmentId, [task("live")], { since: 0, readAt: 9 });
    await vi.advanceTimersByTimeAsync(DESKTOP_TASK_LIST_WRITE_DELAY_MS * 2);
    expect(publish).not.toHaveBeenCalled();
    // Off, nothing is painted from a copy either.
    useLocalTasksStore.getState().clear(environmentId);
    await hydrateDesktopTaskList(environmentId);
    expect(Object.keys(shown().tasks)).toEqual([]);
  });

  it("paints a machine's copy as soon as a surface starts reading its tasks", async () => {
    stored = { version: 1, readAt: 3, tasks: [task("copy", "From the copy")] };
    useLocalTasksStore.getState().setLoading(environmentId);
    await vi.advanceTimersByTimeAsync(0);
    expect(Object.values(shown().tasks).map((entry) => entry.title)).toEqual(["From the copy"]);
  });

  it("asks again once main's workspace changed, until a copy shows", async () => {
    // At launch main's workspace is not up yet: it has nothing for the machine.
    useLocalTasksStore.getState().setLoading(environmentId);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);
    expect(shown().readAt).toBeNull();
    // An unrelated store change asks nothing more under the same workspace state.
    useLocalTasksStore.getState().setLoading(environmentId);
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(1);

    stored = { version: 1, readAt: 4, tasks: [task("late", "Once main was up")] };
    workspace.changeWorkspace({ localEnvironmentId: "local-machine" });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(Object.values(shown().tasks).map((entry) => entry.title)).toEqual(["Once main was up"]);
    // Shown: no more asking.
    workspace.changeWorkspace({ localEnvironmentId: "local-machine" });
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("paints nothing when the setting is turned off while main answers", async () => {
    stored = { version: 1, readAt: 4, tasks: [task("gone")] };
    let answer: (value: unknown) => void = () => undefined;
    read = vi.fn(() => new Promise<unknown>((resolve) => (answer = resolve)));
    const pending = hydrateDesktopTaskList(environmentId);
    await vi.advanceTimersByTimeAsync(0);
    await setDesktopThreadContentCacheEnabled(false);
    answer(stored);
    await pending;
    expect(shown().readAt).toBeNull();
  });

  it("ignores an unreadable copy", async () => {
    stored = { version: 7, readAt: 1, tasks: [task("x")] };
    await hydrateDesktopTaskList(environmentId);
    expect(shown().readAt).toBeNull();
  });
});
