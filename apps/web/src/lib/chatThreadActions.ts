import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@ryco/contracts";
import type { DraftThreadEnvMode } from "../composerDraftStore";

interface ThreadContextLike {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  branch: string | null;
  worktreePath: string | null;
}

interface DraftThreadContextLike extends ThreadContextLike {
  envMode: DraftThreadEnvMode;
}

interface NewThreadHandler {
  (
    projectRef: ScopedProjectRef,
    options?: {
      branch?: string | null;
      worktreePath?: string | null;
      envMode?: DraftThreadEnvMode;
    },
  ): Promise<void>;
}

type NewThreadOptions = NonNullable<Parameters<NewThreadHandler>[1]>;

export interface ChatThreadActionContext {
  readonly activeDraftThread: DraftThreadContextLike | null;
  readonly activeThread: ThreadContextLike | undefined;
  readonly defaultProjectRef: ScopedProjectRef | null;
  readonly defaultThreadEnvMode: DraftThreadEnvMode;
  readonly handleNewThread: NewThreadHandler;
  /**
   * The active thread or draft is a "No project" chat. A chat holds one thread,
   * so "new thread" from it starts another chat rather than a second thread in
   * the same chat folder.
   */
  readonly activeContextIsChat?: boolean;
  /** Where a new "No project" chat starts; null/absent when chats are unavailable. */
  readonly chatTarget?: { readonly environmentId: EnvironmentId } | null;
  readonly handleNewChat?: (environmentId: EnvironmentId) => Promise<void>;
}

export function resolveThreadActionProjectRef(
  context: ChatThreadActionContext,
): ScopedProjectRef | null {
  // A chat's project is never a "new thread" target; fall back to the default.
  if (!context.activeContextIsChat) {
    if (context.activeThread) {
      return scopeProjectRef(context.activeThread.environmentId, context.activeThread.projectId);
    }
    if (context.activeDraftThread) {
      return scopeProjectRef(
        context.activeDraftThread.environmentId,
        context.activeDraftThread.projectId,
      );
    }
  }
  return context.defaultProjectRef;
}

function buildContextualThreadOptions(context: ChatThreadActionContext): NewThreadOptions {
  return {
    branch: context.activeThread?.branch ?? context.activeDraftThread?.branch ?? null,
    worktreePath:
      context.activeThread?.worktreePath ?? context.activeDraftThread?.worktreePath ?? null,
    envMode:
      context.activeDraftThread?.envMode ??
      (context.activeThread?.worktreePath ? "worktree" : "local"),
  };
}

function buildDefaultThreadOptions(): NewThreadOptions {
  // The owning node resolves the project's current default, including overrides.
  return {};
}

export async function startNewThreadInProjectFromContext(
  context: ChatThreadActionContext,
  projectRef: ScopedProjectRef,
): Promise<void> {
  await context.handleNewThread(
    projectRef,
    !context.activeContextIsChat && (context.activeThread || context.activeDraftThread)
      ? buildContextualThreadOptions(context)
      : buildDefaultThreadOptions(),
  );
}

/** Opens a "No project" chat draft; false when chats are unavailable. */
export async function startNewChatFromContext(context: ChatThreadActionContext): Promise<boolean> {
  if (!context.chatTarget || !context.handleNewChat) {
    return false;
  }
  await context.handleNewChat(context.chatTarget.environmentId);
  return true;
}

export async function startNewThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  if (context.activeContextIsChat && (await startNewChatFromContext(context))) {
    return true;
  }
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    // Without any project the only place to start is a chat.
    return startNewChatFromContext(context);
  }

  await startNewThreadInProjectFromContext(context, projectRef);
  return true;
}

export async function startNewLocalThreadFromContext(
  context: ChatThreadActionContext,
): Promise<boolean> {
  if (context.activeContextIsChat && (await startNewChatFromContext(context))) {
    return true;
  }
  const projectRef = resolveThreadActionProjectRef(context);
  if (!projectRef) {
    return startNewChatFromContext(context);
  }

  await context.handleNewThread(projectRef, buildDefaultThreadOptions());
  return true;
}
