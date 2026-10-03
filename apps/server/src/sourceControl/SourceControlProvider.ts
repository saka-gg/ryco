import { Context, Effect } from "effect";
import {
  SourceControlProviderError,
  type ChangeRequestActivity,
  type ChangeRequestActivityInput,
  type ChangeRequestFileContents,
  type ChangeRequestFileContentsInput,
  type ChangeRequestInvolvement,
  type ChangeRequestReplyToThreadInput,
  type ChangeRequestReplyToThreadResult,
  type ChangeRequestSetThreadResolvedInput,
  type ChangeRequestSetThreadResolvedResult,
  type ChangeRequestSubmitReviewInput,
  type ChangeRequestSubmitReviewResult,
  type ChangeRequestUpdateCommentInput,
  type ChangeRequestUpdateCommentResult,
  type ChangeRequestUpdateInput,
  type ChangeRequestUpdateResult,
  type SourceControlGetChangeRequestFilesViewedInput,
  type SourceControlChangeRequestFilesViewed,
  type SourceControlSetChangeRequestFileViewedInput,
  type SourceControlSetChangeRequestFileViewedResult,
  type ChangeRequest,
  type ChangeRequestState,
  type IssueState,
  type PullRequestState,
  type SourceControlAssigneeCandidate,
  type SourceControlAddCommentReactionInput,
  type SourceControlChangeRequestDetail,
  type SourceControlMergeChangeRequestInput,
  type SourceControlMergeChangeRequestResult,
  type SourceControlWorkflowJobLogResult,
  type SourceControlWorkflowRerunInput,
  type SourceControlWorkflowRerunResult,
  type SourceControlWorkflowRunJobsResult,
  type SourceControlWorkflowRunListResult,
  type SourceControlIssueDetail,
  type SourceControlIssueSummary,
  type SourceControlLabel,
  type SourceControlProviderInfo,
  type SourceControlProviderKind,
  type SourceControlRepositoryCloneUrls,
  type SourceControlRepositoryVisibility,
} from "@ryco/contracts";

export interface SourceControlProviderContext {
  readonly provider: SourceControlProviderInfo;
  readonly remoteName: string;
  readonly remoteUrl: string;
}

export interface SourceControlRefSelector {
  readonly refName: string;
  readonly owner?: string;
  readonly repository?: string;
}

export interface SourceControlCloneAuthentication {
  readonly kind: "http-basic";
  readonly username: string;
  readonly password: string;
}

export function parseSourceControlOwnerRef(
  headSelector: string,
): SourceControlRefSelector | undefined {
  const match = /^([^:/\s]+):(.+)$/u.exec(headSelector.trim());
  const owner = match?.[1]?.trim();
  const refName = match?.[2]?.trim();
  return owner && refName ? { owner, refName } : undefined;
}

export function normalizeSourceBranch(headSelector: string): string {
  return parseSourceControlOwnerRef(headSelector)?.refName ?? headSelector.trim();
}

export function sourceBranch(input: {
  readonly headSelector: string;
  readonly source?: SourceControlRefSelector;
}): string {
  return input.source?.refName ?? normalizeSourceBranch(input.headSelector);
}

export function sourceControlRefFromInput(input: {
  readonly headSelector: string;
  readonly source?: SourceControlRefSelector;
}): SourceControlRefSelector | undefined {
  return input.source ?? parseSourceControlOwnerRef(input.headSelector);
}

/**
 * Fail when a caller asks for list/diff/create semantics this provider cannot
 * honor. Ignoring them would silently return unfiltered lists, whole-PR diffs,
 * or non-draft change requests, which is worse than a clear error.
 */
export function rejectUnsupportedChangeRequestOptions(
  kind: SourceControlProviderKind,
  operation: string,
  options: {
    readonly involvement?: ChangeRequestInvolvement | undefined;
    readonly query?: string | undefined;
    readonly commitSha?: string | undefined;
    readonly draft?: boolean | undefined;
  },
): Effect.Effect<void, SourceControlProviderError> {
  const unsupported = (detail: string) =>
    Effect.fail(new SourceControlProviderError({ provider: kind, operation, detail }));
  if (options.involvement !== undefined) {
    return unsupported(`Filtering by involvement is not supported for ${kind} repositories.`);
  }
  if (options.query !== undefined && options.query.trim().length > 0) {
    return unsupported(`Searching change request lists is not supported for ${kind} repositories.`);
  }
  if (options.commitSha !== undefined) {
    return unsupported(`Single-commit diffs are not supported for ${kind} repositories.`);
  }
  if (options.draft === true) {
    return unsupported(`Creating draft change requests is not supported for ${kind} repositories.`);
  }
  return Effect.void;
}

/** Optional change request operations a provider may not implement. */
export type OptionalChangeRequestOperation =
  | "mergeChangeRequest"
  | "getChangeRequestActivity"
  | "getChangeRequestFileContents"
  | "submitChangeRequestReview"
  | "replyToReviewThread"
  | "setReviewThreadResolved"
  | "updateChangeRequestComment"
  | "updateChangeRequest";

const OPTIONAL_CHANGE_REQUEST_OPERATION_LABELS: Record<OptionalChangeRequestOperation, string> = {
  mergeChangeRequest: "pull request merges",
  getChangeRequestActivity: "the review timeline",
  getChangeRequestFileContents: "expanding diff context",
  submitChangeRequestReview: "submitting reviews",
  replyToReviewThread: "replying to review threads",
  setReviewThreadResolved: "resolving review threads",
  updateChangeRequestComment: "editing comments",
  updateChangeRequest: "updating change requests",
};

export function unsupportedChangeRequestOperation(
  kind: SourceControlProviderKind,
  operation: OptionalChangeRequestOperation,
): Effect.Effect<never, SourceControlProviderError> {
  return Effect.fail(
    new SourceControlProviderError({
      provider: kind,
      operation,
      detail: `This source control provider does not support ${OPTIONAL_CHANGE_REQUEST_OPERATION_LABELS[operation]}.`,
    }),
  );
}

export interface SourceControlProviderShape {
  readonly kind: SourceControlProviderKind;
  readonly listChangeRequests: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly source?: SourceControlRefSelector;
    readonly headSelector: string;
    readonly state: ChangeRequestState | "all";
    readonly limit?: number;
    /** Skip optional stack enrichment when only branch/status fields are consumed. */
    readonly includeStackSummary?: boolean;
    /**
     * Narrow to change requests involving the authenticated viewer. Providers
     * that cannot filter server-side must fail rather than return everything.
     */
    readonly involvement?: ChangeRequestInvolvement;
    /** Free-text search combined with `involvement` and `state`; same failure rule. */
    readonly query?: string;
  }) => Effect.Effect<ReadonlyArray<ChangeRequest>, SourceControlProviderError>;
  readonly getChangeRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
  }) => Effect.Effect<ChangeRequest, SourceControlProviderError>;
  readonly createChangeRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly source?: SourceControlRefSelector;
    readonly target?: SourceControlRefSelector;
    readonly baseRefName: string;
    readonly headSelector: string;
    readonly title: string;
    readonly bodyFile: string;
    /** Open as a draft; providers that cannot must fail instead of opening it ready. */
    readonly draft?: boolean;
  }) => Effect.Effect<void, SourceControlProviderError>;
  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly repository: string;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
  readonly searchRepositories?: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly query?: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<SourceControlRepositoryCloneUrls>, SourceControlProviderError>;
  readonly cloneAuthentication?: (input: {
    readonly remoteUrl: string;
  }) => Effect.Effect<SourceControlCloneAuthentication | null, SourceControlProviderError>;
  readonly createRepository: (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly visibility: SourceControlRepositoryVisibility;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
  readonly getDefaultBranch: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
  }) => Effect.Effect<string | null, SourceControlProviderError>;
  readonly checkoutChangeRequest: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, SourceControlProviderError>;
  readonly listIssues: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly state: "open" | "closed" | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<SourceControlIssueSummary>, SourceControlProviderError>;
  readonly getIssue: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
    readonly fullContent?: boolean;
  }) => Effect.Effect<SourceControlIssueDetail, SourceControlProviderError>;
  readonly addIssueComment: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
    readonly body: string;
    readonly clientMutationId?: string;
  }) => Effect.Effect<SourceControlIssueDetail, SourceControlProviderError>;
  readonly addIssueCommentReaction: (
    input: SourceControlAddCommentReactionInput & {
      readonly context?: SourceControlProviderContext;
    },
  ) => Effect.Effect<SourceControlIssueDetail, SourceControlProviderError>;
  readonly searchIssues: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly query: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<SourceControlIssueSummary>, SourceControlProviderError>;
  readonly searchChangeRequests: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly query: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<ChangeRequest>, SourceControlProviderError>;
  readonly getChangeRequestDetail: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
    readonly fullContent?: boolean;
  }) => Effect.Effect<SourceControlChangeRequestDetail, SourceControlProviderError>;
  readonly addChangeRequestComment: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
    readonly body: string;
    readonly clientMutationId?: string;
  }) => Effect.Effect<SourceControlChangeRequestDetail, SourceControlProviderError>;
  readonly addChangeRequestCommentReaction: (
    input: SourceControlAddCommentReactionInput & {
      readonly context?: SourceControlProviderContext;
    },
  ) => Effect.Effect<SourceControlChangeRequestDetail, SourceControlProviderError>;
  readonly getChangeRequestFilesViewed?: (
    input: SourceControlGetChangeRequestFilesViewedInput & {
      readonly context?: SourceControlProviderContext;
    },
  ) => Effect.Effect<SourceControlChangeRequestFilesViewed, SourceControlProviderError>;
  readonly setChangeRequestFileViewed?: (
    input: SourceControlSetChangeRequestFileViewedInput & {
      readonly context?: SourceControlProviderContext;
    },
  ) => Effect.Effect<SourceControlSetChangeRequestFileViewedResult, SourceControlProviderError>;
  readonly getChangeRequestDiff: (input: {
    readonly expectedHeadSha?: string | undefined;
    /** Scope to one commit of the change request; providers that cannot must fail. */
    readonly commitSha?: string | undefined;
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly reference: string;
  }) => Effect.Effect<string, SourceControlProviderError>;
  readonly mergeChangeRequest?: (
    input: SourceControlMergeChangeRequestInput & {
      readonly context?: SourceControlProviderContext;
    },
  ) => Effect.Effect<SourceControlMergeChangeRequestResult, SourceControlProviderError>;
  /** Review conversation, timeline, and viewer capabilities for the pull request page. */
  readonly getChangeRequestActivity?: (
    input: ChangeRequestActivityInput & { readonly context?: SourceControlProviderContext },
  ) => Effect.Effect<ChangeRequestActivity, SourceControlProviderError>;
  readonly getChangeRequestFileContents?: (
    input: ChangeRequestFileContentsInput & { readonly context?: SourceControlProviderContext },
  ) => Effect.Effect<ChangeRequestFileContents, SourceControlProviderError>;
  readonly submitChangeRequestReview?: (
    input: ChangeRequestSubmitReviewInput & { readonly context?: SourceControlProviderContext },
  ) => Effect.Effect<ChangeRequestSubmitReviewResult, SourceControlProviderError>;
  readonly replyToReviewThread?: (
    input: ChangeRequestReplyToThreadInput & { readonly context?: SourceControlProviderContext },
  ) => Effect.Effect<ChangeRequestReplyToThreadResult, SourceControlProviderError>;
  readonly setReviewThreadResolved?: (
    input: ChangeRequestSetThreadResolvedInput & {
      readonly context?: SourceControlProviderContext;
    },
  ) => Effect.Effect<ChangeRequestSetThreadResolvedResult, SourceControlProviderError>;
  readonly updateChangeRequestComment?: (
    input: ChangeRequestUpdateCommentInput & { readonly context?: SourceControlProviderContext },
  ) => Effect.Effect<ChangeRequestUpdateCommentResult, SourceControlProviderError>;
  /** Apply one lifecycle action and return the fresh, uncapped detail. */
  readonly updateChangeRequest?: (
    input: ChangeRequestUpdateInput & { readonly context?: SourceControlProviderContext },
  ) => Effect.Effect<ChangeRequestUpdateResult, SourceControlProviderError>;
  readonly createIssue: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly title: string;
    readonly body: string;
    readonly labels?: ReadonlyArray<string>;
    readonly assignees?: ReadonlyArray<string>;
  }) => Effect.Effect<SourceControlIssueSummary, SourceControlProviderError>;
  readonly listLabels: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
  }) => Effect.Effect<ReadonlyArray<SourceControlLabel>, SourceControlProviderError>;
  readonly listAssignees: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
  }) => Effect.Effect<ReadonlyArray<SourceControlAssigneeCandidate>, SourceControlProviderError>;
  readonly getPullRequestState: (input: {
    readonly number: number;
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
  }) => Effect.Effect<
    { readonly state: PullRequestState; readonly isDraft: boolean },
    SourceControlProviderError
  >;
  readonly getIssueState: (input: {
    readonly number: number;
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
  }) => Effect.Effect<{ readonly state: IssueState }, SourceControlProviderError>;
  readonly listWorkflowRuns?: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly pullRequestNumber?: number;
    readonly commitSha?: string;
    /** Branch scope when there is no pull request (e.g. the default branch). */
    readonly branch?: string;
    readonly limit?: number;
  }) => Effect.Effect<SourceControlWorkflowRunListResult, SourceControlProviderError>;
  readonly getWorkflowRunJobs?: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly runId: string;
  }) => Effect.Effect<SourceControlWorkflowRunJobsResult, SourceControlProviderError>;
  readonly getWorkflowJobLog?: (input: {
    readonly cwd: string;
    readonly context?: SourceControlProviderContext;
    readonly runId: string;
    readonly jobId: string;
  }) => Effect.Effect<SourceControlWorkflowJobLogResult, SourceControlProviderError>;
  readonly rerunWorkflow?: (
    input: SourceControlWorkflowRerunInput & { readonly context?: SourceControlProviderContext },
  ) => Effect.Effect<SourceControlWorkflowRerunResult, SourceControlProviderError>;
}

/**
 * Wrap a provider that has no server-side involvement filter, list search,
 * single-commit diff, or draft creation so callers asking for them get a
 * clear error instead of silently broader results.
 */
export function withUnsupportedChangeRequestOptionGuards(
  provider: SourceControlProviderShape,
): SourceControlProviderShape {
  return {
    ...provider,
    listChangeRequests: (input) =>
      rejectUnsupportedChangeRequestOptions(provider.kind, "listChangeRequests", {
        involvement: input.involvement,
        query: input.query,
      }).pipe(Effect.andThen(() => provider.listChangeRequests(input))),
    getChangeRequestDiff: (input) =>
      rejectUnsupportedChangeRequestOptions(provider.kind, "getChangeRequestDiff", {
        commitSha: input.commitSha,
      }).pipe(Effect.andThen(() => provider.getChangeRequestDiff(input))),
    createChangeRequest: (input) =>
      rejectUnsupportedChangeRequestOptions(provider.kind, "createChangeRequest", {
        draft: input.draft,
      }).pipe(Effect.andThen(() => provider.createChangeRequest(input))),
  };
}

export class SourceControlProvider extends Context.Service<
  SourceControlProvider,
  SourceControlProviderShape
>()("ryco/source-control/SourceControlProvider") {}
