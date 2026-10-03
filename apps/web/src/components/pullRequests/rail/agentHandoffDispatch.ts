import {
  buildSendTurnBootstrap,
  commitSendTurnDispatch,
} from "@ryco/client-runtime/state/composer";
import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type AgentTokenMode,
  type CommandId,
  type ComposerSourceControlContext,
  type EnvironmentApi,
  type GitCreateWorktreeForProjectOutput,
  type MessageId,
  type ModelSelection,
  type ProjectId,
  type SourceControlChangeRequestDetail,
  type ThreadId,
  truncateSourceControlDetailContent,
} from "@ryco/contracts";

import type { HandoffWorkLocation } from "./agentThreads.logic";

/**
 * Starts an agent hand-off thread without leaving the page: the thread is
 * created on the pull request's checkout and its first turn (prompt plus the
 * pull request as source-control context) is dispatched through the same
 * send engine the composer commits with (`commitSendTurnDispatch`), so the
 * server sees exactly what a sent draft would produce.
 *
 * - Existing checkout (a live worktree, or the project on the head branch):
 *   `thread.turn.start` bootstraps the thread there.
 * - No checkout yet: `createWorktreeForProject({ intent: pr })` checks the pull
 *   request out (or reuses its worktree) and creates the thread; the turn is
 *   then dispatched into that thread.
 */
export interface HandoffDispatchInput {
  readonly api: EnvironmentApi;
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  readonly pullRequestNumber: number;
  readonly location: HandoffWorkLocation;
  /** Thread title (the prompt's own words, as a sent draft would title it). */
  readonly title: string;
  /** First message: the prompt plus any quoted material. */
  readonly prompt: string;
  readonly context: ComposerSourceControlContext | null;
  readonly modelSelection: ModelSelection;
  readonly tokenMode: AgentTokenMode;
  readonly newThreadId: () => ThreadId;
  readonly newMessageId: () => MessageId;
  readonly newCommandId: () => CommandId;
  /** Reports the created worktree (submodule setup notices). */
  readonly onWorktreeCreated?: ((created: GitCreateWorktreeForProjectOutput) => void) | undefined;
  readonly now?: (() => Date) | undefined;
}

export async function dispatchHandoffThread(
  input: HandoffDispatchInput,
): Promise<{ readonly threadId: ThreadId }> {
  const { api, location } = input;
  const createdAt = (input.now?.() ?? new Date()).toISOString();
  const runtimeMode = DEFAULT_RUNTIME_MODE;
  const interactionMode = DEFAULT_PROVIDER_INTERACTION_MODE;

  let threadId: ThreadId;
  let isServerThread: boolean;
  let bootstrap: ReturnType<typeof buildSendTurnBootstrap>;
  if (location.kind === "new-worktree") {
    const createWorktree = api.git.createWorktreeForProject;
    if (!createWorktree) throw new Error("Worktree creation is unavailable in this environment.");
    // Creates (or reuses) the pull request's worktree and a thread attached to it.
    const created = await createWorktree({
      projectId: input.projectId,
      intent: { kind: "pr", number: input.pullRequestNumber },
    });
    input.onWorktreeCreated?.(created);
    threadId = created.sessionId;
    isServerThread = true;
    bootstrap = undefined;
  } else {
    threadId = input.newThreadId();
    isServerThread = false;
    bootstrap = buildSendTurnBootstrap({
      isLocalDraftThread: true,
      baseBranchForWorktree: null,
      shouldMaterializeLegacyBranchWorktree: false,
      projectId: input.projectId,
      projectCwd: input.projectCwd,
      title: input.title,
      threadCreateModelSelection: input.modelSelection,
      runtimeMode,
      interactionMode,
      tokenMode: input.tokenMode,
      activeThreadBranch: location.branch || null,
      worktreePath: location.kind === "existing-worktree" ? location.worktreePath : null,
      threadCreatedAt: createdAt,
    });
  }

  await commitSendTurnDispatch({
    api,
    threadId,
    isFirstMessage: true,
    isServerThread,
    title: input.title,
    messageId: input.newMessageId(),
    outgoingMessageText: input.prompt,
    turnAttachments: [],
    modelSelection: input.modelSelection,
    runtimeMode,
    interactionMode,
    tokenMode: input.tokenMode,
    bootstrap,
    sourceControlContexts: input.context ? [input.context] : [],
    createdAt,
    newCommandId: input.newCommandId,
    beginLocalDispatch: () => undefined,
    // The turn itself carries runtime, interaction and token modes.
    persistThreadSettingsForNextTurn: () => Promise.resolve(),
  });
  return { threadId };
}

/**
 * The page's own detail under the composer's caps: body and comments cut to
 * the shared `SOURCE_CONTROL_DETAIL_*` limits, and none of the files or
 * commits the page reads for its other tabs.
 */
export function capHandoffContextDetail(
  detail: SourceControlChangeRequestDetail,
): SourceControlChangeRequestDetail {
  const { files: _files, commits: _commits, ...rest } = detail;
  const content = truncateSourceControlDetailContent({
    body: detail.body,
    // The shared caps read plain comment fields; each comment rides along.
    comments: detail.comments.map((comment) => ({
      author: comment.author,
      body: comment.body,
      createdAt: "",
      comment,
    })),
  });
  return {
    ...rest,
    body: content.body,
    comments: content.comments.map((entry) => ({ ...entry.comment, body: entry.body })),
    truncated: detail.truncated || content.truncated,
  };
}
