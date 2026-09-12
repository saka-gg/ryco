import {
  DEFAULT_MODEL,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DraftId } from "../composerDraftStore";
import type { ChatMessage } from "../types";
import {
  buildOutgoingTurnAttachments,
  buildSendTurnBootstrap,
  executeChatSendTurn,
  rollbackSendTurn,
} from "./executeChatSendTurn";

// ---------------------------------------------------------------------------
// buildOutgoingTurnAttachments
// ---------------------------------------------------------------------------

describe("buildOutgoingTurnAttachments", () => {
  const NOW = Date.parse("2026-09-01T00:00:00.000Z");

  function makeFileAttachment(overrides: Record<string, unknown> = {}) {
    return {
      type: "file" as const,
      id: "att-file-1",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      previewUrl: "",
      file: null,
      ...overrides,
    };
  }

  it("dispatches uploaded file attachments by token without inline bytes", async () => {
    const attachments = await buildOutgoingTurnAttachments(
      [
        makeFileAttachment({
          uploadToken: "upload-token-1",
          expiresAt: "2026-09-01T00:05:00.000Z",
        }),
      ],
      { nowMs: NOW },
    );
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      type: "file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      uploadToken: "upload-token-1",
    });
    expect(attachments[0]).not.toHaveProperty("dataUrl");
  });

  it("falls back to inline dataUrl for legacy files and always for images", async () => {
    const attachments = await buildOutgoingTurnAttachments(
      [
        makeFileAttachment({ file: new File(["hello world"], "notes.txt") }),
        {
          type: "image" as const,
          id: "att-image-1",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: 4,
          previewUrl: "blob:preview",
          file: new File(["abcd"], "shot.png", { type: "image/png" }),
        },
      ],
      { nowMs: NOW },
    );
    expect(attachments[0]).toMatchObject({ type: "file", name: "notes.txt" });
    expect(attachments[0]?.dataUrl).toContain("data:application/octet-stream;base64,");
    expect(attachments[0]).not.toHaveProperty("uploadToken");
    expect(attachments[1]).toMatchObject({ type: "image", name: "shot.png" });
    expect(attachments[1]?.dataUrl).toContain("data:image/png;base64,");
  });

  it("does not dispatch an expired upload token", async () => {
    await expect(
      buildOutgoingTurnAttachments(
        [
          makeFileAttachment({
            uploadToken: "stale-token",
            expiresAt: "2026-08-31T23:00:00.000Z",
          }),
        ],
        { nowMs: NOW },
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// rollbackSendTurn
// ---------------------------------------------------------------------------

describe("rollbackSendTurn", () => {
  function makeRefs() {
    return {
      promptRef: { current: "" },
      composerImagesRef: { current: [] as unknown[] },
      composerTerminalContextsRef: { current: [] as unknown[] },
      sendInFlightRef: { current: false },
    };
  }

  function makeDraftDeps() {
    return {
      composerDraftTarget: DraftId.make("draft-1"),
      environmentId: EnvironmentId.make("env-1"),
      clearComposerDraftContent: vi.fn(),
      setComposerDraftTokenMode: vi.fn(),
      setComposerDraftPrompt: vi.fn(),
      addComposerDraftImages: vi.fn(),
      removeComposerDraftImage: vi.fn(),
      setComposerDraftTerminalContexts: vi.fn(),
      setDraftThreadContext: vi.fn(),
    };
  }

  it("restores prompt, images, and terminal contexts when composer is empty", () => {
    const refs = makeRefs();
    const draft = makeDraftDeps();
    const resetCursorState = vi.fn();
    const composerHandle = {
      readComposer: () => ({ resetCursorState }) as never,
    };
    const setOptimisticUserMessages = vi.fn();

    const promptSnapshot = "Fix the bug";
    const imagesSnapshot = [
      {
        id: "img-1",
        name: "shot.png",
        previewUrl: "data:image/png;base64,abc",
        file: new File([], "shot.png"),
        mimeType: "image/png",
        sizeBytes: 100,
      },
    ] as never[];
    const terminalContextsSnapshot = [
      {
        id: "ctx-1",
        text: "some output",
        threadId: "t1",
        terminalId: "default",
        terminalLabel: "Terminal",
        lineStart: 1,
        lineEnd: 1,
        createdAt: "2026-06-14T00:00:00Z",
      },
    ] as never[];

    rollbackSendTurn({
      refs: refs as never,
      composerHandle,
      dispatch: { setOptimisticUserMessages },
      draft,
      messageId: "msg-1",
      promptSnapshot,
      imagesSnapshot,
      terminalContextsSnapshot,
    });

    expect(refs.promptRef.current).toBe("Fix the bug");
    expect(refs.composerTerminalContextsRef.current).toEqual(terminalContextsSnapshot);
    expect(draft.setComposerDraftPrompt).toHaveBeenCalledWith(
      DraftId.make("draft-1"),
      "Fix the bug",
    );
    expect(draft.addComposerDraftImages).toHaveBeenCalledTimes(1);
    expect(draft.setComposerDraftTerminalContexts).toHaveBeenCalledWith(
      DraftId.make("draft-1"),
      terminalContextsSnapshot,
    );
    expect(resetCursorState).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Fix the bug", detectTrigger: true }),
    );
    expect(setOptimisticUserMessages).toHaveBeenCalledTimes(1);
  });

  it("skips rollback when the composer is not empty (user typed new content)", () => {
    const refs = makeRefs();
    refs.promptRef.current = "New content";
    const draft = makeDraftDeps();
    const composerHandle = { readComposer: () => null };
    const setOptimisticUserMessages = vi.fn();

    rollbackSendTurn({
      refs: refs as never,
      composerHandle,
      dispatch: { setOptimisticUserMessages },
      draft,
      messageId: "msg-1",
      promptSnapshot: "Old prompt",
      imagesSnapshot: [],
      terminalContextsSnapshot: [],
    });

    expect(setOptimisticUserMessages).not.toHaveBeenCalled();
    expect(draft.setComposerDraftPrompt).not.toHaveBeenCalled();
  });

  it("removes the optimistic message from the list", () => {
    const refs = makeRefs();
    const draft = makeDraftDeps();
    const composerHandle = { readComposer: () => null };
    let captured: ChatMessage[] = [];
    const setOptimisticUserMessages = vi.fn(
      (updater: (existing: ChatMessage[]) => ChatMessage[]) => {
        captured = updater([
          {
            id: MessageId.make("msg-1"),
            role: "user",
            text: "Hello",
            streaming: false,
            createdAt: "2026-01-01T00:00:00Z",
          },
          {
            id: MessageId.make("msg-2"),
            role: "user",
            text: "World",
            streaming: false,
            createdAt: "2026-01-01T00:01:00Z",
          },
        ]);
      },
    );

    rollbackSendTurn({
      refs: refs as never,
      composerHandle,
      dispatch: { setOptimisticUserMessages },
      draft,
      messageId: "msg-1",
      promptSnapshot: "Hello",
      imagesSnapshot: [],
      terminalContextsSnapshot: [],
    });

    expect(captured).toEqual([
      {
        id: MessageId.make("msg-2"),
        role: "user",
        text: "World",
        streaming: false,
        createdAt: "2026-01-01T00:01:00Z",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// buildSendTurnBootstrap
// ---------------------------------------------------------------------------

describe("buildSendTurnBootstrap", () => {
  const baseInput = {
    projectId: ProjectId.make("project-1"),
    projectCwd: "/tmp/project",
    title: "Fix something",
    threadCreateModelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: DEFAULT_MODEL,
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    tokenMode: "balanced" as const,
    activeThreadBranch: "main",
    worktreePath: null,
    threadCreatedAt: "2026-06-14T00:00:00Z",
  };

  it("returns undefined when neither draft nor worktree", () => {
    expect(
      buildSendTurnBootstrap({
        ...baseInput,
        isLocalDraftThread: false,
        baseBranchForWorktree: null,
        shouldMaterializeLegacyBranchWorktree: false,
      }),
    ).toBeUndefined();
  });

  it("returns createThread for local draft threads", () => {
    const result = buildSendTurnBootstrap({
      ...baseInput,
      isLocalDraftThread: true,
      baseBranchForWorktree: null,
      shouldMaterializeLegacyBranchWorktree: false,
    });

    expect(result).toBeDefined();
    expect(result?.createThread).toEqual({
      projectId: baseInput.projectId,
      title: baseInput.title,
      modelSelection: baseInput.threadCreateModelSelection,
      runtimeMode: baseInput.runtimeMode,
      interactionMode: baseInput.interactionMode,
      tokenMode: baseInput.tokenMode,
      branch: "main",
      worktreePath: null,
      createdAt: baseInput.threadCreatedAt,
    });
    expect(result?.prepareWorktree).toBeUndefined();
  });

  it("returns prepareWorktree with generated branch for new worktrees", () => {
    const result = buildSendTurnBootstrap({
      ...baseInput,
      isLocalDraftThread: true,
      baseBranchForWorktree: "main",
      shouldMaterializeLegacyBranchWorktree: false,
    });

    expect(result?.prepareWorktree?.projectCwd).toBe("/tmp/project");
    expect(result?.prepareWorktree?.baseBranch).toBe("main");
    expect(result?.prepareWorktree?.branch).toBeDefined();
    expect(result?.runSetupScript).toBe(true);
  });

  it("skips generated branch name for legacy worktree materialization", () => {
    const result = buildSendTurnBootstrap({
      ...baseInput,
      isLocalDraftThread: false,
      baseBranchForWorktree: "feature/foo",
      shouldMaterializeLegacyBranchWorktree: true,
    });

    expect(result?.prepareWorktree?.baseBranch).toBe("feature/foo");
    expect(result?.prepareWorktree?.branch).toBeUndefined();
    expect(result?.createThread).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// executeChatSendTurn — scroll-to-bottom on send (feature 01)
// ---------------------------------------------------------------------------

describe("executeChatSendTurn", () => {
  it("scrolls to the bottom before and after appending the optimistic message", async () => {
    // The first scroll arms live-follow; the second reaches the newly rendered row.
    const order: string[] = [];
    const scrollToEndBeforeOptimistic = vi.fn(async () => {
      order.push("scroll");
    });
    const scrollToEndAfterOptimistic = vi.fn(() => {
      order.push("scroll-after");
    });
    const setOptimisticUserMessages = vi.fn(() => {
      order.push("optimistic");
    });
    const dispatchCommand = vi.fn(async () => {
      order.push("dispatch");
    });

    await executeChatSendTurn({
      composer: {
        prompt: "Hello there",
        trimmedPrompt: "Hello there",
        images: [],
        sendableTerminalContexts: [],
        sourceControlContexts: [],
        selectedProvider: ProviderDriverKind.make("codex"),
        selectedModel: DEFAULT_MODEL,
        selectedProviderModels: [],
        selectedPromptEffort: null,
        selectedModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
        expiredTerminalContextCount: 0,
      },
      thread: {
        threadId: ThreadId.make("thread-1"),
        isFirstMessage: false,
        isServerThread: true,
        isLocalDraftThread: false,
        activeThreadBranch: null,
        worktreePath: null,
        createdAt: "2026-06-14T00:00:00Z",
        projectId: ProjectId.make("project-1"),
      },
      worktree: {
        shouldMaterializeLegacyBranchWorktree: false,
        baseBranchForWorktree: null,
        shouldCreateWorktree: false,
      },
      settings: {
        runtimeMode: "full-access",
        interactionMode: "default",
        tokenMode: "balanced",
      },
      project: {
        projectId: ProjectId.make("project-1"),
        projectCwd: "/tmp/project",
        defaultModelSelection: null,
      },
      scroll: { scrollToEndBeforeOptimistic, scrollToEndAfterOptimistic },
      draft: {
        composerDraftTarget: DraftId.make("draft-1"),
        environmentId: EnvironmentId.make("env-1"),
        clearComposerDraftContent: vi.fn(),
        setComposerDraftTokenMode: vi.fn(),
        setComposerDraftPrompt: vi.fn(),
        addComposerDraftImages: vi.fn(),
        removeComposerDraftImage: vi.fn(),
        setComposerDraftTerminalContexts: vi.fn(),
        setDraftThreadContext: vi.fn(),
      },
      dispatch: {
        api: { orchestration: { dispatchCommand } } as never,
        beginLocalDispatch: vi.fn(),
        resetLocalDispatch: vi.fn(),
        setOptimisticUserMessages,
        setThreadError: vi.fn(),
      },
      refs: {
        promptRef: { current: "" },
        composerImagesRef: { current: [] },
        composerTerminalContextsRef: { current: [] },
        sendInFlightRef: { current: false },
      } as never,
      sourceControl: { fetcher: vi.fn(async (ctx) => ctx) },
      persistSettings: {
        persistThreadSettingsForNextTurn: vi.fn(async () => {}),
      },
      composerHandle: { readComposer: () => null },
      formatOutgoingPrompt: ({ text }) => text,
    });

    expect(scrollToEndBeforeOptimistic).toHaveBeenCalledTimes(1);
    expect(scrollToEndAfterOptimistic).toHaveBeenCalledTimes(1);
    expect(setOptimisticUserMessages).toHaveBeenCalledTimes(1);
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["scroll", "optimistic", "scroll-after", "dispatch"]);
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.turn.start" }),
    );
  });

  it.each([
    { name: "staged target", restorePrompt: undefined },
    { name: "goal command", restorePrompt: "/goal Continue with Claude" },
  ])("keeps the $name retryable after immediate rejection", async ({ restorePrompt }) => {
    const targetSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-4-6",
    };
    const dispatchCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error("handoff rejected: thread became busy"))
      .mockResolvedValue({ sequence: 2 });
    const setComposerDraftPrompt = vi.fn();
    const refs = {
      promptRef: { current: "Continue with Claude" },
      composerImagesRef: { current: [] },
      composerTerminalContextsRef: { current: [] },
      sendInFlightRef: { current: false },
    };
    const persistThreadSettingsForNextTurn = vi.fn(async (_settings: unknown) => {});
    const input: Parameters<typeof executeChatSendTurn>[0] = {
      composer: {
        prompt: "Continue with Claude",
        ...(restorePrompt
          ? { promptForRestore: restorePrompt, goal: { objective: "Continue with Claude" } }
          : {}),
        trimmedPrompt: "Continue with Claude",
        images: [],
        sendableTerminalContexts: [],
        sourceControlContexts: [],
        selectedProvider: ProviderDriverKind.make("claudeAgent"),
        selectedModel: "claude-sonnet-4-6",
        selectedProviderModels: [],
        selectedPromptEffort: null,
        selectedModelSelection: targetSelection,
        expiredTerminalContextCount: 0,
      },
      thread: {
        threadId: ThreadId.make("thread-handoff"),
        isFirstMessage: false,
        isServerThread: true,
        isLocalDraftThread: false,
        activeThreadBranch: null,
        worktreePath: null,
        createdAt: "2026-08-04T00:00:00Z",
        projectId: ProjectId.make("project-1"),
      },
      worktree: {
        shouldMaterializeLegacyBranchWorktree: false,
        baseBranchForWorktree: null,
        shouldCreateWorktree: false,
      },
      settings: {
        runtimeMode: "full-access",
        interactionMode: "default",
        tokenMode: "balanced",
      },
      project: {
        projectId: ProjectId.make("project-1"),
        projectCwd: "/tmp/project",
        defaultModelSelection: null,
      },
      scroll: {
        scrollToEndBeforeOptimistic: vi.fn(async () => {}),
        scrollToEndAfterOptimistic: vi.fn(() => {}),
      },
      draft: {
        composerDraftTarget: DraftId.make("draft-handoff"),
        environmentId: EnvironmentId.make("env-1"),
        clearComposerDraftContent: vi.fn(),
        setComposerDraftTokenMode: vi.fn(),
        setComposerDraftPrompt,
        addComposerDraftImages: vi.fn(),
        removeComposerDraftImage: vi.fn(),
        setComposerDraftTerminalContexts: vi.fn(),
        setDraftThreadContext: vi.fn(),
      },
      dispatch: {
        api: { orchestration: { dispatchCommand } } as never,
        beginLocalDispatch: vi.fn(),
        resetLocalDispatch: vi.fn(),
        setOptimisticUserMessages: vi.fn(),
        setThreadError: vi.fn(),
      },
      refs,
      sourceControl: { fetcher: vi.fn(async (ctx) => ctx) },
      persistSettings: { persistThreadSettingsForNextTurn },
      composerHandle: { readComposer: () => null },
      formatOutgoingPrompt: ({ text }) => text,
    };

    await executeChatSendTurn(input);

    expect(refs.promptRef.current).toBe(restorePrompt ?? "Continue with Claude");
    expect(setComposerDraftPrompt).toHaveBeenCalledWith(
      DraftId.make("draft-handoff"),
      restorePrompt ?? "Continue with Claude",
    );
    expect(input.composer.selectedModelSelection).toEqual(targetSelection);
    expect(persistThreadSettingsForNextTurn.mock.calls[0]?.[0]).not.toHaveProperty(
      "modelSelection",
    );

    await executeChatSendTurn(input);

    const turnStarts = dispatchCommand.mock.calls.map(([command]) => command);
    expect(turnStarts).toHaveLength(2);
    expect(turnStarts).toEqual([
      expect.objectContaining({
        type: "thread.turn.start",
        modelSelection: targetSelection,
      }),
      expect.objectContaining({
        type: "thread.turn.start",
        modelSelection: targetSelection,
      }),
    ]);

    expect(dispatchCommand).toHaveBeenCalledTimes(2);
    expect(persistThreadSettingsForNextTurn).toHaveBeenCalledTimes(2);
    expect(refs.promptRef.current).toBe("");
    expect(input.composer.selectedModelSelection).toEqual(targetSelection);
  });
});

function makeSendInput() {
  const targetSelection = { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL };
  const dispatchCommand = vi.fn(async (_command: unknown) => ({ sequence: 1 }));
  const setComposerDraftPrompt = vi.fn();
  const persistThreadSettingsForNextTurn = vi.fn(async () => {});
  const refs = {
    promptRef: { current: "My next draft" },
    composerImagesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    sendInFlightRef: { current: false },
  };
  const input: Parameters<typeof executeChatSendTurn>[0] = {
    composer: {
      prompt: "Continue with Claude",

      trimmedPrompt: "Continue with Claude",
      images: [],
      sendableTerminalContexts: [],
      sourceControlContexts: [],
      selectedProvider: ProviderDriverKind.make("claudeAgent"),
      selectedModel: "claude-sonnet-4-6",
      selectedProviderModels: [],
      selectedPromptEffort: null,
      selectedModelSelection: targetSelection,
      expiredTerminalContextCount: 0,
    },
    thread: {
      threadId: ThreadId.make("thread-handoff"),
      isFirstMessage: false,
      isServerThread: true,
      isLocalDraftThread: false,
      activeThreadBranch: null,
      worktreePath: null,
      createdAt: "2026-08-04T00:00:00Z",
      projectId: ProjectId.make("project-1"),
    },
    worktree: {
      shouldMaterializeLegacyBranchWorktree: false,
      baseBranchForWorktree: null,
      shouldCreateWorktree: false,
    },
    settings: {
      runtimeMode: "full-access",
      interactionMode: "default",
      tokenMode: "balanced",
    },
    project: {
      projectId: ProjectId.make("project-1"),
      projectCwd: "/tmp/project",
      defaultModelSelection: null,
    },
    scroll: {
      scrollToEndBeforeOptimistic: vi.fn(async () => {}),
      scrollToEndAfterOptimistic: vi.fn(() => {}),
    },
    draft: {
      composerDraftTarget: DraftId.make("draft-handoff"),
      environmentId: EnvironmentId.make("env-1"),
      clearComposerDraftContent: vi.fn(),
      setComposerDraftTokenMode: vi.fn(),
      setComposerDraftPrompt,
      addComposerDraftImages: vi.fn(),
      removeComposerDraftImage: vi.fn(),
      setComposerDraftTerminalContexts: vi.fn(),
      setDraftThreadContext: vi.fn(),
    },
    dispatch: {
      api: { orchestration: { dispatchCommand } } as never,
      beginLocalDispatch: vi.fn(),
      resetLocalDispatch: vi.fn(),
      setOptimisticUserMessages: vi.fn(),
      setThreadError: vi.fn(),
    },
    refs,
    sourceControl: { fetcher: vi.fn(async (ctx) => ctx) },
    persistSettings: { persistThreadSettingsForNextTurn },
    composerHandle: { readComposer: () => null },
    formatOutgoingPrompt: ({ text }) => text,
  };
  return { input, dispatchCommand };
}

describe("queued send draft ownership", () => {
  it.each([false, true])(
    "preserves the live draft and queued attachments (rejected: %s)",
    async (reject) => {
      const { input, dispatchCommand } = makeSendInput();
      input.preserveComposerDraft = true;
      input.messageId = MessageId.make("queued-1");
      input.composer.images = [
        {
          id: "queued-file",
          type: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 4,
          file: null,
          previewUrl: "",
          uploadToken: "retained-upload",
          expiresAt: "2099-01-01T00:00:00Z",
        },
      ];
      const draftImage = { ...input.composer.images[0]!, id: "draft-file" };
      input.refs.composerImagesRef.current = [draftImage];
      if (reject) dispatchCommand.mockRejectedValueOnce(new Error("connection interrupted"));

      const accepted = await executeChatSendTurn(input);
      expect.soft(input.refs.promptRef.current).toBe("My next draft");
      expect.soft(accepted).toBe(!reject);
      expect(input.refs.composerImagesRef.current).toEqual([draftImage]);
      expect(input.draft.clearComposerDraftContent).not.toHaveBeenCalled();
      expect(input.draft.setComposerDraftTokenMode).not.toHaveBeenCalled();
      expect(input.draft.setComposerDraftPrompt).not.toHaveBeenCalled();
      expect(input.draft.addComposerDraftImages).not.toHaveBeenCalled();
      expect(input.composer.images[0]?.uploadToken).toBe("retained-upload");
      expect(input.refs.sendInFlightRef.current).toBe(false);
      expect(dispatchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.objectContaining({
            messageId: "queued-1",
            attachments: [expect.objectContaining({ uploadToken: "retained-upload" })],
          }),
        }),
      );
    },
  );

  it("releases send ownership when pre-send scrolling rejects without consuming the draft", async () => {
    const { input, dispatchCommand } = makeSendInput();
    input.scroll.scrollToEndBeforeOptimistic = async () => {
      throw new Error("unmounted list");
    };
    expect(await executeChatSendTurn(input)).toBe(false);
    expect(input.refs.sendInFlightRef.current).toBe(false);
    expect(input.refs.promptRef.current).toBe("My next draft");
    expect(input.dispatch.resetLocalDispatch).toHaveBeenCalledOnce();
    expect(input.draft.clearComposerDraftContent).not.toHaveBeenCalled();
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it("preserves edits made while a direct send is preparing", async () => {
    const { input } = makeSendInput();
    input.refs.promptRef.current = input.composer.prompt;
    input.scroll.scrollToEndBeforeOptimistic = async () => {
      input.refs.promptRef.current = "Typed during preparation";
    };
    expect(await executeChatSendTurn(input)).toBe(true);
    expect(input.refs.promptRef.current).toBe("Typed during preparation");
    expect(input.draft.clearComposerDraftContent).not.toHaveBeenCalled();
  });

  it("removes consumed uploads after preserving a prompt edit so the next send succeeds", async () => {
    const { input, dispatchCommand } = makeSendInput();
    const uploaded = {
      id: "sent-upload",
      type: "file" as const,
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      file: null,
      previewUrl: "",
      uploadToken: "single-use",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    input.composer.images = [uploaded];
    input.refs.composerImagesRef.current = [uploaded];
    input.refs.promptRef.current = input.composer.prompt;
    const used = new Set<string>();
    dispatchCommand.mockImplementation(async (value) => {
      const command = value as {
        type: string;
        message: { attachments: Array<{ uploadToken?: string }> };
      };
      if (command.type === "thread.turn.start")
        for (const attachment of command.message.attachments) {
          if (!attachment.uploadToken) continue;
          if (used.has(attachment.uploadToken)) throw new Error("already-used");
          used.add(attachment.uploadToken);
        }
      return { sequence: 1 };
    });
    input.scroll.scrollToEndBeforeOptimistic = async () => {
      input.refs.promptRef.current = "Next prompt";
    };
    expect(await executeChatSendTurn(input)).toBe(true);
    expect(input.refs.promptRef.current).toBe("Next prompt");
    expect(input.draft.removeComposerDraftImage).toHaveBeenCalledWith(
      input.draft.composerDraftTarget,
      uploaded.id,
    );
    const next = {
      ...input,
      composer: {
        ...input.composer,
        prompt: "Next prompt",
        trimmedPrompt: "Next prompt",
        images: input.refs.composerImagesRef.current,
      },
      scroll: { ...input.scroll, scrollToEndBeforeOptimistic: async () => {} },
    };
    expect(await executeChatSendTurn(next)).toBe(true);
    expect(input.refs.composerImagesRef.current).toEqual([]);
  });

  it.each([false, true])(
    "keeps new and renewed attachments during direct prep (rejected: %s)",
    async (reject) => {
      const { input, dispatchCommand } = makeSendInput();
      const sent = {
        id: "sent",
        type: "file" as const,
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        file: null,
        previewUrl: "",
        uploadToken: "old",
        expiresAt: "2099-01-01T00:00:00Z",
      };
      const replaced = { ...sent, id: "replaced" };
      const renewed = { ...replaced, uploadToken: "fresh" };
      const added = { ...sent, id: "new", uploadToken: "new" };
      input.composer.images = [sent, replaced];
      input.refs.composerImagesRef.current = input.composer.images;
      input.scroll.scrollToEndBeforeOptimistic = async () => {
        input.refs.promptRef.current = "Edited";
        input.refs.composerImagesRef.current = [sent, renewed, added];
      };
      if (reject) dispatchCommand.mockRejectedValueOnce(new Error("rejected"));
      expect(await executeChatSendTurn(input)).toBe(!reject);
      expect(input.refs.promptRef.current).toBe("Edited");
      expect(input.refs.composerImagesRef.current).toEqual(
        reject ? [sent, renewed, added] : [renewed, added],
      );
      expect(input.draft.removeComposerDraftImage).toHaveBeenCalledTimes(reject ? 0 : 1);
    },
  );

  it("keeps an expired queued file recoverable without consuming the new draft", async () => {
    const { input, dispatchCommand } = makeSendInput();
    input.preserveComposerDraft = true;
    input.composer.images = [
      {
        id: "expired",
        type: "file",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 4,
        file: null,
        previewUrl: "",
        uploadToken: "expired-token",
        expiresAt: "2000-01-01T00:00:00Z",
      },
    ];
    expect(await executeChatSendTurn(input)).toBe(false);
    expect(input.refs.promptRef.current).toBe("My next draft");
    expect(input.refs.sendInFlightRef.current).toBe(false);
    expect(input.draft.clearComposerDraftContent).not.toHaveBeenCalled();
    expect(dispatchCommand).not.toHaveBeenCalled();
  });
});
