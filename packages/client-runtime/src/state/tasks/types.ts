import type { CommandId, LocalTask, ThreadId } from "@ryco/contracts";

import type { SidebarThreadSummary } from "../threads/types.ts";

/** The fields of a task one save can change; absent fields stay as they are. */
export type LocalTaskPatch = Partial<
  Pick<LocalTask, "title" | "notes" | "priority" | "dueAt" | "projectId" | "state" | "links">
>;

/**
 * A chat this client asked the node to start that the node has not confirmed
 * yet. It shows as "Starting" until the task the node returns (or a read)
 * carries a delegation with the same command id.
 */
export interface LocalTaskOptimisticStart {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly status: "starting";
  /** The worktree branch the start asked for; `null` for an existing checkout. */
  readonly branch: string | null;
  readonly createdAt: string;
}

/**
 * What this client changed about one task that the node has not confirmed.
 * The writer (`createLocalTaskWriter`) owns it; reads never touch it except to
 * drop starts the node now knows.
 */
export interface LocalTaskOverlay {
  /** Fields sent or waiting to be sent, newest value per field. */
  readonly patch: LocalTaskPatch | null;
  /** When `patch` last changed, so a task just checked off sorts as just updated. */
  readonly patchedAt: string | null;
  /** Deleted here; the delete is in flight. */
  readonly hidden: boolean;
  readonly optimisticStarts: ReadonlyArray<LocalTaskOptimisticStart>;
  /** Created here and not on the node yet: the task to show until it is. */
  readonly created: LocalTask | null;
}

/** A task as this client shows it: the node's task with the overlay applied. */
export interface LocalTaskView extends LocalTask {
  /** Starts the node has not confirmed yet, oldest first. */
  readonly optimisticStarts: ReadonlyArray<LocalTaskOptimisticStart>;
  /** Created here; the node has not confirmed it yet. */
  readonly creating: boolean;
  /** A change made here is waiting for the node. */
  readonly saving: boolean;
}

/** What the task rules read from a live thread (a full `SidebarThreadSummary` fits). */
export type LocalTaskThreadSummary = Pick<
  SidebarThreadSummary,
  | "session"
  | "latestTurn"
  | "interactionMode"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "hasActionableProposedPlan"
  | "backgroundLiveness"
  | "branch"
>;

/**
 * Looks up a thread of the tasks' environment in the live thread store.
 * `undefined` when the client has no full summary for it (not loaded yet,
 * archived, or deleted): the node's own word is used then.
 */
export type LocalTaskThreadSummaryReader = (
  threadId: ThreadId,
) => LocalTaskThreadSummary | null | undefined;
