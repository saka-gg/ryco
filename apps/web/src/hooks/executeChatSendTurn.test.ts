import {
  DEFAULT_MODEL,
  EnvironmentId,
  MessageId,
  OrchestrationDispatchCommandError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  ThreadId,
  WORKTREE_SETUP_CANCELLED_MESSAGE,
} from "@ryco/contracts";
import { useWorktreeLaunchStore } from "@ryco/client-runtime/state/worktree-setup";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readWorktreeLaunchRetry } from "../components/chat/worktreeLaunch/worktreeLaunchSend";

import { DraftId } from "../composerDraftStore";
import {
  readAndRememberProjectPreferences,
  resetNewDraftDefaultsCacheForTests,
} from "./newDraftDefaults";
import { claudeCacheReviewPresentation } from "../components/chat/ClaudeCacheReview";
import { confirmStopBackgroundWorkDialog } from "../components/chat/StopBackgroundWorkDialog";
import { toastManager } from "../components/ui/toast";
import type { ChatMessage } from "../types";
import {
  buildOutgoingTurnAttachments,
  buildSendTurnBootstrap,
  executeChatSendTurn,
  rollbackSendTurn,
} from "./executeChatSendTurn";

// Hosted Hub mode and the target's connection, for the hosted worktree path.
const hostedTarget = vi.hoisted(() => ({
  hostedHubMode: false,
  connection: null as null | {
    readonly config: { readonly read: () => unknown };
    readonly shellSnapshotReadiness: { readonly read: () => unknown };
  },
}));
vi.mock("../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../env")>()),
  isHostedHubMode: () => hostedTarget.hostedHubMode,
}));
vi.mock("../environments/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../environments/runtime")>();
  // Forwards to the live module (a copy would freeze bindings that a circular
  // import has not initialized yet); no connection is registered in these
  // tests unless one stands in.
  return new Proxy(actual, {
    get: (target, key, receiver) =>
      key === "readEnvironmentConnection"
        ? () => hostedTarget.connection
        : Reflect.get(target, key, receiver),
  });
});

// Pass-through spy: every test still runs the real send engine.
const { commitSendTurnDispatchSpy } = vi.hoisted(() => ({
  commitSendTurnDispatchSpy: { current: null as null | ReturnType<typeof vi.fn> },
}));
vi.mock("@ryco/client-runtime/state/composer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ryco/client-runtime/state/composer")>();
  const spy = vi.fn(actual.commitSendTurnDispatch);
  commitSendTurnDispatchSpy.current = spy;
  return { ...actual, commitSendTurnDispatch: spy };
});

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
      composerFileReferencesRef: { current: [] as unknown[] },
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
      setComposerDraftFileReferences: vi.fn(),
      setDraftThreadContext: vi.fn(),
      readComposerDraftContent: vi.fn(() => null),
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
      fileReferencesSnapshot: [],
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
      fileReferencesSnapshot: [],
    });

    expect(setOptimisticUserMessages).not.toHaveBeenCalled();
    expect(draft.setComposerDraftPrompt).not.toHaveBeenCalled();
  });

  it("restores into the thread's stored draft alone once the view shows another thread", () => {
    const refs = makeRefs();
    // The view's live composer now belongs to the other thread, which is empty.
    const draft = makeDraftDeps();
    const resetCursorState = vi.fn();
    const setOptimisticUserMessages = vi.fn();

    rollbackSendTurn({
      refs: refs as never,
      composerHandle: {
        readComposer: () => ({ resetCursorState }) as never,
        showsSendThread: () => false,
      },
      dispatch: { setOptimisticUserMessages },
      draft,
      messageId: "msg-1",
      promptSnapshot: "Fix the bug",
      imagesSnapshot: [],
      terminalContextsSnapshot: [],
      fileReferencesSnapshot: [],
    });

    expect(draft.setComposerDraftPrompt).toHaveBeenCalledWith(
      DraftId.make("draft-1"),
      "Fix the bug",
    );
    expect(refs.promptRef.current).toBe("");
    expect(resetCursorState).not.toHaveBeenCalled();
    expect(setOptimisticUserMessages).not.toHaveBeenCalled();
  });

  it("restores the thread's draft even while the other thread's composer has content", () => {
    const refs = makeRefs();
    refs.promptRef.current = "typed in the other thread";
    const draft = makeDraftDeps();

    rollbackSendTurn({
      refs: refs as never,
      composerHandle: { readComposer: () => null, showsSendThread: () => false },
      dispatch: { setOptimisticUserMessages: vi.fn() },
      draft,
      messageId: "msg-1",
      promptSnapshot: "Fix the bug",
      imagesSnapshot: [],
      terminalContextsSnapshot: [],
      fileReferencesSnapshot: [],
    });

    expect(draft.setComposerDraftPrompt).toHaveBeenCalledWith(
      DraftId.make("draft-1"),
      "Fix the bug",
    );
    expect(refs.promptRef.current).toBe("typed in the other thread");
  });

  it("leaves the thread's stored draft alone when it has content again", () => {
    const refs = makeRefs();
    const draft = {
      ...makeDraftDeps(),
      readComposerDraftContent: vi.fn(() => ({
        prompt: "written since",
        images: [],
        terminalContexts: [],
        fileReferences: [],
      })),
    };

    rollbackSendTurn({
      refs: refs as never,
      composerHandle: { readComposer: () => null, showsSendThread: () => false },
      dispatch: { setOptimisticUserMessages: vi.fn() },
      draft,
      messageId: "msg-1",
      promptSnapshot: "Fix the bug",
      imagesSnapshot: [],
      terminalContextsSnapshot: [],
      fileReferencesSnapshot: [],
    });

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
      fileReferencesSnapshot: [],
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
    // Omission lets the server resolve current project setup preferences.
    expect(result?.runSetupScript).toBeUndefined();
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
  it("arms the end follow, shows the message and clears the composer before anything else runs", async () => {
    // Nothing waits for the list: the message and the clear land in the same
    // task as the arm, and the follow-up scroll is never awaited.
    const order: string[] = [];
    const armEndFollowBeforeOptimistic = vi.fn(() => {
      order.push("arm");
      queueMicrotask(() => order.push("microtask"));
    });
    const scrollToEndAfterOptimistic = vi.fn(() => {
      order.push("scroll-after");
    });
    const setOptimisticUserMessages = vi.fn(() => {
      order.push("optimistic");
    });
    const clearComposerDraftContent = vi.fn(() => {
      order.push("clear");
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
      scroll: { armEndFollowBeforeOptimistic, scrollToEndAfterOptimistic },
      draft: {
        composerDraftTarget: DraftId.make("draft-1"),
        environmentId: EnvironmentId.make("env-1"),
        clearComposerDraftContent,
        setComposerDraftTokenMode: vi.fn(),
        setComposerDraftPrompt: vi.fn(),
        addComposerDraftImages: vi.fn(),
        removeComposerDraftImage: vi.fn(),
        setComposerDraftTerminalContexts: vi.fn(),
        setComposerDraftFileReferences: vi.fn(),
        setDraftThreadContext: vi.fn(),
        readComposerDraftContent: vi.fn(() => null),
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
        composerFileReferencesRef: { current: [] },
        sendInFlightRef: { current: false },
      } as never,
      sourceControl: { fetcher: vi.fn(async (ctx) => ctx) },
      persistSettings: {
        persistThreadSettingsForNextTurn: vi.fn(async () => {}),
      },
      composerHandle: { readComposer: () => null },
      formatOutgoingPrompt: ({ text }) => text,
    });

    expect(armEndFollowBeforeOptimistic).toHaveBeenCalledTimes(1);
    expect(scrollToEndAfterOptimistic).toHaveBeenCalledTimes(1);
    expect(setOptimisticUserMessages).toHaveBeenCalledTimes(1);
    expect(clearComposerDraftContent).toHaveBeenCalledTimes(1);
    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(order.slice(0, 4)).toEqual(["arm", "optimistic", "scroll-after", "clear"]);
    expect(order.indexOf("microtask")).toBeGreaterThan(order.indexOf("clear"));
    expect(order.at(-1)).toBe("dispatch");
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.turn.start" }),
    );
  });

  it("does not wait for the list before the optimistic message", async () => {
    const { input, dispatchCommand } = makeSendInput();
    input.claudeCacheReview = null;
    input.scroll.armEndFollowBeforeOptimistic = vi.fn(() => {});
    // Stands in for a scroll that has not got anywhere yet.
    input.scroll.scrollToEndAfterOptimistic = vi.fn();
    let releaseDispatch!: () => void;
    const dispatchHeld = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    dispatchCommand.mockImplementation(async () => {
      await dispatchHeld;
      return { sequence: 1 };
    });

    let settled = false;
    const sending = executeChatSendTurn(input).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(input.dispatch.setOptimisticUserMessages).toHaveBeenCalledOnce();
    expect(input.draft.clearComposerDraftContent).toHaveBeenCalledWith(
      input.draft.composerDraftTarget,
    );
    expect(settled).toBe(false);

    releaseDispatch();
    expect(await sending).toBe(true);
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.turn.start" }),
    );
  });

  it("a failed send after the immediate clear still restores the draft", async () => {
    const { input, dispatchCommand } = makeSendInput();
    input.claudeCacheReview = null;
    dispatchCommand.mockImplementation(async (command) => {
      if ((command as { type: string }).type === "thread.turn.start") {
        throw new Error("The node went away.");
      }
      return { sequence: 1 };
    });

    expect(await executeChatSendTurn(input)).toBe(false);

    expect(input.draft.clearComposerDraftContent).toHaveBeenCalledWith(
      input.draft.composerDraftTarget,
    );
    expect(input.draft.setComposerDraftPrompt).toHaveBeenLastCalledWith(
      input.draft.composerDraftTarget,
      "Continue with Claude",
    );
    const updaters = vi
      .mocked(input.dispatch.setOptimisticUserMessages)
      .mock.calls.map(([updater]) => updater);
    const [optimistic] = updaters[0]!([]);
    expect(optimistic?.text).toBe("Continue with Claude");
    expect(updaters[1]!([optimistic!])).toEqual([]);
    expect(input.dispatch.setThreadError).toHaveBeenLastCalledWith(
      input.thread.threadId,
      "The node went away.",
    );
    expect(input.refs.sendInFlightRef.current).toBe(false);
    expect(input.dispatch.resetLocalDispatch).toHaveBeenCalledOnce();
  });

  it("sends file references as a block before terminal contexts and restores them on failure", async () => {
    const { input, dispatchCommand } = makeSendInput();
    input.claudeCacheReview = null;
    const reference = {
      id: "reference-1",
      createdAt: "2026-10-22T00:00:00.000Z",
      path: "src/app.ts",
      lineStart: 4,
      lineEnd: 4,
      snippet: "run(item);",
      truncated: false,
      comment: "Twice?",
    };
    input.composer.fileReferences = [reference];
    input.composer.sendableTerminalContexts = [
      {
        id: "context-1",
        threadId: ThreadId.make("thread-handoff"),
        createdAt: "2026-10-22T00:00:00.000Z",
        terminalId: "t1",
        terminalLabel: "Terminal 1",
        lineStart: 1,
        lineEnd: 1,
        text: "error",
      },
    ];
    input.refs.promptRef.current = input.composer.prompt;
    input.refs.composerFileReferencesRef.current = [reference];
    dispatchCommand.mockImplementation(async (command) => {
      if ((command as { type: string }).type === "thread.turn.start") {
        throw new Error("The node went away.");
      }
      return { sequence: 1 };
    });

    expect(await executeChatSendTurn(input)).toBe(false);

    const turnStart = dispatchCommand.mock.calls
      .map(([command]) => command as { type: string; message?: { text: string } })
      .find((command) => command.type === "thread.turn.start");
    expect(turnStart?.message?.text).toBe(
      [
        "Continue with Claude",
        "",
        "<file_context>",
        "- src/app.ts line 4:",
        "  comment: Twice?",
        "  4 | run(item);",
        "</file_context>",
        "",
        "<terminal_context>",
        "- Terminal 1 line 1:",
        "  1 | error",
        "</terminal_context>",
      ].join("\n"),
    );
    // The send cleared the composer; the failure puts the chips back.
    expect(input.draft.clearComposerDraftContent).toHaveBeenCalled();
    expect(input.draft.setComposerDraftFileReferences).toHaveBeenLastCalledWith(
      input.draft.composerDraftTarget,
      [reference],
    );
    expect(input.refs.composerFileReferencesRef.current).toEqual([reference]);
  });

  it("restores an attachment and a file reference when the send fails before the composer re-renders", async () => {
    const { input, dispatchCommand } = makeSendInput();
    input.claudeCacheReview = null;
    const attachment = {
      id: "sent-upload",
      type: "file" as const,
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      file: null,
      previewUrl: "",
      uploadToken: "upload-1",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    const reference = {
      id: "reference-1",
      createdAt: "2026-10-22T00:00:00.000Z",
      path: "src/app.ts",
      lineStart: 4,
      lineEnd: 4,
      snippet: "run(item);",
      truncated: false,
    };
    input.composer.images = [attachment];
    input.composer.fileReferences = [reference];
    // The live refs still hold what was sent: nothing re-rendered the composer in between.
    input.refs.promptRef.current = input.composer.prompt;
    input.refs.composerImagesRef.current = [attachment];
    input.refs.composerFileReferencesRef.current = [reference];
    dispatchCommand.mockImplementation(async (command) => {
      if ((command as { type: string }).type === "thread.turn.start") {
        throw new Error("The node went away.");
      }
      return { sequence: 1 };
    });

    expect(await executeChatSendTurn(input)).toBe(false);

    expect(input.draft.clearComposerDraftContent).toHaveBeenCalled();
    expect(input.draft.addComposerDraftImages).toHaveBeenLastCalledWith(
      input.draft.composerDraftTarget,
      [attachment],
    );
    expect(input.draft.setComposerDraftFileReferences).toHaveBeenLastCalledWith(
      input.draft.composerDraftTarget,
      [reference],
    );
    expect(input.refs.composerImagesRef.current).toEqual([attachment]);
    expect(input.refs.composerFileReferencesRef.current).toEqual([reference]);
    expect(input.refs.promptRef.current).toBe(input.composer.prompt);
  });

  it("keeps the draft when a file reference was added while the send prepared", async () => {
    const { input } = makeSendInput();
    input.claudeCacheReview = null;
    input.refs.promptRef.current = input.composer.prompt;
    input.scroll.armEndFollowBeforeOptimistic = vi.fn(() => {
      input.refs.composerFileReferencesRef.current = [
        {
          id: "late",
          createdAt: "2026-10-22T00:00:00.000Z",
          path: "src/app.ts",
          lineStart: 1,
          lineEnd: 1,
          snippet: "x",
          truncated: false,
        },
      ];
    });

    expect(await executeChatSendTurn(input)).toBe(true);
    expect(input.draft.clearComposerDraftContent).not.toHaveBeenCalled();
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
      composerFileReferencesRef: { current: [] },
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
        armEndFollowBeforeOptimistic: vi.fn(() => {}),
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
        setComposerDraftFileReferences: vi.fn(),
        setDraftThreadContext: vi.fn(),
        readComposerDraftContent: vi.fn(() => null),
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
    composerFileReferencesRef: { current: [] },
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
      armEndFollowBeforeOptimistic: vi.fn(() => {}),
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
      setComposerDraftFileReferences: vi.fn(),
      setDraftThreadContext: vi.fn(),
      readComposerDraftContent: vi.fn(() => null),
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

describe("a send whose view moved on to another thread", () => {
  function switchedSend() {
    const sent = makeSendInput();
    const resetCursorState = vi.fn();
    const setOptimisticUserMessages = vi.fn();
    let shown = true;
    sent.input.claudeCacheReview = null;
    sent.input.dispatch.setOptimisticUserMessages = setOptimisticUserMessages;
    sent.input.composerHandle = {
      readComposer: () => ({ resetCursorState }) as never,
      showsSendThread: () => shown,
    };
    /** The user opens another thread: the view's live composer becomes that thread's. */
    const switchThread = (otherPrompt: string) => {
      shown = false;
      sent.input.refs.promptRef.current = otherPrompt;
      resetCursorState.mockClear();
      setOptimisticUserMessages.mockClear();
    };
    return { ...sent, resetCursorState, setOptimisticUserMessages, switchThread };
  }

  it("puts a failed prompt back into its own thread's draft, not the shown one", async () => {
    for (const otherPrompt of ["typed in the other thread", ""]) {
      const { input, dispatchCommand, resetCursorState, setOptimisticUserMessages, switchThread } =
        switchedSend();
      dispatchCommand.mockImplementation(async () => {
        switchThread(otherPrompt);
        throw new Error("The node went away.");
      });

      expect(await executeChatSendTurn(input)).toBe(false);
      expect(input.draft.setComposerDraftPrompt).toHaveBeenLastCalledWith(
        DraftId.make("draft-handoff"),
        "Continue with Claude",
      );
      expect(input.refs.promptRef.current).toBe(otherPrompt);
      expect(resetCursorState).not.toHaveBeenCalled();
      expect(setOptimisticUserMessages).not.toHaveBeenCalled();
    }
  });

  it("consumes its own thread's stored draft without touching the shown composer", async () => {
    const { input, resetCursorState, setOptimisticUserMessages, switchThread } = switchedSend();
    vi.mocked(input.draft.readComposerDraftContent).mockReturnValue({
      prompt: "My next draft",
      images: [],
      terminalContexts: [],
      fileReferences: [],
    });
    input.scroll.armEndFollowBeforeOptimistic = vi.fn(() => {
      switchThread("typed in the other thread");
    });

    expect(await executeChatSendTurn(input)).toBe(true);
    expect(input.draft.clearComposerDraftContent).toHaveBeenCalledWith(
      DraftId.make("draft-handoff"),
    );
    expect(input.refs.promptRef.current).toBe("typed in the other thread");
    expect(resetCursorState).not.toHaveBeenCalled();
    // The optimistic message would land in the other thread's timeline.
    expect(setOptimisticUserMessages).not.toHaveBeenCalled();
  });

  it("consumes its own thread's stored draft when the view moved on before the send started", async () => {
    const { input, switchThread } = switchedSend();
    vi.mocked(input.draft.readComposerDraftContent).mockReturnValue({
      prompt: "My next draft",
      images: [],
      terminalContexts: [],
      fileReferences: [],
    });
    // Moved on while the caller was still preparing (a device screenshot, say).
    switchThread("typed in the other thread");

    expect(await executeChatSendTurn(input)).toBe(true);
    expect(input.draft.clearComposerDraftContent).toHaveBeenCalledWith(
      DraftId.make("draft-handoff"),
    );
    expect(input.refs.promptRef.current).toBe("typed in the other thread");
  });
});

describe("chat first send with a retired project id", () => {
  const RETIRED_ID = ProjectId.make("chat-retired");
  const FRESH_ID = ProjectId.make("chat-fresh");
  const retired = () =>
    new OrchestrationDispatchCommandError({
      message: "This chat was cleaned up before its first message was sent.",
      reason: "chat-project-retired",
    });

  function makeChatSendInput() {
    const sent = makeSendInput();
    const renewChatProjectId = vi.fn(() => FRESH_ID);
    sent.input.claudeCacheReview = null;
    sent.input.thread = {
      ...sent.input.thread,
      threadId: ThreadId.make("thread-chat"),
      isFirstMessage: true,
      isServerThread: false,
      isLocalDraftThread: true,
      projectId: RETIRED_ID,
      createChatProjectId: RETIRED_ID,
      renewChatProjectId,
    };
    sent.input.project = { projectId: RETIRED_ID, projectCwd: "" };
    const turnStarts = () =>
      sent.dispatchCommand.mock.calls
        .map(([command]) => command as { type: string; commandId: string; bootstrap?: unknown })
        .filter((command) => command.type === "thread.turn.start");
    return { ...sent, renewChatProjectId, turnStarts };
  }

  it("moves the draft to a fresh project id and sends the same message once more", async () => {
    const { input, dispatchCommand, renewChatProjectId, turnStarts } = makeChatSendInput();
    dispatchCommand.mockRejectedValueOnce(retired());

    expect(await executeChatSendTurn(input)).toBe(true);
    expect(renewChatProjectId).toHaveBeenCalledOnce();
    const [first, second] = turnStarts();
    expect(turnStarts()).toHaveLength(2);
    expect(first?.bootstrap).toMatchObject({
      createChatProject: { projectId: RETIRED_ID },
      createThread: { projectId: RETIRED_ID },
    });
    expect(second?.bootstrap).toMatchObject({
      createChatProject: { projectId: FRESH_ID, titleSeed: "Continue with Claude" },
      createThread: { projectId: FRESH_ID },
    });
    expect(second?.commandId).not.toBe(first?.commandId);
    // The optimistic message stays put and no error reaches the thread.
    expect(input.dispatch.setOptimisticUserMessages).toHaveBeenCalledOnce();
    expect(input.dispatch.setThreadError).toHaveBeenLastCalledWith(input.thread.threadId, null);
    expect(input.dispatch.resetLocalDispatch).not.toHaveBeenCalled();
  });

  it("keeps the message to send again when the resend fails too", async () => {
    const { input, dispatchCommand, turnStarts } = makeChatSendInput();
    dispatchCommand
      .mockRejectedValueOnce(retired())
      .mockRejectedValueOnce(new Error("Provider unavailable"));

    expect(await executeChatSendTurn(input)).toBe(false);
    expect(turnStarts()).toHaveLength(2);
    expect(input.dispatch.setThreadError).toHaveBeenLastCalledWith(
      input.thread.threadId,
      "Provider unavailable",
    );
    // The composed text returns to the composer of the (renewed) draft.
    expect(input.draft.setComposerDraftPrompt).toHaveBeenLastCalledWith(
      input.draft.composerDraftTarget,
      "Continue with Claude",
    );
  });

  it("never renews a send that does not create a chat", async () => {
    const { input, dispatchCommand, renewChatProjectId, turnStarts } = makeChatSendInput();
    const { createChatProjectId: _omitted, ...projectThread } = input.thread;
    input.thread = projectThread;
    dispatchCommand.mockRejectedValueOnce(retired());

    expect(await executeChatSendTurn(input)).toBe(false);
    expect(renewChatProjectId).not.toHaveBeenCalled();
    expect(turnStarts()).toHaveLength(1);
  });
});

describe("a model switch held back by background tasks", () => {
  const blocked = () =>
    new OrchestrationDispatchCommandError({
      message: "This thread still has background tasks running.",
      modelSwitchBlockedByBackgroundWork: { taskIds: ["task-agent"] },
    });

  function makeBlockedSendInput(stop: boolean) {
    const sent = makeSendInput();
    const stopBackgroundTask = vi.fn(async (_input: unknown) => ({}));
    const confirmStopBackgroundWork = vi.fn(async () => stop);
    sent.input.claudeCacheReview = null;
    sent.input.confirmStopBackgroundWork = confirmStopBackgroundWork;
    sent.input.dispatch.api = {
      orchestration: { dispatchCommand: sent.dispatchCommand, stopBackgroundTask },
    } as never;
    sent.dispatchCommand.mockRejectedValueOnce(blocked());
    const turnStarts = () =>
      sent.dispatchCommand.mock.calls
        .map(([command]) => command as { type: string; [key: string]: unknown })
        .filter((command) => command.type === "thread.turn.start");
    return { ...sent, stopBackgroundTask, confirmStopBackgroundWork, turnStarts };
  }

  it("asks with the dialog by default and never for a background send", async () => {
    const calls = () => commitSendTurnDispatchSpy.current!.mock.calls;
    const { input } = makeSendInput();
    expect(await executeChatSendTurn(input)).toBe(true);
    expect(calls().at(-1)?.[0].confirmStopBackgroundWork).toBe(confirmStopBackgroundWorkDialog);

    const background = makeSendInput();
    background.input.confirmStopBackgroundWork = null;
    expect(await executeChatSendTurn(background.input)).toBe(true);
    expect(calls().at(-1)?.[0]).not.toHaveProperty("confirmStopBackgroundWork");
  });

  it("stops and sends nothing more when the choice outlived the send's connection", async () => {
    // No connection stands in here, so the send's readiness capture fails after the choice.
    const { input, stopBackgroundTask, turnStarts } = makeBlockedSendInput(true);

    expect(await executeChatSendTurn(input)).toBe(false);
    expect(stopBackgroundTask).not.toHaveBeenCalled();
    expect(turnStarts()).toHaveLength(1);
    expect(input.draft.setComposerDraftPrompt).toHaveBeenLastCalledWith(
      input.draft.composerDraftTarget,
      "Continue with Claude",
    );
    expect(input.dispatch.setThreadError).toHaveBeenLastCalledWith(
      input.thread.threadId,
      expect.stringContaining("Nothing was stopped or sent"),
    );
  });

  it("keeps the message and the staged target on cancel", async () => {
    const { input, dispatchCommand, stopBackgroundTask, turnStarts } = makeBlockedSendInput(false);

    expect(await executeChatSendTurn(input)).toBe(false);
    expect(stopBackgroundTask).not.toHaveBeenCalled();
    expect(turnStarts()).toHaveLength(1);
    // The composed text returns to the draft, and the send never wrote the target
    // anywhere but the refused turn start, so the composer still stages it.
    expect(input.draft.setComposerDraftPrompt).toHaveBeenLastCalledWith(
      input.draft.composerDraftTarget,
      "Continue with Claude",
    );
    expect(
      dispatchCommand.mock.calls.filter(
        ([command]) => (command as { type: string }).type !== "thread.turn.start",
      ),
    ).toEqual([]);
    expect(input.dispatch.setThreadError).toHaveBeenLastCalledWith(
      input.thread.threadId,
      expect.stringContaining("Your message and the selected model are kept"),
    );
  });
});

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

  it("releases send ownership when arming the end follow throws without consuming the draft", async () => {
    const { input, dispatchCommand } = makeSendInput();
    input.scroll.armEndFollowBeforeOptimistic = () => {
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
    input.scroll.armEndFollowBeforeOptimistic = () => {
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
    input.scroll.armEndFollowBeforeOptimistic = () => {
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
      scroll: { ...input.scroll, armEndFollowBeforeOptimistic: () => {} },
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
      input.scroll.armEndFollowBeforeOptimistic = () => {
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

describe("worktree branch defaults", () => {
  it.each(["team/tasks", ""])("uses the target node's current prefix (%s)", async (prefix) => {
    const { input, dispatchCommand } = makeSendInput();
    input.worktree.baseBranchForWorktree = "main";
    input.worktree.shouldCreateWorktree = true;
    const getSettings = vi.fn(async () => ({ worktreeBranchPrefix: prefix }));
    input.dispatch.api = {
      orchestration: { dispatchCommand },
      server: {
        getConfig: async () => ({ environment: { capabilities: {} } }) as ServerConfig,
        getSettings,
      },
    } as never;
    expect(await executeChatSendTurn(input)).toBe(true);
    expect(getSettings).toHaveBeenCalledOnce();
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        bootstrap: expect.objectContaining({
          prepareWorktree: expect.objectContaining({
            branch: expect.stringMatching(prefix ? /^team\/tasks\/[0-9a-f]{8}$/ : /^[0-9a-f]{8}$/),
          }),
        }),
      }),
    );
  });

  it("reads the config and the settings fallback in parallel", async () => {
    const { input, dispatchCommand } = makeSendInput();
    input.worktree.baseBranchForWorktree = "main";
    input.worktree.shouldCreateWorktree = true;
    const started: string[] = [];
    let releaseConfig!: () => void;
    const configHeld = new Promise<void>((resolve) => {
      releaseConfig = resolve;
    });
    input.dispatch.api = {
      orchestration: { dispatchCommand },
      server: {
        getConfig: async () => {
          started.push("config");
          await configHeld;
          return { environment: { capabilities: {} } } as ServerConfig;
        },
        getSettings: async () => {
          started.push("settings");
          releaseConfig();
          return { worktreeBranchPrefix: "team" };
        },
      },
    } as never;
    expect(await executeChatSendTurn(input)).toBe(true);
    // The settings read starts first and releases the held config read: had
    // they run one after the other, the send would never finish.
    expect(started).toEqual(["settings", "config"]);
  });

  it("sends with remembered preferences and leaves the setup choice to the node", async () => {
    const { input, dispatchCommand } = makeSendInput();
    input.worktree.baseBranchForWorktree = "main";
    input.worktree.shouldCreateWorktree = true;
    const getProjectPreferences = vi.fn(async () => ({
      worktreeBranchPrefix: { value: "remembered", source: "project" },
      runSetupScript: { value: false, source: "project" },
    }));
    const capableConfig = {
      environment: { capabilities: { projectPreferences: true } },
    } as ServerConfig;
    // Entering worktree mode (or opening the draft) remembered the project's answer.
    await readAndRememberProjectPreferences({
      api: { server: { getProjectPreferences } } as never,
      environmentId: EnvironmentId.make("env-1"),
      config: capableConfig,
      projectId: ProjectId.make("project-1"),
    });
    getProjectPreferences.mockClear();
    const getSettings = vi.fn(async () => ({ worktreeBranchPrefix: "team" }));
    input.dispatch.api = {
      orchestration: { dispatchCommand },
      server: { getConfig: async () => capableConfig, getProjectPreferences, getSettings },
    } as never;

    expect(await executeChatSendTurn(input)).toBe(true);
    expect(getProjectPreferences).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
    const command = dispatchCommand.mock.calls[0]?.[0] as { bootstrap?: object } | undefined;
    const bootstrap = command?.bootstrap;
    expect(bootstrap).toMatchObject({
      prepareWorktree: { branch: expect.stringMatching(/^remembered\/[0-9a-f]{8}$/) },
    });
    expect(bootstrap).not.toHaveProperty("runSetupScript");
    resetNewDraftDefaultsCacheForTests();
  });

  it("reads the project's prefix again once the node's settings changed", async () => {
    const { input, dispatchCommand } = makeSendInput();
    input.worktree.baseBranchForWorktree = "main";
    input.worktree.shouldCreateWorktree = true;
    const capableConfig = (worktreeBranchPrefix: string) =>
      ({
        environment: { capabilities: { projectPreferences: true } },
        settings: { projectPreferences: { "project-1": { worktreeBranchPrefix } } },
      }) as unknown as ServerConfig;
    await readAndRememberProjectPreferences({
      api: {
        server: {
          getProjectPreferences: async () => ({
            worktreeBranchPrefix: { value: "old", source: "project" },
          }),
        },
      } as never,
      environmentId: EnvironmentId.make("env-1"),
      config: capableConfig("old"),
      projectId: ProjectId.make("project-1"),
    });
    // The project's prefix was saved since: the remembered answer is stale.
    const getProjectPreferences = vi.fn(async () => ({
      worktreeBranchPrefix: { value: "new", source: "project" },
      runSetupScript: { value: true, source: "builtin" },
    }));
    input.dispatch.api = {
      orchestration: { dispatchCommand },
      server: {
        getConfig: async () => capableConfig("new"),
        getProjectPreferences,
        getSettings: async () => ({ worktreeBranchPrefix: "team" }),
      },
    } as never;

    expect(await executeChatSendTurn(input)).toBe(true);
    expect(getProjectPreferences).toHaveBeenCalledTimes(1);
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        bootstrap: expect.objectContaining({
          prepareWorktree: expect.objectContaining({
            branch: expect.stringMatching(/^new\/[0-9a-f]{8}$/),
          }),
        }),
      }),
    );
    resetNewDraftDefaultsCacheForTests();
  });

  it("uses the project's prefix even when the settings fallback read fails", async () => {
    const { input, dispatchCommand } = makeSendInput();
    input.worktree.baseBranchForWorktree = "main";
    input.worktree.shouldCreateWorktree = true;
    input.dispatch.api = {
      orchestration: { dispatchCommand },
      server: {
        getConfig: async () =>
          ({ environment: { capabilities: { projectPreferences: true } } }) as ServerConfig,
        getProjectPreferences: async () => ({
          worktreeBranchPrefix: { value: "proj", source: "project" },
          runSetupScript: { value: true, source: "builtin" },
        }),
        getSettings: async () => {
          throw new Error("Settings are unavailable");
        },
      },
    } as never;
    expect(await executeChatSendTurn(input)).toBe(true);
    expect(dispatchCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        bootstrap: expect.objectContaining({
          prepareWorktree: expect.objectContaining({
            branch: expect.stringMatching(/^proj\/[0-9a-f]{8}$/),
          }),
        }),
      }),
    );
  });

  describe("on a hosted target", () => {
    beforeEach(() => resetNewDraftDefaultsCacheForTests());
    afterEach(() => {
      hostedTarget.hostedHubMode = false;
      hostedTarget.connection = null;
      resetNewDraftDefaultsCacheForTests();
    });

    function hostedWorktreeSend(liveConfig: ServerConfig | null) {
      hostedTarget.hostedHubMode = true;
      hostedTarget.connection = {
        config: { read: () => liveConfig },
        shellSnapshotReadiness: { read: () => ({}) },
      };
      const { input, dispatchCommand } = makeSendInput();
      input.worktree.baseBranchForWorktree = "main";
      input.worktree.shouldCreateWorktree = true;
      const freshConfig = {
        environment: { capabilities: { projectPreferences: true } },
      } as ServerConfig;
      const getConfig = vi.fn(async () => freshConfig);
      const getProjectPreferences = vi.fn(async () => ({
        worktreeBranchPrefix: { value: "proj", source: "project" },
        runSetupScript: { value: true, source: "builtin" },
      }));
      input.dispatch.api = {
        orchestration: { dispatchCommand },
        server: {
          getConfig,
          getProjectPreferences,
          getSettings: async () => ({ worktreeBranchPrefix: "team" }),
        },
      } as never;
      return { input, dispatchCommand, getConfig, getProjectPreferences };
    }

    it("uses the connection's current live config instead of a fresh read", async () => {
      const live = {
        environment: { capabilities: { projectPreferences: true } },
      } as ServerConfig;
      const send = hostedWorktreeSend(live);

      expect(await executeChatSendTurn(send.input)).toBe(true);
      expect(send.getConfig).not.toHaveBeenCalled();
      expect(send.getProjectPreferences).toHaveBeenCalledOnce();
      const command = send.dispatchCommand.mock.calls[0]?.[0] as { bootstrap?: object };
      // The live config decided support: the node resolves the setup choice.
      expect(command.bootstrap).not.toHaveProperty("runSetupScript");
      expect(command.bootstrap).toMatchObject({
        prepareWorktree: { branch: expect.stringMatching(/^proj\/[0-9a-f]{8}$/) },
      });
    });

    it("reads the config fresh when no current live config exists", async () => {
      const send = hostedWorktreeSend(null);

      expect(await executeChatSendTurn(send.input)).toBe(true);
      expect(send.getConfig).toHaveBeenCalledOnce();
      expect(send.dispatchCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          bootstrap: expect.objectContaining({
            prepareWorktree: expect.objectContaining({
              branch: expect.stringMatching(/^proj\/[0-9a-f]{8}$/),
            }),
          }),
        }),
      );
    });
  });

  it("does not guess a default if the node settings are unavailable", async () => {
    const { input, dispatchCommand } = makeSendInput();
    input.worktree.baseBranchForWorktree = "main";
    input.worktree.shouldCreateWorktree = true;
    expect(await executeChatSendTurn(input)).toBe(false);
    expect(dispatchCommand).not.toHaveBeenCalled();
  });

  it("preserves the draft without falling back when the target config read fails", async () => {
    const { input, dispatchCommand } = makeSendInput();
    input.refs.promptRef.current = input.composer.prompt;
    input.worktree.baseBranchForWorktree = "main";
    const getSettings = vi.fn(async () => ({ worktreeBranchPrefix: "team" }));
    input.dispatch.api = {
      orchestration: { dispatchCommand },
      server: {
        getConfig: async () => {
          throw new Error("Node disconnected");
        },
        getSettings,
      },
    } as never;
    expect(await executeChatSendTurn(input)).toBe(false);
    // The settings read runs alongside the config read; its value is never used.
    expect(getSettings.mock.calls.length).toBeLessThanOrEqual(1);
    expect(dispatchCommand).not.toHaveBeenCalled();
    expect(input.refs.promptRef.current).toBe(input.composer.prompt);
    expect(input.draft.setComposerDraftPrompt).toHaveBeenLastCalledWith(
      input.draft.composerDraftTarget,
      input.composer.prompt,
    );
  });
});

it("rejects a saved memory-dependent composer without dispatching or clearing its draft", async () => {
  const { input, dispatchCommand } = makeSendInput();
  Object.assign(input.composer, { projectMemory: { projectId: "old-project", references: [] } });
  expect(await executeChatSendTurn(input)).toBe(false);
  expect(dispatchCommand).not.toHaveBeenCalled();
  expect(input.draft.clearComposerDraftContent).not.toHaveBeenCalled();
  expect(input.dispatch.setThreadError).toHaveBeenCalledWith(
    input.thread.threadId,
    expect.stringContaining("Project memory was intentionally removed"),
  );
});

describe("background send options", () => {
  function lastCommitInput() {
    const calls = commitSendTurnDispatchSpy.current!.mock.calls;
    return calls.at(-1)?.[0] as Record<string, unknown>;
  }

  it("uses the dialog review by default and no interactive review for null", async () => {
    const { input } = makeSendInput();
    expect(await executeChatSendTurn(input)).toBe(true);
    expect(lastCommitInput().claudeCacheReview).toBe(claudeCacheReviewPresentation);

    const background = makeSendInput();
    background.input.claudeCacheReview = null;
    expect(await executeChatSendTurn(background.input)).toBe(true);
    expect(lastCommitInput()).not.toHaveProperty("claudeCacheReview");
  });

  it("forwards onBeforeTurnStart to run right before turn.start", async () => {
    const { input, dispatchCommand } = makeSendInput();
    const order: string[] = [];
    dispatchCommand.mockImplementation(async (command: unknown) => {
      order.push((command as { type: string }).type);
      return { sequence: 1 };
    });
    input.onBeforeTurnStart = () => order.push("onBeforeTurnStart");
    expect(await executeChatSendTurn(input)).toBe(true);
    expect(order.at(-2)).toBe("onBeforeTurnStart");
    expect(order.at(-1)).toBe("thread.turn.start");
  });

  it("skips the expired-terminal toast when toasts are suppressed", async () => {
    const add = vi.spyOn(toastManager, "add");
    try {
      const shown = makeSendInput();
      shown.input.composer.expiredTerminalContextCount = 1;
      await executeChatSendTurn(shown.input);
      expect(add).toHaveBeenCalledTimes(1);
      add.mockClear();
      const quiet = makeSendInput();
      quiet.input.composer.expiredTerminalContextCount = 1;
      quiet.input.suppressToasts = true;
      await executeChatSendTurn(quiet.input);
      expect(add).not.toHaveBeenCalled();
    } finally {
      add.mockRestore();
    }
  });

  it("lets the caller observe the send error before it becomes a thread error", async () => {
    const { input, dispatchCommand } = makeSendInput();
    const failure = new Error("Provider unavailable");
    dispatchCommand.mockRejectedValueOnce(failure);
    const seen: unknown[] = [];
    input.onSendError = (error) => seen.push(error);
    expect(await executeChatSendTurn(input)).toBe(false);
    expect(seen).toEqual([failure]);
    expect(input.dispatch.setThreadError).toHaveBeenLastCalledWith(
      input.thread.threadId,
      "Provider unavailable",
    );
  });
});

describe("first send into a new worktree", () => {
  const LAUNCH_KEY = "env-1:thread-launch";
  const makeLaunchInput = () => {
    const { input, dispatchCommand } = makeSendInput();
    let messages: ChatMessage[] = [];
    input.thread = {
      ...input.thread,
      threadId: ThreadId.make("thread-launch"),
      isFirstMessage: true,
      isServerThread: false,
      isLocalDraftThread: true,
      activeThreadBranch: "main",
    };
    input.worktree = {
      shouldMaterializeLegacyBranchWorktree: false,
      baseBranchForWorktree: "origin/main",
      shouldCreateWorktree: true,
      fetchOrigin: true,
    };
    input.refs.promptRef.current = "Continue with Claude";
    const unsubscribe = vi.fn();
    const onWorktreeSetup = vi.fn(() => unsubscribe);
    input.dispatch.api = {
      orchestration: { dispatchCommand },
      server: {
        getConfig: async () => ({ environment: { capabilities: {} } }) as ServerConfig,
        getSettings: async () => ({ worktreeBranchPrefix: "ryco" }),
      },
      vcs: { onWorktreeSetup },
    } as never;
    input.dispatch.setOptimisticUserMessages = vi.fn((update) => {
      messages = update(messages);
    });
    return { input, dispatchCommand, onWorktreeSetup, readMessages: () => messages };
  };
  const launch = () => useWorktreeLaunchStore.getState().launchesByKey[LAUNCH_KEY] ?? null;

  afterEach(() => {
    useWorktreeLaunchStore.getState().remove(LAUNCH_KEY);
  });

  it("shows the setup from the send and hands it to the turn the node started", async () => {
    const { input, onWorktreeSetup } = makeLaunchInput();
    expect(await executeChatSendTurn(input)).toBe(true);
    expect(input.dispatch.beginLocalDispatch).toHaveBeenCalledWith({ preparingWorktree: true });
    expect(onWorktreeSetup).toHaveBeenCalledWith(
      { threadId: ThreadId.make("thread-launch") },
      expect.any(Function),
      expect.any(Object),
    );
    expect(launch()).toMatchObject({
      phase: "handed-off",
      baseRef: "origin/main",
      fetchOrigin: true,
    });
  });

  it("keeps the message on a failed setup and sends it again under the same id", async () => {
    const { input, dispatchCommand, readMessages } = makeLaunchInput();
    dispatchCommand.mockRejectedValueOnce(
      new OrchestrationDispatchCommandError({ message: "fatal: could not lock ref" }),
    );
    const resend = vi.fn(async () => true);
    input.resendFailedWorktreeLaunch = resend;

    expect(await executeChatSendTurn(input)).toBe(false);
    expect(launch()).toMatchObject({ phase: "failed", error: "fatal: could not lock ref" });
    const [kept] = readMessages();
    expect(kept?.text).toBe("Continue with Claude");
    // The setup's own row reports it: no thread error toast.
    expect(input.dispatch.setThreadError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
    );

    await readWorktreeLaunchRetry(LAUNCH_KEY)?.resend();
    expect(resend).toHaveBeenCalledWith(kept?.id);

    readWorktreeLaunchRetry(LAUNCH_KEY)?.restore();
    expect(readMessages()).toEqual([]);
    expect(input.draft.setComposerDraftPrompt).toHaveBeenCalledWith(
      input.draft.composerDraftTarget,
      "Continue with Claude",
    );
  });

  it("returns the draft as it was when the user stopped the setup", async () => {
    const { input, dispatchCommand, readMessages } = makeLaunchInput();
    dispatchCommand.mockImplementationOnce(async () => {
      useWorktreeLaunchStore.getState().requestCancel(LAUNCH_KEY);
      throw new OrchestrationDispatchCommandError({ message: WORKTREE_SETUP_CANCELLED_MESSAGE });
    });

    expect(await executeChatSendTurn(input)).toBe(false);
    expect(launch()).toBeNull();
    expect(readMessages()).toEqual([]);
    expect(input.draft.setComposerDraftPrompt).toHaveBeenCalledWith(
      input.draft.composerDraftTarget,
      "Continue with Claude",
    );
    expect(input.dispatch.setThreadError).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
    );
  });

  it("drops the failed message when a new one is sent instead", async () => {
    const { input, dispatchCommand, readMessages } = makeLaunchInput();
    dispatchCommand.mockRejectedValueOnce(new Error("fatal: could not lock ref"));
    await executeChatSendTurn(input);
    const failedMessageId = readMessages()[0]?.id;

    input.refs.promptRef.current = "Try again, differently";
    input.composer = { ...input.composer, prompt: "Try again, differently" };
    expect(await executeChatSendTurn(input)).toBe(true);
    expect(readMessages().map((message) => message.id)).not.toContain(failedMessageId);
    expect(readMessages()).toHaveLength(1);
    expect(launch()?.phase).toBe("handed-off");
  });
});
