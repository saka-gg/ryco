import { EnvironmentId, ProjectId, ThreadId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scopeProjectRef, scopeThreadRef } from "../../scoped.ts";
import { createComposerDraftStore, DraftId, type ComposerDraftImage } from "./draftStore.ts";
import type { ComposerDraftStorage } from "./draftSplitStorage.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("project-1");
const OTHER_PROJECT_ID = ProjectId.make("project-2");
const PROJECT_REF = scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID);
const LOGICAL_KEY = "environment-local:project-1";

function createStore(values = new Map<string, string>()) {
  const storage: ComposerDraftStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
    keys: () => values.keys(),
  };
  const store = createComposerDraftStore<ComposerDraftImage>({
    storage,
    flushStorage: () => undefined,
    revokePreviewUrl: () => undefined,
    hydrateImages: () => [],
    readPersistedAttachmentIds: () => [],
  });
  return { values, useStore: store.useComposerDraftStore };
}

function openTaskDraft(
  useStore: ReturnType<typeof createStore>["useStore"],
  draftId: DraftId,
  input: { readonly taskId: string; readonly createdAt: string },
) {
  useStore.getState().createDetachedDraftSession(LOGICAL_KEY, PROJECT_REF, draftId, {
    threadId: ThreadId.make(`thread-${draftId}`),
    createdAt: input.createdAt,
    envMode: "worktree",
    branch: null,
    worktreePath: null,
    localTaskId: input.taskId,
  });
}

describe("task drafts", () => {
  it("keep their task while the draft changes, and drop it with the project", () => {
    const { useStore } = createStore();
    const draftId = DraftId.make("draft-task");
    openTaskDraft(useStore, draftId, { taskId: "task-1", createdAt: "2026-10-18T10:00:00.000Z" });

    useStore.getState().setDraftThreadContext(draftId, {
      envMode: "local",
      worktreeBranchName: "task/fix-login",
    });
    expect(useStore.getState().getDraftSession(draftId)?.localTaskId).toBe("task-1");

    // A task's chats run in its own project: moving the draft unlinks it.
    useStore.getState().moveDraftThreadToProject(draftId, {
      projectRef: scopeProjectRef(ENVIRONMENT_ID, OTHER_PROJECT_ID),
      logicalProjectKey: "environment-local:project-2",
    });
    expect(useStore.getState().getDraftSession(draftId)?.localTaskId).toBeNull();
  });

  it("unlink when the context clears the task", () => {
    const { useStore } = createStore();
    const draftId = DraftId.make("draft-task");
    openTaskDraft(useStore, draftId, { taskId: "task-1", createdAt: "2026-10-18T10:00:00.000Z" });
    useStore.getState().setDraftThreadContext(draftId, { localTaskId: null });
    expect(useStore.getState().getDraftSession(draftId)?.localTaskId).toBeNull();
    expect(useStore.getState().getLocalTaskDraftSession(ENVIRONMENT_ID, "task-1")).toBeNull();
  });

  it("are found by task: the newest unsent one, never one being sent", () => {
    const { useStore } = createStore();
    const older = DraftId.make("draft-older");
    const newer = DraftId.make("draft-newer");
    openTaskDraft(useStore, older, { taskId: "task-1", createdAt: "2026-10-18T10:00:00.000Z" });
    openTaskDraft(useStore, newer, { taskId: "task-1", createdAt: "2026-10-18T11:00:00.000Z" });
    openTaskDraft(useStore, DraftId.make("draft-other"), {
      taskId: "task-2",
      createdAt: "2026-10-18T12:00:00.000Z",
    });

    const store = useStore.getState();
    expect(store.getLocalTaskDraftSession(ENVIRONMENT_ID, "task-1")?.draftId).toBe(newer);
    expect(store.getLocalTaskDraftSession(EnvironmentId.make("remote"), "task-1")).toBeNull();
    expect(store.getLocalTaskDraftSession(ENVIRONMENT_ID, "task-3")).toBeNull();
    // A task whose project changed has no draft there.
    expect(store.getLocalTaskDraftSession(ENVIRONMENT_ID, "task-1", PROJECT_ID)?.draftId).toBe(
      newer,
    );
    expect(store.getLocalTaskDraftSession(ENVIRONMENT_ID, "task-1", OTHER_PROJECT_ID)).toBeNull();

    store.markDraftThreadPromoting(newer, scopeThreadRef(ENVIRONMENT_ID, ThreadId.make("sent")));
    expect(useStore.getState().getLocalTaskDraftSession(ENVIRONMENT_ID, "task-1")?.draftId).toBe(
      older,
    );
  });

  it("keep their task and worktree source across a reload", () => {
    const first = createStore();
    const draftId = DraftId.make("draft-task");
    openTaskDraft(first.useStore, draftId, {
      taskId: "task-1",
      createdAt: "2026-10-18T10:00:00.000Z",
    });
    first.useStore.getState().setPrompt(draftId, "Fix the login loop");
    const source = { kind: "pr", number: 746, label: "#746 Fix login" } as const;
    first.useStore.getState().setDraftThreadContext(draftId, { worktreeSource: source });

    const reloaded = createStore(new Map(first.values));
    expect(reloaded.useStore.getState().getDraftSession(draftId)).toMatchObject({
      localTaskId: "task-1",
      worktreeSource: source,
    });
    expect(
      reloaded.useStore.getState().getLocalTaskDraftSession(ENVIRONMENT_ID, "task-1")?.draftId,
    ).toBe(draftId);
  });
});
