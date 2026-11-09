import {
  buildProjectAvatarSetCommand,
  buildProjectDeleteCommand,
  buildProjectMetaUpdateCommand,
  type ProjectMetaPatch,
} from "@ryco/client-runtime/projectSettings/commands";
import {
  runDirectWorkspaceAction,
  type DirectWorkspaceActionOutcome,
  type WorkspaceDirectAction,
} from "@ryco/client-runtime/projectSettings/workspaceActions";
import {
  WORKSPACE_REVIEW_APPLY_FAILED,
  WORKSPACE_REVIEW_UNSUPPORTED,
  workspaceReviewApplyError,
  workspaceReviewErrorMessage,
  workspaceReviewResultFailure,
  type WorkspaceReviewFailure,
} from "@ryco/client-runtime/projectSettings/workspaceReview";
import type {
  EnvironmentId,
  ProjectId,
  WorkspaceLifecyclePreview,
  WorktreeId,
} from "@ryco/contracts";

import { ensureEnvironmentApi, readEnvironmentApi } from "../../connection/environmentApi";
import { newCommandId } from "../../lib/ids";

/**
 * The writes the project settings screen makes, each through the machine's own connection.
 * They throw on failure; the screen runs them through `runSettingsWrite`.
 */

export async function writeProjectMeta(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  patch: ProjectMetaPatch,
): Promise<void> {
  await ensureEnvironmentApi(environmentId).orchestration.dispatchCommand(
    buildProjectMetaUpdateCommand({ commandId: newCommandId(), projectId, patch }),
  );
}

/** Back to the auto-detected favicon. */
export async function clearProjectAvatar(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): Promise<void> {
  await ensureEnvironmentApi(environmentId).orchestration.dispatchCommand(
    buildProjectAvatarSetCommand({ commandId: newCommandId(), projectId, contentHash: null }),
  );
}

/** Removes the project from its machine; `force` deletes its threads first. Files stay. */
export async function removeProjectFromMachine(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  force: boolean,
): Promise<void> {
  await ensureEnvironmentApi(environmentId).orchestration.dispatchCommand(
    buildProjectDeleteCommand({ commandId: newCommandId(), projectId, force }),
  );
}

export async function initializeProjectGit(
  environmentId: EnvironmentId,
  cwd: string,
): Promise<void> {
  await ensureEnvironmentApi(environmentId).vcs.init({ cwd });
}

/** Archive or Restore through the machine's lifecycle authority; blockers come back as an error. */
export async function runProjectWorkspaceAction(
  environmentId: EnvironmentId,
  target: { readonly worktreeId: WorktreeId; readonly action: WorkspaceDirectAction },
): Promise<void> {
  const lifecycle = ensureEnvironmentApi(environmentId).lifecycle;
  if (!lifecycle) throw new Error("This machine does not support workspace actions.");
  const outcome: DirectWorkspaceActionOutcome = await runDirectWorkspaceAction(lifecycle, target);
  if (outcome.kind === "blocked") throw new Error(outcome.blockers.join("\n"));
  if (outcome.result.outcome !== "completed") throw new Error(outcome.result.message);
}

/**
 * Applies exactly the delete review on screen (its fingerprint): a workspace that changed in
 * between is refused by the machine. Resolves to what the review should say when the run did not
 * complete, or null when it did.
 */
export async function applyWorkspaceDelete(
  environmentId: EnvironmentId,
  preview: WorkspaceLifecyclePreview,
): Promise<WorkspaceReviewFailure | null> {
  const lifecycle = readEnvironmentApi(environmentId)?.lifecycle;
  if (!lifecycle) {
    return workspaceReviewApplyError("delete-workspace", WORKSPACE_REVIEW_UNSUPPORTED);
  }
  return lifecycle
    .applyWorkspace({ ...preview.request, expectedFingerprint: preview.fingerprint })
    .then(
      (result) => workspaceReviewResultFailure("delete-workspace", result),
      (error: unknown) =>
        workspaceReviewApplyError(
          "delete-workspace",
          workspaceReviewErrorMessage(error, WORKSPACE_REVIEW_APPLY_FAILED),
        ),
    );
}
