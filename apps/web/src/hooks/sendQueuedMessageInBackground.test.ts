import { ClaudeResumeReviewError } from "@ryco/client-runtime/state/composer";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ExecuteChatSendTurnInput } from "./executeChatSendTurn";

const harness = vi.hoisted(() => ({
  mutationReady: true,
  execute: vi.fn(),
  gitStatus: vi.fn(),
}));

vi.mock("./executeChatSendTurn", () => ({
  executeChatSendTurn: (input: unknown) => harness.execute(input),
}));
vi.mock("../environmentApi", () => ({
  readEnvironmentApi: () => ({ orchestration: { dispatchCommand: vi.fn() } }),
}));
vi.mock("../messageQueueEnvironment", () => ({
  readWebQueueEnvironment: () => ({ shellLive: true, mutationReady: harness.mutationReady }),
}));
vi.mock("../lib/gitStatusState", () => ({
  refreshGitStatus: (target: unknown) => harness.gitStatus(target),
}));

import { toastManager } from "../components/ui/toast";
import type { WebQueuedMessage } from "../messageQueueStore";
import { selectThreadByRef, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import {
  QUEUED_SELECTION_NEEDS_HANDOFF_MESSAGE,
  sendQueuedMessageInBackground,
} from "./sendQueuedMessageInBackground";

const ENV = EnvironmentId.make("env-background");
const THREAD = ThreadId.make("thread-background");
const KEY = `${ENV}:${THREAD}`;
const AT = "2026-10-01T10:00:00.000Z";

function seedThread(branch: string | null = null): void {
  useStore.setState({ activeEnvironmentId: null, environmentStateById: {} });
  useStore.getState().syncServerShellSnapshot(
    {
      snapshotSequence: 1,
      projects: [
        {
          id: ProjectId.make("project-background"),
          title: "Project",
          workspaceRoot: "/repo",
          defaultModelSelection: null,
          scripts: [],
          createdAt: AT,
          updatedAt: AT,
        },
      ],
      threads: [
        {
          id: THREAD,
          projectId: ProjectId.make("project-background"),
          title: "Background",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch,
          worktreePath: null,
          latestTurn: null,
          createdAt: AT,
          updatedAt: AT,
          archivedAt: null,
          session: null,
          latestUserMessageAt: AT,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      ],
      updatedAt: AT,
    } as unknown as OrchestrationShellSnapshot,
    ENV,
  );
}

function queued(instanceId = "codex", provider = "codex"): WebQueuedMessage {
  return {
    id: "queued-1",
    composer: {
      prompt: "Follow up",
      trimmedPrompt: "Follow up",
      images: [],
      sendableTerminalContexts: [],
      sourceControlContexts: [],
      selectedProvider: ProviderDriverKind.make(provider),
      selectedModel: "gpt-5",
      selectedProviderModels: [],
      selectedPromptEffort: null,
      selectedModelSelection: { instanceId: ProviderInstanceId.make(instanceId), model: "gpt-5" },
      expiredTerminalContextCount: 1,
    },
    settings: { runtimeMode: "full-access", interactionMode: "plan", tokenMode: "balanced" },
  };
}

const lastInput = () => harness.execute.mock.calls.at(-1)?.[0] as ExecuteChatSendTurnInput;

beforeEach(() => {
  harness.mutationReady = true;
  harness.gitStatus.mockReset();
  harness.gitStatus.mockResolvedValue({ isRepo: true, refName: "main" });
  harness.execute.mockReset();
  harness.execute.mockImplementation(async (input: ExecuteChatSendTurnInput) => {
    input.onBeforeTurnStart?.();
    return true;
  });
  useUiStateStore.setState({ alwaysUseBuildMode: false });
  seedThread();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendQueuedMessageInBackground", () => {
  it("sends headless: no review dialog, no toasts, the queued id, and the turn-start hook", async () => {
    const add = vi.spyOn(toastManager, "add");
    const onBeforeTurnStart = vi.fn();
    expect(await sendQueuedMessageInBackground(KEY, queued(), { onBeforeTurnStart })).toEqual({
      kind: "accepted",
    });
    const input = lastInput();
    expect(input).toMatchObject({
      messageId: "queued-1",
      preserveComposerDraft: true,
      claudeCacheReview: null,
      suppressToasts: true,
      thread: { threadId: THREAD, isServerThread: true, isFirstMessage: false },
      project: { projectCwd: "/repo" },
    });
    expect(onBeforeTurnStart).toHaveBeenCalledTimes(1);
    expect(add).not.toHaveBeenCalled();
  });

  it("turns a Claude resume review into needs-review", async () => {
    harness.execute.mockImplementation(async (input: ExecuteChatSendTurnInput) => {
      const error = new ClaudeResumeReviewError("This Claude resume needs review.");
      input.onSendError?.(error);
      input.dispatch.setThreadError(input.thread.threadId, error.message);
      return false;
    });
    expect(
      await sendQueuedMessageInBackground(KEY, queued(), { onBeforeTurnStart: vi.fn() }),
    ).toEqual({ kind: "needs-review", detail: "This Claude resume needs review." });
    expect(
      selectThreadByRef(useStore.getState(), { environmentId: ENV, threadId: THREAD })?.error,
    ).toBeNull();
  });

  it("reports any other rejection as failed", async () => {
    harness.execute.mockImplementation(async (input: ExecuteChatSendTurnInput) => {
      input.onSendError?.(new Error("Provider unavailable"));
      return false;
    });
    expect(
      await sendQueuedMessageInBackground(KEY, queued(), { onBeforeTurnStart: vi.fn() }),
    ).toEqual({ kind: "failed" });
  });

  it("applies the Build-mode lock", async () => {
    useUiStateStore.setState({ alwaysUseBuildMode: true });
    await sendQueuedMessageInBackground(KEY, queued(), { onBeforeTurnStart: vi.fn() });
    expect(lastInput().settings.interactionMode).toBe("default");
  });

  it("fails a selection that needs a context handoff with a thread error, without sending", async () => {
    expect(
      await sendQueuedMessageInBackground(KEY, queued("claudeAgent", "claudeAgent"), {
        onBeforeTurnStart: vi.fn(),
      }),
    ).toEqual({ kind: "failed" });
    expect(harness.execute).not.toHaveBeenCalled();
    expect(
      selectThreadByRef(useStore.getState(), { environmentId: ENV, threadId: THREAD })?.error,
    ).toBe(QUEUED_SELECTION_NEEDS_HANDOFF_MESSAGE);
  });

  it("defers while the environment is not mutation-ready or the thread is unknown", async () => {
    harness.mutationReady = false;
    expect(
      await sendQueuedMessageInBackground(KEY, queued(), { onBeforeTurnStart: vi.fn() }),
    ).toEqual({ kind: "deferred" });
    harness.mutationReady = true;
    expect(
      await sendQueuedMessageInBackground(`${ENV}:missing`, queued(), {
        onBeforeTurnStart: vi.fn(),
      }),
    ).toEqual({ kind: "deferred" });
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("materializes a legacy branch thread's worktree when the root has another branch checked out", async () => {
    seedThread("feature/queued");
    harness.gitStatus.mockResolvedValue({ isRepo: true, refName: "main" });
    await sendQueuedMessageInBackground(KEY, queued(), { onBeforeTurnStart: vi.fn() });
    expect(harness.gitStatus).toHaveBeenCalledWith({ environmentId: ENV, cwd: "/repo" });
    expect(lastInput().worktree).toEqual({
      shouldMaterializeLegacyBranchWorktree: true,
      baseBranchForWorktree: "feature/queued",
      shouldCreateWorktree: true,
    });
  });

  it("sends a branch thread in place when its branch is the one checked out", async () => {
    seedThread("main");
    await sendQueuedMessageInBackground(KEY, queued(), { onBeforeTurnStart: vi.fn() });
    expect(lastInput().worktree).toEqual({
      shouldMaterializeLegacyBranchWorktree: false,
      baseBranchForWorktree: null,
      shouldCreateWorktree: false,
    });
  });

  it("defers a branch thread while the checked-out branch cannot be read", async () => {
    seedThread("feature/queued");
    harness.gitStatus.mockRejectedValue(new Error("socket closed"));
    expect(
      await sendQueuedMessageInBackground(KEY, queued(), { onBeforeTurnStart: vi.fn() }),
    ).toEqual({ kind: "deferred" });
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("never reads git status for a thread without a branch", async () => {
    await sendQueuedMessageInBackground(KEY, queued(), { onBeforeTurnStart: vi.fn() });
    expect(harness.gitStatus).not.toHaveBeenCalled();
  });
});
