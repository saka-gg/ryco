import {
  type ClientOrchestrationCommand,
  type CommandId,
  type EnvironmentId,
  type ProjectId,
  type WorktreeId,
} from "@ryco/contracts";

type CommandOf<Type extends ClientOrchestrationCommand["type"]> = Extract<
  ClientOrchestrationCommand,
  { readonly type: Type }
>;

export type ProjectCreateCommand = CommandOf<"project.create">;
export type ProjectMetaUpdateCommand = CommandOf<"project.meta.update">;
export type WorktreeCreateCommand = CommandOf<"worktree.create">;
export type WorktreeMetaUpdateCommand = CommandOf<"worktree.meta.update">;
export type WorktreeArchiveCommand = CommandOf<"worktree.archive">;
export type WorktreeRestoreCommand = CommandOf<"worktree.restore">;

export type WorkspaceMutationReadiness =
  | "ready"
  | "reconnecting"
  | "offline"
  | "read-only"
  | "unauthorized";

type WorkspaceActionErrorCode =
  | "branch-required"
  | "dispatch-failed"
  | "invalid-path"
  | "not-ready"
  | "title-required";

export class WorkspaceActionError extends Error {
  readonly code: WorkspaceActionErrorCode;

  constructor(code: WorkspaceActionErrorCode) {
    super(code);
    this.name = "WorkspaceActionError";
    this.code = code;
  }
}

export function workspaceActionErrorMessage(
  action:
    | "add-project"
    | "rename-project"
    | "create-worktree"
    | "rename-worktree"
    | "archive-worktree"
    | "restore-worktree",
  error: unknown,
): string {
  if (error instanceof WorkspaceActionError) {
    if (error.code === "invalid-path") {
      return "Enter a node workspace path such as /srv/code/app, ~/code/app, or C:\\Code\\app.";
    }
    if (error.code === "title-required") return "Enter a title.";
    if (error.code === "branch-required") return "Enter a branch name.";
    if (error.code === "not-ready") {
      return "This node is not ready for changes. Reconnect it or choose another node.";
    }
  }

  const fallback: Readonly<Record<typeof action, string>> = {
    "add-project": "The project could not be added. Check the node connection and try again.",
    "rename-project": "The project could not be renamed. Try again when the node is ready.",
    "create-worktree": "The worktree could not be created. Check the branch and try again.",
    "rename-worktree": "The worktree could not be renamed. Try again when the node is ready.",
    "archive-worktree": "The worktree could not be archived. Try again when the node is ready.",
    "restore-worktree": "The worktree could not be restored. Try again when the node is ready.",
  };
  return fallback[action];
}

function requiredTrimmed(value: string, code: "branch-required" | "title-required"): string {
  const trimmed = value.trim();
  if (!trimmed) throw new WorkspaceActionError(code);
  return trimmed;
}

function isAbsoluteNodePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value === "~" ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith("\\\\")
  );
}

/**
 * Validate a path for transmission to the selected node. This intentionally
 * performs no path resolution or normalization: the node, not the phone, owns
 * the filesystem and decides what the accepted path means.
 */
export function validateNodeWorkspacePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !isAbsoluteNodePath(trimmed)) {
    throw new WorkspaceActionError("invalid-path");
  }
  return trimmed;
}

export function inferNodeProjectTitle(workspaceRoot: string): string {
  const withoutTrailingSeparators = workspaceRoot.replace(/[\\/]+$/u, "");
  const segments = withoutTrailingSeparators.split(/[\\/]/u);
  const title = segments.at(-1)?.trim();
  if (!title || /^[A-Za-z]:$/u.test(title) || title === "~") return "Workspace";
  return title;
}

export function buildProjectCreateCommand(input: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly title?: string;
  readonly createdAt: string;
}): ProjectCreateCommand {
  const workspaceRoot = validateNodeWorkspacePath(input.workspaceRoot);
  return {
    type: "project.create",
    commandId: input.commandId,
    projectId: input.projectId,
    title: input.title
      ? requiredTrimmed(input.title, "title-required")
      : inferNodeProjectTitle(workspaceRoot),
    workspaceRoot,
    projectMetadataDir: ".ryco",
    createWorkspaceRootIfMissing: true,
    createdAt: input.createdAt,
  };
}

export function buildProjectRenameCommand(input: {
  readonly commandId: CommandId;
  readonly projectId: ProjectId;
  readonly title: string;
}): ProjectMetaUpdateCommand {
  return {
    type: "project.meta.update",
    commandId: input.commandId,
    projectId: input.projectId,
    title: requiredTrimmed(input.title, "title-required"),
  };
}

export function buildWorktreeCreateCommand(input: {
  readonly commandId: CommandId;
  readonly worktreeId: WorktreeId;
  readonly projectId: ProjectId;
  readonly branch: string;
  readonly createdAt: string;
}): WorktreeCreateCommand {
  return {
    type: "worktree.create",
    commandId: input.commandId,
    worktreeId: input.worktreeId,
    projectId: input.projectId,
    branch: requiredTrimmed(input.branch, "branch-required"),
    worktreePath: null,
    origin: "manual",
    prNumber: null,
    issueNumber: null,
    prTitle: null,
    issueTitle: null,
    workItemProvider: null,
    workItemKey: null,
    workItemTitle: null,
    workItemState: null,
    workItemStateName: null,
    workItemUrl: null,
    createdAt: input.createdAt,
  };
}

export function buildWorktreeRenameCommand(input: {
  readonly commandId: CommandId;
  readonly worktreeId: WorktreeId;
  readonly title: string;
  readonly changedAt: string;
}): WorktreeMetaUpdateCommand {
  return {
    type: "worktree.meta.update",
    commandId: input.commandId,
    worktreeId: input.worktreeId,
    title: requiredTrimmed(input.title, "title-required"),
    changedAt: input.changedAt,
  };
}

export function buildWorktreeArchiveCommand(input: {
  readonly commandId: CommandId;
  readonly worktreeId: WorktreeId;
  readonly archivedAt: string;
}): WorktreeArchiveCommand {
  return {
    type: "worktree.archive",
    commandId: input.commandId,
    worktreeId: input.worktreeId,
    archivedAt: input.archivedAt,
    deletedBranch: false,
  };
}

export function buildWorktreeRestoreCommand(input: {
  readonly commandId: CommandId;
  readonly worktreeId: WorktreeId;
  readonly restoredAt: string;
}): WorktreeRestoreCommand {
  return {
    type: "worktree.restore",
    commandId: input.commandId,
    worktreeId: input.worktreeId,
    restoredAt: input.restoredAt,
  };
}

export async function dispatchWorkspaceCommand(input: {
  readonly readiness: WorkspaceMutationReadiness;
  readonly command: ClientOrchestrationCommand;
  readonly dispatch: (command: ClientOrchestrationCommand) => Promise<unknown>;
}): Promise<void> {
  await runWorkspaceMutation({
    readiness: input.readiness,
    mutation: () => input.dispatch(input.command),
  });
}

export async function runWorkspaceMutation<Result>(input: {
  readonly readiness: WorkspaceMutationReadiness;
  readonly mutation: () => Promise<Result>;
}): Promise<Result> {
  if (input.readiness !== "ready") throw new WorkspaceActionError("not-ready");
  try {
    return await input.mutation();
  } catch {
    throw new WorkspaceActionError("dispatch-failed");
  }
}

export interface PendingWorktreeRow {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly worktreeId: WorktreeId;
  readonly branch: string;
}

export function pendingWorktreeFromCommand(
  environmentId: EnvironmentId,
  command: WorktreeCreateCommand,
): PendingWorktreeRow {
  return {
    environmentId,
    projectId: command.projectId,
    worktreeId: command.worktreeId,
    branch: command.branch,
  };
}

export function reconcilePendingWorktree(
  pending: PendingWorktreeRow | null,
  authoritative: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly id: WorktreeId;
  }>,
): PendingWorktreeRow | null {
  if (!pending) return null;
  return authoritative.some(
    (worktree) =>
      worktree.environmentId === pending.environmentId &&
      worktree.projectId === pending.projectId &&
      worktree.id === pending.worktreeId,
  )
    ? null
    : pending;
}
