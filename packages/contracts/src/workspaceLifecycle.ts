import { Schema } from "effect";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProjectKind } from "./orchestration.ts";
import { WorktreeId, WorktreeOrigin } from "./worktree.ts";

/**
 * Workspace lifecycle is separate from conversation lifecycle. No action here ever
 * deletes a conversation; checkout removal archives the workspace's conversations
 * by default and keeps their history and the branch. Only an explicit discard
 * ("Delete workspace") throws work away, and it moves conversations to Trash.
 */
export const WorkspaceLifecycleAction = Schema.Literals([
  "archive",
  "restore",
  "remove-checkout",
  "remove-stale-record",
  "recreate-checkout",
]);
export type WorkspaceLifecycleAction = typeof WorkspaceLifecycleAction.Type;

/** `removed`: the record says the checkout is gone. `unavailable`: inspection failed. */
export const WorkspaceCheckoutState = Schema.Literals([
  "present",
  "missing",
  "removed",
  "unavailable",
]);
export type WorkspaceCheckoutState = typeof WorkspaceCheckoutState.Type;

const SamplePaths = Schema.Array(Schema.String).check(Schema.isMaxLength(20));

export const WorkspaceChangeSummary = Schema.Struct({
  /** Tracked files with staged, unstaged or conflicted changes. */
  modified: NonNegativeInt,
  untracked: NonNegativeInt,
  /** Ignored content that is not a known regenerable cache (credentials, databases, outputs…). */
  protectedIgnored: NonNegativeInt,
  protectedIgnoredSample: SamplePaths,
  /** Ignored caches/build outputs that `git worktree remove` may discard. */
  regenerableIgnored: NonNegativeInt,
  regenerableIgnoredSample: SamplePaths,
  /** Status output exceeded its bound; treated as blocking. */
  truncated: Schema.Boolean,
});
export type WorkspaceChangeSummary = typeof WorkspaceChangeSummary.Type;

export const WorkspaceConversationCounts = Schema.Struct({
  active: NonNegativeInt,
  archived: NonNegativeInt,
  trashed: NonNegativeInt,
});
export type WorkspaceConversationCounts = typeof WorkspaceConversationCounts.Type;

export const WorkspaceActionAvailability = Schema.Struct({
  action: WorkspaceLifecycleAction,
  available: Schema.Boolean,
  blockers: Schema.Array(Schema.String),
});
export type WorkspaceActionAvailability = typeof WorkspaceActionAvailability.Type;

export const WorkspaceLifecycleSummary = Schema.Struct({
  worktreeId: WorktreeId,
  projectId: ProjectId,
  title: Schema.String,
  branch: TrimmedNonEmptyString,
  path: Schema.NullOr(Schema.String),
  origin: WorktreeOrigin,
  /** The project root/main checkout is never a disposable workspace. */
  main: Schema.Boolean,
  archivedAt: Schema.NullOr(IsoDateTime),
  checkoutRemovedAt: Schema.NullOr(IsoDateTime),
  checkout: WorkspaceCheckoutState,
  gitRegistered: Schema.NullOr(Schema.Boolean),
  branchExists: Schema.NullOr(Schema.Boolean),
  /** Commits on the branch that the project HEAD does not contain. */
  unmerged: Schema.NullOr(Schema.Boolean),
  changes: Schema.NullOr(WorkspaceChangeSummary),
  conversations: WorkspaceConversationCounts,
  activeWork: Schema.Array(Schema.String),
  actions: Schema.Array(WorkspaceActionAvailability),
  /**
   * Why "Delete workspace" (`remove-checkout` with `discard`) cannot run; empty
   * when it can. Absent from nodes that predate it.
   */
  discardBlockers: Schema.optional(Schema.Array(Schema.String)),
  inspectedAt: IsoDateTime,
});
export type WorkspaceLifecycleSummary = typeof WorkspaceLifecycleSummary.Type;

export const WorkspaceLifecycleListInput = Schema.Struct({ projectId: ProjectId });
export type WorkspaceLifecycleListInputType = typeof WorkspaceLifecycleListInput.Type;

export const WorkspaceLifecycleRequest = Schema.Struct({
  worktreeId: WorktreeId,
  action: WorkspaceLifecycleAction,
  /** Default true for checkout removal and stale-record cleanup; ignored otherwise. */
  archiveConversations: Schema.optional(Schema.Boolean),
  /**
   * Off by default. Only on removal; a verified merged branch, or any branch when
   * discarding.
   */
  deleteBranch: Schema.optional(Schema.Boolean),
  /**
   * Off by default; `remove-checkout` only. "Delete workspace": the checkout is
   * removed even with uncommitted, untracked or ignored files (they are lost),
   * an unmerged branch may be deleted, and the workspace's conversations move to
   * Trash instead of the archive. Also finishes a workspace whose checkout is
   * already removed. Active work still blocks it.
   */
  discard: Schema.optional(Schema.Boolean),
});
export type WorkspaceLifecycleRequest = typeof WorkspaceLifecycleRequest.Type;

export const WorkspaceLifecycleEffects = Schema.Struct({
  archiveWorkspace: Schema.Boolean,
  restoreWorkspace: Schema.Boolean,
  removeCheckout: Schema.Boolean,
  recreateCheckout: Schema.Boolean,
  recordCheckoutRemoval: Schema.Boolean,
  stopSessionThreadIds: Schema.Array(ThreadId),
  archiveConversationIds: Schema.Array(ThreadId),
  /** Conversations left exactly as they are (already archived, trashed or never used). */
  unchangedConversations: NonNegativeInt,
  discardedRegenerableIgnored: NonNegativeInt,
  deleteBranch: Schema.Boolean,
  branch: TrimmedNonEmptyString,
  /** The request discards ("Delete workspace"). Absent from nodes that predate it. */
  discard: Schema.optional(Schema.Boolean),
  /** Conversations moved to Trash, where they stay restorable. */
  trashConversationIds: Schema.optional(Schema.Array(ThreadId)),
  /** Work that exists nowhere else is lost: changed or untracked files, unmerged commits. */
  discardsWork: Schema.optional(Schema.Boolean),
});
export type WorkspaceLifecycleEffects = typeof WorkspaceLifecycleEffects.Type;

export const WorkspaceLifecyclePreview = Schema.Struct({
  request: WorkspaceLifecycleRequest,
  workspace: WorkspaceLifecycleSummary,
  effects: WorkspaceLifecycleEffects,
  /** One-line exact effect, e.g. "Remove 1 checkout, archive 4 conversations, keep history and branch." */
  summary: Schema.String,
  details: Schema.Array(Schema.String),
  blockers: Schema.Array(Schema.String),
  /** Binds an apply to exactly the state this preview inspected. */
  fingerprint: TrimmedNonEmptyString,
});
export type WorkspaceLifecyclePreview = typeof WorkspaceLifecyclePreview.Type;

export const WorkspaceLifecycleApplyInput = Schema.Struct({
  ...WorkspaceLifecycleRequest.fields,
  expectedFingerprint: TrimmedNonEmptyString,
});
export type WorkspaceLifecycleApplyInput = typeof WorkspaceLifecycleApplyInput.Type;

export const WorkspaceLifecycleStepId = Schema.Literals([
  "preflight",
  "stop-sessions",
  "fence-checkout",
  "revalidate",
  "remove-checkout",
  "recreate-checkout",
  "update-record",
  "archive-conversations",
  "delete-branch",
]);
export type WorkspaceLifecycleStepId = typeof WorkspaceLifecycleStepId.Type;

export const WorkspaceLifecycleStep = Schema.Struct({
  id: WorkspaceLifecycleStepId,
  status: Schema.Literals(["done", "skipped", "failed"]),
  detail: Schema.String,
});
export type WorkspaceLifecycleStep = typeof WorkspaceLifecycleStep.Type;

/**
 * `blocked`: nothing changed. `failed`: nothing durable changed. `partial`: some steps
 * completed (listed truthfully); retrying the same action resumes safely.
 */
export const WorkspaceLifecycleOutcome = Schema.Literals([
  "completed",
  "blocked",
  "partial",
  "failed",
]);
export type WorkspaceLifecycleOutcome = typeof WorkspaceLifecycleOutcome.Type;

export const WorkspaceLifecycleResult = Schema.Struct({
  outcome: WorkspaceLifecycleOutcome,
  message: Schema.String,
  steps: Schema.Array(WorkspaceLifecycleStep),
});
export type WorkspaceLifecycleResult = typeof WorkspaceLifecycleResult.Type;

export class WorkspaceLifecycleError extends Schema.TaggedError<WorkspaceLifecycleError>()(
  "WorkspaceLifecycleError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const SuggestionDays = Schema.NullOr(
  Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3650 })),
);

/** `null` turns a suggestion off. Suggestions never act on their own; each needs approval. */
export const LifecycleSuggestionPolicy = Schema.Struct({
  archiveInactiveThreadsDays: SuggestionDays,
  removeArchivedCheckoutsDays: SuggestionDays,
});
export type LifecycleSuggestionPolicy = typeof LifecycleSuggestionPolicy.Type;

export const DEFAULT_LIFECYCLE_SUGGESTION_POLICY: LifecycleSuggestionPolicy = {
  archiveInactiveThreadsDays: 30,
  removeArchivedCheckoutsDays: 7,
};

export const ThreadArchiveSuggestion = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  lastActivityAt: IsoDateTime,
});
export type ThreadArchiveSuggestion = typeof ThreadArchiveSuggestion.Type;

export const CheckoutRemovalSuggestion = Schema.Struct({
  worktreeId: WorktreeId,
  projectId: ProjectId,
  title: Schema.String,
  branch: TrimmedNonEmptyString,
  /** When the last of its conversations was archived. */
  archivedSince: IsoDateTime,
  conversations: NonNegativeInt,
});
export type CheckoutRemovalSuggestion = typeof CheckoutRemovalSuggestion.Type;

export const LifecycleSuggestions = Schema.Struct({
  generatedAt: IsoDateTime,
  threads: Schema.Array(ThreadArchiveSuggestion),
  checkouts: Schema.Array(CheckoutRemovalSuggestion),
});
export type LifecycleSuggestions = typeof LifecycleSuggestions.Type;

export const TrashedThreadSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  projectTitle: Schema.NullOr(Schema.String),
  /**
   * The owning project's kind, so a chat is listed as "No project" without the client's project
   * store. Absent when the project record is gone, or from a node that predates chats; both read
   * as a regular project.
   */
  projectKind: Schema.optionalKey(ProjectKind),
  /** False when the owning project was removed; restore is unavailable. */
  projectAvailable: Schema.Boolean,
  title: Schema.String,
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  worktreeId: Schema.NullOr(WorktreeId),
  /** Restoring returns the conversation to this archive state. */
  archivedAt: Schema.NullOr(IsoDateTime),
  trashedAt: IsoDateTime,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TrashedThreadSummary = typeof TrashedThreadSummary.Type;

export const TrashListResult = Schema.Struct({
  threads: Schema.Array(TrashedThreadSummary),
  truncated: Schema.Boolean,
});
export type TrashListResult = typeof TrashListResult.Type;
