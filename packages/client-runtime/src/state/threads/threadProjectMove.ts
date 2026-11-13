/**
 * The client half of "Move to project", shared by web, desktop and mobile: whether a listed
 * thread can move now, where it can go, what the user is told before it moves, and the command.
 * The node re-checks everything (`thread.project.move`); this only keeps menus honest.
 *
 * @module state/threads/threadProjectMove
 */
import type { ClientOrchestrationCommand, CommandId, ProjectId, ThreadId } from "@ryco/contracts";
import { CHAT_PROJECT_TITLE_MAX_CHARS } from "@ryco/contracts/orchestration";
import { isChatProject, type ProjectKindCarrier } from "@ryco/shared/projectKind";
import { threadProjectMoveBlocker, type ThreadProjectMoveBlocker } from "@ryco/shared/threadMove";

import type { SidebarThreadSummary } from "./types.ts";

/** Why a listed thread cannot move now, or null. Server-only signals are left to the node. */
export function threadSummaryMoveBlocker(
  thread: Pick<
    SidebarThreadSummary,
    | "archivedAt"
    | "session"
    | "latestTurn"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "backgroundLiveness"
  >,
): ThreadProjectMoveBlocker | null {
  return threadProjectMoveBlocker({
    archived: thread.archivedAt !== null,
    deleted: false,
    sessionStatus: thread.session?.orchestrationStatus ?? null,
    latestTurnRunning: thread.latestTurn?.state === "running",
    backgroundWorking: thread.backgroundLiveness === "working",
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    queuedTurn: false,
    contextHandoffPending: false,
    checkpointRevertPending: false,
  });
}

export interface MoveTargetProject extends ProjectKindCarrier {
  readonly id: ProjectId;
  readonly name: string;
}

/**
 * The projects a thread can move to: the node's other projects (never a chat's own folder), by
 * name. "No project" is offered separately, for threads not already in a chat.
 */
export function listMoveTargetProjects<P extends MoveTargetProject>(
  projects: ReadonlyArray<P>,
  currentProjectId: ProjectId,
): P[] {
  return projects
    .filter((project) => project.id !== currentProjectId && !isChatProject(project))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

export interface ThreadMoveNoticeInput {
  readonly sourceProjectName: string;
  /** The thread runs in its own worktree, which stays with the old project. */
  readonly worktreePath: string | null;
  /** The thread is a chat without a project: its folder stays where it is. */
  readonly chatFolderPath: string | null;
  readonly activePullRequestWatches: number;
  readonly commandWatchCount: number;
  /** Delegated tasks of this thread that are not archived. */
  readonly delegatedTaskCount: number;
  /** Some earlier turn changed files (it has an undo or diff the move retires). */
  readonly hasFileChanges: boolean;
}

/** What does not come along, one short line each; empty when there is nothing to tell. */
export function threadMoveNotices(input: ThreadMoveNoticeInput): string[] {
  const notices: string[] = [];
  if (input.worktreePath !== null) {
    notices.push(`Its worktree stays in ${input.sourceProjectName}: ${input.worktreePath}`);
  }
  if (input.chatFolderPath !== null) {
    notices.push(`Files in its chat folder stay there: ${input.chatFolderPath}`);
  }
  if (input.hasFileChanges) {
    notices.push("Changes from earlier turns can no longer be undone or shown as diffs.");
  }
  if (input.activePullRequestWatches > 0 || input.commandWatchCount > 0) {
    notices.push("Ryco stops watching for it.");
  }
  if (input.delegatedTaskCount > 0) {
    notices.push(
      input.delegatedTaskCount === 1
        ? `Its delegated task stays in ${input.sourceProjectName}.`
        : `Its ${input.delegatedTaskCount} delegated tasks stay in ${input.sourceProjectName}.`,
    );
  }
  return notices;
}

/** The confirmation text, or null when the move needs none. */
export function threadMoveConfirmation(input: {
  readonly threadTitle: string;
  readonly targetName: string;
  readonly notices: ReadonlyArray<string>;
}): string | null {
  if (input.notices.length === 0) return null;
  return [
    `Move "${input.threadTitle}" to ${input.targetName}?`,
    "",
    "The conversation comes along, and the next message starts the agent in the new folder.",
    ...input.notices.map((notice) => `• ${notice}`),
  ].join("\n");
}

export type ThreadMoveTarget =
  | { readonly kind: "project"; readonly projectId: ProjectId }
  /** A new chat without a project; `projectId` is the new chat's id. */
  | { readonly kind: "new-chat"; readonly projectId: ProjectId };

export function threadProjectMoveCommand(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly currentProjectId: ProjectId;
  readonly target: ThreadMoveTarget;
  readonly createdAt: string;
}): Extract<ClientOrchestrationCommand, { type: "thread.project.move" }> {
  return {
    type: "thread.project.move",
    commandId: input.commandId,
    threadId: input.threadId,
    expectedProjectId: input.currentProjectId,
    projectId: input.target.projectId,
    ...(input.target.kind === "new-chat"
      ? {
          createChatProject: {
            projectId: input.target.projectId,
            titleSeed: input.threadTitle.trim().slice(0, CHAT_PROJECT_TITLE_MAX_CHARS) || "Chat",
          },
        }
      : {}),
    createdAt: input.createdAt,
  };
}
