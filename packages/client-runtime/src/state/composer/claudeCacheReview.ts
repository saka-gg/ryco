import {
  CommandId,
  MessageId,
  type ClaudeResumeGuard,
  type OrchestrationThread,
} from "@ryco/contracts";
import { assessClaudeCacheResume } from "@ryco/shared/claudeCacheReview";
import type { ClaudeCacheReview } from "@ryco/shared/claudeCacheReview";
import type { CommitSendTurnDispatchInput } from "./sendEngine.ts";

export {
  assessClaudeCacheResume,
  latestClaudeCacheObservation,
  type ClaudeCacheReview,
} from "@ryco/shared/claudeCacheReview";

export class ClaudeResumeReviewError extends Error {
  readonly _tag = "ClaudeResumeReviewError";
}
export function isClaudeResumeReviewError(error: unknown): error is ClaudeResumeReviewError {
  return error instanceof ClaudeResumeReviewError;
}

export type ClaudeCacheReviewChoice = "continue" | "compact" | "cancel";
export interface ClaudeCacheReviewPresentation {
  readonly review: (review: ClaudeCacheReview) => Promise<ClaudeCacheReviewChoice>;
  /** Returns a disposer for the progress presentation. Cancel only stops the held send. */
  readonly compacting?: (cancel: () => void) => () => void;
}

function identity(thread: OrchestrationThread): string {
  return JSON.stringify([
    thread.session?.runtimeSessionId,
    thread.session?.providerInstanceId,
    thread.modelSelection,
  ]);
}

/**
 * Holds the caller's original message/attachments. Only an attachment-free native
 * /compact is dispatched first. A matching boundary AND settled successful turn
 * are required; successful no-op results, reconnects and replacement fail closed.
 */
export async function reviewClaudeResumeBeforeSend(
  input: CommitSendTurnDispatchInput,
): Promise<{ guard: ClaudeResumeGuard } | undefined> {
  if (
    input.providerDriver !== "claudeAgent" ||
    (input.sourceProviderDriver !== undefined && input.sourceProviderDriver !== "claudeAgent")
  )
    return undefined;
  const getWindow = input.api.orchestration.getThreadWindow;
  if (
    !input.isServerThread ||
    input.isFirstMessage ||
    !getWindow ||
    input.outgoingMessageText.trim().startsWith("/")
  )
    return undefined;
  const read = async () =>
    (
      await getWindow({
        threadId: input.threadId,
        limits: { messages: 1, activities: 40, checkpoints: 1, proposedPlans: 1 },
      })
    ).thread;
  input.assertMutationReady?.();
  const before = await read();
  const review = assessClaudeCacheResume(before, input.modelSelection, Date.now());
  if (!review) return undefined;
  const presentation = input.claudeCacheReview;
  if (!presentation)
    throw new ClaudeResumeReviewError(
      "This Claude resume needs review. Open the conversation and send again; your message is retained.",
    );
  const choice = await presentation.review(review);
  if (choice === "cancel")
    throw new ClaudeResumeReviewError("Send cancelled. Your message and attachments are retained.");
  input.assertMutationReady?.();
  const current = await read();
  input.assertMutationReady?.();
  const originalIdentity = identity(before);
  if (
    identity(current) !== originalIdentity ||
    current.latestTurn?.turnId !== before.latestTurn?.turnId
  ) {
    throw new ClaudeResumeReviewError(
      "The conversation changed during review. Review and send again; your draft is retained.",
    );
  }
  if (!current.session?.runtimeSessionId)
    throw new ClaudeResumeReviewError(
      "Claude runtime identity is unavailable. Reconnect before sending; your draft is retained.",
    );
  const guardFor = (thread: OrchestrationThread): ClaudeResumeGuard => ({
    runtimeSessionId: current.session!.runtimeSessionId!,
    latestTurnId: thread.latestTurn?.turnId ?? null,
    modelSelection: thread.modelSelection,
    requireReady: choice === "compact",
  });
  if (choice === "continue") return { guard: guardFor(current) };
  if (
    current.session?.status !== "ready" ||
    current.session.activeTurnId ||
    !current.session.runtimeSessionId
  ) {
    throw new ClaudeResumeReviewError(
      "Claude must be ready before compacting. Reconnect and retry; your draft is retained.",
    );
  }
  if (JSON.stringify(current.modelSelection) !== JSON.stringify(input.modelSelection)) {
    throw new ClaudeResumeReviewError(
      "Apply the model or context change before compacting, or continue with full context. Your draft is retained.",
    );
  }
  const compactMessageId = MessageId.make(`claude-resume-compact:${input.messageId}`);
  let cancelled = false;
  const dispose = presentation.compacting?.(() => {
    cancelled = true;
  });
  try {
    input.assertMutationReady?.();
    await input.api.orchestration.dispatchCommand({
      type: "thread.turn.start",
      claudeResumeGuard: guardFor(current),
      commandId: CommandId.make(`claude-resume-compact:${input.messageId}`),
      threadId: input.threadId,
      message: { messageId: compactMessageId, role: "user", text: "/compact", attachments: [] },
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      tokenMode: input.tokenMode,
      createdAt: new Date().toISOString(),
    });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (cancelled)
        throw new ClaudeResumeReviewError(
          "Send cancelled. Compaction may finish, but your original message was not sent.",
        );
      input.assertMutationReady?.();
      const snapshot = await read();
      input.assertMutationReady?.();
      if (cancelled)
        throw new ClaudeResumeReviewError("Send cancelled. Your original message was not sent.");
      if (
        identity(snapshot) !== originalIdentity ||
        snapshot.session?.status === "stopped" ||
        snapshot.session?.status === "error"
      ) {
        throw new ClaudeResumeReviewError(
          "Claude's session changed or disconnected during compaction. Your original message was not sent.",
        );
      }
      const turnId =
        snapshot.latestTurn?.userMessageId === compactMessageId
          ? snapshot.latestTurn.turnId
          : undefined;
      if (
        snapshot.latestTurn?.userMessageId &&
        snapshot.latestTurn.userMessageId !== compactMessageId &&
        snapshot.latestTurn.turnId !== before.latestTurn?.turnId
      ) {
        throw new ClaudeResumeReviewError(
          "Another turn replaced compaction. Your original message was not sent.",
        );
      }
      if (
        turnId &&
        snapshot.latestTurn?.turnId === turnId &&
        snapshot.latestTurn.state !== "running"
      ) {
        const confirmed = snapshot.activities.some(
          (activity) => activity.kind === "context-compaction" && activity.turnId === turnId,
        );
        if (snapshot.latestTurn.state !== "completed" || !confirmed) {
          throw new ClaudeResumeReviewError(
            "Native compaction did not complete successfully. Your message and attachments are retained.",
          );
        }
        if (snapshot.session?.status === "ready" && !snapshot.session.activeTurnId)
          return { guard: guardFor(snapshot) };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new ClaudeResumeReviewError(
      "Compaction could not be confirmed in time. Your original message was not sent; check the conversation before retrying.",
    );
  } catch (error) {
    throw error instanceof ClaudeResumeReviewError
      ? error
      : new ClaudeResumeReviewError(
          error instanceof Error
            ? error.message
            : "Compaction could not be confirmed. Your original message was not sent.",
        );
  } finally {
    dispose?.();
  }
}

export async function revalidateClaudeResumeBeforeCommit(
  input: CommitSendTurnDispatchInput,
  guard: ClaudeResumeGuard,
): Promise<void> {
  input.assertMutationReady?.();
  const snapshot = await input.api.orchestration.getThreadWindow!({
    threadId: input.threadId,
    limits: { messages: 1, activities: 1, checkpoints: 1, proposedPlans: 1 },
  });
  input.assertMutationReady?.();
  const thread = snapshot.thread;
  if (
    thread.session?.runtimeSessionId !== guard.runtimeSessionId ||
    (thread.latestTurn?.turnId ?? null) !== guard.latestTurnId ||
    JSON.stringify(thread.modelSelection) !== JSON.stringify(guard.modelSelection) ||
    thread.session.activeTurnId ||
    (guard.requireReady && thread.session.status !== "ready")
  ) {
    throw new ClaudeResumeReviewError(
      "Claude changed before sending. Review again; your message and attachments are retained.",
    );
  }
}
