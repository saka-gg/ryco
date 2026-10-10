import {
  CHAT_PROJECT_TITLE_MAX_CHARS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  buildChatDraftTarget,
  CHAT_PROJECT_LABEL,
  chatDraftLogicalProjectKey,
  isChatDraftLogicalProjectKey,
  projectDisplayLabel,
  projectPlaceLabel,
  resolveChatProjectTitleSeed,
  resolveChatsAvailability,
} from "./chatDrafts.ts";
import {
  createComposerDraftStore,
  DraftId,
  isPendingChatDraft,
  type ComposerDraftImage,
} from "./draftStore.ts";
import { buildSendTurnBootstrap } from "./sendEngine.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CHAT_PROJECT_ID = ProjectId.make("chat-project-1");
const REAL_PROJECT_ID = ProjectId.make("project-1");
const DRAFT_ID = DraftId.make("draft-chat-1");
const THREAD_ID = ThreadId.make("thread-chat-1");

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => {
      values.set(name, value);
    },
    removeItem: (name: string) => {
      values.delete(name);
    },
  };
}

function createStore() {
  const storage = createMemoryStorage();
  const store = createComposerDraftStore<ComposerDraftImage>({
    storage,
    flushStorage: () => undefined,
    revokePreviewUrl: () => undefined,
    hydrateImages: () => [],
    readPersistedAttachmentIds: () => [],
  });
  return { storage, useStore: store.useComposerDraftStore };
}

function createChatDraft(useStore: ReturnType<typeof createStore>["useStore"]) {
  const target = buildChatDraftTarget(ENVIRONMENT_ID, CHAT_PROJECT_ID);
  useStore
    .getState()
    .setLogicalProjectDraftThreadId(target.logicalProjectKey, target.projectRef, DRAFT_ID, {
      threadId: THREAD_ID,
      createdAt: "2026-10-08T10:00:00.000Z",
      envMode: "worktree",
      branch: "main",
      pendingChat: true,
    });
}

describe("chat draft helpers", () => {
  it("keys each chat by its own project id and never as a scoped project key", () => {
    expect(chatDraftLogicalProjectKey(CHAT_PROJECT_ID)).toBe("chat:chat-project-1");
    expect(isChatDraftLogicalProjectKey("chat:chat-project-1")).toBe(true);
    expect(isChatDraftLogicalProjectKey("environment-local:project-1")).toBe(false);
    expect(buildChatDraftTarget(ENVIRONMENT_ID, CHAT_PROJECT_ID)).toEqual({
      projectRef: { environmentId: ENVIRONMENT_ID, projectId: CHAT_PROJECT_ID },
      logicalProjectKey: "chat:chat-project-1",
      pendingChat: true,
    });
  });

  it("treats a node without the chats capability as unsupported", () => {
    expect(resolveChatsAvailability(null)).toMatchObject({
      available: false,
      reason: "unsupported",
    });
    expect(resolveChatsAvailability({})).toMatchObject({ available: false, reason: "unsupported" });
  });

  it("reports the node's reason when chats are unavailable", () => {
    const availability = resolveChatsAvailability({
      chats: { available: false, unavailableReason: "inside-git-repository" },
    });
    expect(availability).toMatchObject({ available: false, reason: "inside-git-repository" });
    expect(availability.available ? "" : availability.message).toMatch(/Git repository/);
    expect(
      resolveChatsAvailability({ chats: { available: true, root: "/home/me/.ryco/chats" } }),
    ).toEqual({ available: true, root: "/home/me/.ryco/chats" });
  });

  it("bounds the title seed like the contract and rejects blank text", () => {
    expect(resolveChatProjectTitleSeed("  Plan   a\ntrip  ")).toBe("Plan a trip");
    expect(resolveChatProjectTitleSeed(" \n\t ")).toBeNull();
    const long = resolveChatProjectTitleSeed("x".repeat(CHAT_PROJECT_TITLE_MAX_CHARS + 50));
    expect(long).toHaveLength(CHAT_PROJECT_TITLE_MAX_CHARS);
    // A cut never leaves half of a surrogate pair behind.
    const emoji = resolveChatProjectTitleSeed(`${"a".repeat(CHAT_PROJECT_TITLE_MAX_CHARS - 1)}😀`);
    expect(emoji).toBe("a".repeat(CHAT_PROJECT_TITLE_MAX_CHARS - 1));
  });

  it("names a chat's place No project, never after its folder", () => {
    expect(projectPlaceLabel({ kind: "chat" }, "Plan a trip")).toBe(CHAT_PROJECT_LABEL);
    expect(projectPlaceLabel({ kind: "project" }, "Ryco")).toBe("Ryco");
    // Older nodes and caches carry no kind: a regular project.
    expect(projectPlaceLabel({}, "Ryco")).toBe("Ryco");
    expect(projectPlaceLabel(null, "Removed project")).toBe("Removed project");
  });

  it("names a thread's project after its name, chats No project", () => {
    expect(projectDisplayLabel({ name: "fix-the-login-bug", kind: "chat" }, "Project")).toBe(
      CHAT_PROJECT_LABEL,
    );
    expect(CHAT_PROJECT_LABEL).toBe("No project");
    expect(projectDisplayLabel({ name: " Ryco ", kind: "project" }, "Project")).toBe("Ryco");
    expect(projectDisplayLabel({ name: "Legacy" }, "Project")).toBe("Legacy");
    // An unknown project or a blank name falls back.
    expect(projectDisplayLabel({ name: "  " }, "Project")).toBe("Project");
    expect(projectDisplayLabel(null, "Unknown project")).toBe("Unknown project");
  });
});

describe("composer draft store — chat drafts", () => {
  let harness: ReturnType<typeof createStore>;

  beforeEach(() => {
    harness = createStore();
  });

  it("creates a pending chat draft that always runs locally without a branch", () => {
    createChatDraft(harness.useStore);
    const draft = harness.useStore.getState().getDraftSession(DRAFT_ID);
    expect(draft).toMatchObject({
      projectId: CHAT_PROJECT_ID,
      logicalProjectKey: "chat:chat-project-1",
      pendingChat: true,
      envMode: "local",
      branch: null,
      worktreePath: null,
    });

    harness.useStore.getState().setDraftThreadContext(DRAFT_ID, {
      envMode: "worktree",
      branch: "feature/x",
      worktreePath: "/tmp/worktree",
    });
    expect(harness.useStore.getState().getDraftSession(DRAFT_ID)).toMatchObject({
      pendingChat: true,
      envMode: "local",
      branch: null,
      worktreePath: null,
    });
  });

  it("resumes the latest unsent chat draft of an environment", () => {
    createChatDraft(harness.useStore);
    const store = harness.useStore.getState();
    expect(store.getPendingChatDraftSession(ENVIRONMENT_ID)?.draftId).toBe(DRAFT_ID);
    expect(store.getPendingChatDraftSession(EnvironmentId.make("environment-remote"))).toBeNull();

    store.markDraftThreadPromoting(DRAFT_ID);
    expect(harness.useStore.getState().getPendingChatDraftSession(ENVIRONMENT_ID)).toBeNull();
  });

  it("clears pendingChat when the user picks a real project, keeping the prompt", () => {
    createChatDraft(harness.useStore);
    harness.useStore.getState().setPrompt(DRAFT_ID, "keep me");

    harness.useStore.getState().moveDraftThreadToProject(DRAFT_ID, {
      projectRef: { environmentId: ENVIRONMENT_ID, projectId: REAL_PROJECT_ID },
      logicalProjectKey: "environment-local:project-1",
    });

    const draft = harness.useStore.getState().getDraftSession(DRAFT_ID);
    expect(draft?.projectId).toBe(REAL_PROJECT_ID);
    expect(isPendingChatDraft(draft)).toBe(false);
    expect(harness.useStore.getState().getComposerDraft(DRAFT_ID)?.prompt).toBe("keep me");
    expect(
      harness.useStore.getState().getDraftSessionByLogicalProjectKey("chat:chat-project-1"),
    ).toBeNull();
  });

  it("converts a project draft into a chat draft and drops its branch and worktree", () => {
    harness.useStore
      .getState()
      .setLogicalProjectDraftThreadId(
        "environment-local:project-1",
        { environmentId: ENVIRONMENT_ID, projectId: REAL_PROJECT_ID },
        DRAFT_ID,
        {
          threadId: THREAD_ID,
          branch: "feature/x",
          worktreePath: "/tmp/worktree",
          envMode: "worktree",
        },
      );

    harness.useStore
      .getState()
      .moveDraftThreadToProject(DRAFT_ID, buildChatDraftTarget(ENVIRONMENT_ID, CHAT_PROJECT_ID));

    expect(harness.useStore.getState().getDraftSession(DRAFT_ID)).toMatchObject({
      projectId: CHAT_PROJECT_ID,
      logicalProjectKey: "chat:chat-project-1",
      pendingChat: true,
      envMode: "local",
      branch: null,
      worktreePath: null,
    });
    expect(
      harness.useStore.getState().getDraftSessionByLogicalProjectKey("environment-local:project-1"),
    ).toBeNull();
  });

  it("round-trips a chat draft through persistence without retargeting it", () => {
    createChatDraft(harness.useStore);
    const options = harness.useStore.persist.getOptions();
    const snapshot = JSON.parse(
      JSON.stringify(options.partialize!(harness.useStore.getState())),
    ) as unknown;
    const hydrated = options.merge!(snapshot, harness.useStore.getState());

    expect(hydrated.draftThreadsByThreadKey[DRAFT_ID]).toMatchObject({
      environmentId: ENVIRONMENT_ID,
      projectId: CHAT_PROJECT_ID,
      logicalProjectKey: "chat:chat-project-1",
      pendingChat: true,
      envMode: "local",
    });
    expect(hydrated.logicalProjectDraftThreadKeyByLogicalProjectKey).toEqual({
      "chat:chat-project-1": DRAFT_ID,
    });
  });

  it("decodes drafts persisted before chats as project drafts", () => {
    const options = harness.useStore.persist.getOptions();
    const hydrated = options.merge!(
      {
        draftsByThreadKey: {},
        draftThreadsByThreadKey: {
          [DRAFT_ID]: {
            threadId: THREAD_ID,
            environmentId: ENVIRONMENT_ID,
            projectId: REAL_PROJECT_ID,
            logicalProjectKey: "environment-local:project-1",
            createdAt: "2026-10-08T10:00:00.000Z",
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            envMode: "local",
          },
        },
        logicalProjectDraftThreadKeyByLogicalProjectKey: {
          "environment-local:project-1": DRAFT_ID,
        },
      },
      harness.useStore.getState(),
    );
    expect(isPendingChatDraft(hydrated.draftThreadsByThreadKey[DRAFT_ID])).toBe(false);
    expect(hydrated.draftThreadsByThreadKey[DRAFT_ID]?.branch).toBe("main");
  });
});

describe("send engine — chat bootstrap", () => {
  const baseInput = {
    isLocalDraftThread: true,
    baseBranchForWorktree: "origin/main",
    shouldMaterializeLegacyBranchWorktree: false,
    projectId: CHAT_PROJECT_ID,
    projectCwd: "",
    title: "Plan a trip",
    threadCreateModelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5"),
    runtimeMode: "full-access",
    interactionMode: "default",
    tokenMode: "off",
    activeThreadBranch: "main",
    worktreePath: "/tmp/ignored",
    threadCreatedAt: "2026-10-08T10:00:00.000Z",
  } as const;

  it("creates the chat project and its thread without preparing a worktree", () => {
    const bootstrap = buildSendTurnBootstrap({
      ...baseInput,
      createChatProject: { projectId: CHAT_PROJECT_ID, titleSeed: "Plan a trip" },
    });
    expect(bootstrap).toEqual({
      createChatProject: { projectId: CHAT_PROJECT_ID, titleSeed: "Plan a trip" },
      createThread: {
        projectId: CHAT_PROJECT_ID,
        title: "Plan a trip",
        modelSelection: baseInput.threadCreateModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        tokenMode: "off",
        branch: null,
        worktreePath: null,
        createdAt: "2026-10-08T10:00:00.000Z",
      },
    });
  });

  it("refuses a chat that is required to run in a worktree", () => {
    expect(() =>
      buildSendTurnBootstrap({
        ...baseInput,
        requireWorktree: true,
        createChatProject: { projectId: CHAT_PROJECT_ID, titleSeed: "Plan a trip" },
      }),
    ).toThrow(/chat without a project/);
  });
});
