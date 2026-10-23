import type { EnvironmentApi, ModelSelection, ProjectId, ThreadId } from "@ryco/contracts";
import { OrchestrationDispatchCommandError } from "@ryco/contracts";
import { EnvironmentId, MessageId } from "@ryco/contracts/base-schemas";
import {
  createQuoteCitation,
  expandQuoteCitations,
  serializeQuoteCitation,
} from "@ryco/shared/quoteCitations";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-crypto", () => ({ randomUUID: () => `id-${Math.random().toString(16).slice(2)}` }));

import { executeSendTurn, type ExecuteSendTurnInput } from "./executeSendTurn";

const THREAD_ID = "thread-1" as ThreadId;
const PROJECT_ID = "project-1" as ProjectId;

const modelSelection = {
  instanceId: "inst-1",
  model: "gpt-5",
  options: [],
} as unknown as ModelSelection;

function baseInput(overrides: Partial<ExecuteSendTurnInput> = {}): {
  input: ExecuteSendTurnInput;
  dispatchCommand: ReturnType<typeof vi.fn>;
  clearDraft: ReturnType<typeof vi.fn>;
  restoreDraft: ReturnType<typeof vi.fn>;
  setThreadError: ReturnType<typeof vi.fn>;
} {
  const dispatchCommand = vi.fn(async (_command: unknown) => undefined);
  const clearDraft = vi.fn();
  const restoreDraft = vi.fn();
  const setThreadError = vi.fn();
  const input: ExecuteSendTurnInput = {
    api: { orchestration: { dispatchCommand } } as unknown as EnvironmentApi,
    thread: {
      threadId: THREAD_ID,
      isFirstMessage: true,
      isServerThread: true,
      isLocalDraftThread: false,
      activeThreadBranch: null,
      worktreePath: null,
      createdAt: "2026-07-24T00:00:00.000Z",
    },
    composer: {
      prompt: "hello world",
      images: [],
      selectedModelSelection: modelSelection,
      selectedModel: "gpt-5",
      hasSelectedModel: true,
    },
    project: { projectId: PROJECT_ID, projectCwd: "/repo" },
    settings: {
      runtimeMode: "default" as never,
      interactionMode: "code" as never,
      tokenMode: "default" as never,
    },
    title: "Thread title",
    clearDraft,
    restoreDraft,
    setThreadError,
    ...overrides,
  };
  return { input, dispatchCommand, clearDraft, restoreDraft, setThreadError };
}

describe("executeSendTurn", () => {
  it("clears the draft and dispatches thread.meta.update then thread.turn.start on a first server message", async () => {
    const { input, dispatchCommand, clearDraft } = baseInput();
    const result = await executeSendTurn(input);

    // MAJOR 2: a successful send signals true so the composer clears its input.
    expect(result).toBe(true);
    expect(clearDraft).toHaveBeenCalledTimes(1);
    const types = dispatchCommand.mock.calls.map((call) => (call[0] as { type: string }).type);
    expect(types).toEqual(["thread.meta.update", "thread.turn.start"]);
    const start = dispatchCommand.mock.calls.find(
      (c) => (c[0] as { type: string }).type === "thread.turn.start",
    )![0] as { threadId: ThreadId };
    expect(start.threadId).toBe(THREAD_ID);
  });

  it("sends a pasted quote token expanded, as web does", async () => {
    const prompt = `Explain ${serializeQuoteCitation(
      createQuoteCitation({
        source: { environmentId: EnvironmentId.make("env-1"), threadId: THREAD_ID },
        messageId: MessageId.make("assistant-1"),
        selector: { exact: "The passage.", prefix: "", suffix: "", start: 0, end: 12 },
      }),
    )}  `;
    const { input, dispatchCommand } = baseInput({
      composer: { ...baseInput().input.composer, prompt },
    });

    await executeSendTurn(input);

    const start = dispatchCommand.mock.calls.find(
      (call) => (call[0] as { type: string }).type === "thread.turn.start",
    )![0] as { message: { text: string } };
    expect(start.message.text).toBe(expandQuoteCitations(prompt.trim()));
    expect(start.message.text).toContain("<assistant_quotes>");
  });

  it("skips the title update for a non-first message", async () => {
    const { input, dispatchCommand } = baseInput({
      thread: {
        threadId: THREAD_ID,
        isFirstMessage: false,
        isServerThread: true,
        isLocalDraftThread: false,
        activeThreadBranch: null,
        worktreePath: null,
        createdAt: "2026-07-24T00:00:00.000Z",
      },
    });
    await executeSendTurn(input);
    const types = dispatchCommand.mock.calls.map((call) => (call[0] as { type: string }).type);
    expect(types).toEqual(["thread.turn.start"]);
  });

  it("carries image data URLs into the outgoing turn payload", async () => {
    const image = {
      type: "image" as const,
      id: "image-1",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
      dataUrl: "data:image/png;base64,AQID",
      previewUri: "file:///tmp/screen.png",
    };
    const { input, dispatchCommand } = baseInput({
      composer: {
        prompt: "",
        images: [image],
        selectedModelSelection: modelSelection,
        selectedModel: "gpt-5",
        hasSelectedModel: true,
      },
    });

    await executeSendTurn(input);

    const start = dispatchCommand.mock.calls.find(
      (call) => (call[0] as { type: string }).type === "thread.turn.start",
    )![0] as {
      message: {
        text: string;
        attachments: ReadonlyArray<{ dataUrl: string }>;
      };
    };
    expect(start.message.attachments).toEqual([
      expect.objectContaining({ dataUrl: "data:image/png;base64,AQID" }),
    ]);
    expect(start.message.text).toBeTruthy();
  });

  it("rolls back the draft and records the error when dispatch fails", async () => {
    const { input, restoreDraft, setThreadError } = baseInput();
    (
      input.api.orchestration.dispatchCommand as unknown as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("network down"));

    const result = await executeSendTurn(input);

    // MAJOR 2: a failed send signals false so the composer KEEPS the user text.
    expect(result).toBe(false);
    expect(restoreDraft).toHaveBeenCalledWith({ prompt: "hello world", images: [] });
    expect(setThreadError).toHaveBeenLastCalledWith(THREAD_ID, "network down");
  });

  describe("Claude resume review", () => {
    function claudeInput(
      readSubscribedClaudeReviewState?: ExecuteSendTurnInput["readSubscribedClaudeReviewState"],
    ) {
      const getThreadWindow = vi.fn(async () => ({
        thread: { session: null, activities: [], modelSelection },
        workspaceCwd: "/repo",
      }));
      const { input, dispatchCommand } = baseInput({
        providerDriver: "claudeAgent" as never,
        sourceProviderDriver: "claudeAgent" as never,
        ...(readSubscribedClaudeReviewState ? { readSubscribedClaudeReviewState } : {}),
        thread: {
          threadId: THREAD_ID,
          isFirstMessage: false,
          isServerThread: true,
          isLocalDraftThread: false,
          activeThreadBranch: null,
          worktreePath: null,
          createdAt: "2026-07-24T00:00:00.000Z",
        },
      });
      const api = {
        orchestration: { dispatchCommand, getThreadWindow },
      } as unknown as EnvironmentApi;
      return { input: { ...input, api }, dispatchCommand, getThreadWindow };
    }

    it("skips the window read when the subscribed state clears the send", async () => {
      const readSubscribed = vi.fn(() => ({
        thread: {
          session: {
            providerName: "claudeAgent",
            status: "ready" as const,
            activeTurnId: null,
          },
          activities: [],
          modelSelection,
        },
        workspaceCwd: "/repo",
      }));
      const { input, dispatchCommand, getThreadWindow } = claudeInput(readSubscribed);

      expect(await executeSendTurn(input)).toBe(true);
      expect(readSubscribed).toHaveBeenCalledOnce();
      expect(getThreadWindow).not.toHaveBeenCalled();
      expect(dispatchCommand.mock.calls.map((call) => (call[0] as { type: string }).type)).toEqual([
        "thread.turn.start",
      ]);
    });

    it("reads the window when no subscribed state is available", async () => {
      const { input, getThreadWindow } = claudeInput(() => undefined);
      expect(await executeSendTurn(input)).toBe(true);
      expect(getThreadWindow).toHaveBeenCalledOnce();
    });
  });

  describe("a model switch held back by background tasks", () => {
    const refusal = () =>
      new OrchestrationDispatchCommandError({
        message: "This thread still has background tasks running.",
        modelSwitchBlockedByBackgroundWork: { taskIds: ["task-shell"] },
      });

    it("asks, then sends the same message again marked to stop background work", async () => {
      const confirmStopBackgroundWork = vi.fn(async () => true);
      const { input, dispatchCommand, restoreDraft } = baseInput({ confirmStopBackgroundWork });
      dispatchCommand.mockImplementation(async (command: unknown) => {
        const turnStart = command as { type: string; stopBackgroundWork?: true };
        if (turnStart.type === "thread.turn.start" && !turnStart.stopBackgroundWork) {
          throw refusal();
        }
        return undefined;
      });

      expect(await executeSendTurn(input)).toBe(true);
      expect(confirmStopBackgroundWork).toHaveBeenCalledWith({ taskIds: ["task-shell"] });
      const turnStarts = dispatchCommand.mock.calls
        .map((call) => call[0] as { type: string; commandId: string; stopBackgroundWork?: true })
        .filter((command) => command.type === "thread.turn.start");
      expect(turnStarts.map((command) => command.stopBackgroundWork)).toEqual([undefined, true]);
      expect(turnStarts[1]?.commandId).toBe(turnStarts[0]?.commandId);
      expect(restoreDraft).not.toHaveBeenCalled();
    });

    it("restores the draft when the user keeps the tasks running", async () => {
      const { input, dispatchCommand, restoreDraft, setThreadError } = baseInput({
        confirmStopBackgroundWork: async () => false,
      });
      dispatchCommand.mockImplementation(async (command: unknown) => {
        if ((command as { type: string }).type === "thread.turn.start") throw refusal();
        return undefined;
      });

      expect(await executeSendTurn(input)).toBe(false);
      expect(restoreDraft).toHaveBeenCalledWith({ prompt: "hello world", images: [] });
      expect(setThreadError).toHaveBeenLastCalledWith(
        THREAD_ID,
        expect.stringContaining("background tasks keep running"),
      );
    });
  });
});
