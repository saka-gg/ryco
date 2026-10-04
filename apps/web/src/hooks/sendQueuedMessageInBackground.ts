import { parseScopedThreadKey, scopeProjectRef } from "@ryco/client-runtime/scoped";
import {
  isClaudeResumeReviewError,
  selectionAllowedAtSendBoundary,
} from "@ryco/client-runtime/state/composer";
import type { QueueSendHooks, QueueSendResult } from "@ryco/client-runtime/state/message-queue";
import { MessageId, type EnvironmentId } from "@ryco/contracts";
import { projectScriptCwd } from "@ryco/shared/projectScripts";
import { rejectRetiredProjectMemory } from "@ryco/shared/retiredFeatures";

import { resolveChatSendWorktreePlan } from "../components/ChatView.logic";
import { readEnvironmentApi } from "../environmentApi";
import { readLocalGitRefName } from "../lib/gitStatusState";
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
import { executeChatSendTurn, type SendTurnWorktreePlan } from "./executeChatSendTurn";

export const QUEUED_SELECTION_NEEDS_HANDOFF_MESSAGE =
  "The queued provider or model needs a context handoff. Open the conversation to send it.";
export const QUEUED_BRANCH_UNREADABLE_MESSAGE =
  "The queued message could not check which branch the project checkout is on. Open the conversation to send it.";

/**
 * Background sends in a row that could not read the checkout's branch before
 * the head fails visibly. Each read waits up to its own timeout, so this bounds
 * the silent retrying to a few seconds instead of polling forever.
 */
export const MAX_UNREADABLE_BRANCH_ATTEMPTS = 3;
const unreadableBranchAttemptsByThreadKey = new Map<string, number>();

const noop = () => {};

const NO_WORKTREE_PLAN: SendTurnWorktreePlan = {
  shouldMaterializeLegacyBranchWorktree: false,
  baseBranchForWorktree: null,
  shouldCreateWorktree: false,
};

/**
 * The same worktree plan the foreground ChatView computes for a started thread.
 * A legacy branch thread (a branch, no worktree) whose branch is not the one
 * checked out in the project root gets that branch's worktree materialized
 * first, so the agent never edits the root checkout on the wrong branch. The
 * branch comes from local status only (no remote or change-request lookup);
 * null when it cannot be read now.
 */
export async function resolveBackgroundWorktreePlan(input: {
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}): Promise<SendTurnWorktreePlan | null> {
  if (input.branch === null || input.worktreePath !== null) return NO_WORKTREE_PLAN;
  const refName = await readLocalGitRefName({
    environmentId: input.environmentId,
    cwd: input.projectCwd,
  }).catch(() => undefined);
  if (refName === undefined) return null;
  return resolveChatSendWorktreePlan({
    isServerThread: true,
    isFirstMessage: false,
    threadWorktreePath: null,
    activeThreadBranch: input.branch,
    currentGitRefName: refName,
    // Only a first message reads the env mode.
    sendEnvMode: "local",
  });
}

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
  const worktree = await resolveBackgroundWorktreePlan({
    environmentId: ref.environmentId,
    projectCwd: project.cwd,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
  });
  if (worktree === null) {
    // The checkout's branch is unknown: sending could run the agent on whatever
    // branch the project root has checked out. Retry a few times, then fail the
    // head visibly (thread error and Retry) rather than wait forever unseen.
    const attempts = (unreadableBranchAttemptsByThreadKey.get(threadKey) ?? 0) + 1;
    if (attempts < MAX_UNREADABLE_BRANCH_ATTEMPTS) {
      unreadableBranchAttemptsByThreadKey.set(threadKey, attempts);
      return { kind: "deferred" };
    }
    unreadableBranchAttemptsByThreadKey.delete(threadKey);
    setThreadError(QUEUED_BRANCH_UNREADABLE_MESSAGE);
    return { kind: "failed" };
  }
  unreadableBranchAttemptsByThreadKey.delete(threadKey);
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
    worktree,
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
