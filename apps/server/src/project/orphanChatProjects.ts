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
 * @module OrphanChatProjects
 */
import { CommandId, type OrchestrationCommand } from "@ryco/contracts";
import { isChatProject } from "@ryco/shared/projectKind";
import { Duration, Effect } from "effect";

import type { ProjectionProjectRepositoryShape } from "../persistence/Services/ProjectionProjects.ts";
import {
  isRolledBackThreadCreation,
  type ProjectionThreadRepositoryShape,
} from "../persistence/Services/ProjectionThreads.ts";
import type { ChatFoldersShape } from "./chatFolders.ts";

/** Younger chats may belong to a first send that is still being retried. */
export const ORPHAN_CHAT_PROJECT_MIN_AGE = Duration.hours(1);

export interface OrphanChatProjectDependencies {
  readonly projects: Pick<ProjectionProjectRepositoryShape, "listAll">;
  /** Every thread row: live, archived, in Trash, or deleted but retained. */
  readonly threads: Pick<ProjectionThreadRepositoryShape, "listByProjectId">;
  /** Removes a folder only when it is empty and strictly inside the chats root. */
  readonly chatFolders: Pick<ChatFoldersShape, "removeEmptyChatFolder">;
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

/**
 * Delete every chat project older than {@link ORPHAN_CHAT_PROJECT_MIN_AGE} that has no
 * conversation (every thread row, if any, is a rolled-back creation), then remove its folder if it
 * is empty and inside the chats root. The delete is guarded by the record's `updatedAt` and an
 * empty live thread set, so a chat that gains a thread or changes meanwhile is kept.
 */
export const removeOrphanChatProjects = Effect.fn("removeOrphanChatProjects")(function* (
  deps: OrphanChatProjectDependencies,
) {
  const cutoffMs =
    (deps.now ?? (() => new Date()))().getTime() - Duration.toMillis(ORPHAN_CHAT_PROJECT_MIN_AGE);
  const chats = (yield* deps.projects.listAll()).filter(
    (project) =>
      isChatProject(project) &&
      project.deletedAt === null &&
      Date.parse(project.createdAt) < cutoffMs,
  );
  let orphans = 0;
  let deleted = 0;
  let foldersRemoved = 0;
  let skipped = 0;
  for (const chat of chats) {
    // Live, archived, trashed and used-then-deleted threads all keep the chat.
    const threads = yield* deps.threads.listByProjectId({ projectId: chat.projectId });
    if (!threads.every(isRolledBackThreadCreation)) continue;
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
