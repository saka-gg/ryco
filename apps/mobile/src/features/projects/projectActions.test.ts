import { describe, expect, it, vi } from "vitest";

import {
  CommandId,
  EnvironmentId,
  ProjectId,
  WorktreeId,
  type ClientOrchestrationCommand,
} from "@ryco/contracts";

import {
  buildProjectCreateCommand,
  buildProjectRenameCommand,
  buildWorktreeArchiveCommand,
  buildWorktreeCreateCommand,
  buildWorktreeRenameCommand,
  buildWorktreeRestoreCommand,
  dispatchWorkspaceCommand,
  inferNodeProjectTitle,
  pendingWorktreeFromCommand,
  reconcilePendingWorktree,
  runWorkspaceMutation,
  validateNodeWorkspacePath,
  workspaceActionErrorMessage,
} from "./projectActions";

const commandId = CommandId.make("command-1");
const projectId = ProjectId.make("project-1");
const worktreeId = WorktreeId.make("worktree-1");
const environmentId = EnvironmentId.make("environment-1");
const now = "2026-07-26T08:00:00.000Z";

describe("project actions", () => {
  it("keeps node paths opaque while accepting common absolute forms", () => {
    expect(validateNodeWorkspacePath("  /srv/code/ryco  ")).toBe("/srv/code/ryco");
    expect(validateNodeWorkspacePath("~/Code/ryco")).toBe("~/Code/ryco");
    expect(validateNodeWorkspacePath("C:\\Code\\ryco")).toBe("C:\\Code\\ryco");
    expect(validateNodeWorkspacePath("\\\\server\\share\\ryco")).toBe("\\\\server\\share\\ryco");
    expect(() => validateNodeWorkspacePath("./ryco")).toThrow("invalid-path");
    expect(() => validateNodeWorkspacePath("ryco")).toThrow("invalid-path");
  });

  it("infers a bounded title without resolving the remote path", () => {
    expect(inferNodeProjectTitle("/srv/code/ryco/")).toBe("ryco");
    expect(inferNodeProjectTitle("C:\\Code\\Ryco")).toBe("Ryco");
    expect(inferNodeProjectTitle("/")).toBe("Workspace");
  });

  it("builds project commands with caller-provided stable ids", () => {
    expect(
      buildProjectCreateCommand({
        commandId,
        projectId,
        workspaceRoot: "/srv/code/ryco",
        createdAt: now,
      }),
    ).toEqual({
      type: "project.create",
      commandId,
      projectId,
      title: "ryco",
      workspaceRoot: "/srv/code/ryco",
      projectMetadataDir: ".ryco",
      createWorkspaceRootIfMissing: true,
      createdAt: now,
    });
    expect(
      buildProjectRenameCommand({
        commandId,
        projectId,
        title: "  Mobile app  ",
      }),
    ).toEqual({
      type: "project.meta.update",
      commandId,
      projectId,
      title: "Mobile app",
    });
  });

  it("builds create, rename, archive, and restore worktree commands", () => {
    expect(
      buildWorktreeCreateCommand({
        commandId,
        worktreeId,
        projectId,
        branch: "  feat/mobile  ",
        createdAt: now,
      }),
    ).toMatchObject({
      type: "worktree.create",
      commandId,
      worktreeId,
      projectId,
      branch: "feat/mobile",
      worktreePath: null,
      origin: "manual",
      createdAt: now,
    });
    expect(
      buildWorktreeRenameCommand({
        commandId,
        worktreeId,
        title: "  Mobile redesign  ",
        changedAt: now,
      }),
    ).toEqual({
      type: "worktree.meta.update",
      commandId,
      worktreeId,
      title: "Mobile redesign",
      changedAt: now,
    });
    expect(buildWorktreeArchiveCommand({ commandId, worktreeId, archivedAt: now })).toEqual({
      type: "worktree.archive",
      commandId,
      worktreeId,
      archivedAt: now,
      deletedBranch: false,
    });
    expect(buildWorktreeRestoreCommand({ commandId, worktreeId, restoredAt: now })).toEqual({
      type: "worktree.restore",
      commandId,
      worktreeId,
      restoredAt: now,
    });
  });

  it("dispatches once only when the node is mutation-ready", async () => {
    const dispatch = vi.fn(async (_command: ClientOrchestrationCommand) => undefined);
    const command = buildProjectRenameCommand({
      commandId,
      projectId,
      title: "Ryco",
    });

    await dispatchWorkspaceCommand({ readiness: "ready", command, dispatch });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(command);

    await expect(
      dispatchWorkspaceCommand({ readiness: "read-only", command, dispatch }),
    ).rejects.toThrow("not-ready");
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("guards server-managed worktree RPC mutations with the same readiness decision", async () => {
    const mutation = vi.fn(async () => ({ worktreeId }));
    await expect(runWorkspaceMutation({ readiness: "ready", mutation })).resolves.toEqual({
      worktreeId,
    });
    await expect(runWorkspaceMutation({ readiness: "offline", mutation })).rejects.toThrow(
      "not-ready",
    );
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it("reconciles only the matching authoritative worktree id", () => {
    const command = buildWorktreeCreateCommand({
      commandId,
      worktreeId,
      projectId,
      branch: "feat/mobile",
      createdAt: now,
    });
    const pending = pendingWorktreeFromCommand(environmentId, command);
    expect(reconcilePendingWorktree(pending, [])).toBe(pending);
    expect(
      reconcilePendingWorktree(pending, [
        {
          environmentId,
          projectId,
          id: WorktreeId.make("worktree-other"),
        },
      ]),
    ).toBe(pending);
    expect(reconcilePendingWorktree(pending, [{ environmentId, projectId, id: worktreeId }])).toBe(
      null,
    );
  });

  it("maps failures to bounded user-facing messages", async () => {
    const command = buildProjectRenameCommand({
      commandId,
      projectId,
      title: "Ryco",
    });
    const failing = dispatchWorkspaceCommand({
      readiness: "ready",
      command,
      dispatch: async () => {
        throw new Error("sqlite /private/secret.db and bearer token");
      },
    });
    await expect(failing).rejects.toThrow("dispatch-failed");
    expect(
      workspaceActionErrorMessage("rename-project", await failing.catch((error) => error)),
    ).toBe("The project could not be renamed. Try again when the node is ready.");
  });
});
