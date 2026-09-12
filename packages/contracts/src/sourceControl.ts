import { Schema } from "effect";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { VcsDriverKind } from "./vcs.ts";

export const SourceControlProviderKind = Schema.Literals([
  "github",
  "gitlab",
  "forgejo",
  "azure-devops",
  "bitbucket",
  "unknown",
]);
export type SourceControlProviderKind = typeof SourceControlProviderKind.Type;

export const SourceControlProviderInfo = Schema.Struct({
  kind: SourceControlProviderKind,
  name: TrimmedNonEmptyString,
  baseUrl: Schema.String,
});
export type SourceControlProviderInfo = typeof SourceControlProviderInfo.Type;

export const ChangeRequestState = Schema.Literals(["open", "closed", "merged"]);
export type ChangeRequestState = typeof ChangeRequestState.Type;

export const SourceControlChangeRequestMergeability = Schema.Literals([
  "mergeable",
  "conflicting",
  "unknown",
]);
export type SourceControlChangeRequestMergeability =
  typeof SourceControlChangeRequestMergeability.Type;

/** Compact stack identity used by change-request list rows. */
export const SourceControlChangeRequestStackSummary = Schema.Struct({
  number: PositiveInt,
  size: PositiveInt,
  position: PositiveInt,
  baseRefName: TrimmedNonEmptyString,
});
export type SourceControlChangeRequestStackSummary =
  typeof SourceControlChangeRequestStackSummary.Type;

export const SourceControlChangeRequestStackEntry = Schema.Struct({
  position: PositiveInt,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  baseRefName: TrimmedNonEmptyString,
  state: ChangeRequestState,
  isDraft: Schema.Boolean,
  mergeability: SourceControlChangeRequestMergeability,
  mergeStateStatus: Schema.optional(Schema.NullOr(Schema.String)),
});
export type SourceControlChangeRequestStackEntry = typeof SourceControlChangeRequestStackEntry.Type;

/**
 * Entries are normalized from the ultimate base branch upwards. `position`
 * identifies the selected pull request within that bottom-to-top ordering.
 */
export const SourceControlChangeRequestStack = Schema.Struct({
  ...SourceControlChangeRequestStackSummary.fields,
  entries: Schema.Array(SourceControlChangeRequestStackEntry),
});
export type SourceControlChangeRequestStack = typeof SourceControlChangeRequestStack.Type;

export const SourceControlChangeRequestMergeMethod = Schema.Literals(["merge", "squash", "rebase"]);
export type SourceControlChangeRequestMergeMethod =
  typeof SourceControlChangeRequestMergeMethod.Type;

export const SourceControlChangeRequestMergeCapabilities = Schema.Struct({
  merge: Schema.Boolean,
  squash: Schema.Boolean,
  rebase: Schema.Boolean,
});
export type SourceControlChangeRequestMergeCapabilities =
  typeof SourceControlChangeRequestMergeCapabilities.Type;

export const SourceControlCheckRollupItemKind = Schema.Literals([
  "check-run",
  "status-context",
  "unknown",
]);
export type SourceControlCheckRollupItemKind = typeof SourceControlCheckRollupItemKind.Type;

export const SourceControlCheckRollupItem = Schema.Struct({
  kind: SourceControlCheckRollupItemKind,
  name: TrimmedNonEmptyString,
  workflowName: Schema.optional(TrimmedNonEmptyString),
  status: Schema.Option(TrimmedNonEmptyString),
  conclusion: Schema.Option(TrimmedNonEmptyString),
  url: Schema.Option(TrimmedNonEmptyString),
  startedAt: Schema.Option(Schema.DateTimeUtc),
  completedAt: Schema.Option(Schema.DateTimeUtc),
});
export type SourceControlCheckRollupItem = typeof SourceControlCheckRollupItem.Type;

export const SourceControlLabel = Schema.Struct({
  name: TrimmedNonEmptyString,
  color: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlLabel = typeof SourceControlLabel.Type;

export const ChangeRequest = Schema.Struct({
  provider: SourceControlProviderKind,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  baseRefName: TrimmedNonEmptyString,
  headRefName: TrimmedNonEmptyString,
  state: ChangeRequestState,
  updatedAt: Schema.Option(Schema.DateTimeUtc),
  isCrossRepository: Schema.optional(Schema.Boolean),
  isDraft: Schema.optional(Schema.Boolean),
  author: Schema.optional(TrimmedNonEmptyString),
  assignees: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  labels: Schema.optional(Schema.Array(SourceControlLabel)),
  commentsCount: Schema.optional(Schema.Number),
  headRepositoryNameWithOwner: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  headRepositoryOwnerLogin: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  headSha: Schema.optional(TrimmedNonEmptyString),
  mergeability: Schema.optional(SourceControlChangeRequestMergeability),
  checkRollup: Schema.optional(Schema.Array(SourceControlCheckRollupItem)),
  stackSummary: Schema.optional(SourceControlChangeRequestStackSummary),
});
export type ChangeRequest = typeof ChangeRequest.Type;

// Token-budget caps. Server enforces these before responding so the web client
// always receives bounded payloads. Keep these here so server, web, and tests
// reference the same constants.
export const SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES = 8 * 1024; // 8 KB
export const SOURCE_CONTROL_DETAIL_COMMENT_BODY_MAX_BYTES = 2 * 1024; // 2 KB
export const SOURCE_CONTROL_DETAIL_MAX_COMMENTS = 5;

export const SourceControlIssueState = Schema.Literals(["open", "closed"]);
export type SourceControlIssueState = typeof SourceControlIssueState.Type;

export const SourceControlIssueSummary = Schema.Struct({
  provider: SourceControlProviderKind,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  state: SourceControlIssueState,
  author: Schema.optional(TrimmedNonEmptyString),
  updatedAt: Schema.Option(Schema.DateTimeUtc),
  labels: Schema.optional(Schema.Array(SourceControlLabel)),
  assignees: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  commentsCount: Schema.optional(Schema.Number),
});
export type SourceControlIssueSummary = typeof SourceControlIssueSummary.Type;

export const SourceControlReviewState = Schema.Literals([
  "approved",
  "changes_requested",
  "commented",
  "dismissed",
  "pending",
]);
export type SourceControlReviewState = typeof SourceControlReviewState.Type;

export const SourceControlCommentAuthorRoleKind = Schema.Literals([
  "author",
  "owner",
  "maintainer",
  "participant",
]);
export type SourceControlCommentAuthorRoleKind = typeof SourceControlCommentAuthorRoleKind.Type;

export const SourceControlCommentAuthorRole = Schema.Struct({
  primary: SourceControlCommentAuthorRoleKind,
  isOriginalAuthor: Schema.Boolean,
  isRepositoryOwner: Schema.Boolean,
  isRepositoryMaintainer: Schema.Boolean,
});
export type SourceControlCommentAuthorRole = typeof SourceControlCommentAuthorRole.Type;

export const SourceControlCommentReactionContent = Schema.Literals([
  "thumbs-up",
  "thumbs-down",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
]);
export type SourceControlCommentReactionContent = typeof SourceControlCommentReactionContent.Type;

export const SourceControlCommentReaction = Schema.Struct({
  content: SourceControlCommentReactionContent,
  count: NonNegativeInt,
  viewerHasReacted: Schema.optional(Schema.Boolean),
});
export type SourceControlCommentReaction = typeof SourceControlCommentReaction.Type;

export const SourceControlIssueComment = Schema.Struct({
  id: Schema.optional(TrimmedNonEmptyString),
  author: Schema.String,
  body: Schema.String,
  createdAt: Schema.DateTimeUtc,
  authorAssociation: Schema.optional(Schema.String),
  authorRole: Schema.optional(SourceControlCommentAuthorRole),
  reviewState: Schema.optional(SourceControlReviewState),
  reactions: Schema.optional(Schema.Array(SourceControlCommentReaction)),
});
export type SourceControlIssueComment = typeof SourceControlIssueComment.Type;

export const SourceControlIssueDetail = Schema.Struct({
  ...SourceControlIssueSummary.fields,
  body: Schema.String,
  comments: Schema.Array(SourceControlIssueComment),
  truncated: Schema.Boolean,
  linkedChangeRequestNumbers: Schema.optional(Schema.Array(Schema.Number)),
});
export type SourceControlIssueDetail = typeof SourceControlIssueDetail.Type;

export const SourceControlAssigneeCandidate = Schema.Struct({
  login: TrimmedNonEmptyString,
  displayName: Schema.optional(TrimmedNonEmptyString),
  avatarUrl: Schema.optional(Schema.String),
});
export type SourceControlAssigneeCandidate = typeof SourceControlAssigneeCandidate.Type;

export const SourceControlCreateIssueWorktree = Schema.Struct({
  enabled: Schema.Boolean,
  branchName: TrimmedNonEmptyString,
});
export type SourceControlCreateIssueWorktree = typeof SourceControlCreateIssueWorktree.Type;

export const SourceControlCreateIssueInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  body: Schema.String,
  labels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  assignees: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  worktree: Schema.optional(SourceControlCreateIssueWorktree),
});
export type SourceControlCreateIssueInput = typeof SourceControlCreateIssueInput.Type;

const NonBlankMarkdownBody = Schema.String.check(
  Schema.makeFilter((body: string) =>
    body.trim().length > 0 ? undefined : "Expected a non-blank Markdown body",
  ),
);

export const SourceControlAddIssueCommentInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
  body: NonBlankMarkdownBody,
  clientMutationId: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlAddIssueCommentInput = typeof SourceControlAddIssueCommentInput.Type;

export const SourceControlAddIssueCommentResult = Schema.Struct({
  detail: SourceControlIssueDetail,
});
export type SourceControlAddIssueCommentResult = typeof SourceControlAddIssueCommentResult.Type;

export const SourceControlAddCommentReactionInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
  commentId: TrimmedNonEmptyString,
  content: SourceControlCommentReactionContent,
});
export type SourceControlAddCommentReactionInput = typeof SourceControlAddCommentReactionInput.Type;

export const SourceControlAddIssueCommentReactionResult = Schema.Struct({
  detail: SourceControlIssueDetail,
});
export type SourceControlAddIssueCommentReactionResult =
  typeof SourceControlAddIssueCommentReactionResult.Type;

export const SourceControlChangeRequestCommit = Schema.Struct({
  oid: TrimmedNonEmptyString,
  shortOid: TrimmedNonEmptyString,
  messageHeadline: Schema.String,
  committedDate: Schema.optional(Schema.String),
  author: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlChangeRequestCommit = typeof SourceControlChangeRequestCommit.Type;

export const SourceControlChangeRequestFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type SourceControlChangeRequestFile = typeof SourceControlChangeRequestFile.Type;

export const SourceControlChangeRequestParticipant = Schema.Struct({
  displayName: TrimmedNonEmptyString,
  username: Schema.optional(TrimmedNonEmptyString),
  role: Schema.optional(TrimmedNonEmptyString),
  approved: Schema.optional(Schema.Boolean),
});
export type SourceControlChangeRequestParticipant =
  typeof SourceControlChangeRequestParticipant.Type;

export const SourceControlChangeRequestDetail = Schema.Struct({
  ...ChangeRequest.fields,
  body: Schema.String,
  comments: Schema.Array(SourceControlIssueComment),
  truncated: Schema.Boolean,
  linkedIssueNumbers: Schema.optional(Schema.Array(Schema.Number)),
  linkedWorkItemKeys: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  reviewers: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  participants: Schema.optional(Schema.Array(SourceControlChangeRequestParticipant)),
  tasksCount: Schema.optional(NonNegativeInt),
  commits: Schema.optional(Schema.Array(SourceControlChangeRequestCommit)),
  additions: Schema.optional(Schema.Number),
  deletions: Schema.optional(Schema.Number),
  changedFiles: Schema.optional(Schema.Number),
  files: Schema.optional(Schema.Array(SourceControlChangeRequestFile)),
  stack: Schema.optional(SourceControlChangeRequestStack),
  stackMetadataIncomplete: Schema.optional(Schema.Boolean),
  mergeCapabilities: Schema.optional(SourceControlChangeRequestMergeCapabilities),
});
export type SourceControlChangeRequestDetail = typeof SourceControlChangeRequestDetail.Type;

export const SourceControlMergeChangeRequestInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
  mergeMethod: SourceControlChangeRequestMergeMethod,
});
export type SourceControlMergeChangeRequestInput = typeof SourceControlMergeChangeRequestInput.Type;

export const SourceControlMergeChangeRequestResult = Schema.Struct({
  outcome: Schema.Literals(["merged", "enqueued"]),
});
export type SourceControlMergeChangeRequestResult =
  typeof SourceControlMergeChangeRequestResult.Type;

export const SOURCE_CONTROL_WORKFLOW_LOG_MAX_BYTES = 200 * 1024; // 200 KB

export const SourceControlWorkflowRunCommit = Schema.Struct({
  oid: TrimmedNonEmptyString,
  shortOid: TrimmedNonEmptyString,
  messageHeadline: Schema.optional(Schema.String),
});
export type SourceControlWorkflowRunCommit = typeof SourceControlWorkflowRunCommit.Type;

export const SourceControlWorkflowRun = Schema.Struct({
  provider: SourceControlProviderKind,
  runId: TrimmedNonEmptyString,
  workflowName: TrimmedNonEmptyString,
  displayTitle: Schema.optional(TrimmedNonEmptyString),
  branch: Schema.Option(TrimmedNonEmptyString),
  event: Schema.optional(TrimmedNonEmptyString),
  commit: SourceControlWorkflowRunCommit,
  actor: Schema.Option(TrimmedNonEmptyString),
  status: TrimmedNonEmptyString,
  conclusion: Schema.Option(TrimmedNonEmptyString),
  startedAt: Schema.Option(Schema.DateTimeUtc),
  updatedAt: Schema.Option(Schema.DateTimeUtc),
  durationMs: Schema.Option(NonNegativeInt),
  url: TrimmedNonEmptyString,
});
export type SourceControlWorkflowRun = typeof SourceControlWorkflowRun.Type;

export const SourceControlWorkflowRunListInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  pullRequestNumber: Schema.optional(PositiveInt),
  commitSha: Schema.optional(TrimmedNonEmptyString),
  /**
   * Branch to scope runs to when there is no pull request (e.g. the default
   * branch). Ignored when `pullRequestNumber` or `commitSha` is provided.
   * Providers narrow the result to the branch's most recent commit so the
   * panel shows the latest push's checks — the branch analogue of a PR head.
   */
  branch: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(PositiveInt),
});
export type SourceControlWorkflowRunListInput = typeof SourceControlWorkflowRunListInput.Type;

export const SourceControlWorkflowRunListResult = Schema.Struct({
  provider: SourceControlProviderKind,
  repository: Schema.Option(TrimmedNonEmptyString),
  pullRequestNumber: Schema.Option(PositiveInt),
  headSha: Schema.Option(TrimmedNonEmptyString),
  runs: Schema.Array(SourceControlWorkflowRun),
});
export type SourceControlWorkflowRunListResult = typeof SourceControlWorkflowRunListResult.Type;

export const SourceControlWorkflowStep = Schema.Struct({
  number: NonNegativeInt,
  name: TrimmedNonEmptyString,
  status: TrimmedNonEmptyString,
  conclusion: Schema.Option(TrimmedNonEmptyString),
  startedAt: Schema.Option(Schema.DateTimeUtc),
  completedAt: Schema.Option(Schema.DateTimeUtc),
  durationMs: Schema.Option(NonNegativeInt),
});
export type SourceControlWorkflowStep = typeof SourceControlWorkflowStep.Type;

export const SourceControlWorkflowJob = Schema.Struct({
  jobId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  status: TrimmedNonEmptyString,
  conclusion: Schema.Option(TrimmedNonEmptyString),
  startedAt: Schema.Option(Schema.DateTimeUtc),
  completedAt: Schema.Option(Schema.DateTimeUtc),
  durationMs: Schema.Option(NonNegativeInt),
  url: Schema.Option(TrimmedNonEmptyString),
  steps: Schema.Array(SourceControlWorkflowStep),
});
export type SourceControlWorkflowJob = typeof SourceControlWorkflowJob.Type;

export const SourceControlWorkflowRunJobsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
});
export type SourceControlWorkflowRunJobsInput = typeof SourceControlWorkflowRunJobsInput.Type;

export const SourceControlWorkflowRunJobsResult = Schema.Struct({
  provider: SourceControlProviderKind,
  runId: TrimmedNonEmptyString,
  jobs: Schema.Array(SourceControlWorkflowJob),
});
export type SourceControlWorkflowRunJobsResult = typeof SourceControlWorkflowRunJobsResult.Type;

export const SourceControlWorkflowJobLogInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  runId: TrimmedNonEmptyString,
  jobId: TrimmedNonEmptyString,
});
export type SourceControlWorkflowJobLogInput = typeof SourceControlWorkflowJobLogInput.Type;

export const SourceControlWorkflowJobLogResult = Schema.Struct({
  provider: SourceControlProviderKind,
  runId: TrimmedNonEmptyString,
  jobId: TrimmedNonEmptyString,
  log: Schema.String,
  truncated: Schema.Boolean,
});
export type SourceControlWorkflowJobLogResult = typeof SourceControlWorkflowJobLogResult.Type;

export const SourceControlWorkflowRerunInput = Schema.Union([
  Schema.Struct({
    cwd: TrimmedNonEmptyString,
    runId: TrimmedNonEmptyString,
    target: Schema.Literal("failed-jobs"),
  }),
  Schema.Struct({
    cwd: TrimmedNonEmptyString,
    runId: TrimmedNonEmptyString,
    target: Schema.Literal("job"),
    jobId: TrimmedNonEmptyString,
  }),
]);
export type SourceControlWorkflowRerunInput = typeof SourceControlWorkflowRerunInput.Type;

export const SourceControlWorkflowRerunResult = Schema.Struct({
  provider: SourceControlProviderKind,
  runId: TrimmedNonEmptyString,
  target: Schema.Literals(["failed-jobs", "job"]),
  jobId: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlWorkflowRerunResult = typeof SourceControlWorkflowRerunResult.Type;

export const SourceControlAddChangeRequestCommentInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
  body: NonBlankMarkdownBody,
  clientMutationId: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlAddChangeRequestCommentInput =
  typeof SourceControlAddChangeRequestCommentInput.Type;

export const SourceControlAddChangeRequestCommentResult = Schema.Struct({
  detail: SourceControlChangeRequestDetail,
});
export type SourceControlAddChangeRequestCommentResult =
  typeof SourceControlAddChangeRequestCommentResult.Type;

export const SourceControlAddChangeRequestCommentReactionResult = Schema.Struct({
  detail: SourceControlChangeRequestDetail,
});
export type SourceControlAddChangeRequestCommentReactionResult =
  typeof SourceControlAddChangeRequestCommentReactionResult.Type;

export const ComposerSourceControlContextKind = Schema.Literals(["issue", "change-request"]);
export type ComposerSourceControlContextKind = typeof ComposerSourceControlContextKind.Type;

export const ComposerSourceControlContext = Schema.Struct({
  id: TrimmedNonEmptyString, // local UUID, generated client-side
  kind: ComposerSourceControlContextKind,
  provider: SourceControlProviderKind,
  reference: TrimmedNonEmptyString, // 'owner/repo#42' or full URL
  detail: Schema.Union([SourceControlIssueDetail, SourceControlChangeRequestDetail]),
  fetchedAt: Schema.DateTimeUtc,
  staleAfter: Schema.DateTimeUtc, // fetchedAt + 5 minutes
});
export type ComposerSourceControlContext = typeof ComposerSourceControlContext.Type;

export const SourceControlRepositoryCloneUrls = Schema.Struct({
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
export type SourceControlRepositoryCloneUrls = typeof SourceControlRepositoryCloneUrls.Type;

export const SourceControlRepositoryVisibility = Schema.Literals(["private", "public"]);
export type SourceControlRepositoryVisibility = typeof SourceControlRepositoryVisibility.Type;

export const SourceControlCloneProtocol = Schema.Literals(["auto", "ssh", "https"]);
export type SourceControlCloneProtocol = typeof SourceControlCloneProtocol.Type;

export const SourceControlRepositoryInfo = Schema.Struct({
  provider: SourceControlProviderKind,
  nameWithOwner: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  sshUrl: TrimmedNonEmptyString,
});
export type SourceControlRepositoryInfo = typeof SourceControlRepositoryInfo.Type;

export const SourceControlRepositoryLookupInput = Schema.Struct({
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type SourceControlRepositoryLookupInput = typeof SourceControlRepositoryLookupInput.Type;

export const SourceControlRepositorySearchInput = Schema.Struct({
  provider: SourceControlProviderKind,
  query: Schema.optional(Schema.String),
  cwd: Schema.optional(TrimmedNonEmptyString),
  limit: Schema.optional(PositiveInt),
});
export type SourceControlRepositorySearchInput = typeof SourceControlRepositorySearchInput.Type;

export const SourceControlRepositorySearchResult = Schema.Struct({
  repositories: Schema.Array(SourceControlRepositoryInfo),
});
export type SourceControlRepositorySearchResult = typeof SourceControlRepositorySearchResult.Type;

export const SourceControlCloneRepositoryInput = Schema.Struct({
  provider: Schema.optional(SourceControlProviderKind),
  repository: Schema.optional(TrimmedNonEmptyString),
  remoteUrl: Schema.optional(TrimmedNonEmptyString),
  destinationPath: TrimmedNonEmptyString,
  protocol: Schema.optional(SourceControlCloneProtocol),
});
export type SourceControlCloneRepositoryInput = typeof SourceControlCloneRepositoryInput.Type;

export const SourceControlCloneRepositoryResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  repository: Schema.NullOr(SourceControlRepositoryInfo),
});
export type SourceControlCloneRepositoryResult = typeof SourceControlCloneRepositoryResult.Type;

export const SourceControlPublishRepositoryInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  visibility: SourceControlRepositoryVisibility,
  remoteName: Schema.optional(TrimmedNonEmptyString),
  protocol: Schema.optional(SourceControlCloneProtocol),
});
export type SourceControlPublishRepositoryInput = typeof SourceControlPublishRepositoryInput.Type;

export const SourceControlPublishStatus = Schema.Literals(["pushed", "remote_added"]);
export type SourceControlPublishStatus = typeof SourceControlPublishStatus.Type;

export const SourceControlPublishRepositoryResult = Schema.Struct({
  repository: SourceControlRepositoryInfo,
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  upstreamBranch: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlPublishStatus,
});
export type SourceControlPublishRepositoryResult = typeof SourceControlPublishRepositoryResult.Type;

export const SourceControlDiscoveryStatus = Schema.Literals(["available", "missing"]);
export type SourceControlDiscoveryStatus = typeof SourceControlDiscoveryStatus.Type;

export const SourceControlProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type SourceControlProviderAuthStatus = typeof SourceControlProviderAuthStatus.Type;

export const SourceControlProviderAuth = Schema.Struct({
  status: SourceControlProviderAuthStatus,
  account: Schema.Option(TrimmedNonEmptyString),
  host: Schema.Option(TrimmedNonEmptyString),
  detail: Schema.Option(TrimmedNonEmptyString),
});
export type SourceControlProviderAuth = typeof SourceControlProviderAuth.Type;

const SourceControlDiscoverySharedFields = {
  label: TrimmedNonEmptyString,
  executable: Schema.optional(TrimmedNonEmptyString),
  status: SourceControlDiscoveryStatus,
  version: Schema.Option(TrimmedNonEmptyString),
  installHint: TrimmedNonEmptyString,
  detail: Schema.Option(TrimmedNonEmptyString),
} as const;

export const VcsDiscoveryItem = Schema.Struct({
  kind: VcsDriverKind,
  implemented: Schema.Boolean,
  ...SourceControlDiscoverySharedFields,
});
export type VcsDiscoveryItem = typeof VcsDiscoveryItem.Type;

export const SourceControlProviderDiscoveryItem = Schema.Struct({
  kind: SourceControlProviderKind,
  ...SourceControlDiscoverySharedFields,
  auth: SourceControlProviderAuth,
});
export type SourceControlProviderDiscoveryItem = typeof SourceControlProviderDiscoveryItem.Type;

export const SourceControlDiscoveryResult = Schema.Struct({
  versionControlSystems: Schema.Array(VcsDiscoveryItem),
  sourceControlProviders: Schema.Array(SourceControlProviderDiscoveryItem),
});
export type SourceControlDiscoveryResult = typeof SourceControlDiscoveryResult.Type;

export class SourceControlProviderError extends Schema.TaggedError<SourceControlProviderError>()(
  "SourceControlProviderError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Source control provider ${this.provider} failed in ${this.operation}: ${this.detail}`;
  }
}

export class SourceControlRepositoryError extends Schema.TaggedError<SourceControlRepositoryError>()(
  "SourceControlRepositoryError",
  {
    provider: SourceControlProviderKind,
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Source control repository operation ${this.operation} failed for ${this.provider}: ${this.detail}`;
  }
}

export interface SourceControlDetailContentCommentLike {
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface SourceControlDetailContentInput<
  C extends SourceControlDetailContentCommentLike = SourceControlDetailContentCommentLike,
> {
  readonly body: string;
  readonly comments: ReadonlyArray<C>;
}

export interface SourceControlDetailContentOutput<
  C extends SourceControlDetailContentCommentLike = SourceControlDetailContentCommentLike,
> {
  readonly body: string;
  readonly comments: ReadonlyArray<C>;
  readonly truncated: boolean;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8Prefix(bytes: Uint8Array): string {
  for (let end = bytes.length; end >= 0; end -= 1) {
    try {
      return utf8Decoder.decode(bytes.subarray(0, end));
    } catch {
      // Drop a trailing partial multi-byte character and try again.
    }
  }
  return "";
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = utf8Encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  return { value: decodeUtf8Prefix(bytes.subarray(0, maxBytes)), truncated: true };
}

export function truncateSourceControlDetailContent<C extends SourceControlDetailContentCommentLike>(
  input: SourceControlDetailContentInput<C>,
): SourceControlDetailContentOutput<C> {
  let truncated = false;
  const { value: body, truncated: bodyCut } = truncateUtf8(
    input.body,
    SOURCE_CONTROL_DETAIL_BODY_MAX_BYTES,
  );
  if (bodyCut) truncated = true;

  let comments = input.comments;
  if (comments.length > SOURCE_CONTROL_DETAIL_MAX_COMMENTS) {
    comments = comments.slice(comments.length - SOURCE_CONTROL_DETAIL_MAX_COMMENTS);
    truncated = true;
  }

  const cappedComments: C[] = [];
  for (const c of comments) {
    const { value, truncated: cBodyCut } = truncateUtf8(
      c.body,
      SOURCE_CONTROL_DETAIL_COMMENT_BODY_MAX_BYTES,
    );
    if (cBodyCut) truncated = true;
    cappedComments.push(c.body === value ? c : ({ ...c, body: value } as C));
  }

  return { body, comments: cappedComments, truncated };
}

/** Provider-owned review progress; environment storage is reserved for future adapters. */
export const SourceControlViewedCapability = Schema.Struct({
  storage: Schema.Literals(["host", "environment", "unsupported"]),
});
export const SourceControlFileViewedState = Schema.Literals(["viewed", "unviewed", "stale"]);
export const SourceControlFileViewed = Schema.Struct({
  path: Schema.String.check(Schema.isMinLength(1)),
  state: SourceControlFileViewedState,
});
export const SourceControlGetChangeRequestFilesViewedInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
});
export type SourceControlGetChangeRequestFilesViewedInput =
  typeof SourceControlGetChangeRequestFilesViewedInput.Type;
export const SourceControlChangeRequestFilesViewed = Schema.Struct({
  provider: SourceControlProviderKind,
  capability: SourceControlViewedCapability,
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  files: Schema.Array(SourceControlFileViewed),
});
export type SourceControlChangeRequestFilesViewed =
  typeof SourceControlChangeRequestFilesViewed.Type;
export const SourceControlSetChangeRequestFileViewedInput = Schema.Struct({
  ...SourceControlGetChangeRequestFilesViewedInput.fields,
  path: Schema.String.check(Schema.isMinLength(1)),
  viewed: Schema.Boolean,
  expectedHeadSha: TrimmedNonEmptyString,
});
export type SourceControlSetChangeRequestFileViewedInput =
  typeof SourceControlSetChangeRequestFileViewedInput.Type;
export const SourceControlSetChangeRequestFileViewedResult = Schema.Struct({
  ...SourceControlFileViewed.fields,
  headSha: TrimmedNonEmptyString,
});
export type SourceControlSetChangeRequestFileViewedResult =
  typeof SourceControlSetChangeRequestFileViewedResult.Type;
