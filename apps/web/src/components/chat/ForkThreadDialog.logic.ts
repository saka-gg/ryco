// FILE: ForkThreadDialog.logic.ts
// Purpose: Presentation glue for the fork dialog: which folder answers "is this
//          Git?", and which notices the dialog shows. The attempt itself (keys,
//          locks, retries, outcomes, what the form shows, copy) is the shared
//          fork-attempt controller and state machine in
//          `@ryco/client-runtime/state/threads`; nothing here re-decides it.
// Layer: Web UI logic, pure.

import type {
  ThreadForkAttemptNotice,
  ThreadForkAttemptView,
} from "@ryco/client-runtime/state/threads";

/**
 * The folder whose Git status decides whether "New worktree" is offered: the
 * project root, as the node checks it (`isGitRepository(project.workspaceRoot)`)
 * and the native app reads it. Never the source thread's own checkout: a removed
 * worktree would hide an option the node accepts. A chat folder is never asked.
 */
export function forkSourceGitCwd(input: {
  readonly project: { readonly cwd: string } | null | undefined;
  readonly isChat: boolean;
}): string | null {
  return input.project && !input.isChat ? input.project.cwd : null;
}

/** Headline of the notice shown while forking cannot be sent from this dialog. */
export const FORK_BLOCKED_TITLE = "Can't fork right now";

export interface ForkDialogNotice {
  /** `attempt`: what the shared attempt says; `blocked`: why nothing can be sent now. */
  readonly kind: "attempt" | "blocked";
  readonly notice: ThreadForkAttemptNotice;
}

/**
 * The notices the dialog shows, in order. Why forking is blocked right now (the
 * source is gone, or hosted access or the relay is stale) replaces an editable
 * attempt's notice, but never a locked attempt's: "may have been created" and
 * "still being prepared" stay visible above it, so a blocked dialog never hides
 * that a fork may already exist.
 */
export function forkDialogNotices(input: {
  readonly view: Pick<ThreadForkAttemptView, "locked" | "notice">;
  readonly blocked: string | null;
}): ReadonlyArray<ForkDialogNotice> {
  const { view, blocked } = input;
  const notices: ForkDialogNotice[] = [];
  if (view.notice && (view.locked || blocked === null)) {
    notices.push({ kind: "attempt", notice: view.notice });
  }
  if (blocked !== null) {
    notices.push({
      kind: "blocked",
      notice: { tone: "error", title: FORK_BLOCKED_TITLE, message: blocked, detail: null },
    });
  }
  return notices;
}
