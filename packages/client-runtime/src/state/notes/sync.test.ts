import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, type NotesApi, type NotesSnapshot } from "@ryco/contracts";

import { projectNotesKey, selectProjectNotesState, useNotesStore } from "./store.ts";
import { isProjectNotesRetained, NOTES_READ_ERROR, retainProjectNotes } from "./sync.ts";

const ENV = EnvironmentId.make("env-notes");
const PROJECT = ProjectId.make("project-notes");
const KEY = projectNotesKey(ENV, PROJECT);

const snapshot = (revision: number): NotesSnapshot => ({
  projectId: PROJECT,
  documents: [
    {
      projectId: PROJECT,
      scope: "project",
      worktreeId: null,
      body: `Revision ${revision}`,
      revision,
      updatedAt: "2026-10-07T00:00:00.000Z",
    },
  ],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const notesState = () => selectProjectNotesState(useNotesStore.getState(), KEY);
const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function makeApi(list: NotesApi["list"]): NotesApi {
  return { list, command: vi.fn() };
}

afterEach(async () => {
  await flushMicrotasks();
  useNotesStore.setState({ byKey: {} });
});

describe("retainProjectNotes", () => {
  it("shares one reader between retainers and reads once on retain", async () => {
    const list = vi.fn().mockResolvedValue(snapshot(10));
    const api = makeApi(list);
    const first = retainProjectNotes(api, ENV, PROJECT);
    const second = retainProjectNotes(api, ENV, PROJECT);
    expect(notesState().status).toBe("loading");
    await flushMicrotasks();

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ projectId: PROJECT });
    expect(notesState()).toMatchObject({ status: "ready", snapshot: snapshot(10), error: null });

    first.release();
    await flushMicrotasks();
    expect(isProjectNotesRetained(ENV, PROJECT)).toBe(true);
    second.release();
    second.release();
    await flushMicrotasks();
    expect(isProjectNotesRetained(ENV, PROJECT)).toBe(false);
    // Memory only: the last release drops the project's notes.
    expect(useNotesStore.getState().byKey[KEY]).toBeUndefined();
  });

  it("forgets the notes on the last release but remembers this client's own revisions", async () => {
    const sync = retainProjectNotes(makeApi(vi.fn().mockResolvedValue(snapshot(10))), ENV, PROJECT);
    await flushMicrotasks();
    useNotesStore.getState().markOwn(KEY, "project", 3);
    sync.release();
    await flushMicrotasks();
    expect(notesState()).toMatchObject({ snapshot: null, status: "idle" });
    expect(notesState().ownRevisions.get("project")).toBe(3);
  });

  it("hands the sync over when a release and a retain land in the same task", async () => {
    const list = vi.fn().mockResolvedValue(snapshot(10));
    const api = makeApi(list);
    retainProjectNotes(api, ENV, PROJECT).release();
    const next = retainProjectNotes(api, ENV, PROJECT);
    await flushMicrotasks();
    expect(isProjectNotesRetained(ENV, PROJECT)).toBe(true);
    expect(notesState().status).toBe("ready");
    next.release();
  });

  it("lets a command reply supersede a read already in flight", async () => {
    const read = deferred<NotesSnapshot>();
    const list = vi.fn().mockReturnValueOnce(read.promise);
    const sync = retainProjectNotes(makeApi(list), ENV, PROJECT);

    sync.applySnapshot(snapshot(20));
    read.resolve(snapshot(10));
    await flushMicrotasks();

    expect(notesState().snapshot).toEqual(snapshot(20));
    sync.release();
  });

  it("keeps the last snapshot through a failed refresh and reports the error", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce(snapshot(10))
      .mockRejectedValueOnce(new Error("offline"));
    const sync = retainProjectNotes(makeApi(list), ENV, PROJECT);
    await flushMicrotasks();
    await sync.refresh();

    expect(notesState()).toMatchObject({
      status: "error",
      error: NOTES_READ_ERROR,
      snapshot: snapshot(10),
    });
    sync.release();
  });

  it("swaps the shared reader when retained through a new connection", async () => {
    const stale = deferred<NotesSnapshot>();
    const oldApi = makeApi(vi.fn().mockReturnValueOnce(stale.promise));
    const newList = vi.fn().mockResolvedValue(snapshot(30));
    const first = retainProjectNotes(oldApi, ENV, PROJECT);
    const second = retainProjectNotes(makeApi(newList), ENV, PROJECT);
    stale.resolve(snapshot(10));
    await flushMicrotasks();

    expect(notesState().snapshot).toEqual(snapshot(30));
    // The older handle now refreshes through the new connection too.
    await first.refresh();
    expect(newList).toHaveBeenCalledTimes(2);
    first.release();
    second.release();
  });

  it("installs refresh triggers once per project, however many surfaces retain it", async () => {
    const list = vi.fn().mockResolvedValue(snapshot(10));
    const api = makeApi(list);
    let fire = () => {};
    const stop = vi.fn();
    const triggers = vi.fn((refresh: () => void) => {
      fire = refresh;
      return stop;
    });
    const first = retainProjectNotes(api, ENV, PROJECT, triggers);
    const second = retainProjectNotes(api, ENV, PROJECT, triggers);
    await flushMicrotasks();
    expect(triggers).toHaveBeenCalledTimes(1);

    fire();
    await flushMicrotasks();
    expect(list).toHaveBeenCalledTimes(2);

    first.release();
    await flushMicrotasks();
    expect(stop).not.toHaveBeenCalled();
    second.release();
    await flushMicrotasks();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
