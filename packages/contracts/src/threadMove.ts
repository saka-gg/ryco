import * as Schema from "effect/Schema";

import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Moving a thread to another project of the same node ("Move to project").
 *
 * The thread keeps its id, history, attachments and artifacts. It then works in the target
 * project's shared checkout (a chat without a project: its own new folder); a worktree it had
 * stays where it is, registered with the old project. The next turn starts in the new directory
 * with a fresh provider session that receives the conversation (the cwd-relocation handoff), or
 * a native resume where the provider keeps conversations across directories.
 *
 * Checkpoints of turns before the move live in the old checkout's repository, so they are never
 * restored or diffed in the new one: the decider refuses reverts to them and clients hide them.
 * The move's provenance activity (below) is the one record of where that line is.
 */

/** Provenance activity appended to a thread each time it moves to another project. */
export const THREAD_MOVED_ACTIVITY_KIND = "thread.moved";

export const ThreadMovedActivityPayload = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  fromProjectId: ProjectId,
  /** Titles when the thread moved, so the divider reads the same after a rename or delete. */
  fromProjectTitle: TrimmedNonEmptyString,
  toProjectId: ProjectId,
  toProjectTitle: TrimmedNonEmptyString,
  /** The thread's own worktree before the move; it stays with the old project. */
  fromWorktreePath: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * The thread's newest checkpoint turn count when it moved. Checkpoints up to this count were
   * captured in the old checkout: none of them is restored or diffed in the new one. The first
   * turn after the move diffs against a baseline captured in the new checkout under this count.
   */
  checkpointTurnCount: NonNegativeInt,
});
export type ThreadMovedActivityPayload = typeof ThreadMovedActivityPayload.Type;
