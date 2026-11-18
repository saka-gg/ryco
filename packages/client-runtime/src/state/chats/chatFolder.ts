// Which chat folder a delete frees, and whether the deleted conversation came
// back. Kept apart from the schedule in `chatFolderDelete.ts`: web's shell needs
// only this, and a module it imports lands in its first load together with
// everything that module imports (here the schedule's promotion error helpers).

import type { EnvironmentId, ProjectId, ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { isChatProject, type ProjectKindCarrier } from "@ryco/shared/projectKind";

/** The folder of a chat whose last conversation is being deleted. */
export interface ChatFolderTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly folderPath: string;
}

/** What the decision reads of one environment's state (an `EnvironmentState` fits). */
export interface ChatFolderEnvironment {
  readonly projectById: Readonly<
    Record<string, (ProjectKindCarrier & { readonly cwd?: string | null }) | undefined>
  >;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly threadShellById: Readonly<Record<string, { readonly projectId: ProjectId } | undefined>>;
}

/**
 * The folder deleting this conversation leaves unused: its project is a chat
 * and no other listed conversation, archived included, belongs to it. Null for
 * every other delete, which never offers the folder.
 */
export function chatFolderFreedByDelete(
  environment: ChatFolderEnvironment,
  threadRef: ScopedThreadRef,
): ChatFolderTarget | null {
  const projectId = environment.threadShellById[threadRef.threadId]?.projectId;
  if (projectId === undefined) return null;
  const project = environment.projectById[projectId];
  if (!isChatProject(project) || !project?.cwd) return null;
  const shared = environment.threadIds.some(
    (threadId) =>
      threadId !== threadRef.threadId &&
      environment.threadShellById[threadId]?.projectId === projectId,
  );
  return shared
    ? null
    : { environmentId: threadRef.environmentId, projectId, folderPath: project.cwd };
}

/**
 * Whether a deleted conversation is listed again: Undo, on this device or
 * another, brought it back, so its chat folder must stay.
 */
export function isDeletedThreadListed(
  environment: Pick<ChatFolderEnvironment, "threadShellById">,
  threadId: ThreadId,
): boolean {
  return environment.threadShellById[threadId] !== undefined;
}
