import type { OrchestrationEvent, OrchestrationReadModel } from "@ryco/contracts";

export interface ThreadWorkspaceIdentity {
  readonly threadId: string;
  readonly cwd: string;
  readonly worktreePath: string | null;
}

/** Synchronous authority beside the orchestration commit, never a streamed cache. */
export function createWorkspaceCommitFence(read: () => OrchestrationReadModel) {
  let revision = 0;
  let available = true;
  const matches = (input: ThreadWorkspaceIdentity) => {
    const model = read();
    const thread = model.threads.find(
      (thread) => thread.id === input.threadId && !thread.deletedAt,
    );
    const project =
      thread &&
      model.projects.find((project) => project.id === thread.projectId && !project.deletedAt);
    return (
      !!thread &&
      !!project &&
      thread.worktreePath === input.worktreePath &&
      (thread.worktreePath ?? project.workspaceRoot) === input.cwd
    );
  };
  return {
    begin(events: ReadonlyArray<Pick<OrchestrationEvent, "type">>) {
      if (
        !events.some(
          (event) =>
            event.type.startsWith("project.") ||
            event.type === "thread.created" ||
            event.type === "thread.deleted" ||
            event.type === "thread.trashed" ||
            event.type === "thread.untrashed" ||
            event.type === "thread.meta-updated",
        )
      )
        return;
      revision++;
      available = false;
    },
    publish() {
      available = true;
    },
    capture(input: ThreadWorkspaceIdentity): (() => boolean) | undefined {
      if (!available || !matches(input)) return undefined;
      const captured = revision;
      return () => available && captured === revision && matches(input);
    },
  };
}
