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
import { setDesktopThreadContentCacheEnabled } from "./desktopWorkspace";

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
const publish = vi.fn(async (_environmentId: EnvironmentId, list: unknown) => {
  stored = list;
  return true;
});

beforeEach(async () => {
  vi.useFakeTimers();
  stored = null;
  publish.mockClear();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      desktopBridge: {
        setDesktopThreadContentCacheEnabled: async (enabled: boolean) => enabled,
        publishDesktopTaskList: publish,
        getDesktopTaskList: async () => stored,
      },
    },
  });
  await setDesktopThreadContentCacheEnabled(true);
  installDesktopTaskListCache();
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

  it("ignores an unreadable copy", async () => {
    stored = { version: 7, readAt: 1, tasks: [task("x")] };
    await hydrateDesktopTaskList(environmentId);
    expect(shown().readAt).toBeNull();
  });
});
