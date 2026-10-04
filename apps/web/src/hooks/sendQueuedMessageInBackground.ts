import { parseScopedThreadKey, scopeProjectRef } from "@ryco/client-runtime/scoped";
import {
  isClaudeResumeReviewError,
  selectionAllowedAtSendBoundary,
} from "@ryco/client-runtime/state/composer";
import type { QueueSendHooks, QueueSendResult } from "@ryco/client-runtime/state/message-queue";
import { MessageId } from "@ryco/contracts";
import { projectScriptCwd } from "@ryco/shared/projectScripts";
import { rejectRetiredProjectMemory } from "@ryco/shared/retiredFeatures";

import { readEnvironmentApi } from "../environmentApi";
import { readWebQueueEnvironment } from "../messageQueueEnvironment";
import type { WebQueuedMessage } from "../messageQueueStore";
import { defaultQueryClient } from "../rpc/queryClient";
import { selectProjectByRef, selectThreadByRef, useStore } from "../store";
import {
  applyBuildModeToSend,
  attachDevicePromptScreenshot,
  createSourceControlContextFetcher,
  formatOutgoingPrompt,
  persistThreadSettingsForNextTurn,
  resolveEnforceBuildMode,
} from "./chatSendShared";
import { executeChatSendTurn } from "./executeChatSendTurn";

export const QUEUED_SELECTION_NEEDS_HANDOFF_MESSAGE =
  "The queued provider or model needs a context handoff. Open the conversation to send it.";

const noop = () => {};

/**
 * Headless sender for a queued message on a started server thread whose
 * ChatView is not mounted. It never shows a dialog or a toast: a Claude resume
 * that needs review becomes a `needs-review` result (a review hold) instead.
 */
export async function sendQueuedMessageInBackground(
  threadKey: string,
  entry: WebQueuedMessage,
  hooks: QueueSendHooks,
): Promise<QueueSendResult> {
  const ref = parseScopedThreadKey(threadKey);
  if (!ref) return { kind: "deferred" };
  const state = useStore.getState();
  const thread = selectThreadByRef(state, ref);
  const project = thread
    ? selectProjectByRef(state, scopeProjectRef(ref.environmentId, thread.projectId))
    : undefined;
  const api = readEnvironmentApi(ref.environmentId);
  if (!thread || !project || !api) return { kind: "deferred" };
  if (!readWebQueueEnvironment(ref.environmentId, state).mutationReady) {
    return { kind: "deferred" };
  }
  try {
    rejectRetiredProjectMemory(entry.composer);
  } catch {
    return { kind: "failed" };
  }

  const setThreadError = (error: string | null) => {
    useStore.getState().setThreadError(ref, error);
  };
  const buildMode = applyBuildModeToSend({
    composer: entry.composer,
    settings: entry.settings,
    enforceBuildMode: resolveEnforceBuildMode(),
  });
  // A queued send always sees a non-empty queue, so the foreground policy is
  // continuation-only here too.
  if (
    !selectionAllowedAtSendBoundary({
      threadStarted: true,
      policy: {
        mode: "continuation-only",
        lockedProvider: thread.session?.provider ?? null,
        reason: "queued-message",
      },
      canonicalSelection: thread.modelSelection,
      targetSelection: buildMode.composer.selectedModelSelection,
    })
  ) {
    setThreadError(QUEUED_SELECTION_NEEDS_HANDOFF_MESSAGE);
    return { kind: "failed" };
  }
  const composer = await attachDevicePromptScreenshot({
    api,
    threadId: thread.id,
    composer: buildMode.composer,
  });

  const captured: { error: unknown } = { error: null };
  const accepted = await executeChatSendTurn({
    messageId: MessageId.make(entry.id),
    preserveComposerDraft: true,
    claudeCacheReview: null,
    suppressToasts: true,
    onBeforeTurnStart: hooks.onBeforeTurnStart,
    onSendError: (error) => {
      captured.error = error;
    },
    composer,
    thread: {
      threadId: thread.id,
      sourceProviderDriver: thread.session?.provider ?? null,
      isFirstMessage: false,
      isServerThread: true,
      isLocalDraftThread: false,
      activeThreadBranch: thread.branch,
      worktreePath: thread.worktreePath,
      createdAt: thread.createdAt,
      projectId: thread.projectId,
    },
    worktree: {
      shouldMaterializeLegacyBranchWorktree: false,
      baseBranchForWorktree: null,
      shouldCreateWorktree: false,
    },
    settings: buildMode.settings,
    project: { projectId: project.id, projectCwd: project.cwd },
    scroll: { scrollToEndBeforeOptimistic: async () => {}, scrollToEndAfterOptimistic: noop },
    draft: {
      composerDraftTarget: ref,
      environmentId: ref.environmentId,
      clearComposerDraftContent: noop,
      setComposerDraftTokenMode: noop,
      setComposerDraftPrompt: noop,
      removeComposerDraftImage: noop,
      addComposerDraftImages: noop,
      setComposerDraftTerminalContexts: noop,
      setDraftThreadContext: noop,
    },
    dispatch: {
      api,
      beginLocalDispatch: noop,
      resetLocalDispatch: noop,
      setOptimisticUserMessages: noop,
      setThreadError: (_threadId, error) => setThreadError(error),
    },
    refs: {
      promptRef: { current: "" },
      composerImagesRef: { current: [] },
      composerTerminalContextsRef: { current: [] },
      sendInFlightRef: { current: false },
    },
    sourceControl: {
      fetcher: createSourceControlContextFetcher({
        environmentId: ref.environmentId,
        cwd: projectScriptCwd({
          project: { cwd: project.cwd },
          worktreePath: thread.worktreePath,
        }),
        queryClient: defaultQueryClient,
      }),
    },
    persistSettings: {
      persistThreadSettingsForNextTurn: (input) =>
        persistThreadSettingsForNextTurn(api, thread, input),
    },
    composerHandle: { readComposer: () => null },
    formatOutgoingPrompt,
  });
  if (accepted) return { kind: "accepted" };
  if (isClaudeResumeReviewError(captured.error)) {
    // The review hold carries this; do not repeat it as a thread error.
    setThreadError(null);
    return { kind: "needs-review", detail: captured.error.message };
  }
  return { kind: "failed" };
}
