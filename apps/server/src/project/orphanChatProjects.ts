/**
 * OrphanChatProjects - chat projects that never got a conversation.
 *
 * A chat's project is created right before its first thread. When that first send fails, the chat
 * is kept so a retry reuses it (see `ws/context/chatBootstrap.ts`); a send that failed after its
 * thread was created rolls that thread back, leaving only a deleted, never-used row. A chat nobody
 * retried has no conversation at all, so nothing shows or reaches it: startup removes it once it
 * is old enough that no send can still be retrying it. Its folder goes too, but only when it is
 * empty and inside the chats root; files are never deleted here.
 *
 * The candidates come from one SQL anti-join (`listOrphanChatProjects`), not a thread read per
 * chat, and the sweep runs after the command gate opens.
 *
 * A chat fork (`new-chat` destination) creates its chat project before it publishes the fork's
 * thread, and may wait longer than any age limit (a server that was down, a retry the client has
 * not sent yet). The fork ledger names those chats; the sweep never retires one of them.
 *
 * @module OrphanChatProjects
 */
import { CommandId, type OrchestrationCommand, type ProjectId } from "@ryco/contracts";
import { Duration, Effect } from "effect";

import type { ThreadForkRepositoryError } from "../persistence/Errors.ts";
import type { ProjectionProjectRepositoryShape } from "../persistence/Services/ProjectionProjects.ts";
import type { ThreadForkRepositoryShape } from "../persistence/Services/ThreadForks.ts";
import type { ThreadForkLedgerRow } from "../threadFork/forkLedger.ts";
import type { ChatFoldersShape } from "./chatFolders.ts";

/** Younger chats may belong to a first send that is still being retried. */
export const ORPHAN_CHAT_PROJECT_MIN_AGE = Duration.hours(1);

export interface OrphanChatProjectDependencies {
  /**
   * Active chat projects older than the cutoff whose thread rows (live, archived, in Trash, or
   * deleted but retained) are all rolled-back creations, if they have any.
   */
  readonly projects: Pick<ProjectionProjectRepositoryShape, "listOrphanChatProjects">;
  /** Removes a folder only when it is empty and strictly inside the chats root. */
  readonly chatFolders: Pick<ChatFoldersShape, "removeEmptyChatFolder">;
  /** The chat fork ledger: forks still bound for a new chat keep it ({@link forkHeldChatProjectIds}). */
  readonly threadForks: Pick<ThreadForkRepositoryShape, "listUnfinished" | "listRetryableFailed">;
  /** Server-internal dispatch. */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<unknown, { readonly message: string }>;
  readonly now?: () => Date;
}

export interface OrphanChatProjectSweep {
  /** Chat projects old enough with no conversation: no thread but rolled-back creations. */
  readonly orphans: number;
  readonly deleted: number;
  readonly foldersRemoved: number;
  /** Refused, usually because a thread arrived meanwhile; retried on the next start. */
  readonly skipped: number;
}

/** Any `failed` row a client may still retry, however long ago it failed. */
const ANY_TIME = "9999-12-31T23:59:59.999Z";

const forkChatProjectIds = (row: ThreadForkLedgerRow): ReadonlyArray<ProjectId> => [
  ...(row.plan.checkout.kind === "new-chat" ? [row.plan.checkout.projectId] : []),
  ...(row.checkout?.kind === "new-chat" ? [row.checkout.projectId] : []),
];

/**
 * Chat projects a `new-chat` fork still needs: its run is unfinished (it resumes at startup), or
 * it failed and a retry with the same key would resume it in the same chat. A settled fork holds
 * nothing; its unused chat is an orphan like any other. Read after the chats are listed: a fork
 * creates its chat only after its row exists, so every listed fork chat has a visible row.
 */
export const forkHeldChatProjectIds = (
  threadForks: OrphanChatProjectDependencies["threadForks"],
): Effect.Effect<ReadonlySet<ProjectId>, ThreadForkRepositoryError> =>
  Effect.gen(function* () {
    const unfinished = yield* threadForks.listUnfinished();
    const retryable = yield* threadForks.listRetryableFailed({ updatedBefore: ANY_TIME });
    return new Set([...unfinished, ...retryable].flatMap(forkChatProjectIds));
  });

/**
 * Delete every chat project older than {@link ORPHAN_CHAT_PROJECT_MIN_AGE} that has no
 * conversation (every thread row, if any, is a rolled-back creation), then remove its folder if it
 * is empty and inside the chats root. The delete is guarded by the record's `updatedAt` and an
 * empty live thread set, so a chat that gains a thread or changes meanwhile is kept. A chat a fork
 * still needs is never a candidate.
 */
export const removeOrphanChatProjects = Effect.fn("removeOrphanChatProjects")(function* (
  deps: OrphanChatProjectDependencies,
) {
  const cutoffMs =
    (deps.now ?? (() => new Date()))().getTime() - Duration.toMillis(ORPHAN_CHAT_PROJECT_MIN_AGE);
  // Live, archived, trashed and used-then-deleted threads all keep the chat.
  const chats = yield* deps.projects.listOrphanChatProjects({
    createdBefore: new Date(cutoffMs).toISOString(),
  });
  // An unreadable ledger fails the sweep before anything is deleted; the next start retries.
  const heldByForks = chats.length > 0 ? yield* forkHeldChatProjectIds(deps.threadForks) : null;
  let orphans = 0;
  let deleted = 0;
  let foldersRemoved = 0;
  let skipped = 0;
  for (const chat of chats) {
    if (heldByForks?.has(chat.projectId)) continue;
    orphans += 1;
    const removed = yield* deps
      .dispatch({
        type: "project.delete",
        commandId: CommandId.make(`server:chat-project-orphan:${crypto.randomUUID()}`),
        projectId: chat.projectId,
        expectedUpdatedAt: chat.updatedAt,
        expectedThreadIds: [],
      })
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("kept a chat project without threads", {
            projectId: chat.projectId,
            cause: cause.message,
          }).pipe(Effect.as(false)),
        ),
      );
    if (!removed) {
      skipped += 1;
      continue;
    }
    deleted += 1;
    if (yield* deps.chatFolders.removeEmptyChatFolder(chat.workspaceRoot)) foldersRemoved += 1;
  }
  const sweep: OrphanChatProjectSweep = { orphans, deleted, foldersRemoved, skipped };
  yield* orphans > 0
    ? Effect.logInfo("removed chat projects without threads", sweep)
    : Effect.logDebug("no chat projects without threads", sweep);
  return sweep;
});
