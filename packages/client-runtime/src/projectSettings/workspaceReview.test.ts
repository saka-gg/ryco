import {
  ProjectId,
  ThreadId,
  WorktreeId,
  type WorkspaceLifecyclePreview,
  type WorkspaceLifecycleSummary,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { recreatedCheckout, workspaceLifecycleIncompleteTitle } from "../state/lifecycle/index.ts";
import {
  resolveWorkspaceReview,
  WORKSPACE_REVIEW_OUTDATED,
  WORKSPACE_REVIEW_UNSUPPORTED,
  workspaceReviewApplyError,
  workspaceReviewConfirmLabel,
  workspaceReviewDeletedConversationIds,
  workspaceReviewEffectParts,
  workspaceReviewErrorMessage,
  workspaceReviewResultFailure,
} from "./workspaceReview.ts";

const workspace = (overrides: Partial<WorkspaceLifecycleSummary> = {}) =>
  ({
    worktreeId: WorktreeId.make("wt-1"),
    projectId: ProjectId.make("p"),
    main: false,
    checkout: "present",
    unmerged: false,
    changes: {
      modified: 0,
      untracked: 0,
      protectedIgnored: 0,
      protectedIgnoredSample: [],
      regenerableIgnored: 0,
      regenerableIgnoredSample: [],
      truncated: false,
    },
    conversations: { active: 2, archived: 1, trashed: 0 },
    activeWork: [],
    ...overrides,
  }) as WorkspaceLifecycleSummary;

const preview = (
  overrides: {
    readonly workspace?: Partial<WorkspaceLifecycleSummary>;
    readonly effects?: Partial<WorkspaceLifecyclePreview["effects"]>;
    readonly blockers?: string[];
    readonly deleteConversations?: boolean;
  } = {},
): WorkspaceLifecyclePreview =>
  ({
    request: {
      worktreeId: WorktreeId.make("wt-1"),
      action: "remove-checkout",
      discard: true,
      deleteBranch: true,
      deleteConversations: overrides.deleteConversations ?? false,
    },
    workspace: workspace(overrides.workspace),
    effects: {
      removeCheckout: true,
      deleteBranch: true,
      branch: "feature",
      discard: true,
      trashConversationIds: [ThreadId.make("t-1")],
      ...overrides.effects,
    },
    summary: "",
    details: [],
    blockers: overrides.blockers ?? [],
    fingerprint: "fp",
  }) as WorkspaceLifecyclePreview;

describe("resolveWorkspaceReview", () => {
  it("confirms only the preview for the options on screen", () => {
    const ready = { status: "ready", preview: preview() } as const;
    const current = resolveWorkspaceReview({
      previewDenied: null,
      lifecycleAvailable: true,
      current: ready,
      last: ready,
    });
    expect(current.preview).toBe(ready.preview);
    expect(current.refreshing).toBe(false);
    expect(current.losesWork).toBe(false);
    expect(current.conversationCount).toBe(3);

    const reinspecting = resolveWorkspaceReview({
      previewDenied: null,
      lifecycleAvailable: true,
      current: null,
      last: ready,
    });
    expect(reinspecting.preview).toBeNull();
    expect(reinspecting.shown).toBe(ready.preview);
    expect(reinspecting.refreshing).toBe(true);
  });

  it("states lost work and server blockers", () => {
    const view = resolveWorkspaceReview({
      previewDenied: null,
      lifecycleAvailable: true,
      current: {
        status: "ready",
        preview: preview({ workspace: { unmerged: true }, blockers: ["A turn is running."] }),
      },
      last: null,
    });
    expect(view.lostWork.map((fact) => fact.label)).toEqual(["Unmerged commits"]);
    expect(view.losesWork).toBe(true);
    expect(view.blocked).toBe(true);
    expect(
      resolveWorkspaceReview({
        previewDenied: null,
        lifecycleAvailable: true,
        current: { status: "ready", preview: preview({ effects: { discardsWork: true } }) },
        last: null,
      }).losesWork,
    ).toBe(true);
  });

  it("says why it cannot review", () => {
    expect(
      resolveWorkspaceReview({
        previewDenied: "Viewers cannot change workspaces.",
        lifecycleAvailable: true,
        current: null,
        last: null,
      }).view,
    ).toEqual({ status: "error", message: "Viewers cannot change workspaces." });
    expect(
      resolveWorkspaceReview({
        previewDenied: null,
        lifecycleAvailable: false,
        current: null,
        last: null,
      }).view,
    ).toEqual({ status: "error", message: WORKSPACE_REVIEW_UNSUPPORTED });
    const outdated = resolveWorkspaceReview({
      previewDenied: null,
      lifecycleAvailable: true,
      current: { status: "ready", preview: preview({ effects: { discard: undefined } }) },
      last: null,
    });
    expect(outdated.view).toEqual({ status: "error", message: WORKSPACE_REVIEW_OUTDATED });
    expect(outdated.preview).toBeNull();
  });
});

describe("review results", () => {
  const result = (outcome: "completed" | "partial" | "failed") => ({
    outcome,
    message: "Removed the checkout.",
    steps: [
      { id: "remove-checkout" as const, status: "done" as const, detail: "" },
      { id: "delete-branch" as const, status: "failed" as const, detail: "Branch is locked." },
    ],
  });

  it("tells a run that did not complete", () => {
    expect(workspaceReviewResultFailure("delete-workspace", result("completed"))).toBeNull();
    expect(workspaceReviewResultFailure("delete-workspace", result("partial"))).toEqual({
      title: "Delete workspace partly completed",
      message: "Removed the checkout.",
      detail: "Branch is locked.",
      tone: "warning",
    });
    expect(workspaceReviewResultFailure("delete-workspace", result("failed"))?.title).toBe(
      "Delete workspace did not run",
    );
    expect(workspaceReviewApplyError("delete-workspace", "Offline")).toEqual({
      title: "Delete workspace failed",
      message: "Offline",
      detail: null,
      tone: "destructive",
    });
    expect(workspaceLifecycleIncompleteTitle("archive", "blocked")).toBe(
      "Archive workspace did not run",
    );
    expect(recreatedCheckout(result("completed"))).toBe(false);
  });

  it("words the effects and the confirm button", () => {
    expect(workspaceReviewEffectParts(preview())).toEqual({
      action: "Removes the checkout from disk",
      deletesBranch: "feature",
    });
    expect(
      workspaceReviewEffectParts(
        preview({ effects: { removeCheckout: false, deleteBranch: false } }),
      ),
    ).toEqual({ action: "Removes the workspace", deletesBranch: null });
    expect(workspaceReviewConfirmLabel(true)).toBe("Delete anyway");
    expect(workspaceReviewConfirmLabel(false)).toBe("Delete workspace");
    expect(workspaceReviewDeletedConversationIds(preview())).toEqual([]);
    expect(workspaceReviewDeletedConversationIds(preview({ deleteConversations: true }))).toEqual([
      "t-1",
    ]);
    expect(workspaceReviewErrorMessage(new Error(""), "fallback")).toBe("fallback");
    expect(workspaceReviewErrorMessage(new Error("boom"), "fallback")).toBe("boom");
  });
});
