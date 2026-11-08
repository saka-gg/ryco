/**
 * Archive and Restore, the workspace actions that run without a review: the
 * node previews the action, and the preview is applied exactly (by its
 * fingerprint) unless the node names a blocker. Every surface tells the outcome
 * its own way.
 */
import type { EnvironmentApi, WorkspaceLifecycleResult, WorktreeId } from "@ryco/contracts";

import type { WorkspaceActionId, WorkspaceReviewAction } from "../state/lifecycle/index.ts";

/** A workspace action that runs without a review: hiding or restoring the record. */
export type WorkspaceDirectAction = Exclude<WorkspaceActionId, WorkspaceReviewAction>;

export type WorkspaceLifecycleApi = NonNullable<EnvironmentApi["lifecycle"]>;

export type DirectWorkspaceActionOutcome =
  | { readonly kind: "blocked"; readonly blockers: readonly string[] }
  | { readonly kind: "applied"; readonly result: WorkspaceLifecycleResult };

/** Previews one direct action, then applies that exact preview unless the node refuses it. */
export async function runDirectWorkspaceAction(
  lifecycle: Pick<WorkspaceLifecycleApi, "previewWorkspace" | "applyWorkspace">,
  target: { readonly worktreeId: WorktreeId; readonly action: WorkspaceDirectAction },
): Promise<DirectWorkspaceActionOutcome> {
  const preview = await lifecycle.previewWorkspace({
    worktreeId: target.worktreeId,
    action: target.action,
  });
  if (preview.blockers.length > 0) return { kind: "blocked", blockers: preview.blockers };
  const result = await lifecycle.applyWorkspace({
    ...preview.request,
    expectedFingerprint: preview.fingerprint,
  });
  return { kind: "applied", result };
}
