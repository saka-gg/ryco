import { Effect, Schema } from "effect";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { WorkItemProviderKind, WorkItemState } from "./workItems.ts";

export const WorktreeId = Schema.String.pipe(Schema.brand("WorktreeId"));
export type WorktreeId = typeof WorktreeId.Type;

export const WorktreeOrigin = Schema.Literals(["main", "branch", "pr", "issue", "manual"]);
export type WorktreeOrigin = typeof WorktreeOrigin.Type;

export const PullRequestState = Schema.Literals(["open", "closed", "merged"]);
export type PullRequestState = typeof PullRequestState.Type;

export const IssueState = Schema.Literals(["open", "closed"]);
export type IssueState = typeof IssueState.Type;

export const StatusBucket = Schema.Literals(["idle", "in_progress", "review", "done"]);
export type StatusBucket = typeof StatusBucket.Type;

export const WorktreeCheckoutLocation = Schema.Literals(["appManaged", "projectMetadata"]);
export type WorktreeCheckoutLocation = typeof WorktreeCheckoutLocation.Type;

/** Why a workspace record no longer has a checkout: removed by Ryco, or found missing. */
export const WorktreeCheckoutRemovalReason = Schema.Literals(["removed", "missing"]);
export type WorktreeCheckoutRemovalReason = typeof WorktreeCheckoutRemovalReason.Type;

export const Worktree = Schema.Struct({
  worktreeId: WorktreeId,
  projectId: ProjectId,
  title: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  branch: TrimmedNonEmptyString,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  origin: WorktreeOrigin,
  prNumber: Schema.NullOr(Schema.Number),
  issueNumber: Schema.NullOr(Schema.Number),
  prTitle: Schema.NullOr(TrimmedNonEmptyString),
  issueTitle: Schema.NullOr(TrimmedNonEmptyString),
  prState: Schema.optional(Schema.NullOr(PullRequestState)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  prIsDraft: Schema.optional(Schema.NullOr(Schema.Boolean)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  issueState: Schema.optional(Schema.NullOr(IssueState)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * When the PR reached its current merged/closed state (forge time, else first
   * observation). `null` while open, unknown, or absent. No decoding default:
   * an absent key means the server predates the field (legacy settlement rule).
   */
  prTerminalAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  workItemProvider: Schema.optional(Schema.NullOr(WorkItemProviderKind)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  workItemKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  workItemTitle: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  workItemState: Schema.optional(Schema.NullOr(WorkItemState)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  workItemStateName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  workItemUrl: Schema.optional(Schema.NullOr(Schema.String)).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  /**
   * Set once the physical checkout is gone (removed or found missing). The record,
   * `worktreePath` and `branch` stay as provenance. Optional so older peers decode.
   */
  checkoutRemovedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  checkoutRemovalReason: Schema.optional(Schema.NullOr(WorktreeCheckoutRemovalReason)),
  manualPosition: Schema.Number,
});
export type Worktree = typeof Worktree.Type;

export const CreateWorktreeIntent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("branch"), branchName: TrimmedNonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("pr"), number: Schema.Number }),
  Schema.Struct({
    kind: Schema.Literal("issue"),
    number: Schema.Number,
    branchName: Schema.optional(TrimmedNonEmptyString),
    baseBranch: Schema.optional(TrimmedNonEmptyString),
    title: Schema.optional(TrimmedNonEmptyString),
    body: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("workItem"),
    provider: WorkItemProviderKind,
    key: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString,
    state: Schema.optional(WorkItemState),
    stateName: Schema.optional(TrimmedNonEmptyString),
    url: Schema.optional(Schema.String),
    body: Schema.optional(Schema.String),
    branchSource: Schema.optional(Schema.Literals(["new", "existing"])),
    branchName: Schema.optional(TrimmedNonEmptyString),
    baseBranch: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literal("newBranch"),
    branchName: Schema.optional(TrimmedNonEmptyString),
    baseBranch: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type CreateWorktreeIntent = typeof CreateWorktreeIntent.Type;
