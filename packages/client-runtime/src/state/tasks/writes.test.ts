import {
  CommandId,
  EnvironmentId,
  LocalTaskError,
  MessageId,
  ThreadId,
  type LocalTask,
  type LocalTaskDelegateInput,
  type LocalTaskDelegation,
  type LocalTaskUpdateInput,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { selectLocalTasksEnvironment, selectTaskView, useLocalTasksStore } from "./store.ts";
import { LocalTasksUnsupportedError, retainLocalTasks, type LocalTasksApi } from "./sync.ts";
import { createLocalTaskWriter, type LocalTaskWriteOperation } from "./writes.ts";

const ENV = EnvironmentId.make("env-tasks-writes");

function task(taskId: string, overrides: Partial<LocalTask> = {}): LocalTask {
  return {
    taskId,
    revision: 1,
    title: `Task ${taskId}`,
    notes: "",
    priority: "normal",
    dueAt: null,
    projectId: null,
    links: [],
    files: [],
    state: "todo",
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
    status: "todo",
    delegations: [],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const conflict = () => new LocalTaskError({ reason: "conflict", message: "Changed elsewhere." });
const store = () => useLocalTasksStore.getState();
const environment = () => selectLocalTasksEnvironment(store(), ENV);
const view = (taskId: string) => selectTaskView(store(), ENV, taskId);
const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Applies an update input to the stored task, as the node would. */
function updated(input: LocalTaskUpdateInput, revision = input.expectedRevision + 1): LocalTask {
  const { taskId, expectedRevision: _expected, ...fields } = input;
  const current = environment().tasks[taskId] ?? task(taskId);
  const changed = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<LocalTask>;
  return { ...current, ...changed, revision };
}

function setup(api: LocalTasksApi = {}) {
  const errors: Array<{ cause: unknown; operation: LocalTaskWriteOperation }> = [];
  const writer = createLocalTaskWriter({
    api,
    environmentId: ENV,
    onError: (cause, operation) => errors.push({ cause, operation }),
  });
  return { writer, errors };
}

afterEach(async () => {
  await flushMicrotasks();
  useLocalTasksStore.setState({ byEnvironment: {} });
});

describe("update", () => {
  it("keeps one save in flight and sends later changes together on its revision", async () => {
    store().applyTask(ENV, task("a"));
    const first = deferred<LocalTask>();
    const updateLocalTask = vi
      .fn<(input: LocalTaskUpdateInput) => Promise<LocalTask>>()
      .mockReturnValueOnce(first.promise)
      .mockImplementation(async (input) => updated(input));
    const { writer, errors } = setup({ updateLocalTask });

    writer.update("a", { title: "One" });
    writer.update("a", { notes: "Typed meanwhile" });
    writer.update("a", { title: "Two" });
    expect(updateLocalTask).toHaveBeenCalledTimes(1);
    expect(updateLocalTask).toHaveBeenLastCalledWith({
      taskId: "a",
      expectedRevision: 1,
      title: "One",
    });
    expect(view("a")).toMatchObject({ title: "Two", notes: "Typed meanwhile", saving: true });

    first.resolve(task("a", { revision: 2, title: "One" }));
    await flushMicrotasks();
    expect(updateLocalTask).toHaveBeenCalledTimes(2);
    expect(updateLocalTask).toHaveBeenLastCalledWith({
      taskId: "a",
      expectedRevision: 2,
      notes: "Typed meanwhile",
      title: "Two",
    });
    expect(environment().tasks.a).toMatchObject({ revision: 3, title: "Two" });
    expect(environment().overlays.a).toBeUndefined();
    expect(view("a")).toMatchObject({ title: "Two", notes: "Typed meanwhile", saving: false });
    expect(errors).toEqual([]);
  });

  it("sends nothing for a change the task already shows", async () => {
    store().applyTask(ENV, task("a", { links: [{ kind: "pr", number: 7 }] }));
    const updateLocalTask = vi.fn(async (input: LocalTaskUpdateInput) => updated(input));
    const { writer } = setup({ updateLocalTask });

    writer.update("a", { title: "Task a", links: [{ kind: "pr", number: 7 }] });
    expect(updateLocalTask).not.toHaveBeenCalled();
    expect(environment().overlays.a).toBeUndefined();
    writer.update("a", { title: "Task a", notes: "New" });
    expect(updateLocalTask).toHaveBeenCalledWith({
      taskId: "a",
      expectedRevision: 1,
      notes: "New",
    });
  });

  it("reloads the task after a conflict and sends everything changed once more", async () => {
    store().applyTask(ENV, task("a"));
    const rejected = deferred<LocalTask>();
    const updateLocalTask = vi
      .fn<(input: LocalTaskUpdateInput) => Promise<LocalTask>>()
      .mockReturnValueOnce(rejected.promise)
      .mockImplementation(async (input) => updated(input));
    const getLocalTask = vi.fn(async () => task("a", { revision: 5, notes: "Theirs" }));
    const { writer, errors } = setup({ updateLocalTask, getLocalTask });

    writer.update("a", { title: "Mine" });
    writer.update("a", { dueAt: "2026-10-20T00:00:00.000Z" });
    rejected.reject(conflict());
    await flushMicrotasks();

    expect(getLocalTask).toHaveBeenCalledWith({ taskId: "a" });
    expect(updateLocalTask).toHaveBeenCalledTimes(2);
    expect(updateLocalTask).toHaveBeenLastCalledWith({
      taskId: "a",
      expectedRevision: 5,
      title: "Mine",
      dueAt: "2026-10-20T00:00:00.000Z",
    });
    expect(environment().tasks.a).toMatchObject({
      revision: 6,
      title: "Mine",
      notes: "Theirs",
      dueAt: "2026-10-20T00:00:00.000Z",
    });
    expect(errors).toEqual([]);
  });

  it("rolls back, re-reads and reports after a second conflict", async () => {
    store().applyTask(ENV, task("a"));
    const list = vi.fn(async () => ({ tasks: [task("a", { revision: 5 })], nextCursor: null }));
    const updateLocalTask = vi.fn(async (): Promise<LocalTask> => {
      throw conflict();
    });
    const getLocalTask = vi.fn(async () => task("a", { revision: 5 }));
    const release = retainLocalTasks({ listLocalTasks: list }, ENV);
    await flushMicrotasks();
    const { writer, errors } = setup({ updateLocalTask, getLocalTask });

    writer.update("a", { title: "Mine" });
    await flushMicrotasks();

    expect(updateLocalTask).toHaveBeenCalledTimes(2);
    expect(view("a")).toMatchObject({ title: "Task a", saving: false });
    expect(list).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.operation).toEqual({
      kind: "update",
      taskId: "a",
      patch: { title: "Mine" },
    });
    release();
  });

  it("applies its link edits to the node's links when a conflict makes it send again", async () => {
    store().applyTask(ENV, task("a"));
    const updateLocalTask = vi
      .fn<(input: LocalTaskUpdateInput) => Promise<LocalTask>>()
      .mockRejectedValueOnce(conflict())
      .mockImplementation(async (input) => updated(input));
    // Another device linked a pull request meanwhile.
    const getLocalTask = vi.fn(async () =>
      task("a", { revision: 2, links: [{ kind: "pr", number: 12 }] }),
    );
    const { writer, errors } = setup({ updateLocalTask, getLocalTask });

    writer.update("a", { links: [{ kind: "issue", number: 5 }] });
    await flushMicrotasks();
    expect(updateLocalTask.mock.calls.map(([input]) => input.links)).toEqual([
      [{ kind: "issue", number: 5 }],
      [
        { kind: "pr", number: 12 },
        { kind: "issue", number: 5 },
      ],
    ]);
    expect(view("a")?.links).toEqual([
      { kind: "pr", number: 12 },
      { kind: "issue", number: 5 },
    ]);
    expect(errors).toEqual([]);
  });

  it("sends a removed link as a removal, keeping links added elsewhere", async () => {
    store().applyTask(
      ENV,
      task("a", {
        links: [
          { kind: "issue", number: 5 },
          { kind: "pr", number: 7 },
        ],
      }),
    );
    const saving = deferred<LocalTask>();
    const updateLocalTask = vi
      .fn<(input: LocalTaskUpdateInput) => Promise<LocalTask>>()
      .mockReturnValueOnce(saving.promise)
      .mockImplementation(async (input) => updated(input));
    const { writer } = setup({ updateLocalTask });

    writer.update("a", { links: [{ kind: "pr", number: 7 }] });
    // Meanwhile a read brings another device's link, then this client removes one more.
    saving.resolve(
      task("a", {
        revision: 2,
        links: [
          { kind: "pr", number: 7 },
          { kind: "branch", name: "feature/x" },
        ],
      }),
    );
    writer.update("a", { links: [] });
    await flushMicrotasks();
    expect(updateLocalTask).toHaveBeenLastCalledWith({
      taskId: "a",
      expectedRevision: 2,
      links: [{ kind: "branch", name: "feature/x" }],
    });
  });

  it("rolls back without a retry on any other failure, keeping changes made since", async () => {
    store().applyTask(ENV, task("a"));
    const failing = deferred<LocalTask>();
    const updateLocalTask = vi
      .fn<(input: LocalTaskUpdateInput) => Promise<LocalTask>>()
      .mockReturnValueOnce(failing.promise)
      .mockImplementation(async (input) => updated(input));
    const { writer, errors } = setup({ updateLocalTask });

    writer.update("a", { title: "Lost" });
    writer.update("a", { notes: "Kept" });
    failing.reject(new Error("socket closed"));
    await flushMicrotasks();

    expect(errors.map((entry) => entry.operation.kind)).toEqual(["update"]);
    expect(updateLocalTask).toHaveBeenLastCalledWith({
      taskId: "a",
      expectedRevision: 1,
      notes: "Kept",
    });
    expect(view("a")).toMatchObject({ title: "Task a", notes: "Kept" });
  });
});

describe("create", () => {
  it("shows the task at once and queues its saves behind the creation", async () => {
    const created = deferred<LocalTask>();
    const createLocalTask = vi.fn(() => created.promise);
    const updateLocalTask = vi.fn(async (input: LocalTaskUpdateInput) => updated(input));
    const { writer } = setup({ createLocalTask, updateLocalTask });

    const result = writer.create({
      taskId: "new",
      title: "New task",
      notes: "",
      priority: "normal",
      dueAt: null,
      projectId: null,
    });
    expect(view("new")).toMatchObject({ title: "New task", creating: true, revision: 0 });
    writer.update("new", { notes: "Right away" });
    expect(updateLocalTask).not.toHaveBeenCalled();

    created.resolve(task("new", { revision: 0, title: "New task" }));
    expect(await result).toMatchObject({ taskId: "new" });
    await flushMicrotasks();
    expect(updateLocalTask).toHaveBeenCalledWith({
      taskId: "new",
      expectedRevision: 0,
      notes: "Right away",
    });
    expect(view("new")).toMatchObject({ notes: "Right away", creating: false, saving: false });
  });

  it("removes the task and drops what was queued behind it when the creation fails", async () => {
    const createLocalTask = vi.fn(async (): Promise<LocalTask> => {
      throw new Error("offline");
    });
    const updateLocalTask = vi.fn();
    const { writer, errors } = setup({ createLocalTask, updateLocalTask });

    const result = writer.create({
      taskId: "new",
      title: "New task",
      notes: "",
      priority: "normal",
      dueAt: null,
      projectId: null,
    });
    writer.update("new", { notes: "Lost" });
    const file = writer.addFile("new", {
      name: "a.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      dataUrl: "data:text/plain;base64,YQ==",
    });
    expect(await result).toBeNull();
    expect(await file).toBeNull();
    expect(view("new")).toBeUndefined();
    expect(updateLocalTask).not.toHaveBeenCalled();
    expect(errors.map((entry) => entry.operation)).toEqual([{ kind: "create", taskId: "new" }]);
  });
});

describe("remove", () => {
  it("hides the task at once and removes it once the node confirms", async () => {
    store().applyTask(ENV, task("a", { revision: 4 }));
    const deleted = deferred<{ readonly deleted: true }>();
    const deleteLocalTask = vi.fn(() => deleted.promise);
    const { writer } = setup({ deleteLocalTask });

    const result = writer.remove("a");
    expect(view("a")).toBeUndefined();
    expect(writer.remove("a")).toBe(result);
    expect(deleteLocalTask).toHaveBeenCalledWith({ taskId: "a", expectedRevision: 4 });
    deleted.resolve({ deleted: true });
    expect(await result).toBe(true);
    expect(environment().tasks.a).toBeUndefined();
    expect(environment().overlays.a).toBeUndefined();
  });

  it("restores the task when the delete fails, and takes not-found as done", async () => {
    store().applyTask(ENV, task("a"));
    store().applyTask(ENV, task("b"));
    const deleteLocalTask = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new LocalTaskError({ reason: "not-found", message: "Gone." }));
    const { writer, errors } = setup({ deleteLocalTask });

    expect(await writer.remove("a")).toBe(false);
    expect(view("a")).toBeDefined();
    expect(errors.map((entry) => entry.operation)).toEqual([{ kind: "remove", taskId: "a" }]);

    expect(await writer.remove("b")).toBe(true);
    expect(environment().tasks.b).toBeUndefined();
    expect(errors).toHaveLength(1);
  });
});

describe("files", () => {
  it("chains file writes on the revision the save before them returned", async () => {
    store().applyTask(ENV, task("a"));
    const saving = deferred<LocalTask>();
    const updateLocalTask = vi.fn(() => saving.promise);
    const addLocalTaskFile = vi.fn(async () => task("a", { revision: 3 }));
    const removeLocalTaskFile = vi.fn(async () => task("a", { revision: 4 }));
    const { writer } = setup({ updateLocalTask, addLocalTaskFile, removeLocalTaskFile });

    writer.update("a", { title: "Saving" });
    const added = writer.addFile("a", {
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 10,
      uploadToken: "token-1" as never,
    });
    const removed = writer.removeFile("a", "file-1");
    expect(addLocalTaskFile).not.toHaveBeenCalled();

    saving.resolve(task("a", { revision: 2, title: "Saving" }));
    expect(await added).toMatchObject({ revision: 3 });
    expect(addLocalTaskFile).toHaveBeenCalledWith({
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 10,
      uploadToken: "token-1",
      taskId: "a",
      expectedRevision: 2,
    });
    expect(await removed).toMatchObject({ revision: 4 });
    expect(removeLocalTaskFile).toHaveBeenCalledWith({
      taskId: "a",
      expectedRevision: 3,
      fileId: "file-1",
    });
  });

  it("drops a cancelled add that has not gone out, and takes back one that had", async () => {
    store().applyTask(ENV, task("a"));
    const saving = deferred<LocalTask>();
    const updateLocalTask = vi.fn(() => saving.promise);
    const adding = deferred<LocalTask>();
    const file = {
      fileId: "task-a-1-txt",
      type: "file" as const,
      name: "a.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      addedAt: "2026-10-18T00:00:00.000Z",
    };
    const addLocalTaskFile = vi.fn(() => adding.promise);
    const removeLocalTaskFile = vi.fn(async () => task("a", { revision: 4 }));
    const { writer, errors } = setup({ updateLocalTask, addLocalTaskFile, removeLocalTaskFile });
    const request = {
      name: "a.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      dataUrl: "data:text/plain;base64,YQ==",
    };

    writer.update("a", { title: "Saving" });
    const queued = new AbortController();
    const dropped = writer.addFile("a", request, { signal: queued.signal });
    queued.abort();
    const inFlight = new AbortController();
    const takenBack = writer.addFile("a", request, { signal: inFlight.signal });
    saving.resolve(task("a", { revision: 2, title: "Saving" }));
    expect(await dropped).toBeNull();
    await flushMicrotasks();
    expect(addLocalTaskFile).toHaveBeenCalledTimes(1);
    inFlight.abort();
    adding.resolve(task("a", { revision: 3, files: [file] }));
    expect(await takenBack).toBeNull();
    expect(removeLocalTaskFile).toHaveBeenCalledWith({
      taskId: "a",
      expectedRevision: 3,
      fileId: file.fileId,
    });
    expect(environment().tasks.a).toMatchObject({ revision: 4, files: [] });
    expect(errors).toEqual([]);
  });

  it("refuses file writes for a task being deleted", async () => {
    store().applyTask(ENV, task("a"));
    const deleting = deferred<{ readonly deleted: true }>();
    const addLocalTaskFile = vi.fn();
    const { writer, errors } = setup({
      deleteLocalTask: vi.fn(() => deleting.promise),
      addLocalTaskFile,
    });
    const removed = writer.remove("a");
    expect(
      await writer.addFile("a", {
        name: "a.txt",
        mimeType: "text/plain",
        sizeBytes: 1,
        dataUrl: "data:text/plain;base64,YQ==",
      }),
    ).toBeNull();
    expect(await writer.removeFile("a", "file-1")).toBeNull();
    deleting.resolve({ deleted: true });
    await removed;
    expect(addLocalTaskFile).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it("reports a node without the file methods as unsupported", async () => {
    store().applyTask(ENV, task("a"));
    const { writer, errors } = setup({});
    expect(await writer.removeFile("a", "file-1")).toBeNull();
    expect(errors[0]?.cause).toBeInstanceOf(LocalTasksUnsupportedError);
    await expect(
      writer.createFileUpload({ taskId: "a", name: "a.txt", mimeType: "text/plain", sizeBytes: 1 }),
    ).rejects.toBeInstanceOf(LocalTasksUnsupportedError);
  });
});

describe("delegate", () => {
  const command = (name: string): LocalTaskDelegateInput["command"] => ({
    type: "thread.turn.start",
    commandId: CommandId.make(`command-${name}`),
    threadId: ThreadId.make(`thread-${name}`),
    message: {
      messageId: MessageId.make(`message-${name}`),
      role: "user",
      text: "Fix it",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-10-18T00:00:00.000Z",
  });
  const delegation = (name: string): LocalTaskDelegation => ({
    commandId: CommandId.make(`command-${name}`),
    threadId: ThreadId.make(`thread-${name}`),
    messageId: MessageId.make(`message-${name}`),
    sequence: 1,
    branch: "task/fix",
    dispatched: true,
    status: "running",
    error: null,
    createdAt: "2026-10-18T00:00:00.000Z",
  });

  it("shows the start at once without waiting for a save in flight", async () => {
    store().applyTask(ENV, task("a"));
    const saving = deferred<LocalTask>();
    const started = deferred<LocalTask>();
    const updateLocalTask = vi.fn(() => saving.promise);
    const delegateLocalTask = vi.fn(() => started.promise);
    const { writer } = setup({ updateLocalTask, delegateLocalTask });

    writer.update("a", { notes: "Typing" });
    const result = writer.delegate("a", command("one"), { branch: "task/fix" });
    expect(view("a")?.optimisticStarts.map((start) => start.branch)).toEqual(["task/fix"]);
    expect(view("a")?.status).toBe("starting");
    await flushMicrotasks();
    expect(delegateLocalTask).toHaveBeenCalledWith({ taskId: "a", command: command("one") });

    started.resolve(task("a", { delegations: [delegation("one")] }));
    expect(await result).toMatchObject({ taskId: "a" });
    expect(view("a")?.optimisticStarts).toEqual([]);
    expect(view("a")?.delegations).toHaveLength(1);
    expect(view("a")?.status).toBe("running");
    saving.resolve(task("a", { revision: 2, notes: "Typing" }));
  });

  it("drops the start and rethrows when it fails", async () => {
    store().applyTask(ENV, task("a"));
    const delegateLocalTask = vi.fn(async (): Promise<LocalTask> => {
      throw new Error("refused");
    });
    const { writer, errors } = setup({ delegateLocalTask });

    await expect(writer.delegate("a", command("one"), { branch: null })).rejects.toThrow("refused");
    expect(view("a")?.optimisticStarts).toEqual([]);
    expect(environment().overlays.a).toBeUndefined();
    expect(errors).toEqual([]);
  });

  it("waits for the task's file adds still on their way, which the chat then carries", async () => {
    store().applyTask(ENV, task("a"));
    const adding = deferred<LocalTask>();
    const addLocalTaskFile = vi.fn(() => adding.promise);
    const delegateLocalTask = vi.fn(async () => task("a", { delegations: [delegation("one")] }));
    const { writer } = setup({ addLocalTaskFile, delegateLocalTask });

    void writer.addFile("a", {
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 10,
      uploadToken: "token-1" as never,
    });
    const result = writer.delegate("a", command("one"), { branch: null });
    await flushMicrotasks();
    expect(view("a")?.status).toBe("starting");
    expect(delegateLocalTask).not.toHaveBeenCalled();
    adding.resolve(task("a", { revision: 2 }));
    await result;
    expect(delegateLocalTask).toHaveBeenCalledTimes(1);
  });

  it("refuses to start a chat for a task that is gone or being deleted", async () => {
    store().applyTask(ENV, task("a"));
    const delegateLocalTask = vi.fn();
    const { writer } = setup({
      deleteLocalTask: vi.fn(() => new Promise<{ readonly deleted: true }>(() => {})),
      delegateLocalTask,
    });
    void writer.remove("a");
    await expect(writer.delegate("a", command("one"), { branch: null })).rejects.toThrow(
      "The task was deleted",
    );
    await expect(writer.delegate("missing", command("two"), { branch: null })).rejects.toThrow(
      "The task was deleted",
    );
    expect(delegateLocalTask).not.toHaveBeenCalled();
    expect(environment().overlays.a?.optimisticStarts ?? []).toEqual([]);
  });

  it("waits for the task's creation and gives up when it fails", async () => {
    const created = deferred<LocalTask>();
    const createLocalTask = vi.fn(() => created.promise);
    const delegateLocalTask = vi.fn(async () => task("new", { delegations: [delegation("one")] }));
    const { writer } = setup({ createLocalTask, delegateLocalTask });
    const input = {
      taskId: "new",
      title: "New",
      notes: "",
      priority: "normal" as const,
      dueAt: null,
      projectId: null,
    };

    void writer.create(input);
    const result = writer.delegate("new", command("one"), { branch: null });
    await flushMicrotasks();
    expect(delegateLocalTask).not.toHaveBeenCalled();
    created.resolve(task("new", { revision: 0 }));
    await result;
    expect(delegateLocalTask).toHaveBeenCalledTimes(1);

    createLocalTask.mockRejectedValueOnce(new Error("offline"));
    void writer.create({ ...input, taskId: "other" });
    await expect(writer.delegate("other", command("two"), { branch: null })).rejects.toThrow();
    expect(delegateLocalTask).toHaveBeenCalledTimes(1);
  });
});
